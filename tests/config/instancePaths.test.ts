import { describe, expect, it } from 'vitest'
import {
  isValidInstanceId,
  permissionsFilePath,
  homesFilePath,
  defaultProfilesFolder,
  isSafeRelativeFolder
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

describe('isSafeRelativeFolder', () => {
  it('accepts plain relative paths, including nested ones', () => {
    expect(isSafeRelativeFolder('./auth_cache/steve')).toBe(true)
    expect(isSafeRelativeFolder('auth_cache/steve')).toBe(true)
    expect(isSafeRelativeFolder('custom/nested/profiles')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isSafeRelativeFolder('')).toBe(false)
  })

  it('rejects POSIX absolute paths', () => {
    expect(isSafeRelativeFolder('/etc/passwd')).toBe(false)
  })

  it('rejects Windows drive-letter and UNC absolute paths', () => {
    expect(isSafeRelativeFolder('C:\\Windows\\System32')).toBe(false)
    expect(isSafeRelativeFolder('C:/secrets')).toBe(false)
    expect(isSafeRelativeFolder('\\\\server\\share')).toBe(false)
  })

  it('rejects any ".." traversal segment, POSIX or Windows separators', () => {
    expect(isSafeRelativeFolder('../secrets')).toBe(false)
    expect(isSafeRelativeFolder('auth_cache/../../etc')).toBe(false)
    expect(isSafeRelativeFolder('auth_cache\\..\\..\\secrets')).toBe(false)
  })
})
