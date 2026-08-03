// src/core/reconnect.ts
// Pure backoff math for reconnect scheduling, kept separate from bot.ts so it's unit-testable
// without spinning up a real (or mocked) mineflayer connection.

export const RECONNECT_BASE_DELAY_MS = 2000
export const RECONNECT_MAX_DELAY_MS = 60_000

/**
 * Delay before reconnect attempt N (1-indexed): doubles each attempt, capped
 * at RECONNECT_MAX_DELAY_MS so a persistently unreachable server still gets
 * retried at a steady, rate-limited pace instead of a tight loop.
 */
export function computeReconnectDelay(attempt: number): number {
  const uncapped = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(uncapped, RECONNECT_MAX_DELAY_MS)
}
