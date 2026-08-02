# Architecture

## Directory layout

| Path | Responsibility |
|---|---|
| `src/core` | Bot creation and lifecycle, the action/command registries, the pathfinder lock |
| `src/interfaces` | TypeScript contracts shared across the framework (`IModule`, `IAction`, `ICommand`, `IBotContext`, ...) |
| `src/modules` | Self-contained feature plugins (see [modules.md](modules.md)) |
| `src/utils` | Small, stateless helper functions used by modules |
| `src/config` | Reads `.env` into a typed `IBotConfig` |

## Boot flow

1. `src/index.ts` loads `.env` (via `dotenv/config`) and calls `startBot(botConfig)`.
2. `startBot` ([src/core/bot.ts](../src/core/bot.ts)) creates the mineflayer `bot`, loads the `pathfinder` plugin, and constructs the shared services: `ActionRegistry`, `CommandRegistry`, `PathfinderLock`.
3. Those pieces are bundled into a single `IBotContext` (`ctx`) — this is the one object threaded through the entire framework. Every module, action, and command receives it.
4. `startBot` wires `bot.on('chat', ...)` to `commands.handleChatMessage`, then calls `init(ctx)` on every module listed in [src/modules/index.ts](../src/modules/index.ts).
5. Each module registers its actions and commands against `ctx.actions` / `ctx.commands` during `init`. From then on, the registries — not the modules themselves — own how a chat message turns into behavior.

## `IBotContext`

```ts
interface IBotContext {
  bot: Bot                       // the mineflayer bot instance
  config: IBotConfig             // parsed .env values
  logger: ILogger                // console logger (see src/utils/logger.ts)
  actions: IActionRegistry
  commands: ICommandRegistry
  pathfinderLock: IPathfinderLock
}
```

Nothing in `src/modules` reaches for globals or singletons — everything a module needs comes through `ctx`. This is what makes modules testable and lets new ones be added without touching existing code.

## Actions vs. commands

* **Actions** (`IAction`, registered via `ctx.actions`) are reusable units of behavior — "jump", "come", "say". They take `(ctx, args)` and don't know anything about chat.
* **Commands** (`ICommand`, registered via `ctx.commands`) are the chat-facing entry points — `!jump`, `!come`. A command's `execute` typically validates/parses chat input (cooldowns, argument parsing) and then calls into one or more actions via `ctx.actions.run(...)`.

This split exists so behavior can be triggered from more than one place — chat commands, action sequences (`ActionRegistry.runSequence`), or future triggers (e.g. scheduled tasks) — without duplicating logic.

## Coordinating the pathfinder: `PathfinderLock`

Only one module should be allowed to drive `bot.pathfinder` at a time — two modules setting conflicting goals on the same tick would fight each other silently. [`PathfinderLock`](../src/core/pathfinder-lock.ts) is a small mutex exposed on `ctx.pathfinderLock` for exactly this:

```ts
if (!ctx.pathfinderLock.acquire('my-module:my-command')) {
  // someone else is already navigating — bail out or tell the player
  return
}
try {
  // set movements/goal, wait for arrival
} finally {
  ctx.pathfinderLock.release('my-module:my-command')
}
```

Any module that calls `bot.pathfinder.setGoal(...)` should acquire the lock first and release it once movement is done (success, failure, or timeout — hence the `finally`). The `navigation` and `sign-trapdoor` modules both do this; see [modules.md](modules.md) for how each uses it.

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
