// src/interfaces/action.ts
import type { IBotContext } from './bot-context'

export interface IAction {
  /** The unique name of the action */
  name: string
  description?: string
  category?: string

  run(ctx: IBotContext, args: string[]): Promise<void>
}

export interface IActionRegistry {
  register(action: IAction): void
  get(name: string): IAction | undefined

  run(name: string, ctx: IBotContext, args?: string[]): Promise<void>
  runSequence(steps: string[], ctx: IBotContext): Promise<void>
}
