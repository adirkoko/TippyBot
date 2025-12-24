// src/interfaces/command.ts
import type { IBotContext } from './bot-context'

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
