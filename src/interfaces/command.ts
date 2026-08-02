// src/interfaces/command.ts
import type { IBotContext } from './bot-context'
import type { PermissionLevel } from './permissions'

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
