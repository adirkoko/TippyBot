# Tasks & Reliability

TippyBot can only do one long-running thing at a time — walk somewhere, work a trapdoor sequence, and so on. `TaskManager`, exposed on every `ctx` as `ctx.tasks`, tracks that single active operation: what it is, who asked for it, when it started, and how to stop it. It's also the thing that gets cleared out when the bot dies or drops off the server, so a bad connection can't leave the bot stuck "busy" forever.

## The model: one task, no queue

There's no queue. `ctx.tasks.start(...)` either claims the single slot and returns a handle, or returns `null` because something else is already running. A module that wants to run something long/cancelable:

```ts
const task = ctx.tasks.start({
  name: 'come',              // shown in !status
  requestedBy: username,
  timeoutMs: 30_000,
  onEnd: (reason) => {
    // 'timeout' | 'cancelled' | 'disconnected' | 'death'
    // called once if the task ends abnormally -- never after finish()
  }
})

if (!task) {
  ctx.bot.chat("I'm busy with something else right now.")
  return
}

// ... do the work ...

task.finish() // normal completion (success or failure) -- does NOT call onEnd
```

Because there's only ever one slot, no two long-running commands (`!come`, `!follow`, `!goto`, `!s`) can ever run at the same time — the second one is refused outright with a clear message, exactly like every other "busy" case.

`task.signal` is a standard `AbortSignal` that fires when the task ends abnormally. Anything awaiting a cancellable operation can pass it through — `waitForGoalReached(ctx, timeoutMs, task.signal)` in [src/utils/navigation.ts](../src/utils/navigation.ts) is the one place that does today, so `!cancel`/`!stop`/`!unfollow` can interrupt an in-progress walk immediately instead of waiting out its own internal timeout.

Reaching the goal doesn't always mean the task is *done* — `!follow` uses a dynamic `GoalFollow` that keeps re-pathing as the target moves, so `navigation` only calls `task.finish()` for that task's `goal_reached` when it's actually a one-shot walk (`!come`/`!goto`); for `!follow` it just logs and keeps going.

## `!status`, `!cancel`, and `!stop`

`!status`/`!cancel` are provided by the `bot-status` module ([src/modules/bot-status/index.ts](../src/modules/bot-status/index.ts)); full syntax in [commands.md](commands.md).

* `!status` — reports the active task's name, requester, and elapsed time, or "I'm not doing anything right now."
* `!cancel` — ends the active task. Allowed for the original requester, or for an `Operator`+; refused for anyone else with a clear message. This check lives inside `TaskManager.cancel`, not in the module.
* `!stop` — also in `bot-status`; calls the exact same `TaskManager.cancel`, but is gated at `Operator` from the command's own `requiredLevel` rather than being open to everyone with an inner requester-check. A deliberate "staff emergency stop" alongside the more permissive `!cancel`.

`TaskManager.cancel` actually takes an optional third argument, `minStaffLevel` (default `'operator'`), so a module can define a different "who besides the requester can cancel this" threshold for its own commands. `navigation`'s `!unfollow` uses this: it passes `'member'`, and only after confirming the active task is specifically a `follow` — see [modules.md](modules.md#navigation).

## Cleanup guarantees

A task's slot is always freed, one way or another:

* **Success or failure** — the owning module calls `task.finish()`.
* **Timeout** — `TaskManager` calls `onEnd('timeout')` itself once `timeoutMs` elapses; no module-level timer needed.
* **Cancellation** (`!cancel`, `!stop`, `!unfollow`) — `onEnd('cancelled')`, gated by whichever permission check the caller used.
* **Disconnect or death** — `bot.ts` calls `ctx.tasks.abort('disconnected' | 'death')` from the bot's `end`/`death` handlers, which ends whatever's active the same way. This is what guarantees a dropped connection never leaves the bot reporting itself as permanently "busy."

`finish()` and the abnormal-end path are both idempotent and mutually exclusive — whichever happens first wins, and nothing double-fires.

## Reconnection

Mineflayer doesn't reconnect on its own: a dropped connection just ends the `Bot` object. `startBot` ([src/core/bot.ts](../src/core/bot.ts)) wraps connecting in a `connect()` function that can be called again, and re-runs it on every `end` event:

1. `bot.on('end', reason)` logs the reason, calls `ctx.tasks.abort('disconnected')`, and schedules a reconnect.
2. `bot.on('kicked', reason)` and `bot.on('error', err)` are logged too, so the *cause* of a disconnect is visible even though the actual retry is always driven by `end`.
3. Reconnect delay follows capped exponential backoff — `computeReconnectDelay(attempt)` in [src/core/reconnect.ts](../src/core/reconnect.ts): 2s, 4s, 8s, ... up to a 60s ceiling. This is what keeps a persistently unreachable server from causing a tight retry loop.
4. A `reconnectTimer` guard means only one reconnect can ever be scheduled at a time.
5. On a successful `login`, the attempt counter resets to 0, so a brief blip doesn't leave the backoff artificially inflated for the next real outage.
6. Reconnecting creates a **new** `bot` (and a new `IBotContext` wrapping it) but reuses the same `actions`, `commands`, `pathfinderLock`, `permissions`, `tasks`, `cooldowns`, and `homes` instances — dynamic state (permissions, cooldown timers, saved homes, whatever task was running) survives across the reconnect; only the live connection is replaced. Modules' `init(ctx)` runs again each time so their registered commands close over the fresh `bot`.

None of this is unit-tested end-to-end — spinning up a real or mocked mineflayer connection is out of scope per [testing.md](testing.md). `computeReconnectDelay` is a pure function specifically so the backoff math itself can be (and is) tested in isolation.
