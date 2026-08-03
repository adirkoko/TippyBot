// src/interfaces/bot-context.ts
import type { Bot } from 'mineflayer'
import type { IBotConfig } from './config'
import type { ILogger } from './logger'
import type { IActionRegistry } from './action'
import type { ICommandRegistry } from './command'
import type { IPathfinderLock } from './pathfinder-lock'
import type { IPermissionService } from './permissions'
import type { ITaskManager } from './tasks'
import type { ICooldownService } from './cooldown'
import type { IHomeService } from './homes'

export interface IBotContext {
  bot: Bot
  config: IBotConfig
  logger: ILogger

  actions: IActionRegistry
  commands: ICommandRegistry
  pathfinderLock: IPathfinderLock
  permissions: IPermissionService
  tasks: ITaskManager
  cooldowns: ICooldownService
  homes: IHomeService
}
