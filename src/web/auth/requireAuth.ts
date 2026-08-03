import type { IncomingMessage, ServerResponse } from 'http'
import type { SessionStore } from './session'

export interface RequireAuthOptions {
  redirectTo?: string
}

export function isAuthenticated(
  request: Pick<IncomingMessage, 'headers'>,
  sessions: SessionStore
): boolean {
  return sessions.isAuthenticated(request)
}

/**
 * Returns true for authenticated requests. Otherwise it completes the response
 * with either a JSON 401 or a redirect and returns false.
 */
export function requireAuth(
  request: Pick<IncomingMessage, 'headers'>,
  response: ServerResponse,
  sessions: SessionStore,
  options: RequireAuthOptions = {}
): boolean {
  if (isAuthenticated(request, sessions)) return true

  if (response.headersSent) {
    response.end()
    return false
  }

  if (options.redirectTo) {
    response.statusCode = 302
    response.setHeader('Location', options.redirectTo)
    response.setHeader('Cache-Control', 'no-store')
    response.end()
    return false
  }

  const body = JSON.stringify({ error: 'Authentication required' })
  response.statusCode = 401
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
  return false
}
