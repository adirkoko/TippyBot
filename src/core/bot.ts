// src/core/bot.ts
import mineflayer from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import type { IBotConfig } from '../interfaces/config'
import type { IBotContext } from '../interfaces/bot-context'

import { consoleLogger } from '../utils/logger'
import { ActionRegistry } from './actions'
import { CommandRegistry } from './commands'
import { modules } from '../modules/index'
import type { IModule } from '../interfaces/module'

export async function startBot(config: IBotConfig) {
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

  const actions = new ActionRegistry()
  const commands = new CommandRegistry()

  const ctx: IBotContext = {
    bot,
    config,
    logger: consoleLogger,
    actions,
    commands
  }

  bot.once('login', () => {
    ctx.logger.info('TippyBot joined the server')
  })

  bot.on('error', (err) => {
    ctx.logger.error('Bot error', { err })
  })

  bot.on('end', () => {
    ctx.logger.warn('Bot disconnected from the server')
  })

  // Handle chat messages
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    void commands.handleChatMessage(username, message, ctx)
  })

  // Load all modules
  await loadModules(modules, ctx)
}

async function loadModules(allModules: IModule[], ctx: IBotContext) {
  for (const mod of allModules) {
    try {
      await mod.init(ctx)
      ctx.logger.info(`Loaded module: ${mod.id}`)
    } catch (err) {
      ctx.logger.error(`Failed to init module: ${mod.id}`, { err })
    }
  }
}
