# Architecture

## Directory layout

| Path | Responsibility |
|---|---|
| `src/core` | Bot creation and lifecycle (incl. reconnection), the action/command registries, the pathfinder lock, the permission service, the task manager, the cooldown service, the home service, and the shared atomic-JSON-file-store helper they're built on |
| `src/interfaces` | TypeScript contracts shared across the framework (`IModule`, `IAction`, `ICommand`, `IBotContext`, ...) |
| `src/modules` | Self-contained feature plugins (see [modules.md](modules.md)) |
| `src/utils` | Small, stateless helper functions used by modules |
| `src/config` | Reads `.env` into a typed `IBotConfig` |

## Boot flow

1. `src/index.ts` loads `.env` (via `dotenv/config`) and calls `startBot(botConfig)`.
2. `startBot` ([src/core/bot.ts](../src/core/bot.ts)) constructs the services shared across the bot's entire lifetime — `ActionRegistry`, `CommandRegistry`, `PathfinderLock`, `PermissionService`, `TaskManager`, `CooldownService` — and awaits `PermissionService.load()` before anything else touches chat.
3. It then calls an internal `connect()` function that creates the mineflayer `bot`, loads the `pathfinder` plugin, and bundles everything into a single `IBotContext` (`ctx`) — the one object threaded through the entire framework.
4. `connect()` wires `bot.on('chat', ...)` to `commands.handleChatMessage`, wires `end`/`death` to `ctx.tasks.abort(...)` (see [tasks.md](tasks.md)), then calls `init(ctx)` on every module listed in [src/modules/index.ts](../src/modules/index.ts).
5. Each module registers its actions and commands against `ctx.actions` / `ctx.commands` during `init`. From then on, the registries — not the modules themselves — own how a chat message turns into behavior.
6. If the connection drops, `connect()` runs again on a backoff schedule — see [tasks.md](tasks.md#reconnection). `bot` (and therefore `ctx`) is recreated per connection attempt; the services from step 2 persist across reconnects.

## `IBotContext`

```ts
interface IBotContext {
  bot: Bot                       // the mineflayer bot instance
  config: IBotConfig             // parsed .env values
  logger: ILogger                // console logger (see src/utils/logger.ts)
  actions: IActionRegistry
  commands: ICommandRegistry
  pathfinderLock: IPathfinderLock
  permissions: IPermissionService
  tasks: ITaskManager
  cooldowns: ICooldownService
  homes: IHomeService
}
```

Nothing in `src/modules` reaches for globals or singletons — everything a module needs comes through `ctx`. This is what makes modules testable and lets new ones be added without touching existing code.

## Actions vs. commands

* **Actions** (`IAction`, registered via `ctx.actions`) are reusable units of behavior — "jump", "come", "say". They take `(ctx, args)` and don't know anything about chat.
* **Commands** (`ICommand`, registered via `ctx.commands`) are the chat-facing entry points — `!jump`, `!come`. A command's `execute` calls into one or more actions via `ctx.actions.run(...)`; permission, argument, and cooldown checks all happen centrally *before* `execute` is ever called (see below), not inside it.

This split exists so behavior can be triggered from more than one place — chat commands, action sequences (`ActionRegistry.runSequence`), or future triggers — without duplicating logic.

## Command execution pipeline

`CommandRegistry.handleChatMessage` ([src/core/commands.ts](../src/core/commands.ts)) is the single place a chat message becomes a command execution, and it runs every registered command through the same four gates, in order, before calling `execute`:

1. **Permission** — `ctx.permissions.canUseCommand(username, command)`. Every `ICommand` must declare a `requiredLevel`. See [permissions.md](permissions.md) for the full model (levels, Admin config, custom groups, the `!access` commands, and storage).
2. **Params** — `validateParams(command, args)` ([src/core/param-validator.ts](../src/core/param-validator.ts)), checked against the command's optional `params: ParamSpec[]`. Handles missing/extra arguments and typed checks (`playerName`, `groupName`, `integer` with `min`/`max`, `enum` with `values`). The last spec can set `rest: true` to consume all remaining args as one value instead of counting them individually — `!say`'s `<message>` is the example. A command that omits `params` is left alone — it parses its own args (`access`'s subcommand tree is the example).
3. **Cooldown** — `ctx.cooldowns.getRemainingMs(...)` / `recordUse(...)` (`CooldownService`, [src/core/cooldown-service.ts](../src/core/cooldown-service.ts)), checked against the command's optional `cooldown: CommandCooldownConfig` (`perPlayerMs` and/or `globalMs`). Declared on the command, never implemented inside `execute`.
4. **Execute** — only now is `command.execute(commandCtx)` called.

A module never re-implements any of these checks itself; it only declares `requiredLevel`, `params`, and `cooldown` on the `ICommand` object it registers. See [modules.md](modules.md#writing-a-new-module).

## Tasks and reliability

`ctx.tasks` (`TaskManager`) tracks the single long-running operation the bot is doing right now — who asked for it, how to cancel it, and what happens if the bot disconnects or dies mid-task. `ctx.tasks.abort(...)` is wired into the bot's `end`/`death` handlers so a dropped connection always clears stale "busy" state. Reconnection itself (capped exponential backoff, rate-limiting retries) lives in `connect()`/`scheduleReconnect()` in [src/core/bot.ts](../src/core/bot.ts). Full details, including the `!status`/`!cancel` commands, are in [tasks.md](tasks.md).

## Coordinating the pathfinder: `PathfinderLock`

Only one module should be allowed to drive `bot.pathfinder` at a time — two modules setting conflicting goals on the same tick would fight each other silently. [`PathfinderLock`](../src/core/pathfinder-lock.ts) is a small mutex exposed on `ctx.pathfinderLock` for exactly this:

```ts
if (!ctx.pathfinderLock.acquire('my-module')) {
  // someone else is already navigating — bail out or tell the player
  return
}
try {
  // set movements/goal, wait for arrival
} finally {
  ctx.pathfinderLock.release('my-module')
}
```

Any module that calls `bot.pathfinder.setGoal(...)` should acquire the lock first and release it once movement is done (success, failure, or timeout). `navigation` uses one shared owner id (`'navigation'`) across all of its pathfinder-driven commands (`!come`, `!follow`, `!goto`) since only one can ever be active anyway (enforced independently by `ctx.tasks`); `sign-trapdoor` uses its own id. See [modules.md](modules.md) for how each uses it.

## Homes

`ctx.homes` (`HomeService`, [src/core/home-service.ts](../src/core/home-service.ts)) holds one saved location per player — set via `!sethome`, walked to via `!home` (see [commands.md](commands.md)). It follows the exact same storage-behind-an-interface pattern as `PermissionService`: `IHomeStore` ([src/interfaces/home-store.ts](../src/interfaces/home-store.ts)) hides the on-disk format, and `JsonHomeStore` ([src/core/home-store.ts](../src/core/home-store.ts)) is the only implementation today, persisting to `data/homes.json`.

Both `JsonPermissionStore` and `JsonHomeStore` are now thin wrappers around a shared pair of primitives in [src/core/json-file-store.ts](../src/core/json-file-store.ts) — `readJsonFile` (parse-or-fallback) and `writeJsonFileAtomic` (temp-file-then-rename, same crash-safety guarantee as before). A third JSON-backed store can reuse these instead of re-implementing atomic writes.

Each saved home records the dimension it was set in alongside the coordinates. `!home` compares that against the bot's *current* dimension and refuses to walk if they differ, rather than attempting (and failing) to path across a dimension boundary — see [commands.md](commands.md) for the exact message.

## Error handling

[`reportError`](../src/utils/errors.ts) wraps the repeated "log it, tell the player something broke" pattern used across command/action `catch` blocks:

```ts
try {
  // ...
} catch (err) {
  reportError(ctx, 'come action', err) // logs, then bot.chat('Something went wrong.')
}
```

Use it for the generic case. Where a `catch` needs a specific player-facing message or shouldn't spam chat (e.g. the throttled jump-error message in `navigation`), handle it inline instead.
