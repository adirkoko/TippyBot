# Permissions

TippyBot is controlled entirely through in-game chat commands, so not every command should be reachable by every player. The permission system is a single central authority — `PermissionService`, exposed on every `ctx` as `ctx.permissions` — that every command is checked against before it runs.

## Levels

Four fixed levels, highest to lowest:

| Level | Who | Granted via |
|---|---|---|
| `Admin` | Full access to everything | `admins` in `bots.config.json` only |
| `Operator` | Manages Members, blacklist, and groups | `!access grant <player> operator` (Admin only) |
| `Member` | Regular trusted player | `!access grant <player> member` (Admin or Operator) |
| `User` | Anyone not blacklisted | Default — no action needed |

Higher levels automatically inherit everything a lower level can do (`Admin` → `Operator` → `Member` → `User`). A player on the blacklist cannot run **any** command, including `User`-level ones — blacklist is checked first and overrides everything else.

### Admins are config-only

Admins are read once from that instance's `admins` list in `bots.config.json` at startup (see [configuration.md](configuration.md)) and are never persisted, never mutable via chat, and cannot be targeted by any `!access` mutation (`grant`, `revoke`, member/blacklist add-remove, etc. all refuse a target that resolves to Admin). Changing who's an Admin means editing `bots.config.json` and restarting the bot — there is no in-game path to it, by design.

## Custom groups

Beyond the four levels, `Operator`s and `Admin`s can create named groups that grant access to specific commands without changing anyone's underlying level:

```
!access group create Builders
!access group command add Builders build
!access group member add Builders SomePlayer
```

`SomePlayer` can now run `!build` even if their level is `User`, without becoming a `Member` or `Operator`. Groups are purely additive — they never lower access, never change a player's reported level, and can never be used to reach a command that requires `Admin` (attempting to assign an Admin-level command to a group is rejected, for any actor, including Admins).

A player can belong to multiple groups. Deleting a group removes all its members and command assignments at once (nothing else references a group by name). Renaming updates the group in place; nothing else needs to change since group name is the only thing referenced externally.

## Access rule

For a given player and command:

1. If the player is blacklisted → denied, full stop.
2. If the player's level meets the command's `requiredLevel` → allowed.
3. Otherwise, if the command has been assigned to a group the player belongs to (and the command doesn't require `Admin`) → allowed.
4. Otherwise → denied.

This check happens in exactly one place: `CommandRegistry.handleChatMessage` (see [architecture.md](architecture.md)), calling `ctx.permissions.canUseCommand(username, command)` before `command.execute()` is ever invoked. Modules never implement their own permission checks — they only declare `requiredLevel` on each `ICommand`.

## `!access` commands

`!access` itself is reachable by anyone not blacklisted (so `!access me` always works); each subcommand enforces its own actor requirement internally through `PermissionService`, and replies with a clear message when denied. The full syntax, arguments, and examples for every `!access` subcommand are documented in **[commands.md](commands.md)** — this page covers the rules behind them, not the command list itself.

There is intentionally no command to add, remove, or list Admins.

### Operator vs. Operator, Operator vs. Admin

An `Operator` can manage `Member`s, the blacklist, and groups — but never another `Operator` or an `Admin`. Every mutation that takes a target player (`grant`/`revoke`, member add/remove, blacklist add/remove) enforces this: if the resolved target is `Admin`, it's always refused; if the target is `Operator` and the actor isn't `Admin`, it's refused too. This applies regardless of which command or code path triggers the mutation, since the check lives inside `PermissionService`, not in the `!access` module.

## Storage

Everything except Admins is dynamic and persisted to `data/<id>/permissions.json` (gitignored, like `auth_cache/`, and namespaced per instance — see [multi-instance.md](multi-instance.md)):

* Operators
* Members
* Blacklist
* Groups (members + assigned commands)

Storage is hidden behind `IPermissionStore` ([src/interfaces/permission-store.ts](../src/interfaces/permission-store.ts)); the only implementation today is `JsonPermissionStore` ([src/core/permission-store.ts](../src/core/permission-store.ts)), which writes to a temp file and renames it into place so a crash mid-write can never corrupt the file. Swapping to a database later means writing a new `IPermissionStore`, not touching `PermissionService` or any module.

## Extending: declaring a command's level

Every `ICommand` must set `requiredLevel`:

```ts
const buildCommand: ICommand = {
  name: 'build',
  requiredLevel: 'operator',
  async execute({ ctx, username }) { /* ... */ }
}
```

That's the entire integration point — `CommandRegistry` handles the rest. If you want the command to also be reachable via groups (the common case for anything below `Admin`), no extra work is needed: any `Operator`/`Admin` can assign it to a group with `!access group command add`.

## Logging

Every successful permission mutation (grant/revoke, member add/remove, blacklist add/remove, group create/delete/rename, group member/command add/remove) is logged with the actor and target. Denied command attempts are also logged (user, command, required level), but their chat replies stay generic — no permission file contents, group membership lists (beyond what `!access me`/`!access group show` intentionally expose to an authorized caller), or internal state are ever surfaced to unauthorized players.
