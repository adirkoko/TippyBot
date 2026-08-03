import { describe, expect, it } from 'vitest'
import {
  isValidInstanceId,
  permissionsFilePath,
  homesFilePath,
  defaultProfilesFolder
} from '../../src/config/instancePaths'

describe('isValidInstanceId', () => {
  it('accepts letters, digits, underscores, and hyphens', () => {
    expect(isValidInstanceId('steve')).toBe(true)
    expect(isValidInstanceId('bot_1-2')).toBe(true)
    expect(isValidInstanceId('A1')).toBe(true)
  })

  it('rejects empty strings', () => {
    expect(isValidInstanceId('')).toBe(false)
  })

  it('rejects strings longer than 32 characters', () => {
    expect(isValidInstanceId('a'.repeat(33))).toBe(false)
    expect(isValidInstanceId('a'.repeat(32))).toBe(true)
  })

  it('rejects characters outside the allowed set', () => {
    expect(isValidInstanceId('bot 1')).toBe(false)
    expect(isValidInstanceId('bot/1')).toBe(false)
    expect(isValidInstanceId('bot.1')).toBe(false)
    expect(isValidInstanceId('../etc')).toBe(false)
  })
})

describe('per-instance path helpers', () => {
  it('namespaces permissions, homes, and profiles under the instance id', () => {
    expect(permissionsFilePath('steve')).toBe('./data/steve/permissions.json')
    expect(homesFilePath('steve')).toBe('./data/steve/homes.json')
    expect(defaultProfilesFolder('steve')).toBe('./auth_cache/steve')
  })

  it('keeps different instance ids from colliding', () => {
    expect(permissionsFilePath('steve')).not.toBe(permissionsFilePath('alex'))
    expect(homesFilePath('steve')).not.toBe(homesFilePath('alex'))
    expect(defaultProfilesFolder('steve')).not.toBe(defaultProfilesFolder('alex'))
  })
})
