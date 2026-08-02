# Testing

Tests use [Vitest](https://vitest.dev/), configured in [vitest.config.ts](../vitest.config.ts). Test files live under `tests/`, mirroring the `src/` layout (`tests/core/...`, `tests/utils/...`), and are excluded from the TypeScript build (`tsconfig.json` only includes `src/`).

```bash
npm test         # run once
npm run test:watch   # watch mode
```

## What's covered

* **Registries** (`tests/core/actions.test.ts`, `tests/core/commands.test.ts`) — registration/lookup case-insensitivity, aliasing, dispatch, and unknown-name handling for `ActionRegistry` and `CommandRegistry`.
* **Pathfinder lock** (`tests/core/pathfinder-lock.test.ts`) — acquire/release semantics, including that a second owner is refused while the lock is held and that a non-owner can't release it.
* **Cooldowns/throttling** (`tests/utils/chat.test.ts`) — `createChatThrottler` and `createCommandCooldownManager`, using fake timers to assert on cooldown boundaries.
* **Sign parsing** (`tests/utils/signUtils.test.ts`, `tests/utils/signWorld.test.ts`) — chat-component decoding, color-code stripping, both legacy (`Text1..4`) and modern (`front_text`/`back_text`) sign NBT formats, and graceful handling of malformed data.

## What's not covered

There are no integration tests that spin up a real (or mocked) mineflayer `Bot`/pathfinder — the modules themselves (`chat-basic`, `navigation`, `sign-trapdoor`) are exercised manually against a live server rather than under test. The tests above focus on the framework pieces (`src/core`, `src/utils`) that are cheap to isolate and easy to get subtly wrong.

## Conventions

* [`tests/helpers/fakeLogger.ts`](../tests/helpers/fakeLogger.ts) provides a `vi.fn()`-based `ILogger` for asserting on log calls without a real console logger.
* Tests build a minimal `IBotContext` inline (`as unknown as IBotContext`) with only the fields a given unit actually touches — there's no shared "full fake bot" fixture yet. If you add tests that need a fuller fake `Bot`/`IBotContext`, consider promoting it into `tests/helpers/`.
