// src/interfaces/command.ts
import type { IBotContext } from './bot-context'
import type { PermissionLevel } from './permissions'
import type { CommandCooldownConfig } from './cooldown'
import type { ParamSpec } from './params'

export interface ICommandContext {
  ctx: IBotContext
  username: string
  rawMessage: string
  args: string[]
}

export interface ICommand {
  name: string
  aliases?: string[]
  description?: string
  usage?: string
  /** Minimum permission level required to run this command; checked centrally before execute() is called. */
  requiredLevel: PermissionLevel
  /** Declares this command's positional args; checked centrally before execute(). Omit if the command parses its own (e.g. variable subcommand trees). */
  params?: ParamSpec[]
  /** Declares this command's cooldown; enforced centrally before execute(). Omit for no cooldown. */
  cooldown?: CommandCooldownConfig

  execute(commandCtx: ICommandContext): Promise<void>
}

export interface ICommandRegistry {
  register(command: ICommand): void
  get(name: string): ICommand | undefined

  handleChatMessage(
    username: string,
    message: string,
    ctx: IBotContext
  ): Promise<void>
}
