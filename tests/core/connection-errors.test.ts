import { describe, expect, it } from 'vitest'
import { isFatalConnectionError } from '../../src/core/connection-errors'

describe('isFatalConnectionError', () => {
  it('matches an unsupported-protocol-version error regardless of the reported version number', () => {
    expect(isFatalConnectionError(new Error("Unsupported protocol version '776'; try updating your packages with 'npm update'"))).toBe(true)
    expect(isFatalConnectionError(new Error("Unsupported protocol version '-1'"))).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isFatalConnectionError(new Error('unsupported PROTOCOL version detected'))).toBe(true)
  })

  it('does not match transient network errors', () => {
    expect(isFatalConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:25565'))).toBe(false)
    expect(isFatalConnectionError(new Error('read ECONNRESET'))).toBe(false)
    expect(isFatalConnectionError(new Error('socket hang up'))).toBe(false)
  })

  it('handles a non-Error value without throwing', () => {
    expect(isFatalConnectionError('Unsupported protocol version 5')).toBe(true)
    expect(isFatalConnectionError(undefined)).toBe(false)
  })
})
