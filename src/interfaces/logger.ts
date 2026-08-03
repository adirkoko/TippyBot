import type { LogCategory } from './log-entry'

export interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  debug?(message: string, meta?: Record<string, unknown>): void
  withCategory(category: LogCategory): ILogger
}
