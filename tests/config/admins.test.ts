import { describe, expect, it } from 'vitest'
import { parseAdminList } from '../../src/config/admins'

describe('parseAdminList', () => {
  it('returns an empty list for undefined or empty input', () => {
    expect(parseAdminList(undefined)).toEqual([])
    expect(parseAdminList('')).toEqual([])
  })

  it('splits on commas and trims whitespace', () => {
    expect(parseAdminList(' PlayerOne , PlayerTwo ')).toEqual(['playerone', 'playertwo'])
  })

  it('normalizes case for consistent comparisons', () => {
    expect(parseAdminList('PlayerOne')).toEqual(['playerone'])
  })

  it('drops empty entries from stray commas', () => {
    expect(parseAdminList('PlayerOne,,PlayerTwo,')).toEqual(['playerone', 'playertwo'])
  })

  it('dedupes case-insensitive duplicates', () => {
    expect(parseAdminList('PlayerOne,playerone,PLAYERONE')).toEqual(['playerone'])
  })

  it('throws on an invalid Minecraft username', () => {
    expect(() => parseAdminList('Player One')).toThrow(/invalid Minecraft username/)
    expect(() => parseAdminList('Player!')).toThrow(/invalid Minecraft username/)
  })
})
