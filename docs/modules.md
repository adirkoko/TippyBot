# Modules

Modules are the unit of feature development in TippyBot. Each one lives under `src/modules/<name>/`, implements `IModule`, and is registered in [src/modules/index.ts](../src/modules/index.ts).

For the full list of commands each module registers — syntax, permission level, arguments, cooldowns/limits, examples — see **[commands.md](commands.md)**, the single source of truth for the command list. This page only covers what's relevant to understanding or extending each module's *implementation*.

## Built-in modules

### `chat-basic`

Basic chat interaction, mostly useful for confirming the bot is alive. Also registers a `say` action (`ctx.actions.run('say', ctx, ['hello'])`) that sends arbitrary chat text — actions aren't commands, so it isn't in [commands.md](commands.md); see [architecture.md](architecture.md#actions-vs-commands).

### `navigation`

Movement commands (`!jump`, `!come`). Implementation notes:

* Both commands are rate-limited per user via `createCommandCooldownManager` (see [src/utils/chat.ts](../src/utils/chat.ts)).
* `!come` acquires `ctx.pathfinderLock` under the owner id `navigation:come` for the duration of the walk, and reacts to `goal_reached`, `path_update`, `path_reset`, `death`, and `end` to clean up and report back to chat.

### `sign-trapdoor`

Provides `!s`. Implementation notes:

* Sign text is read from block NBT via [`signWorld.ts`](../src/utils/signWorld.ts) / [`signUtils.ts`](../src/utils/signUtils.ts), which understand both the legacy `Text1..4` format and the modern `front_text`/`back_text` format.
* Acquires `ctx.pathfinderLock` under the owner id `sign-trapdoor:s` for the walk, same pattern as `navigation`.

### `access`

The player-facing surface of the permission system — provides the full `!access` command tree. See [permissions.md](permissions.md) for the rules behind each subcommand. Unlike the other modules, `access` itself is registered at `User` level so anyone can at least run `!access me`; each subcommand enforces its own actual requirement internally via `ctx.permissions`, since a single flat command can't have more than one static `requiredLevel` (see the note at the end of [commands.md](commands.md)).

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
4. If the module drives `bot.pathfinder`, acquire/release `ctx.pathfinderLock` around it — see [architecture.md](architecture.md#coordinating-the-pathfinder-pathfinderlock).
5. For player-input validation, use [`isValidPlayerName`](../src/utils/validation.ts) rather than rolling a new regex; for per-user rate limiting or throttled chat replies, reuse the helpers in [src/utils/chat.ts](../src/utils/chat.ts).
6. In `catch` blocks, prefer [`reportError(ctx, scope, err)`](../src/utils/errors.ts) unless you need a specific player-facing message.
