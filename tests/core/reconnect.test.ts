import { describe, expect, it } from 'vitest'
import {
  computeReconnectDelay,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS
} from '../../src/core/reconnect'

describe('computeReconnectDelay', () => {
  it('starts at the base delay for the first attempt', () => {
    expect(computeReconnectDelay(1)).toBe(RECONNECT_BASE_DELAY_MS)
  })

  it('doubles the delay on each successive attempt', () => {
    expect(computeReconnectDelay(2)).toBe(RECONNECT_BASE_DELAY_MS * 2)
    expect(computeReconnectDelay(3)).toBe(RECONNECT_BASE_DELAY_MS * 4)
    expect(computeReconnectDelay(4)).toBe(RECONNECT_BASE_DELAY_MS * 8)
  })

  it('caps the delay so a persistently unreachable server is retried at a steady rate', () => {
    const delay = computeReconnectDelay(20)
    expect(delay).toBe(RECONNECT_MAX_DELAY_MS)
  })

  it('never exceeds the max delay once capped', () => {
    expect(computeReconnectDelay(50)).toBe(RECONNECT_MAX_DELAY_MS)
  })
})
