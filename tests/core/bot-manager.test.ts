import { describe, expect, it, vi } from 'vitest'
import { BotManager } from '../../src/core/bot-manager'
import type { IBotConfig } from '../../src/interfaces/config'
import type { BotInstanceSnapshot, IBotInstanceHandle } from '../../src/interfaces/bot-instance'
import type { LogStore } from '../../src/core/log-store'

function fakeConfig(id: string): IBotConfig {
  return {
    id,
    host: 'example.com',
    port: 25565,
    username: `${id}Bot`,
    auth: 'offline',
    commandPrefix: '!',
    admins: []
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
    getSnapshot: () => fakeSnapshot(config)
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
})
