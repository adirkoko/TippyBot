// src/core/commands.ts
import type {
  ICommand,
  ICommandRegistry,
  ICommandContext
} from '../interfaces/command'
import type { IBotContext } from '../interfaces/bot-context'
import { validateParams } from './param-validator'
import { capitalize } from '../utils/text'

export class CommandRegistry implements ICommandRegistry {
  private commands = new Map<string, ICommand>()

  register(command: ICommand): void {
    this.commands.set(command.name.toLowerCase(), command)
    for (const alias of command.aliases ?? []) {
      this.commands.set(alias.toLowerCase(), command)
    }
  }

  get(name: string): ICommand | undefined {
    return this.commands.get(name.toLowerCase())
  }

  async handleChatMessage(username: string, message: string, ctx: IBotContext) {
    const prefix = ctx.config.commandPrefix
    if (!message.startsWith(prefix)) return

    const withoutPrefix = message.slice(prefix.length).trim()
    if (!withoutPrefix) return

    const [name, ...args] = withoutPrefix.split(/\s+/)
    const command = this.get(name)
    if (!command) {
      ctx.logger.info(`Unknown command: ${name}`)
      return
    }

    if (!ctx.permissions.canUseCommand(username, command)) {
      ctx.logger.info(
        `command denied (user=${username}, command=${command.name}, requiredLevel=${command.requiredLevel})`
      )
      const denialMessage = ctx.permissions.isBlacklisted(username)
        ? "You're not allowed to use any commands."
        : `You need ${capitalize(command.requiredLevel)} permission or higher to use this command.`
      ctx.bot.chat(denialMessage)
      return
    }

    const paramResult = validateParams(command, args)
    if (!paramResult.ok) {
      ctx.bot.chat(paramResult.message)
      return
    }

    if (command.cooldown) {
      const remainingMs = ctx.cooldowns.getRemainingMs(command.name, username, command.cooldown)
      if (remainingMs > 0) {
        ctx.bot.chat(`Please wait ${formatCooldownRemaining(remainingMs)} before using this again.`)
        return
      }
      ctx.cooldowns.recordUse(command.name, username, command.cooldown)
    }

    const commandCtx: ICommandContext = {
      ctx,
      username,
      rawMessage: message,
      args
    }

    await command.execute(commandCtx)
  }
}

function formatCooldownRemaining(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`
}
