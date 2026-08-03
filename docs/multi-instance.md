# Multi-instance

TippyBot can run several independent bots at once — different accounts, different servers (or the same server), all from a single `npm run dev`/`npm start`. Each is called an **instance**, identified by a unique `id`.

## Process model

One Node.js process manages every instance, coordinated by `BotManager` ([src/core/bot-manager.ts](../src/core/bot-manager.ts)). [src/index.ts](../src/index.ts) loads all instances from `bots.config.json` (see [configuration.md](configuration.md)) and hands them to it:

```ts
const configs = loadBotInstances()
const manager = new BotManager(configs)
manager.startAll()
```

There's no supervisor process or child-process spawning — `BotManager.startAll()` calls `startBot(config)` ([src/core/bot.ts](../src/core/bot.ts)) once per instance, in the same process, and each call owns its own mineflayer connection, services, and reconnect loop for the lifetime of the process.

## `BotManager`: one API surface for every instance

`startBot(config)` returns an `IBotInstanceHandle` ([src/interfaces/bot-instance.ts](../src/interfaces/bot-instance.ts)) immediately — connecting and module loading continue in the background — and `BotManager` keeps every handle in a map keyed by instance `id`:

```ts
interface IBotInstanceHandle {
  readonly id: string
  readonly config: IBotConfig
  getStatus(): 'connecting' | 'online' | 'reconnecting' | 'errored'
  getLastError(): { message: string; at: number } | undefined
  getSnapshot(): BotInstanceSnapshot
}
```

`manager.getInstances()` / `manager.getInstance(id)` are the only two calls a caller needs to enumerate every running bot and inspect its status — this is the seam a future control surface (a web admin panel, a CLI, anything) is meant to be built against, instead of that caller knowing how instances connect or reconnect internally. Nothing about it is web-specific; it's just a registry.

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

## Per-instance state

Everything an instance owns is namespaced under its `id`, via helpers in [src/config/instancePaths.ts](../src/config/instancePaths.ts):

| State | Path | Notes |
|---|---|---|
| Permissions | `data/<id>/permissions.json` | `JsonPermissionStore`, constructed per-instance in `startBot` |
| Homes | `data/<id>/homes.json` | `JsonHomeStore`, constructed per-instance in `startBot` |
| Auth cache | `auth_cache/<id>/` | Default `profilesFolder`; overridable per-instance in `bots.config.json` |
| Logs | `logs/<id>/YYYY-MM-DD.jsonl[.gz]` | One `LogStore` per instance, owned by the startup/manager wiring and readable by the authenticated web surface |
| Logs | prefixed `[<id>]` | `createConsoleLogger(config.id)` ([src/utils/logger.ts](../src/utils/logger.ts)) |

`id` is validated (1-32 characters, letters/digits/`_`/`-`) before it's ever used in a path, and `bots.config.json` is rejected at load time if two instances share an `id` — see [configuration.md](configuration.md).

## Why this required so little change

`startBot(config)` already constructed all of its services — `ActionRegistry`, `CommandRegistry`, `PathfinderLock`, `PermissionService`, `TaskManager`, `CooldownService`, `HomeService` — as local variables scoped to that one call, and threads them through `IBotContext` rather than reaching for module-level state. Every module under `src/modules` only ever touches state through `ctx`. So making the framework multi-instance-safe came down to a small, contained set of changes:

* Give `IBotConfig` an `id` field and load configuration from a structured file that can list many instances (`bots.config.json` via [src/config/instances.ts](../src/config/instances.ts)) instead of a single set of `BOT_*` environment variables.
* Namespace the two on-disk stores (permissions, homes) and the auth cache under that `id`.
* Replace the single module-level `consoleLogger` with a `createConsoleLogger(label)` factory, called once per instance.
* Have `startBot` return an `IBotInstanceHandle` instead of a bare `Promise<void>`, and add `BotManager` to hold one per instance — giving every instance a status and an on-ramp for a future control surface, on top of the failure isolation `src/index.ts` already needed.

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
