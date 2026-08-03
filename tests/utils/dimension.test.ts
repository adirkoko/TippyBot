import { describe, expect, it } from 'vitest'
import { formatDimension } from '../../src/utils/dimension'

describe('formatDimension', () => {
  it('formats each known dimension', () => {
    expect(formatDimension('overworld')).toBe('overworld')
    expect(formatDimension('the_nether')).toBe('nether')
    expect(formatDimension('the_end')).toBe('end')
  })
})
