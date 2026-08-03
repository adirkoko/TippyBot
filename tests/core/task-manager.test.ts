import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskManager } from '../../src/core/task-manager'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskManager: start/finish', () => {
  it('starts a task when none is active', () => {
    const tasks = new TaskManager()

    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd: vi.fn() })

    expect(handle).not.toBeNull()
    expect(tasks.getActive()).toMatchObject({ name: 'come', requestedBy: 'alice' })
  })

  it('refuses a second task while one is active', () => {
    const tasks = new TaskManager()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd: vi.fn() })

    const second = tasks.start({ name: 's', requestedBy: 'bob', timeoutMs: 30_000, onEnd: vi.fn() })

    expect(second).toBeNull()
  })

  it('frees the slot on finish() without calling onEnd', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd })!

    handle.finish()

    expect(tasks.getActive()).toBeUndefined()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('finish() is idempotent', () => {
    const tasks = new TaskManager()
    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd: vi.fn() })!

    handle.finish()
    expect(() => handle.finish()).not.toThrow()
  })

  it('allows a new task once the previous one finished', () => {
    const tasks = new TaskManager()
    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd: vi.fn() })!
    handle.finish()

    const next = tasks.start({ name: 's', requestedBy: 'bob', timeoutMs: 30_000, onEnd: vi.fn() })

    expect(next).not.toBeNull()
  })
})

describe('TaskManager: timeout', () => {
  it('calls onEnd with "timeout" and frees the slot after timeoutMs', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 5000, onEnd })

    vi.advanceTimersByTime(5000)

    expect(onEnd).toHaveBeenCalledWith('timeout')
    expect(tasks.getActive()).toBeUndefined()
  })

  it('aborts the handle signal on timeout', () => {
    const tasks = new TaskManager()
    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 5000, onEnd: vi.fn() })!

    vi.advanceTimersByTime(5000)

    expect(handle.signal.aborted).toBe(true)
  })

  it('does not fire the timeout if finish() was already called', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    const handle = tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 5000, onEnd })!
    handle.finish()

    vi.advanceTimersByTime(5000)

    expect(onEnd).not.toHaveBeenCalled()
  })
})

describe('TaskManager: cancel', () => {
  it('lets the requester cancel their own task', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd })

    const result = tasks.cancel('alice', 'user')

    expect(result.ok).toBe(true)
    expect(onEnd).toHaveBeenCalledWith('cancelled')
    expect(tasks.getActive()).toBeUndefined()
  })

  it('lets an Operator cancel someone else\'s task', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd })

    const result = tasks.cancel('bob', 'operator')

    expect(result.ok).toBe(true)
    expect(onEnd).toHaveBeenCalledWith('cancelled')
  })

  it('refuses a plain User cancelling someone else\'s task', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd })

    const result = tasks.cancel('bob', 'user')

    expect(result.ok).toBe(false)
    expect(onEnd).not.toHaveBeenCalled()
    expect(tasks.getActive()).toBeDefined()
  })

  it('reports nothing to cancel when idle', () => {
    const tasks = new TaskManager()

    const result = tasks.cancel('alice', 'admin')

    expect(result.ok).toBe(false)
  })
})

describe('TaskManager: abort (bot lifecycle)', () => {
  it('force-ends the active task on death', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd })

    tasks.abort('death')

    expect(onEnd).toHaveBeenCalledWith('death')
    expect(tasks.getActive()).toBeUndefined()
  })

  it('force-ends the active task on disconnect', () => {
    const tasks = new TaskManager()
    const onEnd = vi.fn()
    tasks.start({ name: 's', requestedBy: 'alice', timeoutMs: 30_000, onEnd })

    tasks.abort('disconnected')

    expect(onEnd).toHaveBeenCalledWith('disconnected')
  })

  it('is a no-op when nothing is active', () => {
    const tasks = new TaskManager()

    expect(() => tasks.abort('death')).not.toThrow()
  })

  it('frees the slot for a new task after an abort', () => {
    const tasks = new TaskManager()
    tasks.start({ name: 'come', requestedBy: 'alice', timeoutMs: 30_000, onEnd: vi.fn() })

    tasks.abort('disconnected')
    const next = tasks.start({ name: 's', requestedBy: 'bob', timeoutMs: 30_000, onEnd: vi.fn() })

    expect(next).not.toBeNull()
  })
})
