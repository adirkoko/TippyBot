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
import type { BotInstanceError, BotInstanceStatus, IBotInstanceHandle } from '../../interfaces/bot-instance'
import type { IBotConfig } from '../../interfaces/config'
import { redactText } from '../../utils/redaction'
import { HttpError, readJsonBody, type Router, sendJson, sendNoContent } from '../router'
import type { BotInstanceRegistry } from './logs'

/**
 * Everything the /bots page needs to render and edit one instance --
 * deliberately just IBotConfig's own (non-secret) fields plus live status.
 * No auth_cache paths are resolved or read here, and no field on IBotConfig
 * ever holds a token or credential -- auth is only ever the mode string
 * 'microsoft' | 'offline'.
 */
export interface BotSummary {
  id: string
  host: string
  port: number
  username: string
  auth: 'microsoft' | 'offline'
  commandPrefix: string
  admins: string[]
  profilesFolder: string | undefined
  autoConnect: boolean
  status: BotInstanceStatus
  lastError: BotInstanceError | undefined
}

export interface BotManagementRegistry extends BotInstanceRegistry {
  addInstance(config: IBotConfig, logStore: LogStore): Promise<IBotInstanceHandle>
  removeInstance(id: string): Promise<void>
  updateInstance(id: string, config: IBotConfig): Promise<IBotInstanceHandle>
  connectInstance(id: string): Promise<void>
  disconnectInstance(id: string, reason?: string): Promise<void>
  restartInstance(id: string): Promise<void>
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
    if (err instanceof BotInstanceNotFoundError) throw new HttpError(404, err.message)
    if (err instanceof BotInstanceConflictError) throw new HttpError(409, err.message)
    throw err
  }
}

function mustGetInstance(manager: BotInstanceRegistry, id: string): IBotInstanceHandle {
  const handle = manager.getInstance(id)
  if (!handle) throw new HttpError(404, `Bot instance "${id}" does not exist.`)
  return handle
}

function summarize(handle: IBotInstanceHandle): BotSummary {
  const config = handle.config
  const lastError = handle.getLastError()

  return {
    id: config.id,
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    commandPrefix: config.commandPrefix,
    admins: [...config.admins],
    profilesFolder: config.profilesFolder,
    autoConnect: config.autoConnect,
    status: handle.getStatus(),
    lastError: lastError ? { ...lastError, message: redactText(lastError.message) } : undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
