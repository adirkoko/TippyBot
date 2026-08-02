import { describe, expect, it } from 'vitest'
import {
  isValidGroupName,
  isValidPlayerName,
  normalizeGroupName,
  normalizeUsername
} from '../../src/utils/validation'

describe('isValidPlayerName', () => {
  it('accepts letters, digits, and underscores', () => {
    expect(isValidPlayerName('Player_One42')).toBe(true)
  })

  it('rejects spaces and symbols', () => {
    expect(isValidPlayerName('Player One')).toBe(false)
    expect(isValidPlayerName('Player!')).toBe(false)
  })

  it('rejects empty strings and names over 16 characters', () => {
    expect(isValidPlayerName('')).toBe(false)
    expect(isValidPlayerName('a'.repeat(17))).toBe(false)
  })

  it('accepts a 16-character name', () => {
    expect(isValidPlayerName('a'.repeat(16))).toBe(true)
  })
})

describe('isValidGroupName', () => {
  it('accepts letters, digits, underscores, and hyphens', () => {
    expect(isValidGroupName('Builders-Team_1')).toBe(true)
  })

  it('rejects spaces and names over 32 characters', () => {
    expect(isValidGroupName('Builders Team')).toBe(false)
    expect(isValidGroupName('a'.repeat(33))).toBe(false)
  })
})

describe('normalizeUsername / normalizeGroupName', () => {
  it('trims whitespace and lowercases', () => {
    expect(normalizeUsername('  PlayerOne  ')).toBe('playerone')
    expect(normalizeGroupName('  Builders  ')).toBe('builders')
  })
})
