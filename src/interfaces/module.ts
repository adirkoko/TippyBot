// src/interfaces/module.ts
import type { IBotContext } from './bot-context'

export interface IModule {
  id: string
  version?: string
  description?: string

  init(ctx: IBotContext): void | Promise<void>
}
