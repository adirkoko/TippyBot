// src/web/routes/bots.ts
// Bot instance management: create/read/update/delete plus connect,
// disconnect, and restart -- the only page allowed to mutate bot state (see
// docs/web.md). Every write goes through BotManager, never a raw handle, so
// BotManager's CRUD queue is the single coordination point for overlapping
// requests on the same instance.

import type { IncomingMessage } from 'node:http'
import { validateInstance } from '../../config/instances'
import { BotInstanceConflictError, BotInstanceNotFoundError } from '../../core/bot-errors'
import type { LogStore } from '../../core/log-store'
import type {
  BotInstanceError,
  BotInstanceStatus,
  IBotInstanceHandle,
  MicrosoftAuthStatus,
  MicrosoftDeviceCode
} from '../../interfaces/bot-instance'
import type { IBotConfig } from '../../interfaces/config'
import { redactText } from '../../utils/redaction'
import { HttpError, readJsonBody, type Router, sendJson, sendNoContent } from '../router'
import type { BotInstanceRegistry } from './logs'

/**
 * Everything the /bots page needs to render and edit one instance --
 * deliberately just IBotConfig's own (non-secret) fields plus live status.
 * No auth_cache paths are resolved or read here, and no field on IBotConfig
 * ever holds a token or credential -- auth is only ever the mode string
 * 'microsoft' | 'offline'. `msaCacheKey` is exposed so the edit form can send
 * the exact existing value straight back unchanged (see PUT below) -- it's
 * an opaque internal identity, never a secret.
 */
export interface BotSummary {
  id: string
  /** Both undefined means this instance is "unconfigured" -- see IBotConfig. */
  host: string | undefined
  port: number | undefined
  username: string
  auth: 'microsoft' | 'offline'
  commandPrefix: string
  admins: string[]
  profilesFolder: string | undefined
  msaCacheKey: string
  autoConnect: boolean
  status: BotInstanceStatus
  lastError: BotInstanceError | undefined
  /** undefined for 'offline' auth. */
  authStatus: MicrosoftAuthStatus | undefined
  authError: BotInstanceError | undefined
  minecraftProfileName: string | undefined
  deviceCode: MicrosoftDeviceCode | undefined
}

export interface BotManagementRegistry extends BotInstanceRegistry {
  addInstance(config: IBotConfig, logStore: LogStore): Promise<IBotInstanceHandle>
  removeInstance(id: string): Promise<void>
  updateInstance(id: string, config: IBotConfig): Promise<IBotInstanceHandle>
  connectInstance(id: string): Promise<void>
  disconnectInstance(id: string, reason?: string): Promise<void>
  restartInstance(id: string): Promise<void>
  authenticateInstance(id: string): Promise<void>
  cancelAuthentication(id: string): Promise<void>
}

export interface BotRoutesOptions {
  manager: BotManagementRegistry
  createLogStore(instanceId: string): LogStore
  maxBodyBytes?: number
}

export function registerBotRoutes(router: Router, options: BotRoutesOptions): void {
  router.get('/api/bots', ({ response }) => {
    sendJson(response, 200, { instances: options.manager.getInstances().map(summarize) })
  })

  router.post('/api/bots', async ({ request, response }) => {
    const config = await readValidatedConfig(request, options.maxBodyBytes, 'New bot instance')

    if (options.manager.getInstance(config.id)) {
      throw new HttpError(409, `Bot instance "${config.id}" already exists.`)
    }

    const logStore = options.createLogStore(config.id)
    await logStore.ready()

    try {
      const handle = await runManaged(() => options.manager.addInstance(config, logStore))
      sendJson(response, 201, summarize(handle))
    } catch (err) {
      await logStore.close().catch(() => undefined)
      throw err
    }
  })

  router.add('PUT', '/api/bots/:id', async ({ request, response, params }) => {
    const config = await readValidatedConfig(
      request,
      options.maxBodyBytes,
      `Bot instance "${params.id}"`,
      params.id
    )
    const handle = await runManaged(() => options.manager.updateInstance(params.id, config))
    sendJson(response, 200, summarize(handle))
  })

  router.add('DELETE', '/api/bots/:id', async ({ response, params }) => {
    await runManaged(() => options.manager.removeInstance(params.id))
    sendNoContent(response)
  })

  router.post('/api/bots/:id/connect', async ({ response, params }) => {
    await runManaged(() => options.manager.connectInstance(params.id))
    sendJson(response, 200, summarize(mustGetInstance(options.manager, params.id)))
  })

  router.post('/api/bots/:id/disconnect', async ({ response, params }) => {
    await runManaged(() => options.manager.disconnectInstance(params.id))
    sendJson(response, 200, summarize(mustGetInstance(options.manager, params.id)))
  })

  router.post('/api/bots/:id/restart', async ({ response, params }) => {
    await runManaged(() => options.manager.restartInstance(params.id))
    sendJson(response, 200, summarize(mustGetInstance(options.manager, params.id)))
  })

  router.post('/api/bots/:id/authenticate', async ({ response, params }) => {
    // authenticateInstance() can legitimately run for minutes (it waits on
    // the user), so unlike the routes above this one deliberately does NOT
    // await it fully -- doing so would hold the HTTP request open the whole
    // time. Its guard checks (already authenticating, not a 'microsoft'
    // instance, currently connecting/online/reconnecting, unknown id) run
    // synchronously inside BotInstance.authenticate() itself and reject
    // almost instantly -- far faster than any real network round-trip to
    // Microsoft could ever complete -- so draining the microtask queue once
    // reliably tells "rejected before doing any real work" apart from
    // "genuinely under way". A response that lands here because the whole
    // thing raced to completion via an already-valid cached token is also
    // handled correctly: summarize() below just reports whatever the
    // instance's current (by then final) state already is.
    const authenticating = options.manager.authenticateInstance(params.id)
    const outcome = await fastSettle(authenticating)
    if (outcome.settled && outcome.error !== undefined) throw toHttpError(outcome.error)
    sendJson(response, 200, summarize(mustGetInstance(options.manager, params.id)))
  })

  router.add('DELETE', '/api/bots/:id/authenticate', async ({ response, params }) => {
    await runManaged(() => options.manager.cancelAuthentication(params.id))
    sendJson(response, 200, summarize(mustGetInstance(options.manager, params.id)))
  })
}

