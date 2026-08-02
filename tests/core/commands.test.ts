import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../src/core/commands'
import type { ICommand } from '../../src/interfaces/command'
import type { IBotContext } from '../../src/interfaces/bot-context'
import { createFakeLogger } from '../helpers/fakeLogger'

function makeCtx(prefix = '!'): IBotContext {
  return {
    config: { commandPrefix: prefix },
    logger: createFakeLogger()
  } as unknown as IBotContext
}

describe('CommandRegistry', () => {
  it('registers a command under its name and aliases, case-insensitively', () => {
    const registry = new CommandRegistry()
    const command: ICommand = { name: 'Come', aliases: ['C'], execute: vi.fn() }

    registry.register(command)

    expect(registry.get('come')).toBe(command)
    expect(registry.get('COME')).toBe(command)
    expect(registry.get('c')).toBe(command)
  })

  it('ignores messages that do not start with the configured prefix', async () => {
    const registry = new CommandRegistry()
    const execute = vi.fn()
    registry.register({ name: 'ping', execute })

    const ctx = makeCtx()
    await registry.handleChatMessage('alice', 'ping', ctx)

    expect(execute).not.toHaveBeenCalled()
  })

  it('parses the command name and args after the prefix and executes it', async () => {
    const registry = new CommandRegistry()
    const execute = vi.fn().mockResolvedValue(undefined)
    registry.register({ name: 'come', execute })

    const ctx = makeCtx()
    await registry.handleChatMessage('alice', '!come bob', ctx)

    expect(execute).toHaveBeenCalledWith({
      ctx,
      username: 'alice',
      rawMessage: '!come bob',
      args: ['bob']
    })
  })

  it('logs and does not throw for an unknown command', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx()

    await expect(registry.handleChatMessage('alice', '!missing', ctx)).resolves.toBeUndefined()
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('missing'))
  })

  it('ignores an empty message consisting only of the prefix', async () => {
    const registry = new CommandRegistry()
    const execute = vi.fn()
    registry.register({ name: 'ping', execute })

    const ctx = makeCtx()
    await registry.handleChatMessage('alice', '!', ctx)

    expect(execute).not.toHaveBeenCalled()
  })
})
