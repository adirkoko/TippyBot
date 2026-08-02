# Modules

Modules are the unit of feature development in TippyBot. Each one lives under `src/modules/<name>/`, implements `IModule`, and is registered in [src/modules/index.ts](../src/modules/index.ts).

## Built-in modules

### `chat-basic`

Basic chat interaction, mostly useful for confirming the bot is alive.

| Command | Description |
|---|---|
| `!ping` | Replies "Pong, `<username>`!" |
| `!tippy` | Replies with the bot's classic line |

Also registers a `say` action (`ctx.actions.run('say', ctx, ['hello'])`) that sends arbitrary chat text.

### `navigation`

Movement commands.

| Command | Description |
|---|---|
| `!jump` | Makes the bot jump once |
| `!come [playerName]` | Walks to `playerName`, or to the caller if omitted |

Notes:

* `!come` refuses targets further than 256 blocks away, validates the player name against `^[A-Za-z0-9_]+$`, and times out after 30s if the goal isn't reached.
* Both commands are rate-limited per user (2s cooldown) via `createCommandCooldownManager` (see [testing.md](testing.md) / [src/utils/chat.ts](../src/utils/chat.ts)).
* `!come` acquires `ctx.pathfinderLock` under the owner id `navigation:come` for the duration of the walk, and reacts to `goal_reached`, `path_update`, `path_reset`, `death`, and `end` to clean up and report back to chat.

### `sign-trapdoor`

| Command | Description |
|---|---|
| `!s` | Finds a sign carrying the caller's username within 48 blocks, walks to the trapdoor directly beneath it, and toggles it twice |

Notes:

* Sign text is read from block NBT via [`signWorld.ts`](../src/utils/signWorld.ts) / [`signUtils.ts`](../src/utils/signUtils.ts), which understand both the legacy `Text1..4` format and the modern `front_text`/`back_text` format.
* The bot must get within 4.5 blocks (Minecraft's interaction reach) before it will activate the trapdoor; otherwise it reports back and gives up.
* Acquires `ctx.pathfinderLock` under the owner id `sign-trapdoor:s` for the walk, same as `navigation`.
* After toggling, it whispers the caller a confirmation (`/msg <player> ...`).

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
3. If the module drives `bot.pathfinder`, acquire/release `ctx.pathfinderLock` around it — see [architecture.md](architecture.md#coordinating-the-pathfinder-pathfinderlock).
4. For player-input validation, per-user rate limiting, or throttled chat replies, reuse the helpers in [src/utils/chat.ts](../src/utils/chat.ts) rather than rolling new ones.
5. In `catch` blocks, prefer [`reportError(ctx, scope, err)`](../src/utils/errors.ts) unless you need a specific player-facing message.
