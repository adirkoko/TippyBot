import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { LoginRateLimiterOptions } from './auth/loginRateLimiter'
import { LoginRateLimiter } from './auth/loginRateLimiter'
import { requireAuth } from './auth/requireAuth'
import { SessionStore, type SessionStoreOptions } from './auth/session'
import { HttpError, Router, sendJson, setSecurityHeaders } from './router'
import { registerAuthRoutes } from './routes/auth'
import { registerDashboardRoutes } from './routes/dashboard'
import { registerLogRoutes, type BotInstanceRegistry, type LogStoreView } from './routes/logs'

const PUBLIC_FILES = new Map<string, PublicFile>([
  ['/', { name: 'dashboard.html', protected: true, contentType: 'text/html; charset=utf-8' }],
  [
    '/dashboard.html',
    { name: 'dashboard.html', protected: true, contentType: 'text/html; charset=utf-8' }
  ],
  ['/logs', { name: 'logs.html', protected: true, contentType: 'text/html; charset=utf-8' }],
  [
    '/logs.html',
    { name: 'logs.html', protected: true, contentType: 'text/html; charset=utf-8' }
  ],
  ['/login', { name: 'login.html', protected: false, contentType: 'text/html; charset=utf-8' }],
  ['/login.html', { name: 'login.html', protected: false, contentType: 'text/html; charset=utf-8' }],
  ['/styles.css', { name: 'styles.css', protected: false, contentType: 'text/css; charset=utf-8' }],
  [
    '/app.js',
    { name: 'app.js', protected: false, contentType: 'text/javascript; charset=utf-8' }
  ]
])

interface PublicFile {
  name: 'dashboard.html' | 'logs.html' | 'login.html' | 'styles.css' | 'app.js'
  protected: boolean
  contentType: string
}

export interface WebServerOptions {
  manager: BotInstanceRegistry
  getLogStore(instanceId: string): LogStoreView | undefined
  password: string
  sessions?: SessionStore
  rateLimiter?: LoginRateLimiter
  sessionOptions?: SessionStoreOptions
  rateLimiterOptions?: LoginRateLimiterOptions
  publicDir?: string
  secureCookies?: boolean
  maxBodyBytes?: number
  sseHeartbeatMs?: number
  dashboardIntervalMs?: number
}

export interface StartWebServerOptions extends WebServerOptions {
  host: string
  port: number
}

/** Creates, but does not listen with, the Web UI's HTTP server. */
export function createWebServer(options: WebServerOptions): Server {
  if (!options.password) throw new Error('A non-empty web password is required')

  const sessions = options.sessions ?? new SessionStore(options.sessionOptions)
  const rateLimiter = options.rateLimiter ?? new LoginRateLimiter(requiredRateOptions(options))
  const publicDir = options.publicDir ?? findPublicDirectory()
  const router = new Router()

  registerAuthRoutes(router, {
    password: options.password,
    sessions,
    rateLimiter,
    maxBodyBytes: options.maxBodyBytes,
    secureCookies: options.secureCookies
  })
  registerLogRoutes(router, {
    manager: options.manager,
    getLogStore: options.getLogStore,
    isAuthenticated: (request) => sessions.isAuthenticated(request),
    heartbeatMs: options.sseHeartbeatMs
  })
  registerDashboardRoutes(router, {
    manager: options.manager,
    isAuthenticated: (request) => sessions.isAuthenticated(request),
    intervalMs: options.dashboardIntervalMs,
    heartbeatMs: options.sseHeartbeatMs
  })

  const server = createServer((request, response) => {
    void handleRequest(request, response, router, sessions, publicDir).catch((error: unknown) => {
      handleRequestError(response, error)
    })
  })

  server.requestTimeout = 15_000
  server.headersTimeout = 20_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100

  const cleanup = setInterval(() => {
    sessions.cleanupExpired()
    rateLimiter.cleanup()
  }, 60_000)
  cleanup.unref()
  server.once('close', () => clearInterval(cleanup))

  return server
}

/** Creates the server and resolves once its TCP listener is ready. */
export async function startWebServer(options: StartWebServerOptions): Promise<Server> {
  const server = createWebServer(options)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })
  return server
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  router: Router,
  sessions: SessionStore,
  publicDir: string
): Promise<void> {
  setSecurityHeaders(response)
  const method = (request.method ?? 'GET').toUpperCase()
  const pathname = requestPathname(request)
  if (pathname.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store')
  const publicFile = PUBLIC_FILES.get(pathname)
  const isPublicLoginApi = method === 'POST' && pathname === '/api/login'
  const isPublicAsset = publicFile !== undefined && !publicFile.protected

  if (pathname === '/favicon.ico' && (method === 'GET' || method === 'HEAD')) {
    response.statusCode = 204
    response.end()
    return
  }

  if (!isPublicLoginApi && !isPublicAsset) {
    const redirectTo = publicFile?.protected && (method === 'GET' || method === 'HEAD')
      ? '/login'
      : undefined
    if (!requireAuth(request, response, sessions, { redirectTo })) return
  } else if (publicFile?.name === 'login.html' && sessions.isAuthenticated(request)) {
    response.statusCode = 302
    response.setHeader('Location', '/')
    response.end()
    return
  }

  if (method === 'GET' || method === 'POST') {
    const handled = await router.handle(request, response)
    if (handled) return
  }

  if (publicFile && (method === 'GET' || method === 'HEAD')) {
    await servePublicFile(request, response, publicDir, publicFile)
    return
  }

  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    response.setHeader('Allow', 'GET, HEAD, POST')
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

async function servePublicFile(
  request: IncomingMessage,
  response: ServerResponse,
  publicDir: string,
  file: PublicFile
): Promise<void> {
  // file.name comes from a closed allowlist above; user-controlled paths are
  // never joined to the filesystem path.
  const contents = await readFile(path.join(publicDir, file.name))
  response.statusCode = 200
  response.setHeader('Content-Type', file.contentType)
  response.setHeader('Content-Length', contents.byteLength)
  response.setHeader(
    'Cache-Control',
    file.contentType.startsWith('text/html') ? 'no-store' : 'no-cache, must-revalidate'
  )
  response.end(request.method === 'HEAD' ? undefined : contents)
}

function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    throw new HttpError(400, 'Malformed request URL')
  }
}

function handleRequestError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.destroy()
    return
  }

  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, { error: error.message })
    return
  }
  sendJson(response, 500, { error: 'Internal server error' })
}

function requiredRateOptions(options: WebServerOptions): LoginRateLimiterOptions {
  if (options.rateLimiterOptions) return options.rateLimiterOptions
  return { maxAttempts: 5, lockoutMs: 15 * 60_000 }
}

function findPublicDirectory(): string {
  const candidates = [
    path.join(__dirname, 'public'),
    path.resolve(__dirname, '../../src/web/public'),
    path.resolve(process.cwd(), 'src/web/public')
  ]
  const requiredFiles = ['dashboard.html', 'logs.html', 'login.html', 'styles.css', 'app.js']
  return candidates.find((candidate) =>
    requiredFiles.every((file) => existsSync(path.join(candidate, file)))
  ) ?? candidates[0]
}
