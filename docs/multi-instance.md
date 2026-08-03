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
  connect(): Promise<void>
  disconnect(reason?: string): Promise<void>
}
```

`manager.getInstances()` / `manager.getInstance(id)` are the calls a caller needs to enumerate every running bot and inspect its status. `connect()`/`disconnect()` exist on the handle for `BotManager`'s own internal use (see below); external callers -- including the `/bots` web page -- are expected to go through `BotManager`'s own `connectInstance()`/`disconnectInstance()`/`restartInstance()` instead of calling a handle's `connect()`/`disconnect()` directly, so every lifecycle change is coordinated through the same queue as adding, editing, and removing instances. Nothing about `BotManager` itself is web-specific; it's just a registry with a coordinated control surface.

`IBotInstanceHandle` never hands out mineflayer's `Bot` instance or the framework's internal `IBotContext` — deliberately, so a control surface can't end up depending on either. Instead it exposes `getSnapshot()`, returning plain data:

```ts
interface BotInstanceSnapshot {
  id: string
  status: BotInstanceStatus
  lastError: { message: string; at: number } | undefined

  host: string
  port: number
  username: string

  uptimeMs: number | undefined     // ms since login, only while 'online'
  ping: number | undefined
  health: number | undefined
  food: number | undefined
  position: { x: number; y: number; z: number } | undefined
  dimension: string | undefined    // 'overworld' | 'nether' | 'end'
  activeTask: ActiveTaskInfo | undefined  // see tasks.md
}
```

Every field that only makes sense with a live connection (`uptimeMs`, `ping`, `health`, `food`, `position`, `dimension`) is `undefined` unless the instance's status is `'online'` — a `'reconnecting'` or `'errored'` instance never reports stale numbers as if they were current. `activeTask` is independent of that: it's read straight from `ctx.tasks.getActive()` whenever `ctx` exists, since a task is only ever running while genuinely connected in the first place.

The mapping from raw connection state to `BotInstanceSnapshot` is a pure function, `buildSnapshot()` in [src/core/bot-instance-snapshot.ts](../src/core/bot-instance-snapshot.ts), kept separate from `bot.ts` so it's unit-testable without a real mineflayer connection (see `tests/core/bot-instance-snapshot.test.ts`). Fields not wired up yet (like armor) simply aren't part of the type yet — adding one later means extending `BotInstanceSnapshot` and `buildSnapshot()`, not touching `IBotInstanceHandle`'s shape.

## Failure isolation

`startBot` never throws — a fatal error during an instance's setup (e.g. a corrupt permissions file on disk, `mineflayer.createBot` rejecting) is caught inside it and reflected as an `'errored'` status on that instance's handle, so `BotManager.startAll()` doesn't need any per-instance try/catch of its own to keep one instance's failure from affecting the others. Ordinary connection failures (unreachable server, bad credentials) don't even reach that path — mineflayer's `error`/`end` events drive the existing reconnect-with-backoff loop, surfaced as the `'reconnecting'` status, same as before this instance had a handle at all.

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
}
```

**One queue coordinates all of it.** All six methods -- regardless of which instance `id` they target -- run through the same manager-level promise queue, so two overlapping calls (e.g. two browser tabs, or a double-click that reaches the server before the button disabled) execute one at a time instead of racing each other's read of `bots.config.json`. This is a *second*, coarser queue on top of the per-instance queue `IBotInstanceHandle.connect()`/`disconnect()` already have (see above) -- that one only protects a single instance's own state, not the shared config file. Internal callers (`startAll()`, and the CRUD methods themselves) call a handle's `connect()`/`disconnect()` directly, since they're already running inside the manager queue; calling back into `connectInstance()`/etc. from there would deadlock.

**Config-file writes happen before any in-memory state changes, always:**

* `addInstance` writes the full instance list (new instance included) to `bots.config.json` *before* adding the handle to its internal map or calling `connect()`. If the write fails, nothing is added and nothing connects.
* `removeInstance` disconnects the instance first (if it was active), then writes the file without it, and only *then* drops it from the map. If the write fails, the instance stays disconnected but is never lost from memory -- it's still there, just not auto-reconnecting, and the delete can be retried.
* `updateInstance` disconnects the old handle (if it was active), then writes the file with the new config. If that write fails, it reconnects the old handle (best-effort) before the error propagates, so a failed edit never leaves the file and the in-memory config disagreeing with each other. On success, it swaps in a new handle built from the new config and reconnects only if the instance was active before the edit.
* None of the three ever deletes or touches `data/<id>/`, `auth_cache/<id>/`, or `logs/<id>/` -- removing an instance from `bots.config.json` only removes its *configuration*. Its on-disk state is left exactly as it was, in case the same `id` is added back later.

**`autoConnect` controls the initial state**, both at boot and when adding a new instance: `startAll()` and `addInstance()` only call `connect()` when `config.autoConnect` is not `false`. It defaults to `true` when the field is absent from `bots.config.json` (see [configuration.md](configuration.md)), so instances created before this field existed keep connecting automatically. Editing an *existing* instance does not re-evaluate `autoConnect` for that purpose -- `updateInstance` reconnects if (and only if) the instance was already active before the edit, independent of the new `autoConnect` value, so an edit never silently starts or stops a bot that a human didn't already start or stop themselves.

**Errors are typed, not stringly matched.** `connectInstance`/`disconnectInstance`/`restartInstance`/`removeInstance`/`updateInstance` throw `BotInstanceNotFoundError` for an unknown `id` and `BotInstanceConflictError` for an operation that's invalid given the instance's current state (already connected, already disconnected, duplicate `id` on create, `id` change on edit) -- see [src/core/bot-errors.ts](../src/core/bot-errors.ts). The web layer maps these to `404` and `409` respectively by `instanceof`, never by matching error message text (see [web.md](web.md#bots-page-instance-management)).

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
