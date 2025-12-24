// src/core/actions.ts
import type { IAction, IActionRegistry } from '../interfaces/action'
import type { IBotContext } from '../interfaces/bot-context'

export class ActionRegistry implements IActionRegistry {
  private actions = new Map<string, IAction>()

  register(action: IAction): void {
    this.actions.set(action.name.toLowerCase(), action)
  }

  get(name: string): IAction | undefined {
    return this.actions.get(name.toLowerCase())
  }

  async run(name: string, ctx: IBotContext, args: string[] = []): Promise<void> {
    const action = this.get(name)
    if (!action) {
      ctx.logger.warn(`Unknown action: ${name}`)
      return
    }

    await action.run(ctx, args)
  }

  async runSequence(steps: string[], ctx: IBotContext): Promise<void> {
    for (const step of steps) {
      const trimmed = step.trim()
      if (!trimmed) continue

      const [name, ...args] = trimmed.split(/\s+/)
      if (!name) continue

      await this.run(name, ctx, args)
    }
  }
}
