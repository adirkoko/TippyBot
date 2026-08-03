import { describe, expect, it } from 'vitest'
import { distanceSquared, isWithinDistance, nearestPosition } from '../../src/utils/navigation'

describe('distanceSquared', () => {
  it('computes the squared distance between two points', () => {
    expect(distanceSquared({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(25)
  })

  it('is 0 for identical points', () => {
    expect(distanceSquared({ x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 })).toBe(0)
  })
})

describe('isWithinDistance', () => {
  it('is true exactly at the boundary', () => {
    expect(isWithinDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, 5)).toBe(true)
  })

  it('is false just beyond the boundary', () => {
    expect(isWithinDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, 4.9)).toBe(false)
  })
})

describe('nearestPosition', () => {
  it('returns null for an empty candidate list', () => {
    expect(nearestPosition([], { x: 0, y: 0, z: 0 })).toBeNull()
  })

  it('picks the closest candidate', () => {
    const from = { x: 0, y: 0, z: 0 }
    const near = { x: 1, y: 0, z: 0 }
    const far = { x: 10, y: 0, z: 0 }

    expect(nearestPosition([far, near], from)).toBe(near)
  })

  it('breaks exact-distance ties deterministically regardless of input order', () => {
    const from = { x: 0, y: 0, z: 0 }
    const a = { x: 1, y: 0, z: 0 }
    const b = { x: -1, y: 0, z: 0 }

    const result1 = nearestPosition([a, b], from)
    const result2 = nearestPosition([b, a], from)

    expect(result1).toBe(result2)
  })
})
