import { describe, expect, it } from 'vitest'
import { levelMeets, rankOfLevel } from '../../src/utils/permissionLevel'

describe('rankOfLevel', () => {
  it('ranks admin > operator > member > user', () => {
    expect(rankOfLevel('admin')).toBeGreaterThan(rankOfLevel('operator'))
    expect(rankOfLevel('operator')).toBeGreaterThan(rankOfLevel('member'))
    expect(rankOfLevel('member')).toBeGreaterThan(rankOfLevel('user'))
  })
})

describe('levelMeets', () => {
  it('is true when the actual level is at or above the required level', () => {
    expect(levelMeets('admin', 'operator')).toBe(true)
    expect(levelMeets('operator', 'operator')).toBe(true)
  })

  it('is false when the actual level is below the required level', () => {
    expect(levelMeets('member', 'operator')).toBe(false)
    expect(levelMeets('user', 'member')).toBe(false)
  })
})
