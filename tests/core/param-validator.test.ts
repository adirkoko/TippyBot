import { describe, expect, it, vi } from 'vitest'
import { validateParams } from '../../src/core/param-validator'
import type { ICommand } from '../../src/interfaces/command'

function makeCommand(overrides: Partial<ICommand> = {}): ICommand {
  return {
    name: 'test',
    requiredLevel: 'user',
    usage: '!test <a> [b]',
    execute: vi.fn(),
    ...overrides
  }
}

describe('validateParams: commands without a declared schema', () => {
  it('accepts anything when params is undefined', () => {
    const command = makeCommand({ params: undefined })

    expect(validateParams(command, ['anything', 'goes', 'here'])).toEqual({ ok: true })
  })
})

describe('validateParams: required vs optional, and count', () => {
  it('accepts exactly the right number of required args', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'string' }] })

    expect(validateParams(command, ['alice'])).toEqual({ ok: true })
  })

  it('rejects missing required args with a usage message', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'string' }] })

    const result = validateParams(command, [])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('Usage: !test')
  })

  it('accepts zero args when the only param is optional', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'string', optional: true }] })

    expect(validateParams(command, [])).toEqual({ ok: true })
  })

  it('rejects too many arguments', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'string', optional: true }] })

    const result = validateParams(command, ['alice', 'bob'])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('Too many arguments')
  })

  it('rejects any argument when the command declares zero params', () => {
    const command = makeCommand({ params: [] })

    const result = validateParams(command, ['unexpected'])
    expect(result.ok).toBe(false)
  })
})

describe('validateParams: playerName type', () => {
  it('accepts a valid player name', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'playerName' }] })

    expect(validateParams(command, ['Player_One'])).toEqual({ ok: true })
  })

  it('rejects an invalid player name', () => {
    const command = makeCommand({ params: [{ name: 'player', type: 'playerName' }] })

    const result = validateParams(command, ['not a name!'])
    expect(result.ok).toBe(false)
  })
})

describe('validateParams: groupName type', () => {
  it('accepts a valid group name', () => {
    const command = makeCommand({ params: [{ name: 'group', type: 'groupName' }] })

    expect(validateParams(command, ['Builders-Team'])).toEqual({ ok: true })
  })

  it('rejects an invalid group name', () => {
    const command = makeCommand({ params: [{ name: 'group', type: 'groupName' }] })

    expect(validateParams(command, ['bad group name']).ok).toBe(false)
  })
})

describe('validateParams: integer type', () => {
  it('accepts an integer within range', () => {
    const command = makeCommand({ params: [{ name: 'amount', type: 'integer', min: 1, max: 10 }] })

    expect(validateParams(command, ['5'])).toEqual({ ok: true })
  })

  it('rejects a non-integer value', () => {
    const command = makeCommand({ params: [{ name: 'amount', type: 'integer' }] })

    const result = validateParams(command, ['abc'])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('whole number')
  })

  it('rejects a value below the minimum', () => {
    const command = makeCommand({ params: [{ name: 'amount', type: 'integer', min: 1 }] })

    const result = validateParams(command, ['0'])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('at least 1')
  })

  it('rejects a value above the maximum', () => {
    const command = makeCommand({ params: [{ name: 'amount', type: 'integer', max: 10 }] })

    const result = validateParams(command, ['11'])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('at most 10')
  })
})

describe('validateParams: enum type', () => {
  it('accepts an allowed value, case-insensitively', () => {
    const command = makeCommand({ params: [{ name: 'level', type: 'enum', values: ['operator', 'member'] }] })

    expect(validateParams(command, ['Operator'])).toEqual({ ok: true })
  })

  it('rejects a disallowed value and lists the allowed ones', () => {
    const command = makeCommand({ params: [{ name: 'level', type: 'enum', values: ['operator', 'member'] }] })

    const result = validateParams(command, ['admin'])
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('operator, member')
  })
})
