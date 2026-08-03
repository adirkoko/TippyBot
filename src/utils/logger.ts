// src/utils/logger.ts
// Console logger factory. Each bot instance gets its own labeled logger so
// interleaved output from multiple instances stays attributable.

import type { ILogger } from '../interfaces/logger'

export function createConsoleLogger(label: string): ILogger {
  const tag = `[${label}]`

  return {
    info(message, meta) {
      console.log(tag, '[INFO]', message, meta ?? '')
    },
    warn(message, meta) {
      console.warn(tag, '[WARN]', message, meta ?? '')
    },
    error(message, meta) {
      console.error(tag, '[ERROR]', message, meta ?? '')
    },
    debug(message, meta) {
      console.debug(tag, '[DEBUG]', message, meta ?? '')
    }
  }
}
