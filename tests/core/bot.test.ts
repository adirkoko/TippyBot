import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startBot } from '../../src/core/bot'
import type { IBotConfig } from '../../src/interfaces/config'
import type mineflayer from 'mineflayer'

/** Lets every already-queued microtask (incl. the enqueue() chain's .then() hops) run before proceeding. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

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

function fakeConfig(id: string, port: number, overrides: Partial<IBotConfig> = {}): IBotConfig {
  return {
    id,
    host: '127.0.0.1',
    port,
    username: `${id}Bot`,
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true,
    msaCacheKey: `${id}Bot`,
    ...overrides
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

  it('stops on a fatal connection error (unsupported protocol version) instead of scheduling a reconnect', async () => {
    vi.useFakeTimers()
    try {
      const { createBot, created } = fakeMineflayerBotFactory()
      const handle = startBot(fakeConfig('lifecycle-fatal-error', 1), undefined, createBot)

      await handle.connect()
      const bot = created[0]

      bot.emit('error', new Error("Unsupported protocol version '776'; try updating your packages with 'npm update'"))
      bot.emit('end', 'socket closed')

      expect(handle.getStatus()).toBe('errored')
      expect(handle.getLastError()?.message).toMatch(/Unsupported protocol version/)

      // No reconnect was scheduled: waiting well past the backoff cap never
      // creates a second bot.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(created).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reconnects with backoff on a transient error, unaffected by fatal-error handling', async () => {
    vi.useFakeTimers()
    try {
      const { createBot, created } = fakeMineflayerBotFactory()
      const handle = startBot(fakeConfig('lifecycle-transient-error', 1), undefined, createBot)

      await handle.connect()
      const bot = created[0]

      bot.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'))
      bot.emit('end', 'socket closed')

      expect(handle.getStatus()).toBe('reconnecting')

      await vi.advanceTimersByTimeAsync(2_000) // RECONNECT_BASE_DELAY_MS
      expect(created).toHaveLength(2)
      // No further cleanup: the reconnected fake bot never emits 'end' on its
      // own, and disconnect() would hang waiting on real DISCONNECT_TIMEOUT_MS
      // fake-timer ticks this test has no further reason to drive. Switching
      // back to real timers below is enough to let the test process exit.
    } finally {
      vi.useRealTimers()
    }
  })
})

/** Deferred, test-controlled stand-in for authenticateMicrosoft() -- resolves/rejects only when the test says so, never on its own. */
function fakeMicrosoftAuthFactory(): {
  authenticateMicrosoft: (
    cacheUsername: string,
    profilesFolder: string,
    onCode: (code: { userCode: string }) => void
  ) => Promise<{ profileName: string }>
  calls: Array<{ cacheUsername: string; profilesFolder: string }>
  pending: Array<{ resolve: (result: { profileName: string }) => void; reject: (err: Error) => void }>
} {
  const calls: Array<{ cacheUsername: string; profilesFolder: string }> = []
  const pending: Array<{ resolve: (result: { profileName: string }) => void; reject: (err: Error) => void }> = []

  const authenticateMicrosoft = (cacheUsername: string, profilesFolder: string): Promise<{ profileName: string }> => {
    calls.push({ cacheUsername, profilesFolder })
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  }

  return { authenticateMicrosoft, calls, pending }
}

function microsoftConfig(id: string): IBotConfig {
  return fakeConfig(id, 1, { auth: 'microsoft', msaCacheKey: `${id}-cache-key` })
}

