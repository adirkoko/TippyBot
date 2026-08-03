export const DEFAULT_WEB_HOST = '0.0.0.0'
export const DEFAULT_WEB_PORT = 3000
export const DEFAULT_WEB_SECURE_COOKIES = false
export const DEFAULT_WEB_DASHBOARD_INTERVAL_MS = 2_000
export const DEFAULT_WEB_LOGIN_MAX_ATTEMPTS = 5
export const DEFAULT_WEB_LOGIN_LOCKOUT_MS = 15 * 60 * 1000
export const DEFAULT_LOG_DISK_WARN_MB = 500
export const DEFAULT_LOG_DISK_CHECK_INTERVAL_MS = 60 * 60 * 1000
/** Node clamps larger setInterval delays to 1ms and emits TimeoutOverflowWarning. */
export const MAX_TIMER_INTERVAL_MS = 2_147_483_647

export interface WebConfig {
  enabled: boolean
  host: string
  port: number
  password: string
  secureCookies: boolean
  dashboardIntervalMs: number
  loginMaxAttempts: number
  loginLockoutMs: number
  logDiskWarnMb: number
  logDiskCheckIntervalMs: number
}

/**
 * Loads the web configuration after ensureWebPassword() has run.
 *
 * Environment numbers are deliberately parsed strictly: values such as
 * "3000ms", decimals and scientific notation are rejected instead of being
 * partially accepted by parseInt().
 */
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const enabled = parseEnabled(env.WEB_ENABLED)
  const host =
    env.WEB_HOST === undefined ? DEFAULT_WEB_HOST : requireNonEmpty(env.WEB_HOST, 'WEB_HOST').trim()
  const port = parseInteger(env.WEB_PORT, 'WEB_PORT', DEFAULT_WEB_PORT, 1, 65_535)
  const password = requireNonEmpty(env.WEB_PASSWORD, 'WEB_PASSWORD')
  const secureCookies = parseBoolean(
    env.WEB_SECURE_COOKIES,
    'WEB_SECURE_COOKIES',
    DEFAULT_WEB_SECURE_COOKIES
  )
  const dashboardIntervalMs = parseInteger(
    env.WEB_DASHBOARD_INTERVAL_MS,
    'WEB_DASHBOARD_INTERVAL_MS',
    DEFAULT_WEB_DASHBOARD_INTERVAL_MS,
    1,
    MAX_TIMER_INTERVAL_MS
  )
  const loginMaxAttempts = parseInteger(
    env.WEB_LOGIN_MAX_ATTEMPTS,
    'WEB_LOGIN_MAX_ATTEMPTS',
    DEFAULT_WEB_LOGIN_MAX_ATTEMPTS,
    1
  )
  const loginLockoutMs = parseInteger(
    env.WEB_LOGIN_LOCKOUT_MS,
    'WEB_LOGIN_LOCKOUT_MS',
    DEFAULT_WEB_LOGIN_LOCKOUT_MS,
    1
  )
  const logDiskWarnMb = parseInteger(
    env.LOG_DISK_WARN_MB,
    'LOG_DISK_WARN_MB',
    DEFAULT_LOG_DISK_WARN_MB,
    1
  )
  const logDiskCheckIntervalMs = parseInteger(
    env.LOG_DISK_CHECK_INTERVAL_MS,
    'LOG_DISK_CHECK_INTERVAL_MS',
    DEFAULT_LOG_DISK_CHECK_INTERVAL_MS,
    1,
    MAX_TIMER_INTERVAL_MS
  )

  return {
    enabled,
    host,
    port,
    password,
    secureCookies,
    dashboardIntervalMs,
    loginMaxAttempts,
    loginLockoutMs,
    logDiskWarnMb,
    logDiskCheckIntervalMs
  }
}

function parseEnabled(value: string | undefined): boolean {
  return parseBoolean(value, 'WEB_ENABLED', true)
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean
): boolean {
  if (value === undefined || value.trim() === '') return defaultValue

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false

  throw new Error(`${name} must be either "true" or "false".`)
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return value
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined || value.trim() === '') return defaultValue

  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }

  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return parsed
}
