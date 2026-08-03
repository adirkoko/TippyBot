import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IBotInstanceHandle } from '../../interfaces/bot-instance'
import type { LogEntry } from '../../interfaces/log-entry'
import { HttpError, type Router, sendJson } from '../router'

const DEFAULT_HISTORY_LIMIT = 200
const MAX_HISTORY_LIMIT = 1_000
const MAX_PENDING_SSE_MESSAGES = 500

export interface LogStoreView {
  readRecent(options: { limit?: number; before?: string }): Promise<{
    entries: LogEntry[]
    nextBefore?: string
  }>
  subscribe(listener: (entry: LogEntry) => void): () => void
}

export interface BotInstanceRegistry {
  getInstances(): IBotInstanceHandle[]
  getInstance(id: string): IBotInstanceHandle | undefined
}

export interface LogRoutesOptions {
  manager: BotInstanceRegistry
  getLogStore(instanceId: string): LogStoreView | undefined
  /** Rechecked on each heartbeat so logout/expiry closes an existing stream. */
  isAuthenticated?: (request: IncomingMessage) => boolean
  heartbeatMs?: number
}

export function registerLogRoutes(router: Router, options: LogRoutesOptions): void {
  router.get('/api/instances', ({ response }) => {
    const instances = options.manager.getInstances().map((instance) => {
      const snapshot = instance.getSnapshot()
      return {
        id: snapshot.id,
        status: snapshot.status,
        username: snapshot.username
      }
    })
    sendJson(response, 200, { instances })
  })

  router.get('/api/logs/:id', async ({ response, params, url }) => {
    const store = findStore(options, params.id)
    const limit = parseLimit(url.searchParams.get('limit'))
    const before = parseBefore(url.searchParams.get('before'))
    try {
      const result = await store.readRecent({ limit, ...(before ? { before } : {}) })
      sendJson(response, 200, result)
    } catch (error) {
      if (before && error instanceof Error && error.message === 'Invalid log cursor') {
        throw new HttpError(400, 'Invalid before cursor')
      }
      throw error
    }
  })

  router.get('/api/logs/:id/stream', ({ request, response, params }) => {
    const store = findStore(options, params.id)
    openLogStream(request, response, params.id, store, options)
  })
}

function findStore(options: LogRoutesOptions, instanceId: string): LogStoreView {
  if (!options.manager.getInstance(instanceId)) {
    throw new HttpError(404, 'Bot instance not found')
  }

  const store = options.getLogStore(instanceId)
  if (!store) throw new HttpError(404, 'Logs are not available for this instance')
  return store
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_HISTORY_LIMIT
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'limit must be a positive integer')

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new HttpError(400, `limit must be between 1 and ${MAX_HISTORY_LIMIT}`)
  }
  return value
}

function parseBefore(raw: string | null): string | undefined {
  if (raw === null || raw === '') return undefined
  if (raw.length > 512) throw new HttpError(400, 'before cursor is too long')
  return raw
}

function openLogStream(
  request: IncomingMessage,
  response: ServerResponse,
  instanceId: string,
  store: LogStoreView,
  options: LogRoutesOptions
): void {
  const heartbeatMs = normalizeHeartbeat(options.heartbeatMs)
  let closed = false
  let canWrite = true
  const pending: string[] = []
  let unsubscribe: () => void = () => undefined

  response.statusCode = 200
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-store, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders()
  request.socket.setKeepAlive(true)

  const close = (endResponse = false, destroyResponse = false): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    response.off('drain', drain)
    request.off('close', onClose)
    response.off('close', onClose)
    pending.length = 0
    if (destroyResponse) response.destroy()
    else if (endResponse && !response.writableEnded) response.end()
  }

  const enqueue = (chunk: string): void => {
    if (closed || response.writableEnded) return
    if (!canWrite) {
      if (pending.length >= MAX_PENDING_SSE_MESSAGES) {
        // A client that never drains must not retain a socket and Node's
        // outgoing buffers indefinitely after exceeding the bounded queue.
        close(false, true)
        return
      }
      pending.push(chunk)
      return
    }
    canWrite = response.write(chunk)
  }

  const drain = (): void => {
    canWrite = true
    while (canWrite && pending.length > 0 && !closed) {
      canWrite = response.write(pending.shift() as string)
    }
  }

  const onClose = (): void => close()

  const heartbeat = setInterval(() => {
    if (options.isAuthenticated && !options.isAuthenticated(request)) {
      if (!response.writableEnded) {
        response.end('event: auth-expired\ndata: {}\n\n')
      }
      close()
      return
    }
    enqueue(`: heartbeat ${Date.now()}\n\n`)
  }, heartbeatMs)
  heartbeat.unref()

  response.on('drain', drain)
  request.on('close', onClose)
  response.on('close', onClose)

  unsubscribe = store.subscribe((entry) => {
    enqueue(`data: ${JSON.stringify(entry)}\n\n`)
  })

  enqueue(`event: ready\ndata: ${JSON.stringify({ instanceId })}\n\n`)
}

function normalizeHeartbeat(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1_000) return 15_000
  return Math.floor(value)
}
