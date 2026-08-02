import { describe, expect, it } from 'vitest'
import {
  exactWordMatch,
  getSignForward,
  linesFromTileEntityNBT,
  tidyLines,
  toPlainStringFromComponent,
  unwrapDoubleQuotes
} from '../../src/utils/signUtils'

describe('unwrapDoubleQuotes', () => {
  it('strips matching surrounding double quotes', () => {
    expect(unwrapDoubleQuotes('"hello"')).toBe('hello')
  })

  it('leaves a string without surrounding quotes untouched', () => {
    expect(unwrapDoubleQuotes('hello')).toBe('hello')
  })

  it('coerces non-string values to a string', () => {
    expect(unwrapDoubleQuotes(42)).toBe('42')
    expect(unwrapDoubleQuotes(null)).toBe('')
  })
})

describe('toPlainStringFromComponent', () => {
  it('returns plain strings unchanged', () => {
    expect(toPlainStringFromComponent('hello')).toBe('hello')
  })

  it('extracts text from a chat component object', () => {
    expect(toPlainStringFromComponent({ text: 'hello' })).toBe('hello')
  })

  it('appends extras from a chat component', () => {
    expect(
      toPlainStringFromComponent({ text: 'hello ', extra: [{ text: 'world' }] })
    ).toBe('hello world')
  })

  it('joins an array of components', () => {
    expect(toPlainStringFromComponent([{ text: 'a' }, { text: 'b' }])).toBe('ab')
  })

  it('parses a JSON-encoded text component string', () => {
    expect(toPlainStringFromComponent('{"text":"hello"}')).toBe('hello')
  })

  it('returns an empty string for null or undefined', () => {
    expect(toPlainStringFromComponent(null)).toBe('')
    expect(toPlainStringFromComponent(undefined)).toBe('')
  })
})

describe('tidyLines', () => {
  it('strips Minecraft color codes', () => {
    expect(tidyLines(['§6Gold§r'])).toEqual(['Gold'])
  })

  it('drops empty, null, and undefined-looking entries', () => {
    expect(tidyLines(['', 'null', 'undefined', 'real line', null, undefined])).toEqual([
      'real line'
    ])
  })
})

describe('exactWordMatch', () => {
  it('matches a line equal to the target after trimming', () => {
    expect(exactWordMatch(['  Alice  ', 'Bob'], 'Alice')).toBe(true)
  })

  it('does not match a partial substring', () => {
    expect(exactWordMatch(['Alice2'], 'Alice')).toBe(false)
  })
})

describe('linesFromTileEntityNBT', () => {
  it('reads legacy Text1-4 fields', () => {
    const nbt = {
      Text1: { value: '"Alice"' },
      Text2: { value: '"line2"' },
      Text3: { value: '""' },
      Text4: { value: '""' }
    }

    expect(linesFromTileEntityNBT(nbt)).toEqual({ front: ['Alice', 'line2'], back: [] })
  })

  it('reads modern front_text/back_text.messages fields', () => {
    const nbt = {
      front_text: { messages: ['"Alice"', '""'] },
      back_text: { messages: ['"back line"'] }
    }

    expect(linesFromTileEntityNBT(nbt)).toEqual({
      front: ['Alice'],
      back: ['back line']
    })
  })

  it('returns empty arrays when no recognizable fields are present', () => {
    expect(linesFromTileEntityNBT({})).toEqual({ front: [], back: [] })
  })
})

describe('getSignForward', () => {
  it('uses the facing property when present', () => {
    const block = { getProperties: () => ({ facing: 'north' }) }
    const forward = getSignForward(block)

    expect([forward.x, forward.y, forward.z]).toEqual([0, 0, -1])
  })

  it('falls back to south when no properties are available', () => {
    const block = { getProperties: () => null }
    const forward = getSignForward(block)

    expect([forward.x, forward.y, forward.z]).toEqual([0, 0, 1])
  })
})
