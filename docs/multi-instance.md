# Multi-instance

TippyBot can run several independent bots at once — different accounts, different servers (or the same server), all from a single `npm run dev`/`npm start`. Each is called an **instance**, identified by a unique `id`.

## Process model

One Node.js process manages every instance, coordinated by `BotManager` ([src/core/bot-manager.ts](../src/core/bot-manager.ts)). [src/index.ts](../src/index.ts) loads all instances from `bots.config.json` (see [configuration.md](configuration.md)) and hands them to it:

```ts
const configs = loadBotInstances()
const manager = new BotManager(configs)
manager.startAll()
```

There's no supervisor process or child-process spawning — `BotManager.startAll()` calls `startBot(config, logStore)` ([src/core/bot.ts](../src/core/bot.ts)) once per instance, in the same process, and each call owns its own mineflayer connection, services, and reconnect loop for the lifetime of the process.

## `BotManager`: one API surface for every instance

`startBot(config, logStore)` returns an `IBotInstanceHandle` ([src/interfaces/bot-instance.ts](../src/interfaces/bot-instance.ts)) immediately, **without connecting it** — `BotManager` decides whether and when to call `connect()` (see [Instance lifecycle](#botmanager-instance-lifecycle) below). It keeps every handle in a map keyed by instance `id`:

```ts
type BotInstanceStatus = 'disconnected' | 'connecting' | 'online' | 'reconnecting' | 'errored'

interface IBotInstanceHandle {
  readonly id: string
  readonly config: IBotConfig
  getStatus(): BotInstanceStatus
  getLastError(): { message: string; at: number } | undefined
  getSnapshot(): BotInstanceSnapshot
  getAuthStatus(): MicrosoftAuthStatus | undefined
  getAuthError(): { message: string; at: number } | undefined
  getMinecraftProfileName(): string | undefined
  getDeviceCode(): MicrosoftDeviceCode | undefined
  connect(): Promise<void>
  disconnect(reason?: string): Promise<void>
  authenticate(): Promise<void>
  cancelAuthentication(): Promise<void>
}
```

`authenticate()`/`cancelAuthentication()` are the standalone Microsoft sign-in
control points -- entirely separate from `connect()`/`disconnect()`, see
[Microsoft authentication](#microsoft-authentication) below.

`manager.getInstances()` / `manager.getInstance(id)` are the calls a caller needs to enumerate every running bot and inspect its status. `connect()`/`disconnect()` exist on the handle for `BotManager`'s own internal use (see below); external callers -- including the `/bots` web page -- are expected to go through `BotManager`'s own `connectInstance()`/`disconnectInstance()`/`restartInstance()` instead of calling a handle's `connect()`/`disconnect()` directly, so every lifecycle change is coordinated through the same queue as adding, editing, and removing instances. Nothing about `BotManager` itself is web-specific; it's just a registry with a coordinated control surface.

`IBotInstanceHandle` never hands out mineflayer's `Bot` instance or the framework's internal `IBotContext` — deliberately, so a control surface can't end up depending on either. Instead it exposes `getSnapshot()`, returning plain data:

```ts
interface BotInstanceSnapshot {
  id: string
  status: BotInstanceStatus
  lastError: { message: string; at: number } | undefined

  host: string | undefined   // both undefined means "unconfigured" -- see below
  port: number | undefined
  username: string

  uptimeMs: number | undefined     // ms since login, only while 'online'
  ping: number | undefined
  health: number | undefined
  food: number | undefined
  position: { x: number; y: number; z: number } | undefined
  dimension: string | undefined    // 'overworld' | 'nether' | 'end'
  activeTask: ActiveTaskInfo | undefined  // see tasks.md

  authStatus: MicrosoftAuthStatus | undefined  // undefined for 'offline' auth
  authError: { message: string; at: number } | undefined
  minecraftProfileName: string | undefined
  deviceCode: MicrosoftDeviceCode | undefined  // only while a device code is actively pending
}
```

Every field that only makes sense with a live connection (`uptimeMs`, `ping`, `health`, `food`, `position`, `dimension`) is `undefined` unless the instance's status is `'online'` — a `'reconnecting'` or `'errored'` instance never reports stale numbers as if they were current. `activeTask` is independent of that: it's read straight from `ctx.tasks.getActive()` whenever `ctx` exists, since a task is only ever running while genuinely connected in the first place.

The mapping from raw connection state to `BotInstanceSnapshot` is a pure function, `buildSnapshot()` in [src/core/bot-instance-snapshot.ts](../src/core/bot-instance-snapshot.ts), kept separate from `bot.ts` so it's unit-testable without a real mineflayer connection (see `tests/core/bot-instance-snapshot.test.ts`). Fields not wired up yet (like armor) simply aren't part of the type yet — adding one later means extending `BotInstanceSnapshot` and `buildSnapshot()`, not touching `IBotInstanceHandle`'s shape.

## Failure isolation

`startBot` never throws — a fatal error during an instance's setup (e.g. a corrupt permissions file on disk, `mineflayer.createBot` rejecting) is caught inside it and reflected as an `'errored'` status on that instance's handle, so `BotManager.startAll()` doesn't need any per-instance try/catch of its own to keep one instance's failure from affecting the others. Ordinary connection failures (unreachable server, bad credentials) don't even reach that path — mineflayer's `error`/`end` events drive the existing reconnect-with-backoff loop, surfaced as the `'reconnecting'` status, same as before this instance had a handle at all.

**Not every dropped connection is worth retrying.** [`isFatalConnectionError()`](../src/core/connection-errors.ts) classifies a connection failure by message pattern (currently just "unsupported protocol version" — a server whose protocol the installed mineflayer/minecraft-data can't decode at all, which retrying only repeats identically). `bot.ts`'s `'error'` handler records a match; its `'end'` handler checks it *before* deciding to reconnect: a fatal error goes straight to `'errored'` with a clear `lastError`, and `scheduleReconnect()` is never called. Anything else (`ECONNREFUSED`, `ECONNRESET`, a timeout, ...) is treated as transient and keeps the existing capped-exponential-backoff retry loop (see [tasks.md](tasks.md#reconnection)). This distinction matters especially for `'microsoft'` auth: retrying a doomed connection also meant requesting a fresh device code on every attempt, discarding the previous one mid-flight — see [Microsoft authentication](#microsoft-authentication) below.

This is separate from the config-loading step in `src/index.ts`: if `bots.config.json` is missing or malformed, that's an all-instances-affecting failure with nothing valid to start, so it's caught around `loadBotInstances()` itself, before `BotManager` is even constructed.

Once running, instances stay isolated because nothing in `src/core` or `src/modules` is a singleton — see below.

## `BotManager` instance lifecycle

Every operation that starts, stops, or changes an instance goes through `BotManager` ([src/core/bot-manager.ts](../src/core/bot-manager.ts)) -- not through a raw `IBotInstanceHandle`. This is what lets the `/bots` web page (see [web.md](web.md#bots-page-instance-management)) safely add, edit, remove, connect, disconnect, and restart instances at runtime without racing itself or corrupting `bots.config.json`.

```ts
class BotManager {
  addInstance(config: IBotConfig, logStore: LogStore): Promise<IBotInstanceHandle>
  removeInstance(id: string): Promise<void>
  updateInstance(id: string, config: IBotConfig): Promise<IBotInstanceHandle>
  connectInstance(id: string): Promise<void>
  disconnectInstance(id: string, reason?: string): Promise<void>
  restartInstance(id: string): Promise<void>
  authenticateInstance(id: string): Promise<void>
  cancelAuthentication(id: string): Promise<void>
}
```

**One queue coordinates the first six.** `addInstance`/`removeInstance`/`updateInstance`/`connectInstance`/`disconnectInstance`/`restartInstance` -- regardless of which instance `id` they target -- run through the same manager-level promise queue, so two overlapping calls (e.g. two browser tabs, or a double-click that reaches the server before the button disabled) execute one at a time instead of racing each other's read of `bots.config.json`. This is a *second*, coarser queue on top of the per-instance queue `IBotInstanceHandle.connect()`/`disconnect()`/`authenticate()`/`cancelAuthentication()` already have (see above) -- that one only protects a single instance's own state, not the shared config file. Internal callers (`startAll()`, and the CRUD methods themselves) call a handle's `connect()`/`disconnect()` directly, since they're already running inside the manager queue; calling back into `connectInstance()`/etc. from there would deadlock.

**`authenticateInstance()`/`cancelAuthentication()` deliberately bypass that queue.** `authenticate()` can run for as long as the user takes to complete a device-code sign-in -- routing it through the same strict-FIFO manager queue would make an unrelated add/remove/update on a *different* instance wait out that whole window. They stay fully race-safe against *this* instance's own `connect()`/`disconnect()` regardless, since all four go through the instance's own per-instance queue. See [Microsoft authentication](#microsoft-authentication) below for the full picture.

**Config-file writes happen before any in-memory state changes, always:**

* `addInstance` writes the full instance list (new instance included) to `bots.config.json` *before* adding the handle to its internal map or calling `connect()`. If the write fails, nothing is added and nothing connects.
* `removeInstance` disconnects the instance first (if it was active), then writes the file without it, and only *then* drops it from the map. If the write fails, the instance stays disconnected but is never lost from memory -- it's still there, just not auto-reconnecting, and the delete can be retried.
* `updateInstance` disconnects the old handle (if it was active), then writes the file with the new config. If that write fails, it reconnects the old handle (best-effort) before the error propagates, so a failed edit never leaves the file and the in-memory config disagreeing with each other. On success, it swaps in a new handle built from the new config and reconnects only if the instance was active before the edit.
* None of the three ever deletes or touches `data/<id>/`, `auth_cache/<id>/`, or `logs/<id>/` -- removing an instance from `bots.config.json` only removes its *configuration*. Its on-disk state is left exactly as it was, in case the same `id` is added back later.

**`autoConnect` controls the initial state**, both at boot and when adding a new instance: `startAll()` and `addInstance()` only call `connect()` when `config.autoConnect` is not `false`. It defaults to `true` when the field is absent from `bots.config.json` (see [configuration.md](configuration.md)), so instances created before this field existed keep connecting automatically. Editing an *existing* instance does not re-evaluate `autoConnect` for that purpose -- `updateInstance` reconnects if (and only if) the instance was already active before the edit, independent of the new `autoConnect` value, so an edit never silently starts or stops a bot that a human didn't already start or stop themselves. An "unconfigured" instance (no `host` -- see [Microsoft authentication](#microsoft-authentication)) is a no-op either way: `connect()` rejects immediately with a clear error before ever touching mineflayer, so `autoConnect: true` on an instance with nothing to connect to just does nothing, quietly.

**Errors are typed, not stringly matched.** `connectInstance`/`disconnectInstance`/`restartInstance`/`removeInstance`/`updateInstance` throw `BotInstanceNotFoundError` for an unknown `id` and `BotInstanceConflictError` for an operation that's invalid given the instance's current state (already connected, already disconnected, duplicate `id` on create, `id` change on edit) -- see [src/core/bot-errors.ts](../src/core/bot-errors.ts). The web layer maps these to `404` and `409` respectively by `instanceof`, never by matching error message text (see [web.md](web.md#bots-page-instance-management)).

## Microsoft authentication

Signing in a `'microsoft'`-auth instance and connecting it to a server used to be the same operation -- every connection attempt re-ran mineflayer's own device-code flow if no valid token was cached yet, so a server that kept failing to connect (a bad address, a protocol mismatch, a flaky network) also kept burning fresh device codes on every retry, invalidating the previous one out from under anyone still looking at it. `authenticate()`/`cancelAuthentication()` on `IBotInstanceHandle` (via [src/core/microsoft-auth.ts](../src/core/microsoft-auth.ts)) split sign-in out as its own, independent operation:

```ts
import { Authflow } from 'prismarine-auth'
```

`authenticateMicrosoft(cacheUsername, profilesFolder, onCode)` constructs an `Authflow` directly and calls `getMinecraftJavaToken()` -- no `mineflayer.createBot()`, no `host`/`port` involved at all. It resolves immediately if a valid cached token already exists, or after the user completes the device code otherwise. Because prismarine-auth's on-disk cache is keyed only by `(cacheUsername, flow, cacheName)` -- never by host or port -- a token obtained this way is transparently reused by mineflayer's own internal auth on the next `connect()`, and vice versa. Both call sites import the exact same fixed flow parameters from [src/core/microsoft-auth-options.ts](../src/core/microsoft-auth-options.ts) (via prismarine-auth's own `Titles.MinecraftNintendoSwitch` constant, not a hand-copied literal) specifically so they can never drift apart and start reading/writing different cache files.

### `msaCacheKey` vs `username`

The cache key passed to `Authflow` is `IBotConfig.msaCacheKey`, not `username`. They're deliberately different things: `username` is either the bot's real identity (`'offline'` auth) or just a technical placeholder mineflayer wants some value for (`'microsoft'` auth, where the *real* identity is `minecraftProfileName`, learned from a successful sign-in); `msaCacheKey` is purely an internal, stable string with no meaning outside "which cache file". `validateInstance()` ([src/config/instances.ts](../src/config/instances.ts)) defaults it to the resolved `username` when absent -- every instance saved before this field existed was already using its username as the de facto cache key, so this default preserves that instance's existing cached token instead of forcing a fresh sign-in. The `/bots` form never lets you type `username` for `'microsoft'` auth at all (an empty value there defaults to `id`), and `msaCacheKey` itself is a disabled, Advanced-Settings-only field once an instance exists -- editing never changes or regenerates it.

### `authStatus` vs connection `status`

These are two independent state machines on the same handle:

```ts
type MicrosoftAuthStatus = 'unknown' | 'unauthenticated' | 'authenticating' | 'authenticated' | 'auth_error'
```

`authStatus` is `undefined` for `'offline'` auth. For `'microsoft'` auth it starts at `'unknown'` whenever a handle is (re)created -- process restart, or an `updateInstance()` edit, which always builds a fresh `BotInstance` -- and only moves to `'authenticated'` after a successful `authenticate()` **or** a successful login through `connect()`. A cached token file existing on disk does *not* by itself prove `'authenticated'`; only an actual successful check does, since a cached token can be expired or revoked. This means `'unknown'` after a restart or an edit is not a warning sign and does not mean the cached token was lost -- it means "not verified again yet in this process". The very next successful `connect()` or `authenticate()` call re-confirms it.

Both operations enforce each other's absence, checked *synchronously* the moment they're called (not deferred into either instance's own operation queue) -- `authenticate()` can stay pending for however long the user takes with the browser, unlike `connect()`, whose own promise resolves quickly regardless of the real network outcome, so a check that only ran once the queued work started would see stale state:

* `connect()` rejects immediately if `authStatus === 'authenticating'`.
* `authenticate()` rejects immediately if the connection status is `'connecting'`/`'online'`/`'reconnecting'`, or if `authStatus` is already `'authenticating'`.

Together these make the two operations structurally unable to run concurrently on the same instance -- `scheduleReconnect()`'s internal retry loop never needs its own check, because by the time `authStatus` could become `'authenticating'`, no reconnect timer can already be pending.

`cancelAuthentication()` stops waiting **immediately** -- `authStatus` returns to `'unauthenticated'` synchronously, before the network call has necessarily noticed. It is deliberately *not* routed through either the instance's own operation queue or the manager's CRUD queue, for the same reason: queuing "stop waiting on the thing that's currently running" behind that same thing would just wait for it anyway. The underlying device-code poll may continue for a short time in the background (prismarine-auth exposes no real cancellation), but its eventual result is discarded: every `authenticate()` call captures a private identity token, and both the success and failure branches check it's still current before touching `authStatus`/`authError`/`minecraftProfileName`/`deviceCode` -- a stale result updates nothing. This is the same bounded-wait-plus-staleness-guard pattern `disconnect()` already uses for mineflayer's `'end'` event (see above), applied to a second, independent flow.

### Unconfigured instances

`host`/`port` are both optional on `IBotConfig`. Absent means the instance is "unconfigured": it exists, and for `'microsoft'` auth can be fully signed in, but has nothing to connect to yet. `connect()` checks this first, before anything else, and rejects with a clear message rather than ever constructing a mineflayer bot -- so an unconfigured instance never gets a reconnect loop, an `'errored'` status, or any other side effect, and `autoConnect: true` on one is simply inert. `port` defaults to `25565` whenever a `host` is given without one; both stay absent together rather than saving a lone, meaningless port. Adding a `host` later (an `updateInstance()` edit) doesn't touch `msaCacheKey`/`profilesFolder`, so a `connect()` afterward reuses whatever was already cached -- no new sign-in required.

### Typical flow

1. Create a `'microsoft'` instance from `/bots` with no `host`/`port` -- it's saved and shown as **Unconfigured**.
2. Click **Authenticate**. The device code and link appear in the page itself (not just the console); `POST /api/bots/:id/authenticate` doesn't wait for the full flow (it can take minutes), so the response comes back once the code is ready, or once an already-valid cached token made the whole thing instant.
3. Complete the sign-in in a browser. `authStatus` becomes `'authenticated'` and `minecraftProfileName` shows the real account name -- the `/bots` page polls for this while the dialog is open.
4. Edit the instance to add a `host` (and optionally a `port` -- defaults to `25565`).
5. Click **Connect**. mineflayer's own internal auth finds the same cached token and logs in without any further device code.

See [web.md](web.md#bots-page-instance-management) for the API endpoints and UI controls this maps to.

## Per-instance state

Everything an instance owns is namespaced under its `id`, via helpers in [src/config/instancePaths.ts](../src/config/instancePaths.ts):

| State | Path | Notes |
|---|---|---|
| Permissions | `data/<id>/permissions.json` | `JsonPermissionStore`, constructed per-instance in `startBot` |
| Homes | `data/<id>/homes.json` | `JsonHomeStore`, constructed per-instance in `startBot` |
| Auth cache | `auth_cache/<id>/` | Default `profilesFolder`; overridable per-instance in `bots.config.json` |
| Logs | `logs/<id>/YYYY-MM-DD.jsonl[.gz]` | One `LogStore` per instance, owned by the startup/manager wiring and readable by the authenticated web surface |
| Console | prefixed `[<id>]` | `createConsoleLogger(config.id)` ([src/utils/logger.ts](../src/utils/logger.ts)) |

`id` is validated (1-32 characters, letters/digits/`_`/`-`) before it's ever used in a path, and `bots.config.json` is rejected at load time if two instances share an `id` — see [configuration.md](configuration.md).

## Why this required so little change

`startBot(config)` already constructed all of its services — `ActionRegistry`, `CommandRegistry`, `PathfinderLock`, `PermissionService`, `TaskManager`, `CooldownService`, `HomeService` — as local variables scoped to that one call, and threads them through `IBotContext` rather than reaching for module-level state. Every module under `src/modules` only ever touches state through `ctx`. So making the framework multi-instance-safe came down to a small, contained set of changes:

* Give `IBotConfig` an `id` field and load configuration from a structured file that can list many instances (`bots.config.json` via [src/config/instances.ts](../src/config/instances.ts)) instead of a single set of `BOT_*` environment variables.
* Namespace the two on-disk stores (permissions, homes) and the auth cache under that `id`.
* Replace the single module-level `consoleLogger` with a `createConsoleLogger(label)` factory, called once per instance.
* Have `startBot` return an `IBotInstanceHandle` instead of a bare `Promise<void>`, and add `BotManager` to hold one per instance — giving every instance a status and a control surface.
* Separate "create a handle" from "connect it": `startBot` no longer connects on its own, so `BotManager` can create an instance without starting it (`autoConnect: false`) and can later `connect()`/`disconnect()`/`restart` it on demand -- see [BotManager instance lifecycle](#botmanager-instance-lifecycle) above.

No changes were needed in `src/core/commands.ts`, `src/core/permission-service.ts`, `src/core/task-manager.ts`, `src/core/cooldown-service.ts`, or any file under `src/modules` — they were already instance-scoped by construction.

## Running multiple instances

```bash
cp bots.config.example.json bots.config.json
```

Edit `bots.config.json` to list each instance (see [configuration.md](configuration.md) for the field reference), then:

```bash
npm run dev
```

Console output from all instances interleaves in the same terminal, tagged by `id` — e.g. `[steve] [INFO] TippyBot joined the server`.

Once the process is running, instances can also be added, edited, removed,
connected, disconnected, and restarted from the `/bots` web page instead of
hand-editing `bots.config.json` and restarting the whole process — see
[web.md](web.md#bots-page-instance-management). Both paths go through the
same validation and the same file.
