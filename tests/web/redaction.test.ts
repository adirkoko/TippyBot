import { describe, expect, it } from 'vitest'

import { redactLogData, redactText, redactValue } from '../../src/web/redaction'

describe('log redaction', () => {
  it('redacts common inline credentials without hiding ordinary text', () => {
    expect(redactText('WEB_PASSWORD=abc123 host=localhost')).toBe(
      'WEB_PASSWORD=[REDACTED] host=localhost'
    )
    expect(redactText('Authorization: Bearer abc.def-123')).not.toContain('abc.def-123')
    expect(redactText('Microsoft Code: ABCD-EFGH')).toBe('Microsoft Code: [REDACTED]')
    expect(redactText('Loaded 3 modules')).toBe('Loaded 3 modules')
  })

  it('redacts complete authorization schemes and quoted values containing spaces', () => {
    expect(redactText('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization: [REDACTED]'
    )
    expect(redactText('Authorization: Digest username="admin", response="secret"')).toBe(
      'Authorization: [REDACTED]'
    )
    expect(redactText('WEB_PASSWORD="correct horse battery staple"')).toBe(
      'WEB_PASSWORD=[REDACTED]'
    )
    expect(redactText("secret='two words'")).toBe('secret=[REDACTED]')
  })

  it('redacts sensitive keys recursively without mutating the input', () => {
    const input = {
      username: 'alex',
      credentials: {
        api_key: 'secret-value',
        notes: ['safe', 'token=inline-secret']
      }
    }

    const output = redactValue(input)

    expect(output).toEqual({
      username: 'alex',
      credentials: {
        api_key: '[REDACTED]',
        notes: ['safe', 'token=[REDACTED]']
      }
    })
    expect(input.credentials.api_key).toBe('secret-value')
  })

  it('produces JSON-safe metadata for errors and circular objects', () => {
    const circular: Record<string, unknown> = { password: 'hidden' }
    circular.self = circular

    const result = redactLogData('failed', {
      error: new Error('token=hidden'),
      circular
    })

    expect(() => JSON.stringify(result)).not.toThrow()
    expect(JSON.stringify(result)).not.toContain('hidden')
    expect(result.meta.circular).toEqual({ password: '[REDACTED]', self: '[Circular]' })
  })
})
