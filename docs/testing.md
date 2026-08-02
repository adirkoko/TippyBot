# Testing

Tests use [Vitest](https://vitest.dev/), configured in [vitest.config.ts](../vitest.config.ts). Test files live under `tests/`, mirroring the `src/` layout (`tests/core/...`, `tests/utils/...`), and are excluded from the TypeScript build (`tsconfig.json` only includes `src/`).

```bash
npm test         # run once
npm run test:watch   # watch mode
```

## What's covered

* **Registries** (`tests/core/actions.test.ts`, `tests/core/commands.test.ts`) — registration/lookup case-insensitivity, aliasing, dispatch, unknown-name handling, and the central permission gate (denied/allowed, blacklist-specific message) for `ActionRegistry` and `CommandRegistry`.
* **Pathfinder lock** (`tests/core/pathfinder-lock.test.ts`) — acquire/release semantics, including that a second owner is refused while the lock is held and that a non-owner can't release it.
* **Cooldowns/throttling** (`tests/utils/chat.test.ts`) — `createChatThrottler` and `createCommandCooldownManager`, using fake timers to assert on cooldown boundaries.
* **Sign parsing** (`tests/utils/signUtils.test.ts`, `tests/utils/signWorld.test.ts`) — chat-component decoding, color-code stripping, both legacy (`Text1..4`) and modern (`front_text`/`back_text`) sign NBT formats, and graceful handling of malformed data.
* **Validation** (`tests/utils/validation.test.ts`) — player/group name rules and normalization.
* **Admin config** (`tests/config/admins.test.ts`) — `BOT_ADMINS` parsing: trimming, dedupe, normalization, and rejecting invalid usernames.
* **Permission store** (`tests/core/permission-store.test.ts`) — `JsonPermissionStore` load/save round-trip against a real temp-directory file, including that no `.tmp` file survives a successful save.
* **Permission service** (`tests/core/permission-service.test.ts`) — the bulk of the permission system: level hierarchy and inheritance, `canUseCommand` (including blacklist override and group-granted access), that Admins can't be targeted or persisted, Operator/Member grant-revoke, Operator-vs-Operator protection, and group create/rename/delete (including that deleting a group drops its command grants).

## What's not covered

There are no integration tests that spin up a real (or mocked) mineflayer `Bot`/pathfinder — the modules themselves (`chat-basic`, `navigation`, `sign-trapdoor`, `access`) are exercised manually against a live server rather than under test. This includes the `!access` command's chat-parsing layer specifically: its subcommand routing is thin glue over `PermissionService`, which is where the real logic (and its tests) live. The tests above focus on the framework pieces (`src/core`, `src/utils`, `src/config`) that are cheap to isolate and easy to get subtly wrong.

## Conventions

* [`tests/helpers/fakeLogger.ts`](../tests/helpers/fakeLogger.ts) provides a `vi.fn()`-based `ILogger` for asserting on log calls without a real console logger.
* [`tests/helpers/fakePermissions.ts`](../tests/helpers/fakePermissions.ts) provides `createAllowAllPermissions()` — an `IPermissionService` fake that allows everything, for tests (like dispatch tests in `commands.test.ts`) that aren't themselves about permission logic.
* `tests/core/permission-service.test.ts` uses an in-memory `IPermissionStore` fake defined in the file itself (not promoted to `tests/helpers/` since nothing else needs it yet); `tests/core/permission-store.test.ts` instead exercises the real `JsonPermissionStore` against a temp directory, since the whole point of that class is its filesystem behavior.
* Tests build a minimal `IBotContext` inline (`as unknown as IBotContext`) with only the fields a given unit actually touches — there's no shared "full fake bot" fixture yet. If you add tests that need a fuller fake `Bot`/`IBotContext`, consider promoting it into `tests/helpers/`.
