import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatThrottler, createCommandCooldownManager } from '../../src/utils/chat'
import type { Bot } from 'mineflayer'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFakeBot() {
  return { chat: vi.fn() } as unknown as Bot
}

describe('createChatThrottler', () => {
  it('sends the first message for a key', () => {
    const bot = makeFakeBot()
    const chatThrottled = createChatThrottler(bot)

    chatThrottled('greeting', 'hi')

    expect(bot.chat).toHaveBeenCalledWith('hi')
  })

  it('suppresses a repeat message for the same key within the cooldown', () => {
    const bot = makeFakeBot()
    const chatThrottled = createChatThrottler(bot)

    chatThrottled('greeting', 'hi', 5000)
    chatThrottled('greeting', 'hi again', 5000)

    expect(bot.chat).toHaveBeenCalledTimes(1)
  })

  it('allows the message again once the cooldown has elapsed', () => {
    const bot = makeFakeBot()
    const chatThrottled = createChatThrottler(bot)

    chatThrottled('greeting', 'hi', 5000)
    vi.advanceTimersByTime(5001)
    chatThrottled('greeting', 'hi again', 5000)

    expect(bot.chat).toHaveBeenCalledTimes(2)
  })

  it('tracks cooldowns independently per key', () => {
    const bot = makeFakeBot()
    const chatThrottled = createChatThrottler(bot)

    chatThrottled('greeting', 'hi', 5000)
    chatThrottled('farewell', 'bye', 5000)

    expect(bot.chat).toHaveBeenCalledTimes(2)
  })
})

describe('createCommandCooldownManager', () => {
  it('allows the first command from a user', () => {
    const checkCommandCooldown = createCommandCooldownManager()

    expect(checkCommandCooldown('alice', 2000)).toBe(true)
  })

  it('blocks a second command from the same user within the cooldown', () => {
    const checkCommandCooldown = createCommandCooldownManager()

    checkCommandCooldown('alice', 2000)

    expect(checkCommandCooldown('alice', 2000)).toBe(false)
  })

  it('allows the command again once the cooldown has elapsed', () => {
    const checkCommandCooldown = createCommandCooldownManager()

    checkCommandCooldown('alice', 2000)
    vi.advanceTimersByTime(2001)

    expect(checkCommandCooldown('alice', 2000)).toBe(true)
  })

  it('tracks cooldowns independently per user', () => {
    const checkCommandCooldown = createCommandCooldownManager()

    checkCommandCooldown('alice', 2000)

    expect(checkCommandCooldown('bob', 2000)).toBe(true)
  })

  it('always allows commands with no username', () => {
    const checkCommandCooldown = createCommandCooldownManager()

    expect(checkCommandCooldown(undefined, 2000)).toBe(true)
    expect(checkCommandCooldown(undefined, 2000)).toBe(true)
  })
})
