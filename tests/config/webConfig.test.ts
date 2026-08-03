import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_DISK_CHECK_INTERVAL_MS,
  DEFAULT_LOG_DISK_WARN_MB,
  DEFAULT_WEB_DASHBOARD_INTERVAL_MS,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_LOGIN_LOCKOUT_MS,
  DEFAULT_WEB_LOGIN_MAX_ATTEMPTS,
  DEFAULT_WEB_PORT,
  DEFAULT_WEB_SECURE_COOKIES,
  loadWebConfig
} from '../../src/config/webConfig'

describe('loadWebConfig', () => {
  it('loads safe defaults while requiring a password', () => {
    expect(loadWebConfig({ WEB_PASSWORD: 'secret' })).toEqual({
      enabled: true,
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
      password: 'secret',
      secureCookies: DEFAULT_WEB_SECURE_COOKIES,
      dashboardIntervalMs: DEFAULT_WEB_DASHBOARD_INTERVAL_MS,
      loginMaxAttempts: DEFAULT_WEB_LOGIN_MAX_ATTEMPTS,
      loginLockoutMs: DEFAULT_WEB_LOGIN_LOCKOUT_MS,
      logDiskWarnMb: DEFAULT_LOG_DISK_WARN_MB,
      logDiskCheckIntervalMs: DEFAULT_LOG_DISK_CHECK_INTERVAL_MS
    })
  })

  it('loads explicit values and recognizes false case-insensitively', () => {
    expect(
      loadWebConfig({
        WEB_ENABLED: ' FALSE ',
        WEB_HOST: ' 127.0.0.1 ',
        WEB_PORT: '8080',
        WEB_PASSWORD: 'configured password',
        WEB_SECURE_COOKIES: ' TRUE ',
        WEB_DASHBOARD_INTERVAL_MS: '2500',
        WEB_LOGIN_MAX_ATTEMPTS: '3',
        WEB_LOGIN_LOCKOUT_MS: '12000',
        LOG_DISK_WARN_MB: '42',
        LOG_DISK_CHECK_INTERVAL_MS: '60000'
      })
    ).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 8080,
      password: 'configured password',
      secureCookies: true,
      dashboardIntervalMs: 2500,
      loginMaxAttempts: 3,
      loginLockoutMs: 12000,
      logDiskWarnMb: 42,
      logDiskCheckIntervalMs: 60000
    })
  })

  it('rejects a missing or blank password', () => {
    expect(() => loadWebConfig({})).toThrow(/WEB_PASSWORD/)
    expect(() => loadWebConfig({ WEB_PASSWORD: '   ' })).toThrow(/WEB_PASSWORD/)
  })

  it.each([
    ['WEB_PORT', '0'],
    ['WEB_PORT', '65536'],
    ['WEB_PORT', '3000ms'],
    ['WEB_PORT', '1.5'],
    ['WEB_LOGIN_MAX_ATTEMPTS', '0'],
    ['WEB_LOGIN_LOCKOUT_MS', '-1'],
    ['WEB_DASHBOARD_INTERVAL_MS', '0'],
    ['WEB_DASHBOARD_INTERVAL_MS', '1.5'],
    ['WEB_DASHBOARD_INTERVAL_MS', '2147483648'],
    ['LOG_DISK_WARN_MB', '1e2'],
    ['LOG_DISK_CHECK_INTERVAL_MS', 'NaN'],
    ['LOG_DISK_CHECK_INTERVAL_MS', '2147483648']
  ])('strictly rejects invalid %s=%s', (name, value) => {
    expect(() => loadWebConfig({ WEB_PASSWORD: 'secret', [name]: value })).toThrow(name)
  })

  it('rejects malformed WEB_ENABLED and an empty explicit host', () => {
    expect(() => loadWebConfig({ WEB_PASSWORD: 'secret', WEB_ENABLED: '0' })).toThrow(/WEB_ENABLED/)
    expect(() => loadWebConfig({ WEB_PASSWORD: 'secret', WEB_SECURE_COOKIES: 'yes' })).toThrow(
      /WEB_SECURE_COOKIES/
    )
    expect(() => loadWebConfig({ WEB_PASSWORD: 'secret', WEB_HOST: '  ' })).toThrow(/WEB_HOST/)
  })
})
