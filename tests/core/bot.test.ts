import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startBot } from '../../src/core/bot'
import type { IBotConfig } from '../../src/interfaces/config'
import type mineflayer from 'mineflayer'

/** Binds an ephemeral port and immediately frees it, so connecting to it is a fast, deterministic ECONNREFUSED. */
async function closedLocalPort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Expected an AddressInfo from an ephemeral TCP listener'))
        return
      }
      resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function fakeConfig(id: string, port: number): IBotConfig {
  return {
    id,
    host: '127.0.0.1',
    port,
    username: `${id}Bot`,
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true
  }
}

describe('BotInstance lifecycle (startBot handle)', () => {
  it('starts disconnected and never auto-connects', () => {
    const handle = startBot(fakeConfig('lifecycle-idle', 1))

    expect(handle.getStatus()).toBe('disconnected')
    expect(handle.getSnapshot().status).toBe('disconnected')
  })

  it('disconnect() rejects when the instance was never connected', async () => {
    const handle = startBot(fakeConfig('lifecycle-never-connected', 1))

    await expect(handle.disconnect()).rejects.toThrow(/not currently connected/)
  })

  it('connects toward an unreachable port, then disconnect() cleanly returns it to disconnected without auto-reconnecting', async () => {
    const port = await closedLocalPort()
    const handle = startBot(fakeConfig('lifecycle-roundtrip', port))

    await handle.connect()
    // loadModules() resolves before the TCP attempt necessarily settles, so
    // the status right after connect() may still be 'connecting' or may
    // already have flipped to 'reconnecting' -- both are valid, neither is racy.
    expect(['connecting', 'reconnecting']).toContain(handle.getStatus())

    await handle.disconnect()
    expect(handle.getStatus()).toBe('disconnected')

    // No auto-reconnect should fire after a requested disconnect.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(handle.getStatus()).toBe('disconnected')
  }, 10_000)

  it('disconnect() rejects when already disconnected', async () => {
    const port = await closedLocalPort()
    const handle = startBot(fakeConfig('lifecycle-double-disconnect', port))

    await handle.connect()
    await handle.disconnect()

    await expect(handle.disconnect()).rejects.toThrow(/not currently connected/)
  }, 10_000)

  it('can connect() again after being disconnected', async () => {
    const port = await closedLocalPort()
    const handle = startBot(fakeConfig('lifecycle-reconnect-after-stop', port))

    await handle.connect()
    await handle.disconnect()
    expect(handle.getStatus()).toBe('disconnected')

    await handle.connect()
    expect(['connecting', 'reconnecting']).toContain(handle.getStatus())

    await handle.disconnect()
    expect(handle.getStatus()).toBe('disconnected')
  }, 10_000)

  it('connect() rejects a second call while a connection is already in flight', async () => {
    const port = await closedLocalPort()
    const handle = startBot(fakeConfig('lifecycle-overlap', port))

    const first = handle.connect()
    const second = handle.connect()

    await expect(second).rejects.toThrow(/already/)
    await first
    await handle.disconnect()
  }, 10_000)
})

/** A minimal stand-in for mineflayer's Bot: just enough surface for runInstance's setup, with 'end' timing fully controlled by the test instead of a real socket. */
type FakeBot = EventEmitter & { username: string; loadPlugin: () => void; end: ReturnType<typeof vi.fn> }

function fakeMineflayerBotFactory(): {
  createBot: typeof mineflayer.createBot
  created: FakeBot[]
} {
  const created: FakeBot[] = []
  const createBot = (() => {
    const bot = new EventEmitter() as FakeBot
    bot.username = 'fakebot'
    bot.loadPlugin = () => {}
    // Real teardown timing is driven entirely by the test emitting 'end' --
    // calling end() here must not itself resolve anything.
    bot.end = vi.fn()
    created.push(bot)
    return bot
  }) as unknown as typeof mineflayer.createBot
  return { createBot, created }
}

describe('BotInstance lifecycle races (fake mineflayer bot)', () => {
  it('ignores a late "end" from a bot abandoned by a timed-out disconnect(), instead of corrupting the newer connection', async () => {
    vi.useFakeTimers()
    try {
      const { createBot, created } = fakeMineflayerBotFactory()
      const handle = startBot(fakeConfig('lifecycle-stale-end', 1), undefined, createBot)

      await handle.connect()
      expect(handle.getStatus()).toBe('connecting')
      const botA = created[0]

      // disconnect() calls botA.end() but the test never emits botA's 'end' --
      // simulating real teardown that's merely slow, not lost -- so this only
      // resolves once DISCONNECT_TIMEOUT_MS forces the fallback.
      const disconnecting = handle.disconnect()
      await vi.advanceTimersByTimeAsync(5_000)
      await disconnecting
      expect(handle.getStatus()).toBe('disconnected')
      expect(botA.end).toHaveBeenCalledTimes(1)

      // A new connection starts before botA's real 'end' ever arrives.
      await handle.connect()
      expect(handle.getStatus()).toBe('connecting')
      const botB = created[1]
      expect(botB).not.toBe(botA)

      // botA's real teardown finally completes, long after disconnect() gave up on it.
      botA.emit('end', 'late teardown')

      // The stale event must not touch the new connection's status...
      expect(handle.getStatus()).toBe('connecting')

      // ...and instance.currentBot must still be botB, not wiped out -- proven
      // by disconnect() actually driving botB.end() rather than short-circuiting.
      const disconnectingB = handle.disconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(botB.end).toHaveBeenCalledTimes(1)
      botB.emit('end', 'test cleanup')
      await disconnectingB
      expect(handle.getStatus()).toBe('disconnected')
    } finally {
      vi.useRealTimers()
    }
  })
})
