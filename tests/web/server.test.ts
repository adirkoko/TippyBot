import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BotInstanceSnapshot, IBotInstanceHandle } from '../../src/interfaces/bot-instance'
import type { IBotConfig } from '../../src/interfaces/config'
import type { LogEntry } from '../../src/interfaces/log-entry'
import { LoginRateLimiter } from '../../src/web/auth/loginRateLimiter'
import { SessionStore } from '../../src/web/auth/session'
import { createWebServer } from '../../src/web/server'
import type { BotInstanceRegistry, LogStoreView } from '../../src/web/routes/logs'

class FakeLogStore implements LogStoreView {
  readonly listeners = new Set<(entry: LogEntry) => void>()
  readonly readRecent = vi.fn(async (_options: { limit?: number; before?: string }) => ({
    entries: [logEntry('history')],
    nextBefore: 'older-cursor'
  }))

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(entry: LogEntry): void {
    for (const listener of this.listeners) listener(entry)
  }
}

let activeServer: Server | undefined

afterEach(async () => {
  if (!activeServer) return
  const server = activeServer
  activeServer = undefined
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
})

describe('web server', () => {
  it('keeps the login assets public and protects the page and APIs', async () => {
    const { baseUrl } = await launch()

    const page = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/login')

    const api = await fetch(`${baseUrl}/api/instances`)
    expect(api.status).toBe(401)
    await expect(api.json()).resolves.toEqual({ error: 'Authentication required' })

    const [login, styles, script] = await Promise.all([
      fetch(`${baseUrl}/login`),
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/app.js`)
    ])
    expect(login.status).toBe(200)
    expect(login.headers.get('content-type')).toContain('text/html')
    expect(styles.status).toBe(200)
    expect(script.status).toBe(200)
    expect(styles.headers.get('cache-control')).toBe('no-cache, must-revalidate')
    expect(script.headers.get('cache-control')).toBe('no-cache, must-revalidate')
  })

  it('creates an HttpOnly session on login and revokes it on logout', async () => {
    const { baseUrl } = await launch()
    const login = await postLogin(baseUrl, 'correct-password')

    expect(login.response.status).toBe(200)
    expect(login.setCookie).toContain('HttpOnly')
    expect(login.setCookie).toContain('SameSite=Strict')

    const allowed = await fetch(`${baseUrl}/api/instances`, {
      headers: { Cookie: login.cookie }
    })
    expect(allowed.status).toBe(200)

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: login.cookie }
    })
    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')

    const revoked = await fetch(`${baseUrl}/api/instances`, {
      headers: { Cookie: login.cookie }
    })
    expect(revoked.status).toBe(401)
  })

  it('marks session cookies Secure when configured for HTTPS', async () => {
    const { baseUrl } = await launch({ secureCookies: true })
    const login = await postLogin(baseUrl, 'correct-password')

    expect(login.setCookie).toContain('Secure')

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: login.cookie }
    })
    expect(logout.headers.get('set-cookie')).toContain('Secure')
  })

  it('locks only the client IP after the configured number of failed logins', async () => {
    const { baseUrl } = await launch({ maxAttempts: 2, lockoutMs: 30_000 })

    expect((await postLogin(baseUrl, 'wrong-one')).response.status).toBe(401)
    const threshold = await postLogin(baseUrl, 'wrong-two')
    expect(threshold.response.status).toBe(429)
    expect(threshold.response.headers.get('retry-after')).toBe('30')

    const blockedCorrectPassword = await postLogin(baseUrl, 'correct-password')
    expect(blockedCorrectPassword.response.status).toBe(429)
  })

  it('does not let a staggered correct login bypass a concurrent lockout', async () => {
    const { baseUrl, rateLimiter } = await launch({ maxAttempts: 1, lockoutMs: 30_000 })
    const checkSpy = vi.spyOn(rateLimiter, 'check')
    const slowCorrectLogin = startStaggeredLogin(baseUrl)

    // The partial body lets this request pass the first limiter check and then
    // pause inside readJsonBody while a second request reaches the threshold.
    await waitFor(() => checkSpy.mock.calls.length >= 1)
    const lockingFailure = await postLogin(baseUrl, 'wrong-password')
    expect(lockingFailure.response.status).toBe(429)

    const delayedResult = await slowCorrectLogin.finish('correct-password"}')
    expect(delayedResult.statusCode).toBe(429)
    expect(delayedResult.setCookie).toBeUndefined()
  })

  it('returns safe instance summaries and forwards history pagination', async () => {
    const { baseUrl, store } = await launch()
    const { cookie } = await postLogin(baseUrl, 'correct-password')

    const instancesResponse = await fetch(`${baseUrl}/api/instances`, { headers: { Cookie: cookie } })
    await expect(instancesResponse.json()).resolves.toEqual({
      instances: [{ id: 'alpha', status: 'online', username: 'AlphaBot' }]
    })

    const historyResponse = await fetch(
      `${baseUrl}/api/logs/alpha?limit=17&before=opaque-cursor`,
      { headers: { Cookie: cookie } }
    )
    expect(historyResponse.status).toBe(200)
    await expect(historyResponse.json()).resolves.toEqual({
      entries: [logEntry('history')],
      nextBefore: 'older-cursor'
    })
    expect(store.readRecent).toHaveBeenCalledWith({ limit: 17, before: 'opaque-cursor' })

    const unknown = await fetch(`${baseUrl}/api/logs/missing?limit=20`, {
      headers: { Cookie: cookie }
    })
    expect(unknown.status).toBe(404)
  })

  it('delivers live SSE entries and unsubscribes when the client disconnects', async () => {
    const { baseUrl, store } = await launch()
    const { cookie } = await postLogin(baseUrl, 'correct-password')
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/logs/alpha/stream`, {
      headers: { Cookie: cookie },
      signal: controller.signal
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(store.listeners.size).toBe(1)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) return

    let received = await readUntil(reader, 'event: ready')
    store.emit(logEntry('live delivery'))
    received += await readUntil(reader, 'live delivery')
    expect(received).toContain('"category":"modules"')
    expect(received).toContain('live delivery')

    controller.abort()
    await waitFor(() => store.listeners.size === 0)
    expect(store.listeners.size).toBe(0)
  })

  it('notifies an open SSE client when its session has been revoked', async () => {
    const { baseUrl, store } = await launch({ sseHeartbeatMs: 1_000 })
    const { cookie } = await postLogin(baseUrl, 'correct-password')
    const response = await fetch(`${baseUrl}/api/logs/alpha/stream`, {
      headers: { Cookie: cookie }
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) return
    await readUntil(reader, 'event: ready')

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    })
    expect(logout.status).toBe(204)

    const expiredEvent = await readUntil(reader, 'event: auth-expired')
    expect(expiredEvent).toContain('event: auth-expired')
    await waitFor(() => store.listeners.size === 0)
    expect(store.listeners.size).toBe(0)
  })
})

describe('method dispatch', () => {
  it('routes PUT and DELETE requests to the Router instead of rejecting them upfront', async () => {
    const { baseUrl } = await launch()
    const { cookie } = await postLogin(baseUrl, 'correct-password')

    // No route exists for this made-up path, but reaching the router (which
    // finds no match) surfaces as 404 -- previously any PUT/DELETE was
    // rejected with 405 before the router ever saw the request.
    const put = await fetch(`${baseUrl}/api/nonexistent-resource/alpha`, {
      method: 'PUT',
      headers: { Cookie: cookie }
    })
    expect(put.status).toBe(404)
    await expect(put.json()).resolves.toEqual({ error: 'Not found' })

    const del = await fetch(`${baseUrl}/api/nonexistent-resource/alpha`, {
      method: 'DELETE',
      headers: { Cookie: cookie }
    })
    expect(del.status).toBe(404)
    await expect(del.json()).resolves.toEqual({ error: 'Not found' })
  })

  it('reaches the router for PUT on a path that exists for a different method, distinguishing method-mismatch (404) from an unsupported method (405)', async () => {
    const { baseUrl } = await launch()
    const { cookie } = await postLogin(baseUrl, 'correct-password')

    // /api/instances exists (GET only); PUTting it should fall through the
    // router (no match) to a plain 404, not to the unsupported-method 405.
    const response = await fetch(`${baseUrl}/api/instances`, { method: 'PUT', headers: { Cookie: cookie } })
    expect(response.status).toBe(404)
  })

  it('still returns 405 with an updated Allow header for a genuinely unsupported method', async () => {
    const { baseUrl } = await launch()

    // /login is public, so this isolates the 405 dispatch logic from auth
    // (an unauthenticated request to a protected path 401s before the
    // method check ever runs, regardless of method -- see the auth test below).
    const response = await fetch(`${baseUrl}/login`, { method: 'PATCH' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, PUT, DELETE')
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed' })
  })

  it('leaves OPTIONS behavior unchanged (still not a recognized method)', async () => {
    const { baseUrl } = await launch()

    const response = await fetch(`${baseUrl}/login`, { method: 'OPTIONS' })

    expect(response.status).toBe(405)
  })

  it('leaves HEAD behavior unchanged for public static assets', async () => {
    const { baseUrl } = await launch()

    const response = await fetch(`${baseUrl}/login`, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('still requires authentication for PUT/DELETE on a protected path, before the request ever reaches the router', async () => {
    const { baseUrl } = await launch()

    const put = await fetch(`${baseUrl}/api/dashboard`, { method: 'PUT' })
    expect(put.status).toBe(401)

    const del = await fetch(`${baseUrl}/api/dashboard`, { method: 'DELETE' })
    expect(del.status).toBe(401)
  })

  it('returns 401, not 405, for an unsupported method on a protected path without a session -- auth runs before the method check', async () => {
    const { baseUrl } = await launch()

    const response = await fetch(`${baseUrl}/api/dashboard`, { method: 'PATCH' })

    expect(response.status).toBe(401)
  })

  it('leaves existing GET and POST routes working exactly as before', async () => {
    const { baseUrl } = await launch()
    const { cookie } = await postLogin(baseUrl, 'correct-password')

    const get = await fetch(`${baseUrl}/api/instances`, { headers: { Cookie: cookie } })
    expect(get.status).toBe(200)

    const post = await fetch(`${baseUrl}/api/logout`, { method: 'POST', headers: { Cookie: cookie } })
    expect(post.status).toBe(204)
  })
})

interface LaunchOptions {
  maxAttempts?: number
  lockoutMs?: number
  sseHeartbeatMs?: number
  secureCookies?: boolean
}

async function launch(options: LaunchOptions = {}): Promise<{
  baseUrl: string
  store: FakeLogStore
  rateLimiter: LoginRateLimiter
}> {
  const store = new FakeLogStore()
  const handle = fakeHandle()
  const rateLimiter = new LoginRateLimiter({
    maxAttempts: options.maxAttempts ?? 3,
    lockoutMs: options.lockoutMs ?? 60_000
  })
  const manager: BotInstanceRegistry = {
    getInstances: () => [handle],
    getInstance: (id) => id === handle.id ? handle : undefined
  }
  activeServer = createWebServer({
    manager,
    getLogStore: (id) => id === handle.id ? store : undefined,
    password: 'correct-password',
    sessions: new SessionStore(),
    rateLimiter,
    publicDir: path.resolve(process.cwd(), 'src/web/public'),
    sseHeartbeatMs: options.sseHeartbeatMs,
    secureCookies: options.secureCookies
  })
  await new Promise<void>((resolve, reject) => {
    activeServer?.once('error', reject)
    activeServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = activeServer.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}`, store, rateLimiter }
}

function startStaggeredLogin(baseUrl: string): {
  finish(remainder: string): Promise<{
    statusCode: number
    setCookie: string[] | undefined
  }>
} {
  let finishRequest: (remainder: string) => void = () => undefined
  const result = new Promise<{ statusCode: number; setCookie: string[] | undefined }>((resolve, reject) => {
    const request = httpRequest(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (response) => {
      response.resume()
      response.once('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        setCookie: response.headers['set-cookie']
      }))
    })
    request.once('error', reject)
    request.write('{"password":"')
    finishRequest = (remainder) => request.end(remainder)
  })

  return {
    finish(remainder) {
      finishRequest(remainder)
      return result
    }
  }
}

async function postLogin(baseUrl: string, password: string): Promise<{
  response: Response
  cookie: string
  setCookie: string
}> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  const setCookie = response.headers.get('set-cookie') ?? ''
  return { response, setCookie, cookie: setCookie.split(';')[0] }
}

function fakeHandle(): IBotInstanceHandle {
  const config: IBotConfig = {
    id: 'alpha',
    host: 'example.test',
    port: 25565,
    username: 'AlphaBot',
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true
  }
  const snapshot: BotInstanceSnapshot = {
    id: config.id,
    status: 'online',
    lastError: undefined,
    host: config.host,
    port: config.port,
    username: config.username,
    uptimeMs: 1_000,
    ping: 42,
    health: 20,
    food: 20,
    position: { x: 1, y: 64, z: 2 },
    dimension: 'overworld',
    activeTask: undefined
  }
  return {
    id: config.id,
    config,
    getStatus: () => snapshot.status,
    getLastError: () => undefined,
    getSnapshot: () => snapshot,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve()
  }
}

function logEntry(message: string): LogEntry {
  return {
    timestamp: '2026-08-03T12:00:00.000Z',
    instanceId: 'alpha',
    level: 'info',
    category: 'modules',
    message,
    meta: {}
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string
): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  while (!output.includes(expected)) {
    const result = await withTimeout(reader.read(), 2_000)
    if (result.done) break
    output += decoder.decode(result.value, { stream: true })
  }
  return output
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!condition()) throw new Error('Timed out waiting for condition')
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for SSE data')), milliseconds)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
