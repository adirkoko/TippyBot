// src/core/connection-errors.ts
// Classifies a connection failure as fatal (retrying can never succeed, so
// don't) vs. transient (worth the existing reconnect-with-backoff loop).
// Kept separate from bot.ts, like reconnect.ts, so it's unit-testable without
// a real mineflayer connection.

/**
 * Matches minecraft-protocol's own wording for a server whose protocol
 * version the installed mineflayer/minecraft-data can't decode at all (see
 * autoVersion.js and transforms/serializer.js) -- retrying only repeats the
 * same failed version negotiation, and for 'microsoft' auth, wastes a fresh
 * device code on every attempt.
 */
const FATAL_ERROR_PATTERNS: readonly RegExp[] = [/unsupported protocol version/i]

export function isFatalConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}
