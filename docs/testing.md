# Testing

Tests use [Vitest](https://vitest.dev/), configured in [vitest.config.ts](../vitest.config.ts). Test files live under `tests/`, mirroring the `src/` layout (`tests/core/...`, `tests/utils/...`), and are excluded from the TypeScript build (`tsconfig.json` only includes `src/`).

```bash
npm test         # run once
npm run test:watch   # watch mode
```

## What's covered

* **Registries** (`tests/core/actions.test.ts`, `tests/core/commands.test.ts`) — registration/lookup case-insensitivity, aliasing, dispatch, unknown-name handling, and the full central pipeline (permission gate, param validation gate, cooldown gate) for `ActionRegistry` and `CommandRegistry`.
* **Pathfinder lock** (`tests/core/pathfinder-lock.test.ts`) — acquire/release semantics, including that a second owner is refused while the lock is held and that a non-owner can't release it.
* **Chat throttling** (`tests/utils/chat.test.ts`) — `createChatThrottler`, using fake timers to assert on cooldown boundaries.
* **Sign parsing** (`tests/utils/signUtils.test.ts`, `tests/utils/signWorld.test.ts`) — chat-component decoding, color-code stripping, both legacy (`Text1..4`) and modern (`front_text`/`back_text`) sign NBT formats, and graceful handling of malformed data.
* **Validation** (`tests/utils/validation.test.ts`) — player/group name rules and normalization.
* **Permission level ranking** (`tests/utils/permissionLevel.test.ts`) — the shared rank table used by both `PermissionService` and `TaskManager`.
* **Admin config** (`tests/config/admins.test.ts`) — `BOT_ADMINS` parsing: trimming, dedupe, normalization, and rejecting invalid usernames.
* **Permission store** (`tests/core/permission-store.test.ts`) — `JsonPermissionStore` load/save round-trip against a real temp-directory file, including that no `.tmp` file survives a successful save.
* **Permission service** (`tests/core/permission-service.test.ts`) — the bulk of the permission system: level hierarchy and inheritance, `canUseCommand` (including blacklist override and group-granted access), that Admins can't be targeted or persisted, Operator/Member grant-revoke, Operator-vs-Operator protection, and group create/rename/delete (including that deleting a group drops its command grants).
* **Task manager** (`tests/core/task-manager.test.ts`) — single-slot start/finish, timeout firing (and not firing after an early `finish()`), `AbortSignal` behavior, `cancel` permission rules (requester or the configurable `minStaffLevel`, defaulting to Operator+ for `!cancel`/`!stop`, passed as `'member'` for `!unfollow`), and `abort()` for disconnect/death.
* **Cooldown service** (`tests/core/cooldown-service.test.ts`) — per-player and global cooldowns independently and combined (longer of the two wins), using fake timers.
* **Param validator** (`tests/core/param-validator.test.ts`) — missing/extra argument counts, each param type (`playerName`, `groupName`, `integer` with `min`/`max`, `enum` with `values`), the `rest` param (consumes remaining args as one value, e.g. `!say`'s message, while still validating any fixed params before it), and that commands without a declared schema are left untouched.
* **Reconnect backoff** (`tests/core/reconnect.test.ts`) — `computeReconnectDelay`'s doubling and its cap.
* **JSON file store** (`tests/core/json-file-store.test.ts`) — the shared `readJsonFile`/`writeJsonFileAtomic` primitives against a real temp directory (fallback on missing file, atomic write, no leftover `.tmp`).
* **Home store / service** (`tests/core/home-store.test.ts`, `tests/core/home-service.test.ts`) — `JsonHomeStore` round-trip and malformed-record filtering against a real file, and `HomeService`'s per-player get/set/overwrite behavior against an in-memory store fake.
* **Dimension formatting** (`tests/utils/dimension.test.ts`) — the three known dimensions.
* **Item resolution** (`tests/utils/items.test.ts`) — `resolveItemName` (exact match wins, single substring match, case-insensitivity, no-match and ambiguous-match errors that list candidates instead of guessing) and `countItem`/`summarizeInventory` (stack summing, grouping, the "and N more" cap) against fake registry/item fixtures.

## What's not covered

There are no integration tests that spin up a real (or mocked) mineflayer `Bot`/pathfinder — the modules themselves (`chat-basic`, `navigation`, `sign-trapdoor`, `access`, `bot-status`, `bot-ops`, `homes`, `inventory`) are exercised manually against a live server rather than under test. This includes the `!access` command's chat-parsing layer specifically: its subcommand routing is thin glue over `PermissionService`, which is where the real logic (and its tests) live. It also includes the reconnect *orchestration* in `bot.ts` (event wiring, `mineflayer.createBot` calls) — only the pure backoff math (`computeReconnectDelay`) is unit-tested; see [tasks.md](tasks.md#reconnection). The tests above focus on the framework pieces (`src/core`, `src/utils`, `src/config`) that are cheap to isolate and easy to get subtly wrong.

## Conventions

* [`tests/helpers/fakeLogger.ts`](../tests/helpers/fakeLogger.ts) provides a `vi.fn()`-based `ILogger` for asserting on log calls without a real console logger.
* [`tests/helpers/fakePermissions.ts`](../tests/helpers/fakePermissions.ts) provides `createAllowAllPermissions()` — an `IPermissionService` fake that allows everything, for tests (like dispatch tests in `commands.test.ts`) that aren't themselves about permission logic.
* [`tests/helpers/fakeCooldowns.ts`](../tests/helpers/fakeCooldowns.ts) provides `createAllowAllCooldowns()`, the same idea for `ICooldownService`.
* `tests/core/permission-service.test.ts` and `tests/core/home-service.test.ts` each use an in-memory store fake defined in the file itself (not promoted to `tests/helpers/` since nothing else needs them yet); `tests/core/permission-store.test.ts` / `tests/core/home-store.test.ts` / `tests/core/json-file-store.test.ts` instead exercise the real filesystem against a temp directory, since the whole point of those classes is their filesystem behavior.
* Tests build a minimal `IBotContext` inline (`as unknown as IBotContext`) with only the fields a given unit actually touches — there's no shared "full fake bot" fixture yet. If you add tests that need a fuller fake `Bot`/`IBotContext`, consider promoting it into `tests/helpers/`.
