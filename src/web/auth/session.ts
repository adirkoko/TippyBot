import { randomBytes as nodeRandomBytes } from 'crypto'
import type { IncomingMessage } from 'http'

export const SESSION_COOKIE_NAME = 'tippybot_session'
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export interface SessionStoreOptions {
  ttlMs?: number
  cookieName?: string
  now?: () => number
  randomBytes?: (size: number) => Buffer
}

interface SessionRecord {
  expiresAt: number
}

export class SessionStore {
  readonly ttlMs: number
  readonly cookieName: string

  private readonly sessions = new Map<string, SessionRecord>()
  private readonly now: () => number
  private readonly makeRandomBytes: (size: number) => Buffer

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
    this.cookieName = options.cookieName ?? SESSION_COOKIE_NAME
    this.now = options.now ?? Date.now
    this.makeRandomBytes = options.randomBytes ?? nodeRandomBytes

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Session ttlMs must be a positive integer.')
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(this.cookieName)) {
      throw new Error('Session cookieName is invalid.')
    }
  }

  createSession(): string {
    this.cleanupExpired()

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.makeRandomBytes(32).toString('base64url')
      if (this.sessions.has(token)) continue

      this.sessions.set(token, { expiresAt: this.now() + this.ttlMs })
      return token
    }
    throw new Error('Unable to allocate a unique session token.')
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false
    const session = this.sessions.get(token)
    if (!session) return false
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  revoke(token: string | undefined): boolean {
    return token ? this.sessions.delete(token) : false
  }

  tokenFromRequest(request: Pick<IncomingMessage, 'headers'>): string | undefined {
    return parseCookies(request.headers.cookie)[this.cookieName]
  }

  isAuthenticated(request: Pick<IncomingMessage, 'headers'>): boolean {
    return this.isValid(this.tokenFromRequest(request))
  }

  createCookie(token: string, secure = false): string {
    const maxAgeSeconds = Math.max(1, Math.floor(this.ttlMs / 1000))
    const expires = new Date(this.now() + this.ttlMs).toUTCString()
    return serializeCookie(this.cookieName, token, maxAgeSeconds, expires, secure)
  }

  clearCookie(secure = false): string {
    return serializeCookie(this.cookieName, '', 0, new Date(0).toUTCString(), secure)
  }

  cleanupExpired(): void {
    const now = this.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token)
    }
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>
  if (!header) return cookies

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const rawValue = pair.slice(separator + 1).trim()
    if (!name) continue
    try {
      cookies[name] = decodeURIComponent(rawValue)
    } catch {
      // Ignore malformed percent-encoding instead of making auth throw.
    }
  }
  return cookies
}

function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  expires: string,
  secure: boolean
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires}`
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
