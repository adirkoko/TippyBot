import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DEFAULT_WEB_DASHBOARD_INTERVAL_MS,
  MAX_TIMER_INTERVAL_MS
} from '../../config/webConfig'
import type { BotInstanceSnapshot } from '../../interfaces/bot-instance'
import { redactText } from '../../utils/redaction'
import type { Router } from '../router'
import { sendJson } from '../router'
import type { BotInstanceRegistry } from './logs'

const DEFAULT_HEARTBEAT_MS = 15_000
const MIN_HEARTBEAT_MS = 1_000

export interface DashboardResponse {
  instances: BotInstanceSnapshot[]
}

export interface DashboardRoutesOptions {
  manager: Pick<BotInstanceRegistry, 'getInstances'>
  /** Rechecked on every update and heartbeat so logout/expiry closes the stream. */
  isAuthenticated?: (request: IncomingMessage) => boolean
  intervalMs?: number
  heartbeatMs?: number
}

export function registerDashboardRoutes(router: Router, options: DashboardRoutesOptions): void {
  const intervalMs = normalizeDashboardInterval(options.intervalMs)

  router.get('/api/dashboard', ({ response }) => {
    sendJson(response, 200, getDashboardResponse(options.manager))
  })

  router.get('/api/dashboard/stream', ({ request, response }) => {
    openDashboardStream(request, response, options, intervalMs)
  })
}

function getDashboardResponse(
  manager: Pick<BotInstanceRegistry, 'getInstances'>
): DashboardResponse {
  return {
    instances: manager.getInstances().map((instance) => redactSnapshot(instance.getSnapshot()))
  }
}

/**
 * Produces a detached DTO and redacts the only free-form diagnostic field.
 * The handle-owned snapshot is never mutated, so other consumers continue to
 * receive the original in-process error details.
 */
function redactSnapshot(snapshot: BotInstanceSnapshot): BotInstanceSnapshot {
  return {
    ...snapshot,
    lastError: snapshot.lastError
      ? { ...snapshot.lastError, message: redactText(snapshot.lastError.message) }
      : undefined,
    position: snapshot.position ? { ...snapshot.position } : undefined,
    activeTask: snapshot.activeTask ? { ...snapshot.activeTask } : undefined
  }
}

function openDashboardStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardRoutesOptions,
  intervalMs: number
): void {
  // Build the initial payload before committing SSE headers. If a broken
  // handle unexpectedly throws, the server can still return its normal 500.
  const initialSnapshot = snapshotEvent(getDashboardResponse(options.manager))
  const heartbeatMs = normalizeHeartbeat(options.heartbeatMs)
  let closed = false
  let canWrite = true
  let pendingSnapshot: string | undefined
  let updateTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  response.statusCode = 200
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-store, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.setHeader('X-Accel-Buffering', 'no')
  response.flushHeaders()
  request.socket.setKeepAlive(true)

  const close = (destroyResponse = false): void => {
    if (closed) return
    closed = true
    if (updateTimer) clearInterval(updateTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    pendingSnapshot = undefined
    response.off('drain', onDrain)
    response.off('error', onClose)
    request.off('close', onClose)
    response.off('close', onClose)
    if (destroyResponse && !response.destroyed) response.destroy()
  }

  const expireAuthentication = (): void => {
    if (closed) return
    pendingSnapshot = undefined
    if (!response.writableEnded) response.end('event: auth-expired\ndata: {}\n\n')
    close()
  }

  const authenticationIsValid = (): boolean => {
    if (!options.isAuthenticated || options.isAuthenticated(request)) return true
    expireAuthentication()
    return false
  }

  // Dashboard payloads supersede one another. While Node applies
  // backpressure, retain only the newest full snapshot instead of growing an
  // event queue for a slow client.
  const writeSnapshot = (chunk: string): void => {
    if (closed || response.writableEnded) return
    if (!canWrite) {
      pendingSnapshot = chunk
      return
    }
    canWrite = response.write(chunk)
  }

  const writeHeartbeat = (): void => {
    if (closed || response.writableEnded || !canWrite) return
    canWrite = response.write(`: heartbeat ${Date.now()}\n\n`)
  }

  const onDrain = (): void => {
    if (closed) return
    canWrite = true
    if (!pendingSnapshot) return

    const newestSnapshot = pendingSnapshot
    pendingSnapshot = undefined
    canWrite = response.write(newestSnapshot)
  }

  const onClose = (): void => close()

  response.on('drain', onDrain)
  response.on('error', onClose)
  request.on('close', onClose)
  response.on('close', onClose)

  writeSnapshot(initialSnapshot)

  updateTimer = setInterval(() => {
    if (!authenticationIsValid()) return
    try {
      writeSnapshot(snapshotEvent(getDashboardResponse(options.manager)))
    } catch {
      // A control-surface read must never crash the bot process. Terminate the
      // affected stream; a reconnect will receive a normal HTTP error if the
      // snapshot source remains unhealthy.
      close(true)
    }
  }, intervalMs)
  updateTimer.unref()

  heartbeatTimer = setInterval(() => {
    if (!authenticationIsValid()) return
    writeHeartbeat()
  }, heartbeatMs)
  heartbeatTimer.unref()
}

function snapshotEvent(payload: DashboardResponse): string {
  return `event: snapshots\ndata: ${JSON.stringify(payload)}\n\n`
}

function normalizeDashboardInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_WEB_DASHBOARD_INTERVAL_MS
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > MAX_TIMER_INTERVAL_MS
  ) {
    throw new Error(
      `Dashboard intervalMs must be an integer between 1 and ${MAX_TIMER_INTERVAL_MS}.`
    )
  }
  return interval
}

function normalizeHeartbeat(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < MIN_HEARTBEAT_MS) {
    return DEFAULT_HEARTBEAT_MS
  }
  return Math.floor(value)
}
