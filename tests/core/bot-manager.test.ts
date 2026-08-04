import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BotManager } from '../../src/core/bot-manager'
import type { IBotConfig } from '../../src/interfaces/config'
import type { BotInstanceSnapshot, IBotInstanceHandle } from '../../src/interfaces/bot-instance'
import type { LogStore } from '../../src/core/log-store'

function fakeConfig(id: string, overrides: Partial<IBotConfig> = {}): IBotConfig {
  return {
    id,
    host: 'example.com',
    port: 25565,
    username: `${id}Bot`,
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true,
    ...overrides
  }
}

function fakeSnapshot(config: IBotConfig): BotInstanceSnapshot {
  return {
    id: config.id,
    status: 'connecting',
    lastError: undefined,
    host: config.host,
    port: config.port,
    username: config.username,
    uptimeMs: undefined,
    ping: undefined,
    health: undefined,
    food: undefined,
    position: undefined,
    dimension: undefined,
    activeTask: undefined
  }
}

function fakeHandle(config: IBotConfig): IBotInstanceHandle {
  return {
    id: config.id,
    config,
    getStatus: () => 'connecting',
    getLastError: () => undefined,
    getSnapshot: () => fakeSnapshot(config),
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    authenticate: () => Promise.resolve(),
    cancelAuthentication: () => Promise.resolve()
  }
}

