// src/modules/bot-status/index.ts
// Player-facing view into the TaskManager: what the bot is doing right now, and a way to cancel it.

import type { IModule } from '../../interfaces/module'
import type { ICommand } from '../../interfaces/command'
import { reportError } from '../../utils/errors'

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  return `${seconds}s`
}

const botStatusModule: IModule = {
  id: 'bot-status',
  description: 'Reports and cancels the bot\'s currently active task',

  init(ctx) {
    const { commands, logger } = ctx

    const statusCommand: ICommand = {
      name: 'status',
      description: 'Shows what the bot is currently doing and who requested it',
      usage: '!status',
      requiredLevel: 'user',
      params: [],
      async execute({ ctx }) {
        try {
          const active = ctx.tasks.getActive()
          if (!active) {
            ctx.bot.chat("I'm not doing anything right now.")
            return
          }
          ctx.bot.chat(
            `Currently running "${active.name}" for ${active.requestedBy} (started ${formatElapsed(active.startedAt)} ago).`
          )
        } catch (err) {
          reportError(ctx, 'status command', err)
        }
      }
    }

    commands.register(statusCommand)

    const cancelCommand: ICommand = {
      name: 'cancel',
      description: "Cancels the bot's active task",
      usage: '!cancel',
      requiredLevel: 'user',
      params: [],
      async execute({ ctx, username }) {
        try {
          const result = ctx.tasks.cancel(username, ctx.permissions.getLevel(username))
          ctx.bot.chat(result.message)
        } catch (err) {
          reportError(ctx, 'cancel command', err)
        }
      }
    }

    commands.register(cancelCommand)

    const stopCommand: ICommand = {
      name: 'stop',
      description: "Immediately stops any action or task the bot is currently doing",
      usage: '!stop',
      requiredLevel: 'operator',
      params: [],
      async execute({ ctx, username }) {
        try {
          const result = ctx.tasks.cancel(username, ctx.permissions.getLevel(username))
          ctx.bot.chat(result.message)
        } catch (err) {
          reportError(ctx, 'stop command', err)
        }
      }
    }

    commands.register(stopCommand)

    logger.info('bot-status module initialized')
  }
}

export default botStatusModule
