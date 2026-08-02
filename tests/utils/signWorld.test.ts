import { describe, expect, it } from 'vitest'
import { getSignLinesFromWorldState } from '../../src/utils/signWorld'

describe('getSignLinesFromWorldState', () => {
  it('returns null for a missing block', () => {
    expect(getSignLinesFromWorldState(null)).toBeNull()
  })

  it('extracts lines from a legacy blockEntity NBT payload', () => {
    const block = {
      blockEntity: {
        Text1: { value: '"Alice"' },
        Text2: { value: '""' },
        Text3: { value: '""' },
        Text4: { value: '""' }
      }
    }

    expect(getSignLinesFromWorldState(block)).toEqual({ front: ['Alice'], back: [] })
  })

  it('extracts lines from a modern front_text/back_text payload nested under .value', () => {
    const block = {
      nbt: {
        value: {
          front_text: { messages: ['"Alice"'] },
          back_text: { messages: [] }
        }
      }
    }

    expect(getSignLinesFromWorldState(block)).toEqual({ front: ['Alice'], back: [] })
  })

  it('returns null when the block has no usable sign data', () => {
    expect(getSignLinesFromWorldState({ name: 'oak_sign' })).toBeNull()
  })

  it('returns null instead of throwing on malformed data', () => {
    const block = { blockEntity: { front_text: { messages: null } } }

    expect(getSignLinesFromWorldState(block)).toBeNull()
  })
})
