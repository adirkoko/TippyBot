import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CooldownService } from '../../src/core/cooldown-service'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CooldownService: per-player cooldown', () => {
  it('has no remaining cooldown before first use', () => {
    const service = new CooldownService()

    expect(service.getRemainingMs('come', 'alice', { perPlayerMs: 2000 })).toBe(0)
  })

  it('reports remaining time right after a use', () => {
    const service = new CooldownService()

    service.recordUse('come', 'alice', { perPlayerMs: 2000 })

    expect(service.getRemainingMs('come', 'alice', { perPlayerMs: 2000 })).toBeGreaterThan(0)
  })

  it('expires after the cooldown elapses', () => {
    const service = new CooldownService()

    service.recordUse('come', 'alice', { perPlayerMs: 2000 })
    vi.advanceTimersByTime(2001)

    expect(service.getRemainingMs('come', 'alice', { perPlayerMs: 2000 })).toBe(0)
  })

  it('tracks cooldowns independently per player', () => {
    const service = new CooldownService()

    service.recordUse('come', 'alice', { perPlayerMs: 2000 })

    expect(service.getRemainingMs('come', 'bob', { perPlayerMs: 2000 })).toBe(0)
  })

  it('tracks cooldowns independently per command', () => {
    const service = new CooldownService()

    service.recordUse('come', 'alice', { perPlayerMs: 2000 })

    expect(service.getRemainingMs('jump', 'alice', { perPlayerMs: 2000 })).toBe(0)
  })
})

describe('CooldownService: global cooldown', () => {
  it('blocks every player once anyone has used the command', () => {
    const service = new CooldownService()

    service.recordUse('build', 'alice', { globalMs: 5000 })

    expect(service.getRemainingMs('build', 'bob', { globalMs: 5000 })).toBeGreaterThan(0)
  })

  it('expires after the global cooldown elapses', () => {
    const service = new CooldownService()

    service.recordUse('build', 'alice', { globalMs: 5000 })
    vi.advanceTimersByTime(5001)

    expect(service.getRemainingMs('build', 'bob', { globalMs: 5000 })).toBe(0)
  })
})

describe('CooldownService: combined per-player and global', () => {
  it('returns the longer of the two remaining times', () => {
    const service = new CooldownService()
    const config = { perPlayerMs: 1000, globalMs: 5000 }

    service.recordUse('build', 'alice', config)

    const remaining = service.getRemainingMs('build', 'alice', config)
    expect(remaining).toBeGreaterThan(1000)
  })
})
