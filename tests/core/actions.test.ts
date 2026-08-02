import { describe, expect, it, vi } from 'vitest'
import { ActionRegistry } from '../../src/core/actions'
import type { IAction } from '../../src/interfaces/action'
import type { IBotContext } from '../../src/interfaces/bot-context'
import { createFakeLogger } from '../helpers/fakeLogger'

function makeCtx(): IBotContext {
  return {
    logger: createFakeLogger()
  } as unknown as IBotContext
}

describe('ActionRegistry', () => {
  it('registers and looks up actions case-insensitively', () => {
    const registry = new ActionRegistry()
    const action: IAction = { name: 'Jump', run: vi.fn() }

    registry.register(action)

    expect(registry.get('jump')).toBe(action)
    expect(registry.get('JUMP')).toBe(action)
  })

  it('runs a registered action with the given ctx and args', async () => {
    const registry = new ActionRegistry()
    const run = vi.fn().mockResolvedValue(undefined)
    registry.register({ name: 'say', run })

    const ctx = makeCtx()
    await registry.run('say', ctx, ['hello', 'world'])

    expect(run).toHaveBeenCalledWith(ctx, ['hello', 'world'])
  })

  it('logs a warning and does not throw for an unknown action', async () => {
    const registry = new ActionRegistry()
    const ctx = makeCtx()

    await expect(registry.run('missing', ctx)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing'))
  })

  it('runs a sequence of steps in order, skipping blanks', async () => {
    const registry = new ActionRegistry()
    const calls: Array<[string, string[]]> = []

    registry.register({
      name: 'jump',
      run: async (_ctx, args = []) => {
        calls.push(['jump', args])
      }
    })
    registry.register({
      name: 'say',
      run: async (_ctx, args = []) => {
        calls.push(['say', args])
      }
    })

    const ctx = makeCtx()
    await registry.runSequence(['jump', '  ', 'say hello world'], ctx)

    expect(calls).toEqual([
      ['jump', []],
      ['say', ['hello', 'world']]
    ])
  })
})
