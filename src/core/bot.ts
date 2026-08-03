// src/core/bot.ts
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import type { IBotConfig } from '../interfaces/config'
import type { IBotContext } from '../interfaces/bot-context'
import type { IModule } from '../interfaces/module'
import type { ILogger } from '../interfaces/logger'
import type {
  BotInstanceError,
  BotInstanceSnapshot,
  BotInstanceStatus,
  IBotInstanceHandle
} from '../interfaces/bot-instance'

import { createConsoleLogger } from '../utils/logger'
import { buildSnapshot } from './bot-instance-snapshot'
import { ActionRegistry } from './actions'
import { CommandRegistry } from './commands'
import { PathfinderLock } from './pathfinder-lock'
import { PermissionService } from './permission-service'
import { JsonPermissionStore } from './permission-store'
import { TaskManager } from './task-manager'
import { CooldownService } from './cooldown-service'
import { HomeService } from './home-service'
import { JsonHomeStore } from './home-store'
import { computeReconnectDelay } from './reconnect'
import { permissionsFilePath, homesFilePath } from '../config/instancePaths'
import { modules } from '../modules/index'

/**
 * Concrete IBotInstanceHandle. `ctx` and `connectedSince` are internal book-
 * keeping used to build getSnapshot() -- they're intentionally not part of
 * IBotInstanceHandle, so nothing outside this module can reach mineflayer's
 * Bot instance or IBotContext through the handle.
 */
class BotInstance implements IBotInstanceHandle {
  status: BotInstanceStatus = 'connecting'
  lastError: BotInstanceError | undefined
  ctx: IBotContext | undefined
  connectedSince: number | undefined

  constructor(
    readonly id: string,
    readonly config: IBotConfig
  ) {}

  getStatus(): BotInstanceStatus {
    return this.status
  }

  getLastError(): BotInstanceError | undefined {
    return this.lastError
  }

  getSnapshot(): BotInstanceSnapshot {
    return buildSnapshot({
      id: this.id,
      config: this.config,
      status: this.status,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
      bot: this.status === 'online' ? this.ctx?.bot : undefined,
      activeTask: this.ctx?.tasks.getActive()
    })
  }
}

/**
 * Starts a single bot instance and returns a handle to it right away --
 * connecting, module loading, and reconnection all continue in the
 * background, and the handle's status/snapshot update as that happens (see
 * BotInstance above). Every piece of state this instance owns (permissions,
 * homes, auth cache, log lines) is namespaced under `config.id`, so multiple
 * instances can run in the same process without ever touching each other's
 * data. A fatal startup error (e.g. a corrupt permissions file on disk) is
 * caught here and reflected as an 'errored' status on the handle rather than
 * rejecting into the caller -- BotManager doesn't need to isolate failures
 * itself, this function already never throws.
 */
export function startBot(config: IBotConfig): IBotInstanceHandle {
  const logger = createConsoleLogger(config.id)
  const instance = new BotInstance(config.id, config)

  runInstance(config, logger, instance).catch((err) => {
    instance.status = 'errored'
    instance.lastError = { message: err instanceof Error ? err.message : String(err), at: Date.now() }
    logger.error('Fatal error starting bot instance', { err })
  })

  return instance
}

async function runInstance(config: IBotConfig, logger: ILogger, instance: BotInstance): Promise<void> {
  // Services shared across reconnects -- only `bot` itself is recreated per connection attempt.
  const actions = new ActionRegistry()
  const commands = new CommandRegistry()
  const pathfinderLock = new PathfinderLock()
  const permissionStore = new JsonPermissionStore(permissionsFilePath(config.id))
  const permissions = new PermissionService(config.admins, permissionStore, logger)
  const tasks = new TaskManager()
  const cooldowns = new CooldownService()
  const homeStore = new JsonHomeStore(homesFilePath(config.id))
  const homes = new HomeService(homeStore)

  await permissions.load()
  await homes.load()

  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  async function connect(): Promise<void> {
    const bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      profilesFolder: config.profilesFolder,

      onMsaCode: (data) => {
        console.log('================================================')
        console.log(`TippyBot Microsoft Authentication [${config.id}]`)
        console.log('Link: https://www.microsoft.com/link')
        console.log(`Code: ${data.user_code}`)
        console.log('================================================')
      }
    })

    bot.loadPlugin(pathfinder)

    const ctx: IBotContext = {
      bot,
      config,
      logger,
      actions,
      commands,
      pathfinderLock,
      permissions,
      tasks,
      cooldowns,
      homes
    }
    instance.ctx = ctx

    bot.once('login', () => {
      reconnectAttempts = 0
      instance.status = 'online'
      instance.connectedSince = Date.now()
      logger.info('TippyBot joined the server')
    })

    bot.on('error', (err) => {
      logger.error('Bot error', { err })
    })

    bot.on('kicked', (reason, loggedIn) => {
      logger.warn('Bot was kicked from the server', { reason, loggedIn })
    })

    bot.on('death', () => {
      tasks.abort('death')
    })

    bot.on('end', (reason) => {
      tasks.abort('disconnected')
      instance.status = 'reconnecting'
      instance.connectedSince = undefined
      logger.warn('Bot disconnected from the server', { reason })
      scheduleReconnect()
    })

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      void commands.handleChatMessage(username, message, ctx)
    })

    await loadModules(modules, ctx)
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return // a reconnect is already scheduled -- never run two in parallel

    reconnectAttempts++
    const delay = computeReconnectDelay(reconnectAttempts)
    logger.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`)

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect().catch((err) => logger.error('Reconnect attempt failed', { err }))
    }, delay)
  }

  await connect()
}

async function loadModules(allModules: IModule[], ctx: IBotContext): Promise<void> {
  for (const mod of allModules) {
    try {
      await mod.init(ctx)
      ctx.logger.info(`Loaded module: ${mod.id}`)
    } catch (err) {
      ctx.logger.error(`Failed to init module: ${mod.id}`, { err })
    }
  }
}
