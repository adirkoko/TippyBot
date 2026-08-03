# Command Reference

This is the single authoritative list of every chat command registered in TippyBot's `CommandRegistry`. It does not include internal `IAction`s — those aren't reachable directly from chat; see [architecture.md](architecture.md#actions-vs-commands) for the distinction. (Note: `chat-basic` registers an internal `say` *action* used as a building block by other commands — not the same thing as the `!say` *command* documented below.)

**Whenever a command is added, renamed, or removed in `src/modules/**`, update this file in the same change.** No other document should carry a full command list — [modules.md](modules.md) and [permissions.md](permissions.md) link here instead of duplicating it.

Permission levels and how group access works are explained in full in [permissions.md](permissions.md); this page focuses on each command's own contract.

## Summary

| Command | Description | Minimum role | Module |
|---|---|---|---|
| `!ping` | Checks whether the bot is responsive | `User` | `chat-basic` |
| `!tippy` | Classic TippyBot one-liner | `User` | `chat-basic` |
| `!jump` | Makes the bot jump once | `User` | `navigation` |
| `!come [playerName]` | Walks to a player | `Member` | `navigation` |
| `!follow <player>` | Continuously follows a player | `Member` | `navigation` |
| `!unfollow` | Stops the active follow | `Member`* | `navigation` |
| `!goto <x> <y> <z>` | Walks to specific coordinates | `Member` | `navigation` |
| `!s` | Finds the caller's sign and toggles the trapdoor beneath it | `Member` | `sign-trapdoor` |
| `!where` | Shows the bot's current position and dimension | `User` | `bot-ops` |
| `!look <player>` | Makes the bot look at a player | `Member` | `bot-ops` |
| `!say <message>` | Makes the bot send a chat message | `Operator` | `bot-ops` |
| `!status` | Shows what the bot is currently doing and who requested it | `User` | `bot-status` |
| `!cancel` | Cancels the bot's active task | `User`* | `bot-status` |
| `!stop` | Immediately stops any active action or task | `Operator` | `bot-status` |
| `!sethome` | Saves the caller's current position as their home | `Member` | `homes` |
| `!home` | Walks to the caller's saved home | `Member` | `homes` |
| `!access me` | Shows your own level and group memberships | `User` | `access` |
| `!access player <player>` | Shows another player's level | `User` | `access` |
| `!access grant <player> operator` | Grants Operator | `Admin` | `access` |
| `!access grant <player> member` | Grants Member | `Operator` | `access` |
| `!access revoke <player> operator` | Revokes Operator | `Admin` | `access` |
| `!access revoke <player> member` | Revokes Member | `Operator` | `access` |
| `!access blacklist add <player>` | Blacklists a player | `Operator` | `access` |
| `!access blacklist remove <player>` | Removes a player from the blacklist | `Operator` | `access` |
| `!access blacklist list` | Lists blacklisted players | `Operator` | `access` |
| `!access group create <group>` | Creates a group | `Operator` | `access` |
| `!access group delete <group>` | Deletes a group | `Operator` | `access` |
| `!access group rename <oldName> <newName>` | Renames a group | `Operator` | `access` |
| `!access group list` | Lists all groups | `Operator` | `access` |
| `!access group show <group>` | Shows a group's members and commands | `Operator` | `access` |
| `!access group member add <group> <player>` | Adds a player to a group | `Operator` | `access` |
| `!access group member remove <group> <player>` | Removes a player from a group | `Operator` | `access` |
| `!access group command add <group> <command>` | Assigns a command to a group | `Operator` | `access` |
| `!access group command remove <group> <command>` | Unassigns a command from a group | `Operator` | `access` |

\* `!cancel` and `!unfollow` are registered at `User` level so anyone not blacklisted can reach them, but each has its own finer-grained check inside `TaskManager.cancel`: `!cancel` requires being the task's requester or `Operator`+; `!unfollow` requires being the requester or `Member`+ (and only acts if the active task is specifically a `follow`). See [tasks.md](tasks.md).

---

## Basic Chat (`chat-basic`)

#### `!ping`

* **Syntax:** `!ping`
* **Description:** Simple liveness check.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — it's already open to every non-blacklisted player.
* **Arguments:** None.
* **Example:** `!ping` → `Pong, Steve!`
* **Limits:** None.
* **Notes:** None.
* **Module:** `chat-basic`

#### `!tippy`

* **Syntax:** `!tippy`
* **Description:** Replies with the bot's signature line.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — same as `!ping`.
* **Arguments:** None.
* **Example:** `!tippy` → `Steve, Don't even ask...`
* **Limits:** None.
* **Notes:** None.
* **Module:** `chat-basic`

## Navigation (`navigation`)

#### `!jump`

* **Syntax:** `!jump`
* **Description:** Makes the bot jump once in place.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — same as `!ping`.
* **Arguments:** None.
* **Example:** `!jump`
* **Limits:** 2s cooldown per player (via `CooldownService`; on cooldown, replies "Please wait Ns before using this again.").
* **Notes:** Failures are reported via a throttled chat message rather than every attempt, to avoid spam.
* **Module:** `navigation`

#### `!come [playerName]`

* **Syntax:** `!come [playerName]`
* **Description:** Walks to the given player, or to the caller if no name is given.
* **Minimum role:** `Member`
* **Group-assignable:** Yes — a group can grant specific `User`s access without making them Members.
* **Arguments:** `playerName` (optional) — must match `^[A-Za-z0-9_]{1,16}$`; defaults to the caller.
* **Example:** `!come` (bot walks to you) / `!come Alice` (bot walks to Alice)
* **Limits:** 2s cooldown per player · refuses targets over 256 blocks away · 30s task timeout (see [tasks.md](tasks.md)).
* **Notes:** Only one long-running command (`!come`, `!follow`, `!goto`, or `!s`) can run at a time — if the bot is already busy, it replies accordingly instead of queuing or interrupting. Cancellable via `!cancel`; also stops cleanly on disconnect or death.
* **Module:** `navigation`

#### `!follow <player>`

* **Syntax:** `!follow <player>`
* **Description:** Continuously walks to stay near the given player, re-pathing as they move.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** `player` (required).
* **Example:** `!follow Alice` → `Following Alice.`
* **Limits:** 2s cooldown per player · stays within ~2 blocks · 10-minute safety-net task timeout (expected to normally end via `!unfollow`/`!stop`, not the timeout — see [tasks.md](tasks.md)).
* **Notes:** Only one long-running command can run at a time. Ends automatically if the followed player leaves the server, if the bot dies or disconnects, or via `!unfollow`/`!cancel`/`!stop`. Reaching the target doesn't end the follow — it keeps going until explicitly stopped.
* **Module:** `navigation`

#### `!unfollow`

* **Syntax:** `!unfollow`
* **Description:** Stops the active `!follow`, if any.
* **Minimum role:** `User` (see footnote above the summary table)
* **Group-assignable:** N/A — effective minimum is enforced inside `TaskManager`, not via the command's own level.
* **Arguments:** None — always targets the active task.
* **Example:** `!unfollow` → `Cancelled "follow".`
* **Limits:** None.
* **Notes:** Only acts if the currently active task is specifically a `follow` — replies "I'm not following anyone." otherwise, even if some other task is active. Allowed for whoever requested the follow, or any `Member`+.
* **Module:** `navigation`

#### `!goto <x> <y> <z>`

* **Syntax:** `!goto <x> <y> <z>`
* **Description:** Walks to the exact given coordinates.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** `x`, `y`, `z` (all required integers). `x`/`z` bounded to ±3,000,000; `y` bounded to Minecraft's build limits (-64 to 320).
* **Example:** `!goto 100 64 -200` → `Heading to (100, 64, -200).`
* **Limits:** 2s cooldown per player · refuses destinations over 256 blocks from the bot's current position · 30s task timeout.
* **Notes:** Only one long-running command can run at a time. Cancellable via `!cancel`; also stops cleanly on disconnect or death.
* **Module:** `navigation`

## Sign & Trapdoor (`sign-trapdoor`)

#### `!s`

* **Syntax:** `!s`
* **Description:** Searches for a sign carrying the caller's own username within 48 blocks, walks to the trapdoor directly beneath it, and toggles it twice.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** None — the caller's username is used as the search label automatically.
* **Example:** `!s`
* **Limits:** No cooldown · 48-block sign search radius · 15s walk timeout · 20s overall task timeout (see [tasks.md](tasks.md)) · must end within 4.5 blocks (Minecraft's interaction reach) to activate the trapdoor.
* **Notes:** Requires a trapdoor directly one block beneath the matching sign; if none is found, or the bot can't get close enough, it reports back instead of retrying. On success it also sends the caller a private `/msg` confirmation. Only one long-running command (`!come`, `!follow`, `!goto`, or `!s`) can run at a time; cancellable via `!cancel`.
* **Module:** `sign-trapdoor`

## Basic Ops (`bot-ops`)

#### `!where`

* **Syntax:** `!where`
* **Description:** Reports the bot's current coordinates and dimension.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — same as `!ping`.
* **Arguments:** None.
* **Example:** `!where` → `I'm at (120, 65, -340) in the overworld.`
* **Limits:** None.
* **Notes:** None.
* **Module:** `bot-ops`

#### `!look <player>`

* **Syntax:** `!look <player>`
* **Description:** Turns the bot's head to face the given player.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** `player` (required).
* **Example:** `!look Alice` → `Looking at Alice.`
* **Limits:** 1s cooldown per player.
* **Notes:** Requires the player to be visible to the bot; replies "Can't see that player." otherwise. Instantaneous — not a task, and doesn't touch `ctx.pathfinderLock`.
* **Module:** `bot-ops`

#### `!say <message>`

* **Syntax:** `!say <message>`
* **Description:** Sends `message` verbatim to server chat as the bot.
* **Minimum role:** `Operator`
* **Group-assignable:** No in practice — `requiredLevel: 'operator'` on this command means it can never be assigned to a group (see [permissions.md](permissions.md)).
* **Arguments:** `message` (required) — everything after `!say`, joined back into one string.
* **Example:** `!say Hello, world!` → bot sends `Hello, world!` to chat.
* **Limits:** 1s **global** cooldown (shared across all callers, not per-player) · max 256 characters (Minecraft's own chat limit).
* **Notes:** Refuses an empty/whitespace-only message, a message over the length limit, a message containing control characters (including newlines/tabs), or a message starting with `/` — the last guard specifically prevents `!say` from being used to smuggle a server command through the bot's chat.
* **Module:** `bot-ops`

## Bot Status (`bot-status`)

#### `!status`

* **Syntax:** `!status`
* **Description:** Shows what the bot is currently doing and who requested it.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — it's already open to every non-blacklisted player.
* **Arguments:** None.
* **Example:** `!status` → `Currently running "come" for Alice (started 4s ago).` or `I'm not doing anything right now.`
* **Limits:** None.
* **Notes:** Reflects `ctx.tasks`; see [tasks.md](tasks.md).
* **Module:** `bot-status`

#### `!cancel`

* **Syntax:** `!cancel`
* **Description:** Cancels the bot's currently active task, if any.
* **Minimum role:** `User`
* **Group-assignable:** Technically yes, but pointless — the underlying permission check (requester or Operator+) happens inside `TaskManager` regardless of how `!cancel` itself was reached.
* **Arguments:** None — always targets whatever's active.
* **Example:** `!cancel` → `Cancelled "come".`
* **Limits:** None.
* **Notes:** Allowed for the player who requested the active task, or for an `Operator`+; refused for anyone else with a clear message. See [tasks.md](tasks.md).
* **Module:** `bot-status`

#### `!stop`

* **Syntax:** `!stop`
* **Description:** Immediately stops any action or task the bot is currently doing, regardless of who requested it.
* **Minimum role:** `Operator`
* **Group-assignable:** No in practice — `requiredLevel: 'operator'` means it can never be assigned to a group.
* **Arguments:** None — always targets whatever's active.
* **Example:** `!stop` → `Cancelled "follow".`
* **Limits:** None.
* **Notes:** Functionally the same underlying `TaskManager.cancel` call as `!cancel`, just gated at `Operator` from the outset rather than allowing the original requester too — a deliberate "emergency stop" for staff. Ends the task via its real `AbortSignal`-based cancellation path (see [tasks.md](tasks.md)), so an in-progress walk stops immediately rather than winding down on its own timeout.
* **Module:** `bot-status`

## Homes (`homes`)

#### `!sethome`

* **Syntax:** `!sethome`
* **Description:** Saves the caller's current position (and dimension) as their home.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** None — uses the caller's current position.
* **Example:** `!sethome` → `Home set at (120, 65, -340) in the overworld.`
* **Limits:** None.
* **Notes:** One home per player; setting a new one overwrites the old. Stored via `ctx.homes` (`IHomeService`/`JsonHomeStore`), not inside the module — see [architecture.md](architecture.md#homes).
* **Module:** `homes`

#### `!home`

* **Syntax:** `!home`
* **Description:** Walks to the caller's saved home.
* **Minimum role:** `Member`
* **Group-assignable:** Yes.
* **Arguments:** None.
* **Example:** `!home` → reuses `!goto`'s walk, ending with `I've arrived!`
* **Limits:** Same as `!goto` (256-block range, 30s task timeout), since it's implemented as a `!goto` to the saved coordinates.
* **Notes:** Replies "You don't have a home set. Use !sethome first." if none is saved. Refuses to walk if the bot is currently in a different dimension than the one the home was saved in, rather than silently attempting (and failing) to cross dimensions.
* **Module:** `homes`

## Access Management (`access`)

All `!access` subcommands are dispatched through a single registered command (`access`, `User`-level) — see the note at the end of this section for what that means for group access.

#### `!access me`

* **Syntax:** `!access me`
* **Description:** Shows your own permission level and any groups you belong to.
* **Minimum role:** `User`
* **Group-assignable:** N/A (see note below).
* **Arguments:** None.
* **Example:** `!access me` → `You are: Member. Groups: Builders.`
* **Limits:** None.
* **Notes:** Never reveals other players' data.
* **Module:** `access`

#### `!access player <player>`

* **Syntax:** `!access player <player>`
* **Description:** Shows another player's permission level.
* **Minimum role:** `User`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `player` (required).
* **Example:** `!access player Alice` → `Alice is: Operator.`
* **Limits:** None.
* **Notes:** Only shows the level, not group membership or blacklist status.
* **Module:** `access`

#### `!access grant <player> operator` / `!access revoke <player> operator`

* **Syntax:** `!access grant <player> operator`, `!access revoke <player> operator`
* **Description:** Grants or revokes Operator.
* **Minimum role:** `Admin`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `player` (required).
* **Example:** `!access grant Alice operator`
* **Limits:** None.
* **Notes:** Refuses if the target resolves to Admin. Admin is the only level that can never be granted or revoked through a command.
* **Module:** `access`

#### `!access grant <player> member` / `!access revoke <player> member`

* **Syntax:** `!access grant <player> member`, `!access revoke <player> member`
* **Description:** Grants or revokes Member.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `player` (required).
* **Example:** `!access grant Alice member`
* **Limits:** None.
* **Notes:** An Operator can't target another Operator or an Admin this way — only an Admin can.
* **Module:** `access`

#### `!access blacklist add <player>` / `!access blacklist remove <player>`

* **Syntax:** `!access blacklist add <player>`, `!access blacklist remove <player>`
* **Description:** Adds or removes a player from the blacklist, blocking (or restoring) access to every command regardless of level or group.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `player` (required).
* **Example:** `!access blacklist add Griefer123`
* **Limits:** None.
* **Notes:** A config-defined Admin can never be blacklisted, by anyone, under any circumstance.
* **Module:** `access`

#### `!access blacklist list`

* **Syntax:** `!access blacklist list`
* **Description:** Lists currently blacklisted players.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** None.
* **Example:** `!access blacklist list` → `Blacklist: griefer123, spammer99`
* **Limits:** None.
* **Notes:** None.
* **Module:** `access`

## Groups (`access`)

#### `!access group create <group>` / `!access group delete <group>`

* **Syntax:** `!access group create <group>`, `!access group delete <group>`
* **Description:** Creates or permanently deletes a permission group.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `group` (required) — letters, digits, `_`/`-`, up to 32 characters.
* **Example:** `!access group create Builders`
* **Limits:** Group names must be unique (case-insensitive).
* **Notes:** Deleting a group removes all of its members and command assignments in one step — nothing else references it by name.
* **Module:** `access`

#### `!access group rename <oldName> <newName>`

* **Syntax:** `!access group rename <oldName> <newName>`
* **Description:** Renames an existing group.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `oldName`, `newName` (both required).
* **Example:** `!access group rename Builders Architects`
* **Limits:** The new name must not already be in use.
* **Notes:** Members and command assignments carry over unchanged.
* **Module:** `access`

#### `!access group list` / `!access group show <group>`

* **Syntax:** `!access group list`, `!access group show <group>`
* **Description:** Lists all groups, or shows one group's members and assigned commands.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `group` (required for `show` only).
* **Example:** `!access group show Builders` → `"Builders" - members: alice, bob; commands: build`
* **Limits:** None.
* **Notes:** None.
* **Module:** `access`

#### `!access group member add <group> <player>` / `!access group member remove <group> <player>`

* **Syntax:** `!access group member add <group> <player>`, `!access group member remove <group> <player>`
* **Description:** Adds or removes a player from a group.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `group`, `player` (both required).
* **Example:** `!access group member add Builders Alice`
* **Limits:** None.
* **Notes:** Group membership never changes a player's underlying level — it only adds access to that group's assigned commands.
* **Module:** `access`

#### `!access group command add <group> <command>` / `!access group command remove <group> <command>`

* **Syntax:** `!access group command add <group> <command>`, `!access group command remove <group> <command>`
* **Description:** Assigns or unassigns a command to/from a group.
* **Minimum role:** `Operator`
* **Group-assignable:** N/A (see note below).
* **Arguments:** `group`, `command` (both required). `command` must already exist in the Command Registry.
* **Example:** `!access group command add Builders come`
* **Limits:** A command that requires `Admin` can never be assigned to any group, for any actor — this is enforced unconditionally, not just for Operators.
* **Notes:** None.
* **Module:** `access`

### Note on `!access` and groups

`!access` is registered as one single `User`-level command; its subcommands aren't separate `Command Registry` entries, so they can't be individually targeted by `!access group command add`. Adding `access` itself to a group would be a no-op in practice: it's already open to everyone, and every subcommand re-checks the actor's real level inside `PermissionService` regardless of how the outer `access` command was reached — so group membership can never be used to unlock `grant`, `revoke`, `blacklist`, or `group` management. See [permissions.md](permissions.md#access-rule) for the full access rule.