describe('BotManager', () => {
  it('starts every configured instance exactly once', () => {
    const configs = [fakeConfig('steve'), fakeConfig('alex')]
    const start = vi.fn(fakeHandle)

    new BotManager(configs, start).startAll()

    expect(start).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledWith(configs[0])
    expect(start).toHaveBeenCalledWith(configs[1])
  })

  it('does nothing for an empty config list', () => {
    const start = vi.fn(fakeHandle)

    const manager = new BotManager([], start)
    manager.startAll()

    expect(start).not.toHaveBeenCalled()
    expect(manager.getInstances()).toEqual([])
  })

  it('getInstances returns every handle after startAll', () => {
    const configs = [fakeConfig('steve'), fakeConfig('alex')]
    const manager = new BotManager(configs, fakeHandle)

    manager.startAll()

    expect(manager.getInstances().map((h) => h.id)).toEqual(['steve', 'alex'])
  })

  it('getInstances returns nothing before startAll is called', () => {
    const manager = new BotManager([fakeConfig('steve')], fakeHandle)

    expect(manager.getInstances()).toEqual([])
  })

  it('getInstance looks up a handle by id', () => {
    const configs = [fakeConfig('steve'), fakeConfig('alex')]
    const manager = new BotManager(configs, fakeHandle)

    manager.startAll()

    expect(manager.getInstance('alex')?.id).toBe('alex')
  })

  it('getInstance returns undefined for an unknown id', () => {
    const manager = new BotManager([fakeConfig('steve')], fakeHandle)

    manager.startAll()

    expect(manager.getInstance('nonexistent')).toBeUndefined()
  })

  it('passes the matching LogStore to each instance and exposes it read-only', () => {
    const config = fakeConfig('steve')
    const store = {} as LogStore
    const start = vi.fn(fakeHandle)
    const manager = new BotManager([config], start, new Map([['steve', store]]))

    manager.startAll()

    expect(start).toHaveBeenCalledWith(config, store)
    expect(manager.getLogStore('steve')).toBe(store)
    expect(manager.getLogStore('missing')).toBeUndefined()
  })

  it('defaults to the real startBot when no start function is injected', () => {
    const manager = new BotManager([])
    expect(() => manager.startAll()).not.toThrow()
  })

  it('connects every instance after creating its handle', () => {
    const configs = [fakeConfig('steve'), fakeConfig('alex')]
    const connect = vi.fn(() => Promise.resolve())
    const start = vi.fn((config: IBotConfig): IBotInstanceHandle => ({
      ...fakeHandle(config),
      connect
    }))

    new BotManager(configs, start).startAll()

    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('does not let one instance rejecting connect() throw out of startAll or block the others', () => {
    const configs = [fakeConfig('steve'), fakeConfig('alex')]
    const connectedIds: string[] = []
    const start = vi.fn((config: IBotConfig): IBotInstanceHandle => ({
      ...fakeHandle(config),
      connect: () => {
        if (config.id === 'steve') return Promise.reject(new Error('boom'))
        connectedIds.push(config.id)
        return Promise.resolve()
      }
    }))

    expect(() => new BotManager(configs, start).startAll()).not.toThrow()
    expect(connectedIds).toEqual(['alex'])
  })

  it('does not connect an instance configured with autoConnect: false', () => {
    const configs = [fakeConfig('steve', { autoConnect: false }), fakeConfig('alex')]
    const connectedIds: string[] = []
    const start = vi.fn((config: IBotConfig): IBotInstanceHandle => ({
      ...fakeHandle(config),
      connect: () => {
        connectedIds.push(config.id)
        return Promise.resolve()
      }
    }))

    new BotManager(configs, start).startAll()

    expect(connectedIds).toEqual(['alex'])
  })
})

describe('BotManager CRUD', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-botmanager-'))
    configPath = path.join(tmpDir, 'bots.config.json')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function readSavedIds(): Promise<string[]> {
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as { instances: IBotConfig[] }
    return raw.instances.map((c) => c.id)
  }

  function fakeLogStore(closeCalls?: string[], id = 'unknown'): LogStore {
    return {
      close: () => {
        closeCalls?.push(id)
        return Promise.resolve()
      }
    } as unknown as LogStore
  }

  function trackingFakeHandle(config: IBotConfig, calls: string[]): IBotInstanceHandle {
    let status: BotInstanceSnapshot['status'] = 'disconnected'
    return {
      ...fakeHandle(config),
      getStatus: () => status,
      connect: () => {
        calls.push(`connect:${config.id}`)
        status = 'online'
        return Promise.resolve()
      },
      disconnect: () => {
        calls.push(`disconnect:${config.id}`)
        status = 'disconnected'
        return Promise.resolve()
      }
    }
  }

  describe('addInstance', () => {
    it('saves the config file before adding the handle to the map', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([], start, new Map(), configPath)

      const handle = await manager.addInstance(fakeConfig('steve'), fakeLogStore())

      expect(await readSavedIds()).toEqual(['steve'])
      expect(manager.getInstance('steve')).toBe(handle)
    })

    it('does not add or connect the instance if saving the config file fails', async () => {
      const blockedDir = path.join(tmpDir, 'blocked')
      await fs.writeFile(blockedDir, 'not a directory', 'utf8')
      const blockedPath = path.join(blockedDir, 'bots.config.json')

      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([], start, new Map(), blockedPath)

      await expect(manager.addInstance(fakeConfig('steve'), fakeLogStore())).rejects.toThrow()

      expect(manager.getInstance('steve')).toBeUndefined()
      expect(calls).toEqual([])
    })

    it('connects the new instance when autoConnect is true, without touching other instances', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('alex')], start, new Map(), configPath)
      manager.startAll()
      calls.length = 0 // only care about what addInstance itself triggers

      await manager.addInstance(fakeConfig('steve'), fakeLogStore())

      expect(calls).toEqual(['connect:steve'])
    })

    it('does not connect the new instance when autoConnect is false', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([], start, new Map(), configPath)

      const handle = await manager.addInstance(fakeConfig('steve', { autoConnect: false }), fakeLogStore())

      expect(handle.getStatus()).toBe('disconnected')
      expect(calls).toEqual([])
    })

    it('rejects a duplicate id without touching the saved file', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()

      await expect(manager.addInstance(fakeConfig('steve'), fakeLogStore())).rejects.toThrow(/already exists/)
      await expect(fs.access(configPath)).rejects.toThrow()
    })
  })

  describe('removeInstance', () => {
    it('disconnects, saves the file, then removes the handle -- in that order', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve'), fakeConfig('alex')], start, new Map(), configPath)
      manager.startAll()
      calls.length = 0

      await manager.removeInstance('steve')

      expect(calls).toEqual(['disconnect:steve'])
      expect(await readSavedIds()).toEqual(['alex'])
      expect(manager.getInstance('steve')).toBeUndefined()
      expect(manager.getInstance('alex')).toBeDefined()
    })

    it('does not lose the instance from state if saving the file fails', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()

      // Make the config file itself unwritable by replacing its directory
      // with a file after the instance already exists in memory.
      await fs.rm(configPath, { force: true })
      await fs.rm(tmpDir, { recursive: true, force: true })
      await fs.writeFile(tmpDir, 'not a directory', 'utf8')

      await expect(manager.removeInstance('steve')).rejects.toThrow()
      expect(manager.getInstance('steve')).toBeDefined()
      expect(manager.getInstance('steve')?.getStatus()).toBe('disconnected')
    })

    it('closes the LogStore without deleting anything on disk', async () => {
      const closeCalls: string[] = []
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager(
        [fakeConfig('steve')],
        start,
        new Map([['steve', fakeLogStore(closeCalls, 'steve')]]),
        configPath
      )
      manager.startAll()

      await manager.removeInstance('steve')

      expect(closeCalls).toEqual(['steve'])
      expect(manager.getLogStore('steve')).toBeUndefined()
    })

    it('rejects for an unknown id', async () => {
      const manager = new BotManager([], undefined, new Map(), configPath)
      await expect(manager.removeInstance('missing')).rejects.toThrow(/does not exist/)
    })
  })

  describe('updateInstance', () => {
    it('rejects an attempt to change the id', async () => {
      const manager = new BotManager([fakeConfig('steve')], fakeHandle, new Map(), configPath)
      manager.startAll()

      await expect(manager.updateInstance('steve', fakeConfig('someone-else'))).rejects.toThrow(/id/)
    })

    it('reconnects only if the instance was active before the update, using the new config', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()
      calls.length = 0

      const updated = fakeConfig('steve', { host: 'new-host.example.com' })
      const handle = await manager.updateInstance('steve', updated)

      expect(calls).toEqual(['disconnect:steve', 'connect:steve'])
      expect(handle.config.host).toBe('new-host.example.com')
      expect(await readSavedIds()).toEqual(['steve'])
    })

    it('does not reconnect if the instance was not active before the update', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager(
        [fakeConfig('steve', { autoConnect: false })],
        start,
        new Map(),
        configPath
      )
      manager.startAll() // autoConnect: false -- never connects
      calls.length = 0

      await manager.updateInstance('steve', fakeConfig('steve', { autoConnect: false, host: 'new-host' }))

      expect(calls).toEqual([])
    })

    it('rolls the disconnect back and leaves the file unchanged if saving fails', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()
      await fs.writeFile(configPath, JSON.stringify({ instances: [fakeConfig('steve')] }), 'utf8')
      calls.length = 0

      await fs.rm(configPath, { force: true })
      await fs.rm(tmpDir, { recursive: true, force: true })
      await fs.writeFile(tmpDir, 'not a directory', 'utf8')

      await expect(
        manager.updateInstance('steve', fakeConfig('steve', { host: 'new-host' }))
      ).rejects.toThrow()

      expect(calls).toEqual(['disconnect:steve', 'connect:steve'])
      expect(manager.getInstance('steve')?.config.host).toBe('example.com')
    })

    it('rejects for an unknown id', async () => {
      const manager = new BotManager([], undefined, new Map(), configPath)
      await expect(manager.updateInstance('missing', fakeConfig('missing'))).rejects.toThrow(/does not exist/)
    })
  })

  describe('concurrent CRUD operations', () => {
    it('serializes overlapping add/remove/update calls instead of racing the shared config file', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => trackingFakeHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()

      const results = await Promise.allSettled([
        manager.addInstance(fakeConfig('alex'), fakeLogStore()),
        manager.addInstance(fakeConfig('bob'), fakeLogStore()),
        manager.updateInstance('steve', fakeConfig('steve', { host: 'new-host' }))
      ])

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      const savedIds = (await readSavedIds()).sort()
      expect(savedIds).toEqual(['alex', 'bob', 'steve'])
      expect(manager.getInstance('steve')?.config.host).toBe('new-host')
      expect(manager.getInstance('alex')).toBeDefined()
      expect(manager.getInstance('bob')).toBeDefined()
    })
  })

  describe('authenticateInstance / cancelAuthentication', () => {
    function authTrackingHandle(config: IBotConfig, calls: string[]): IBotInstanceHandle {
      return {
        ...fakeHandle(config),
        authenticate: () => {
          calls.push(`authenticate:${config.id}`)
          return Promise.resolve()
        },
        cancelAuthentication: () => {
          calls.push(`cancel:${config.id}`)
          return Promise.resolve()
        }
      }
    }

    it('delegates to the handle', async () => {
      const calls: string[] = []
      const start = (config: IBotConfig): IBotInstanceHandle => authTrackingHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()

      await manager.authenticateInstance('steve')
      await manager.cancelAuthentication('steve')

      expect(calls).toEqual(['authenticate:steve', 'cancel:steve'])
    })

    it('rejects for an unknown id', async () => {
      const manager = new BotManager([], undefined, new Map(), configPath)
      await expect(manager.authenticateInstance('missing')).rejects.toThrow(/does not exist/)
      await expect(manager.cancelAuthentication('missing')).rejects.toThrow(/does not exist/)
    })

    it('does not queue behind an in-flight CRUD operation on a different instance', async () => {
      const calls: string[] = []
      let releaseSlowAdd: (() => void) | undefined
      const slowAddBlocked = new Promise<void>((resolve) => {
        releaseSlowAdd = resolve
      })

      const start = (config: IBotConfig): IBotInstanceHandle => authTrackingHandle(config, calls)
      const manager = new BotManager([fakeConfig('steve')], start, new Map(), configPath)
      manager.startAll()

      // Occupies the CRUD queue with a save that won't resolve until released.
      const slowLogStore = {
        ready: () => Promise.resolve(),
        close: () => Promise.resolve()
      } as unknown as LogStore
      const originalWriteFile = fs.writeFile
      const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
        await slowAddBlocked
        return originalWriteFile(...(args as Parameters<typeof fs.writeFile>))
      })

      const slowAdd = manager.addInstance(fakeConfig('alex'), slowLogStore)

      // authenticateInstance on the unrelated, already-existing 'steve' must
      // not wait behind that pending add.
      await manager.authenticateInstance('steve')
      expect(calls).toEqual(['authenticate:steve'])

      releaseSlowAdd?.()
      await slowAdd
      writeSpy.mockRestore()
    })
  })
})
