// src/utils/logger.ts
// Console logger factory. Each bot instance gets its own labeled logger so
// interleaved output from multiple instances stays attributable.

import type { ILogger } from '../interfaces/logger'
import type { LogCategory, LogLevel } from '../interfaces/log-entry'
import type { LogStore } from '../core/log-store'
import { redactLogData } from './redaction'

export function createConsoleLogger(label: string, logStore?: LogStore): ILogger {
  const tag = `[${label}]`
  const categoryLoggers = new Map<LogCategory, ILogger>()

  function persist(
    level: LogLevel,
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (!logStore) return
    void logStore.append(level, category, message, meta).catch((error) => {
      // Keep this path deliberately outside ILogger/LogStore to avoid a
      // recursive persistence failure. It never includes the original entry.
      console.error(tag, '[ERROR]', 'Failed to persist log entry', { error })
    })
  }

  function forCategory(category: LogCategory): ILogger {
    const existing = categoryLoggers.get(category)
    if (existing) return existing

    const logger: ILogger = {
      info(message, meta) {
        const safe = redactLogData(message, meta)
        console.log(tag, '[INFO]', safe.message, meta === undefined ? '' : safe.meta)
        persist('info', category, message, meta)
      },
      warn(message, meta) {
        const safe = redactLogData(message, meta)
        console.warn(tag, '[WARN]', safe.message, meta === undefined ? '' : safe.meta)
        persist('warn', category, message, meta)
      },
      error(message, meta) {
        const safe = redactLogData(message, meta)
        console.error(tag, '[ERROR]', safe.message, meta === undefined ? '' : safe.meta)
        persist('error', category, message, meta)
      },
      debug(message, meta) {
        const safe = redactLogData(message, meta)
        console.debug(tag, '[DEBUG]', safe.message, meta === undefined ? '' : safe.meta)
        persist('debug', category, message, meta)
      },
      withCategory(nextCategory) {
        return forCategory(nextCategory)
      }
    }

    categoryLoggers.set(category, logger)
    return logger
  }

  // Existing callers were predominantly module/service logs; retaining that
  // as the base category also makes adoption backwards-compatible.
  return forCategory('modules')
}
