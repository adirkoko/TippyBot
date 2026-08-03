import type { LoginRateLimiter } from '../auth/loginRateLimiter'
import { verifyPassword } from '../auth/password'
import type { SessionStore } from '../auth/session'
import {
  getClientIp,
  HttpError,
  readJsonBody,
  type Router,
  sendJson,
  sendNoContent
} from '../router'

export interface AuthRoutesOptions {
  password: string
  sessions: SessionStore
  rateLimiter: LoginRateLimiter
  maxBodyBytes?: number
  secureCookies?: boolean
}

interface LoginBody {
  password?: unknown
}

export function registerAuthRoutes(router: Router, options: AuthRoutesOptions): void {
  router.post('/api/login', async ({ request, response }) => {
    response.setHeader('Cache-Control', 'no-store')
    const ip = getClientIp(request)
    const current = options.rateLimiter.check(ip)
    if (!current.allowed) {
      sendLocked(response, current.retryAfterMs)
      return
    }

    const body = await readJsonBody<LoginBody>(request, options.maxBodyBytes)
    if (!isPlainObject(body)) throw new HttpError(400, 'Expected a JSON object')

    // Recheck after the asynchronous body read. Several requests can pass the
    // early check together; from this point through verify/record there is no
    // await, so a request that reached the threshold prevents every later
    // concurrent request (including one carrying the right password) from
    // bypassing the lockout.
    const afterBody = options.rateLimiter.check(ip)
    if (!afterBody.allowed) {
      sendLocked(response, afterBody.retryAfterMs)
      return
    }

    // Calling the timing-safe verifier even for an invalid field type keeps the
    // failure path uniform. The submitted password is never logged or retained.
    const candidate = typeof body.password === 'string' ? body.password : ''
    if (!verifyPassword(candidate, options.password) || typeof body.password !== 'string') {
      const failure = options.rateLimiter.recordFailure(ip)
      if (failure.locked) {
        sendLocked(response, failure.retryAfterMs)
      } else {
        sendJson(response, 401, { error: 'Invalid password' })
      }
      return
    }

    options.rateLimiter.recordSuccess(ip)
    const token = options.sessions.createSession()
    response.setHeader('Set-Cookie', options.sessions.createCookie(token, options.secureCookies))
    sendJson(response, 200, { ok: true })
  })

  router.post('/api/logout', ({ request, response }) => {
    response.setHeader('Cache-Control', 'no-store')
    options.sessions.revoke(options.sessions.tokenFromRequest(request))
    response.setHeader('Set-Cookie', options.sessions.clearCookie(options.secureCookies))
    sendNoContent(response)
  })
}

function sendLocked(response: Parameters<typeof sendJson>[0], retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000))
  response.setHeader('Retry-After', String(seconds))
  sendJson(response, 429, {
    error: 'Too many login attempts. Try again later.',
    retryAfterMs: Math.max(0, Math.ceil(retryAfterMs))
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