describe('BotInstance Microsoft authentication', () => {
  it('rejects for offline auth', async () => {
    const handle = startBot(fakeConfig('auth-offline', 1))
    await expect(handle.authenticate()).rejects.toThrow(/does not use Microsoft authentication/)
  })

  it('reports authStatus "unknown" at startup for a microsoft-auth instance, undefined for offline', () => {
    expect(startBot(microsoftConfig('auth-initial')).getSnapshot().authStatus).toBe('unknown')
    expect(startBot(fakeConfig('auth-initial-offline', 1)).getSnapshot().authStatus).toBeUndefined()
  })

  it('succeeds and exposes the resolved profile name, using msaCacheKey (not username) as the cache identity', async () => {
    const { authenticateMicrosoft, pending, calls } = fakeMicrosoftAuthFactory()
    const handle = startBot(microsoftConfig('auth-success'), undefined, undefined, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    expect(handle.getSnapshot().authStatus).toBe('authenticating')
    await flushMicrotasks()
    expect(calls).toEqual([{ cacheUsername: 'auth-success-cache-key', profilesFolder: './auth_cache/auth-success' }])

    pending[0].resolve({ profileName: 'RealMcName' })
    await authenticating

    const snapshot = handle.getSnapshot()
    expect(snapshot.authStatus).toBe('authenticated')
    expect(snapshot.minecraftProfileName).toBe('RealMcName')
  })

  it('sets auth_error and rethrows on failure', async () => {
    const { authenticateMicrosoft, pending } = fakeMicrosoftAuthFactory()
    const handle = startBot(microsoftConfig('auth-fail'), undefined, undefined, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    await flushMicrotasks()
    pending[0].reject(new Error('boom'))

    await expect(authenticating).rejects.toThrow('boom')
    const snapshot = handle.getSnapshot()
    expect(snapshot.authStatus).toBe('auth_error')
    expect(snapshot.authError?.message).toBe('boom')
  })

  it('rejects a second concurrent authenticate() immediately, without requesting a second device code', async () => {
    const { authenticateMicrosoft, pending, calls } = fakeMicrosoftAuthFactory()
    const handle = startBot(microsoftConfig('auth-double'), undefined, undefined, authenticateMicrosoft)

    const first = handle.authenticate()
    await expect(handle.authenticate()).rejects.toThrow(/already authenticating/)
    await flushMicrotasks()
    expect(calls).toHaveLength(1)

    pending[0].resolve({ profileName: 'X' })
    await first
  })

  it('rejects connect() while authenticating, and rejects authenticate() while connected', async () => {
    const { authenticateMicrosoft, pending } = fakeMicrosoftAuthFactory()
    const { createBot, created } = fakeMineflayerBotFactory()
    const handle = startBot(microsoftConfig('auth-vs-connect'), undefined, createBot, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    await expect(handle.connect()).rejects.toThrow(/authenticating/)
    await flushMicrotasks()

    pending[0].resolve({ profileName: 'X' })
    await authenticating

    await handle.connect()
    await expect(handle.authenticate()).rejects.toThrow(/disconnect first/)

    const disconnecting = handle.disconnect()
    await flushMicrotasks()
    created[0].emit('end', 'test cleanup')
    await disconnecting
  })

  it('cancelAuthentication() stops waiting immediately and ignores a later-arriving result', async () => {
    const { authenticateMicrosoft, pending, calls } = fakeMicrosoftAuthFactory()
    const handle = startBot(microsoftConfig('auth-cancel'), undefined, undefined, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    await flushMicrotasks() // let doAuthenticate() actually start waiting on the device code
    expect(calls).toHaveLength(1)

    await handle.cancelAuthentication()
    expect(handle.getSnapshot().authStatus).toBe('unauthenticated')

    // The underlying "network" call still resolves later -- must be ignored.
    pending[0].resolve({ profileName: 'ShouldBeIgnored' })
    await authenticating

    const snapshot = handle.getSnapshot()
    expect(snapshot.authStatus).toBe('unauthenticated')
    expect(snapshot.minecraftProfileName).toBeUndefined()
  })

  it('cancelAuthentication() called before doAuthenticate() even starts skips the device-code request entirely', async () => {
    const { authenticateMicrosoft, calls } = fakeMicrosoftAuthFactory()
    const handle = startBot(microsoftConfig('auth-cancel-early'), undefined, undefined, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    await handle.cancelAuthentication() // wins the race against doAuthenticate()'s queued turn
    await authenticating
    await flushMicrotasks()

    expect(calls).toHaveLength(0)
  })

  it('cancelAuthentication() rejects when nothing is authenticating', async () => {
    const handle = startBot(microsoftConfig('auth-cancel-noop'))
    await expect(handle.cancelAuthentication()).rejects.toThrow(/not currently authenticating/)
  })

  it('a successful connect() also promotes authStatus to authenticated', async () => {
    const { createBot, created } = fakeMineflayerBotFactory()
    const handle = startBot(microsoftConfig('auth-via-connect'), undefined, createBot)

    await handle.connect()
    expect(handle.getSnapshot().authStatus).toBe('unknown')

    created[0].emit('login')
    expect(handle.getSnapshot().authStatus).toBe('authenticated')
    expect(handle.getSnapshot().minecraftProfileName).toBe('fakebot')

    const disconnecting = handle.disconnect()
    await flushMicrotasks()
    created[0].emit('end', 'test cleanup')
    await disconnecting
  })
})

function unconfiguredMicrosoftConfig(id: string): IBotConfig {
  return { ...microsoftConfig(id), host: undefined, port: undefined }
}

describe('BotInstance without a configured connection target', () => {
  it('starts disconnected with no host/port, same as any other instance', () => {
    const snapshot = startBot(unconfiguredMicrosoftConfig('unconfig-initial')).getSnapshot()
    expect(snapshot.status).toBe('disconnected')
    expect(snapshot.host).toBeUndefined()
    expect(snapshot.port).toBeUndefined()
  })

  it('completes Microsoft authentication with no host/port at all', async () => {
    const { authenticateMicrosoft, pending, calls } = fakeMicrosoftAuthFactory()
    const handle = startBot(unconfiguredMicrosoftConfig('unconfig-auth'), undefined, undefined, authenticateMicrosoft)

    const authenticating = handle.authenticate()
    await flushMicrotasks()
    expect(calls).toHaveLength(1)

    pending[0].resolve({ profileName: 'RealMcName' })
    await authenticating

    const snapshot = handle.getSnapshot()
    expect(snapshot.authStatus).toBe('authenticated')
    expect(snapshot.minecraftProfileName).toBe('RealMcName')
  })

  it('rejects connect() with a clear message and never creates a mineflayer bot', async () => {
    const { createBot, created } = fakeMineflayerBotFactory()
    const handle = startBot(unconfiguredMicrosoftConfig('unconfig-connect'), undefined, createBot)

    await expect(handle.connect()).rejects.toThrow(/no host configured/)
    expect(handle.getStatus()).toBe('disconnected') // no side effect from the rejected attempt
    expect(created).toHaveLength(0)
  })

  it('after a host is configured, connecting reuses the same cache instead of requesting a new device code', async () => {
    const { authenticateMicrosoft, pending, calls: authCalls } = fakeMicrosoftAuthFactory()
    const { createBot, created } = fakeMineflayerBotFactory()

    // Step 1: authenticate while unconfigured.
    const handle = startBot(unconfiguredMicrosoftConfig('unconfig-then-connect'), undefined, createBot, authenticateMicrosoft)
    const authenticating = handle.authenticate()
    await flushMicrotasks()
    pending[0].resolve({ profileName: 'RealMcName' })
    await authenticating
    expect(authCalls).toHaveLength(1)

    // Step 2: "add a host" -- in the real app this goes through
    // BotManager.updateInstance(), which builds a fresh handle from the
    // updated config (see bot-manager.test.ts for that path); what matters
    // here is that connect() on a config with a host now succeeds using
    // mineflayer's own internal auth against the SAME cache files (same
    // msaCacheKey/profilesFolder, untouched by adding a host), without this
    // test's authenticateMicrosoft ever being called again.
    const configuredHandle = startBot(
      { ...unconfiguredMicrosoftConfig('unconfig-then-connect'), host: '127.0.0.1', port: 25565 },
      undefined,
      createBot,
      authenticateMicrosoft
    )
    await configuredHandle.connect()
    expect(created).toHaveLength(1) // mineflayer's own createBot was reached this time
    expect(authCalls).toHaveLength(1) // ...but our standalone authenticateMicrosoft was NOT called again

    created[0].emit('login')
    expect(configuredHandle.getSnapshot().authStatus).toBe('authenticated')

    const disconnecting = configuredHandle.disconnect()
    await flushMicrotasks()
    created[0].emit('end', 'test cleanup')
    await disconnecting
  })
})
