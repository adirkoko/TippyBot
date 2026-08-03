import type { ServerResponse } from 'http'
import { describe, expect, it, vi } from 'vitest'
import { LoginRateLimiter } from '../../src/web/auth/loginRateLimiter'
import { verifyPassword } from '../../src/web/auth/password'
import { isAuthenticated, requireAuth } from '../../src/web/auth/requireAuth'
import { parseCookies, SessionStore } from '../../src/web/auth/session'

describe('password verification', () => {
  it('accepts the exact password and rejects different values and lengths', () => {
    expect(verifyPassword('correct horse', 'correct horse')).toBe(true)
    expect(verifyPassword('correct horse!', 'correct horse')).toBe(false)
    expect(verifyPassword('', 'correct horse')).toBe(false)
  })
})

describe('SessionStore', () => {
  it('creates an in-memory session and a hardened cookie', () => {
    let now = Date.UTC(2026, 7, 3)
    const sessions = new SessionStore({
      ttlMs: 60_000,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 0x42)
    })

    const token = sessions.createSession()
    const cookie = sessions.createCookie(token, true)
    const request = { headers: { cookie: cookie.split(';')[0] } }

    expect(token).toHaveLength(43)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=60')
    expect(cookie).toContain('Secure')
    expect(sessions.isAuthenticated(request)).toBe(true)
    expect(isAuthenticated(request, sessions)).toBe(true)

    now += 60_000
    expect(sessions.isAuthenticated(request)).toBe(false)
  })

  it('revokes sessions and produces an expiring logout cookie', () => {
    const sessions = new SessionStore({ randomBytes: () => Buffer.alloc(32, 1) })
    const token = sessions.createSession()

    expect(sessions.revoke(token)).toBe(true)
    expect(sessions.isValid(token)).toBe(false)
    expect(sessions.clearCookie()).toContain('Max-Age=0')
    expect(sessions.clearCookie()).toContain('HttpOnly')
  })

  it('parses cookie values and ignores malformed percent encoding', () => {
    const cookies = parseCookies('first=hello%20world; bad=%E0%A4%A; token=abc')
    expect(cookies.first).toBe('hello world')
    expect(cookies.bad).toBeUndefined()
    expect(cookies.token).toBe('abc')
  })
})

describe('LoginRateLimiter', () => {
  it('locks one IP at the configured failure threshold and resets after lockout', () => {
    let now = 1_000
    const limiter = new LoginRateLimiter({ maxAttempts: 3, lockoutMs: 5_000, now: () => now })

    expect(limiter.recordFailure('192.0.2.1')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.recordFailure('192.0.2.1')).toEqual({ locked: false, retryAfterMs: 0 })
    expect(limiter.check('192.0.2.1').allowed).toBe(true)
    expect(limiter.recordFailure('192.0.2.1')).toEqual({ locked: true, retryAfterMs: 5_000 })
    expect(limiter.check('192.0.2.1')).toEqual({ allowed: false, retryAfterMs: 5_000 })
    expect(limiter.check('198.51.100.2').allowed).toBe(true)

    now += 5_000
    expect(limiter.check('192.0.2.1')).toEqual({ allowed: true, retryAfterMs: 0 })
  })

  it('clears failures after a successful login', () => {
    const limiter = new LoginRateLimiter({ maxAttempts: 2, lockoutMs: 5_000 })
    limiter.recordFailure('client')
    limiter.recordSuccess('client')

    expect(limiter.recordFailure('client').locked).toBe(false)
  })
})

describe('requireAuth', () => {
  function responseDouble(): ServerResponse & {
    setHeader: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  } {
    return {
      statusCode: 200,
      headersSent: false,
      setHeader: vi.fn(),
      end: vi.fn()
    } as unknown as ServerResponse & {
      setHeader: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
    }
  }

  it('completes an unauthenticated API request with 401', () => {
    const response = responseDouble()
    const allowed = requireAuth({ headers: {} }, response, new SessionStore())

    expect(allowed).toBe(false)
    expect(response.statusCode).toBe(401)
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Authentication required' }))
  })

  it('allows a request carrying a valid session cookie', () => {
    const sessions = new SessionStore()
    const token = sessions.createSession()
    const response = responseDouble()

    expect(
      requireAuth({ headers: { cookie: `tippybot_session=${token}` } }, response, sessions)
    ).toBe(true)
    expect(response.end).not.toHaveBeenCalled()
  })
})
