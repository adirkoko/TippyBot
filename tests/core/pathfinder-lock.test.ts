import { describe, expect, it } from 'vitest'
import { PathfinderLock } from '../../src/core/pathfinder-lock'

describe('PathfinderLock', () => {
  it('lets the first owner acquire a free lock', () => {
    const lock = new PathfinderLock()

    expect(lock.acquire('navigation:come')).toBe(true)
    expect(lock.isOwnedBy('navigation:come')).toBe(true)
    expect(lock.getOwner()?.id).toBe('navigation:come')
  })

  it('refuses a second owner while the lock is held', () => {
    const lock = new PathfinderLock()
    lock.acquire('navigation:come')

    expect(lock.acquire('sign-trapdoor:s')).toBe(false)
    expect(lock.isOwnedBy('sign-trapdoor:s')).toBe(false)
    expect(lock.getOwner()?.id).toBe('navigation:come')
  })

  it('lets the current owner re-acquire its own lock', () => {
    const lock = new PathfinderLock()
    lock.acquire('navigation:come')

    expect(lock.acquire('navigation:come')).toBe(true)
  })

  it('ignores a release request from a non-owner', () => {
    const lock = new PathfinderLock()
    lock.acquire('navigation:come')

    lock.release('sign-trapdoor:s')

    expect(lock.isOwnedBy('navigation:come')).toBe(true)
  })

  it('frees the lock for other owners once released by the holder', () => {
    const lock = new PathfinderLock()
    lock.acquire('navigation:come')

    lock.release('navigation:come')

    expect(lock.getOwner()).toBeUndefined()
    expect(lock.acquire('sign-trapdoor:s')).toBe(true)
  })
})
