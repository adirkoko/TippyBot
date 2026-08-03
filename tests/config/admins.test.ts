import { describe, expect, it } from 'vitest'
import { normalizeAdminList } from '../../src/config/admins'

describe('normalizeAdminList', () => {
  it('returns an empty list for an empty input', () => {
    expect(normalizeAdminList([])).toEqual([])
  })

  it('trims whitespace around entries', () => {
    expect(normalizeAdminList([' PlayerOne ', ' PlayerTwo '])).toEqual(['playerone', 'playertwo'])
  })

  it('normalizes case for consistent comparisons', () => {
    expect(normalizeAdminList(['PlayerOne'])).toEqual(['playerone'])
  })

  it('drops empty/whitespace-only entries', () => {
    expect(normalizeAdminList(['PlayerOne', '', '  ', 'PlayerTwo'])).toEqual(['playerone', 'playertwo'])
  })

  it('dedupes case-insensitive duplicates', () => {
    expect(normalizeAdminList(['PlayerOne', 'playerone', 'PLAYERONE'])).toEqual(['playerone'])
  })

  it('throws on an invalid Minecraft username', () => {
    expect(() => normalizeAdminList(['Player One'])).toThrow(/Invalid Minecraft username/)
    expect(() => normalizeAdminList(['Player!'])).toThrow(/Invalid Minecraft username/)
  })
})
