// src/utils/logger.ts
// Utility logger that logs to the console

import type { ILogger } from '../interfaces/logger'

export const consoleLogger: ILogger = {
  info(message, meta) {
    console.log('[INFO]', message, meta ?? '')
  },
  warn(message, meta) {
    console.warn('[WARN]', message, meta ?? '')
  },
  error(message, meta) {
    console.error('[ERROR]', message, meta ?? '')
  },
  debug(message, meta) {
    console.debug('[DEBUG]', message, meta ?? '')
  }
}
