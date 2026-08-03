const REDACTED = '[REDACTED]'
const MAX_DEPTH = 12

const SENSITIVE_KEY = /(?:password|passwd|pwd|secret|token|authorization|cookie|session|api.?key|user.?code|msa.?code|client.?secret|private.?key)/i

/** A stable marker makes redaction obvious in both JSONL and the web UI. */
export const REDACTED_VALUE = REDACTED

export interface RedactedLogData {
  message: string
  meta: Record<string, unknown>
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, ''))
}

/**
 * Removes common inline secret forms while retaining enough context to make
 * the log message useful. Structured metadata receives an additional key-
 * based pass in redactValue().
 */
export function redactText(input: string): string {
  return input
    // Authorization schemes can contain spaces, commas and multiple fields
    // (Basic, Digest, Negotiate, ...). Once a header/key starts, redact the
    // complete remainder of that logical line rather than only its first word.
    .replace(
      /\b(authorization)\s*([:=])\s*[^\r\n]*/gi,
      (_match, key: string, separator: string) => `${key}${separator} ${REDACTED}`
    )
    // Handle the two-part Authorization value before the generic key/value
    // pass could consume only the word "Bearer".
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    // JSON-shaped secrets, for example {"access_token":"..."}.
    .replace(
      /("(?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|session|user[_-]?code|msa[_-]?code|client[_-]?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      `$1"${REDACTED}"`
    )
    // key=value and key: value forms, including WEB_PASSWORD from env text.
    .replace(
      /\b((?:web[_-]?)?password|passwd|pwd|secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key|cookie|session|user[_-]?code|msa[_-]?code|client[_-]?secret)\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;"']+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`
    )
    // JWT credentials are sometimes logged without a descriptive key.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    // Mineflayer's Microsoft device-flow code is commonly rendered as Code: XXXX-XXXX.
    .replace(
      /\b((?:(?:microsoft|msa|device|user)\s*)?code\s*[:=]\s*)([A-Z0-9][A-Z0-9-]{3,})/gi,
      `$1${REDACTED}`
    )
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  ancestors: Set<object>,
  depth: number
): unknown {
  if (key && isSensitiveKey(key)) return REDACTED
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') return '[Function]'
  if (typeof value === 'symbol') return value.toString()
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  if (typeof value !== 'object') return String(value)

  if (ancestors.has(value)) return '[Circular]'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`

  ancestors.add(value)
  try {
    if (value instanceof Error) {
      const result: Record<string, unknown> = {
        name: redactText(value.name),
        message: redactText(value.message)
      }
      if (value.stack) result.stack = redactText(value.stack)
      if ('cause' in value) {
        result.cause = sanitizeValue(value.cause, 'cause', ancestors, depth + 1)
      }
      return result
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, undefined, ancestors, depth + 1))
    }

    const result: Record<string, unknown> = {}
    for (const property of Object.keys(value)) {
      try {
        result[property] = sanitizeValue(
          (value as Record<string, unknown>)[property],
          property,
          ancestors,
          depth + 1
        )
      } catch {
        result[property] = '[Unserializable]'
      }
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

/** Returns a detached, JSON-safe and redacted representation of any value. */
export function redactValue(value: unknown): unknown {
  return sanitizeValue(value, undefined, new Set<object>(), 0)
}

/** The single gateway used by LogStore before persistence or publication. */
export function redactLogData(
  message: string,
  meta?: Record<string, unknown>
): RedactedLogData {
  const sanitized = sanitizeValue(meta ?? {}, undefined, new Set<object>(), 0)

  return {
    message: redactText(message),
    meta: sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : {}
  }
}
