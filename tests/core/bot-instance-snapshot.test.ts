import { describe, expect, it, vi } from 'vitest'
import { buildSnapshot } from '../../src/core/bot-instance-snapshot'
import type { IBotConfig } from '../../src/interfaces/config'
import type { ActiveTaskInfo } from '../../src/interfaces/tasks'

const config: IBotConfig = {
  id: 'steve',
  host: 'play.example.com',
  port: 25565,
  username: 'SteveBot',
  auth: 'microsoft',
  commandPrefix: '!',
  admins: [],
  autoConnect: true
}

const activeTask: ActiveTaskInfo = {
  id: 1,
  name: 'come',
  requestedBy: 'somePlayer',
  startedAt: 1000
}

describe('buildSnapshot', () => {
  it('carries through id/status/lastError/config fields unconditionally', () => {
    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'reconnecting',
      lastError: undefined,
      connectedSince: undefined,
      bot: undefined,
      activeTask: undefined
    })

    expect(snapshot.id).toBe('steve')
    expect(snapshot.status).toBe('reconnecting')
    expect(snapshot.host).toBe('play.example.com')
    expect(snapshot.port).toBe(25565)
    expect(snapshot.username).toBe('SteveBot')
  })

  it('leaves live stats undefined when no bot is passed (not online)', () => {
    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'reconnecting',
      lastError: undefined,
      connectedSince: 12345,
      bot: undefined,
      activeTask: undefined
    })

    expect(snapshot.uptimeMs).toBeUndefined()
    expect(snapshot.ping).toBeUndefined()
    expect(snapshot.health).toBeUndefined()
    expect(snapshot.food).toBeUndefined()
    expect(snapshot.position).toBeUndefined()
    expect(snapshot.dimension).toBeUndefined()
  })

  it('reports last error even while reconnecting or errored', () => {
    const lastError = { message: 'boom', at: 999 }

    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'errored',
      lastError,
      connectedSince: undefined,
      bot: undefined,
      activeTask: undefined
    })

    expect(snapshot.lastError).toEqual(lastError)
  })

  it('fills in live stats from the bot source when online', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'online',
      lastError: undefined,
      connectedSince: 4_000,
      bot: {
        player: { ping: 42 },
        health: 18,
        food: 15,
        entity: { position: { x: 1.5, y: 64, z: -2.25 } },
        game: { dimension: 'the_nether' }
      },
      activeTask
    })

    expect(snapshot.uptimeMs).toBe(6_000)
    expect(snapshot.ping).toBe(42)
    expect(snapshot.health).toBe(18)
    expect(snapshot.food).toBe(15)
    expect(snapshot.position).toEqual({ x: 1.5, y: 64, z: -2.25 })
    expect(snapshot.dimension).toBe('nether')
    expect(snapshot.activeTask).toEqual(activeTask)

    vi.useRealTimers()
  })

  it('omits position/dimension when the bot source lacks entity/game', () => {
    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'online',
      lastError: undefined,
      connectedSince: 1,
      bot: { health: 20, food: 20 },
      activeTask: undefined
    })

    expect(snapshot.position).toBeUndefined()
    expect(snapshot.dimension).toBeUndefined()
    expect(snapshot.ping).toBeUndefined()
  })

  it('passes activeTask through regardless of connection status', () => {
    const snapshot = buildSnapshot({
      id: 'steve',
      config,
      status: 'reconnecting',
      lastError: undefined,
      connectedSince: undefined,
      bot: undefined,
      activeTask
    })

    expect(snapshot.activeTask).toEqual(activeTask)
  })
})
