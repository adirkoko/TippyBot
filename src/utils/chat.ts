// src/utils/chat.ts
// Utility functions for chat message throttling and command cooldowns

import type { Bot } from 'mineflayer'

/**
 * Creates a chat throttler to limit how often messages can be sent.
 * @param bot The bot instance
 * @returns A function to send throttled chat messages
 */
export function createChatThrottler(bot: Bot) {
  const chatCooldowns: Record<string, number> = {}

  return function chatThrottled(
    key: string,
    msg: string,
    cooldownMs = 5000
  ) {
    const now = Date.now()
    const last = chatCooldowns[key] ?? 0
    if (now - last < cooldownMs) return
    chatCooldowns[key] = now
    bot.chat(msg)
  }
}

/**
 * Creates a command cooldown manager to limit how often users can issue commands.
 * @returns A function to check and update command cooldowns for users
 */
export function createCommandCooldownManager() {
  const lastCommandUse: Record<string, number> = {}

  return function checkCommandCooldown(
    username: string | undefined,
    cooldownMs: number
  ): boolean {
    if (!username) return true
    const now = Date.now()
    const last = lastCommandUse[username] ?? 0
    if (now - last < cooldownMs) {
      return false
    }
    lastCommandUse[username] = now
    return true
  }
}