/**
 * Reads and validates a request body into an IBotConfig using the exact same
 * rules as loading bots.config.json at boot (see validateInstance). When
 * forceId is given (PUT), a body id that disagrees with the URL is rejected
 * outright rather than silently overwritten -- changing an instance's id is
 * not supported.
 */
async function readValidatedConfig(
  request: IncomingMessage,
  maxBodyBytes: number | undefined,
  label: string,
  forceId?: string
): Promise<IBotConfig> {
  const body = await readJsonBody<Record<string, unknown>>(request, maxBodyBytes)
  if (!isPlainObject(body)) throw new HttpError(400, 'Expected a JSON object')

  if (forceId !== undefined && body.id !== undefined && body.id !== forceId) {
    throw new HttpError(
      400,
      `Changing a bot instance's id is not supported (body id "${String(body.id)}" does not match "${forceId}").`
    )
  }

  try {
    return validateInstance(forceId !== undefined ? { ...body, id: forceId } : body, label)
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err))
  }
}

/** Maps BotManager's typed lifecycle errors to HTTP status codes; anything else (e.g. a disk failure while saving) falls through to the generic 500. */
async function runManaged<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw toHttpError(err)
  }
}

function toHttpError(err: unknown): unknown {
  if (err instanceof BotInstanceNotFoundError) return new HttpError(404, err.message)
  if (err instanceof BotInstanceConflictError) return new HttpError(409, err.message)
  return err
}

interface FastSettleResult {
  settled: boolean
  error?: unknown
}

/**
 * Resolves once every microtask already queued at the time of the call has
 * run (via setImmediate, a full macrotask boundary), reporting whether
 * `promise` settled within that window. Real async I/O (a network call,
 * reading a file) can never complete inside a pure microtask flush, so a
 * `promise` that settles here did so for purely synchronous/in-memory
 * reasons -- exactly the guard-check case this exists to detect.
 */
function fastSettle(promise: Promise<unknown>): Promise<FastSettleResult> {
  const result: FastSettleResult = { settled: false }
  promise.then(
    () => {
      result.settled = true
    },
    (err: unknown) => {
      result.settled = true
      result.error = err
    }
  )
  return new Promise((resolve) => {
    setImmediate(() => resolve({ ...result }))
  })
}

function mustGetInstance(manager: BotInstanceRegistry, id: string): IBotInstanceHandle {
  const handle = manager.getInstance(id)
  if (!handle) throw new HttpError(404, `Bot instance "${id}" does not exist.`)
  return handle
}

function summarize(handle: IBotInstanceHandle): BotSummary {
  const config = handle.config
  const lastError = handle.getLastError()
  const authError = handle.getAuthError()

  return {
    id: config.id,
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    commandPrefix: config.commandPrefix,
    admins: [...config.admins],
    profilesFolder: config.profilesFolder,
    msaCacheKey: config.msaCacheKey,
    autoConnect: config.autoConnect,
    status: handle.getStatus(),
    lastError: lastError ? { ...lastError, message: redactText(lastError.message) } : undefined,
    authStatus: handle.getAuthStatus(),
    authError: authError ? { ...authError, message: redactText(authError.message) } : undefined,
    minecraftProfileName: handle.getMinecraftProfileName(),
    deviceCode: handle.getDeviceCode()
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
