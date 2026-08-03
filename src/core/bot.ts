// src/core/bot.ts
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import type { IBotConfig } from '../interfaces/config'
import type { IBotContext } from '../interfaces/bot-context'
import type { IModule } from '../interfaces/module'

import { consoleLogger } from '../utils/logger'
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
import { modules } from '../modules/index'

const PERMISSIONS_FILE_PATH = './data/permissions.json'
const HOMES_FILE_PATH = './data/homes.json'

export async function startBot(config: IBotConfig): Promise<void> {
  const logger = consoleLogger

  // Services shared across reconnects -- only `bot` itself is recreated per connection attempt.
  const actions = new ActionRegistry()
  const commands = new CommandRegistry()
  const pathfinderLock = new PathfinderLock()
  const permissionStore = new JsonPermissionStore(PERMISSIONS_FILE_PATH)
  const permissions = new PermissionService(config.admins, permissionStore, logger)
  const tasks = new TaskManager()
  const cooldowns = new CooldownService()
  const homeStore = new JsonHomeStore(HOMES_FILE_PATH)
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
        console.log('TippyBot Microsoft Authentication')
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

    bot.once('login', () => {
      reconnectAttempts = 0
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
