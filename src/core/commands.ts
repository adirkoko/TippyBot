// src/core/commands.ts
import type {
  ICommand,
  ICommandRegistry,
  ICommandContext
} from '../interfaces/command'
import type { IBotContext } from '../interfaces/bot-context'

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

    const commandCtx: ICommandContext = {
      ctx,
      username,
      rawMessage: message,
      args
    }

    await command.execute(commandCtx)
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
