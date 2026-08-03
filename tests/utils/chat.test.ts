import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatThrottler } from '../../src/utils/chat'
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
