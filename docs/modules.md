# Modules

Modules are the unit of feature development in TippyBot. Each one lives under `src/modules/<name>/`, implements `IModule`, and is registered in [src/modules/index.ts](../src/modules/index.ts).

For the full list of commands each module registers — syntax, permission level, arguments, cooldowns/limits, examples — see **[commands.md](commands.md)**, the single source of truth for the command list. This page only covers what's relevant to understanding or extending each module's *implementation*.

## Built-in modules

### `chat-basic`

Basic chat interaction, mostly useful for confirming the bot is alive. Also registers a `say` action (`ctx.actions.run('say', ctx, ['hello'])`) that sends arbitrary chat text — actions aren't commands, so it isn't in [commands.md](commands.md); see [architecture.md](architecture.md#actions-vs-commands).

### `navigation`

Movement commands (`!jump`, `!come`, `!follow`/`!unfollow`, `!goto`). Cooldowns are declared on the commands (`cooldown: { perPlayerMs: ... }`) and enforced centrally — see [architecture.md](architecture.md#command-execution-pipeline). Implementation notes:

* `!come`, `!follow`, and `!goto` all register a task with `ctx.tasks` for the duration of the walk (see [tasks.md](tasks.md)) and share one `ctx.pathfinderLock` owner id (`'navigation'`), since `ctx.tasks`' single-slot model already guarantees only one of them can be active at a time.
* A single `activeNav` record (tagged with a `kind: 'come' | 'follow' | 'goto'`) backs all three, reused across the module's `goal_reached`/`path_update`/`path_reset` handlers and the shared `onEnd`/`clearActiveNav` cleanup path.
* `!follow` uses `mineflayer-pathfinder`'s `GoalFollow` with `dynamic: true` so it keeps re-pathing as the target moves; reaching the target does *not* end the task (unlike `!come`/`!goto`, where it does) — only `!unfollow`/`!cancel`/`!stop`, a timeout, the target leaving (`bot.on('playerLeft', ...)`), or death/disconnect end it.
* `!unfollow` doesn't call `ctx.tasks.cancel` with the default (`Operator`+) staff threshold — it passes `'member'` explicitly, and first checks that the active task is actually a `follow` before touching it, so it can never accidentally cancel an unrelated `!come`/`!goto`/`!s`.

### `sign-trapdoor`

Provides `!s`. Implementation notes:

* Sign text is read from block NBT via [`signWorld.ts`](../src/utils/signWorld.ts) / [`signUtils.ts`](../src/utils/signUtils.ts), which understand both the legacy `Text1..4` format and the modern `front_text`/`back_text` format.
* Registers a task with `ctx.tasks` and acquires `ctx.pathfinderLock` under its own owner id (`sign-trapdoor:s`) for the walk, same pattern as `navigation`; passes the task's `AbortSignal` into `waitForGoalReached` so `!cancel`/`!stop` can interrupt the walk immediately instead of waiting out its own internal timeout.

### `access`

The player-facing surface of the permission system — provides the full `!access` command tree. See [permissions.md](permissions.md) for the rules behind each subcommand. Unlike the other modules, `access` itself is registered at `User` level so anyone can at least run `!access me`; each subcommand enforces its own actual requirement internally via `ctx.permissions`, since a single flat command can't have more than one static `requiredLevel` (see the note at the end of [commands.md](commands.md)).

### `bot-status`

Provides `!status`, `!cancel`, and `!stop` — the player-facing surface of `ctx.tasks`. See [tasks.md](tasks.md) for the full model (single active task, timeout, cancel permissions, cleanup on disconnect/death). `!stop` and `!cancel` call the exact same `ctx.tasks.cancel(username, level)`; the only difference is `!stop`'s own `requiredLevel: 'operator'` gate versus `!cancel`'s `'user'` gate with the requester-or-Operator check happening inside `TaskManager`.

### `bot-ops`

Basic operational commands: `!where`, `!look`, `!say`. `!where`/`!look` are simple, non-task, non-pathfinder reads/one-shot actions. `!say` is the one command with hand-written validation beyond what `params`/`cooldown` express (length, control characters, a leading-`/` guard against smuggling a server command through the bot's chat) — see [commands.md](commands.md) for the exact rules.

### `homes`

Provides `!sethome`/`!home`. Backed by `ctx.homes` (`HomeService`) rather than any state local to the module — see [architecture.md](architecture.md#homes). `!home` doesn't reimplement walking: it validates the saved dimension matches the bot's current one, then calls `ctx.actions.run('goto', ctx, [...])`, reusing `navigation`'s `goto` action directly.

## Writing a new module

1. Create `src/modules/<name>/index.ts` exporting a default object implementing `IModule`:

   ```ts
   const myModule: IModule = {
     id: 'my-module',
     description: 'What this module does',
     init(ctx) {
       ctx.commands.register({
         name: 'hello',
         usage: '!hello',
         requiredLevel: 'user',
         async execute({ ctx, username }) {
           ctx.bot.chat(`Hi, ${username}!`)
         }
       })
       ctx.logger.info('my-module initialized')
     }
   }

   export default myModule
   ```

2. Add it to the `modules` array in [src/modules/index.ts](../src/modules/index.ts).
3. `requiredLevel` is mandatory on every command — pick the lowest level that's actually safe. Never re-implement a permission check inside the module; if a command needs finer-grained access than a single level allows, that's what [custom groups](permissions.md#custom-groups) are for.
4. Declare `params` and `cooldown` on the command itself rather than checking `args`/timestamps by hand inside `execute` — see [architecture.md](architecture.md#command-execution-pipeline). Use `params` for simple positional commands; a command with a variable/nested arg shape (like `access`'s subcommand tree) can omit it and parse its own args.
5. If the module runs a long-running or cancelable operation, register it with `ctx.tasks` so it shows up in `!status`, respects `!cancel`, and gets cleaned up on disconnect/death automatically — see [tasks.md](tasks.md).
6. If the module drives `bot.pathfinder`, acquire/release `ctx.pathfinderLock` around it — see [architecture.md](architecture.md#coordinating-the-pathfinder-pathfinderlock).
7. For player-input validation, use [`isValidPlayerName`](../src/utils/validation.ts) rather than rolling a new regex; for throttled chat replies (distinct from command cooldowns), reuse `createChatThrottler` in [src/utils/chat.ts](../src/utils/chat.ts).
8. In `catch` blocks, prefer [`reportError(ctx, scope, err)`](../src/utils/errors.ts) unless you need a specific player-facing message.
