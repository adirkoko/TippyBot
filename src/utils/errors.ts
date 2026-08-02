// src/utils/errors.ts
// Shared helper for the common "log the error, tell the player something broke" pattern

import type { IBotContext } from '../interfaces/bot-context'

/**
 * Logs an error under `scope` and sends a fallback chat message to the player.
 * @param ctx The bot context
 * @param scope A short label identifying where the error occurred (used in logs)
 * @param err The caught error
 * @param userMessage The chat message shown to players, defaults to a generic notice
 */
export function reportError(
  ctx: IBotContext,
  scope: string,
  err: unknown,
  userMessage = 'Something went wrong.'
): void {
  ctx.logger.error(`${scope} failed: ${String(err)}`, { err })
  ctx.bot.chat(userMessage)
}
