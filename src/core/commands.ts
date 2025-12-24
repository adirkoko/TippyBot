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

    const commandCtx: ICommandContext = {
      ctx,
      username,
      rawMessage: message,
      args
    }

    await command.execute(commandCtx)
  }
}
