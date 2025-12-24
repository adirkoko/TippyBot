// src/interfaces/bot-context.ts
import type { Bot } from 'mineflayer'
import type { IBotConfig } from './config'
import type { ILogger } from './logger'
import type { IActionRegistry } from './action'
import type { ICommandRegistry } from './command'

export interface IBotContext {
  bot: Bot
  config: IBotConfig
  logger: ILogger

  actions: IActionRegistry
  commands: ICommandRegistry
}
