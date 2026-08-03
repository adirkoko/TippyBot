export const LOG_LEVELS = ['info', 'warn', 'error', 'debug'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_CATEGORIES = [
  'connection',
  'permissions',
  'modules',
  'storage'
] as const

export type LogCategory = (typeof LOG_CATEGORIES)[number]

/**
 * The persisted and streamed representation of a log event.
 *
 * `meta` is always present so consumers do not need to special-case ordinary
 * message-only records. Values have already passed through the central log
 * redactor before a LogEntry leaves LogStore.
 */
export interface LogEntry {
  timestamp: string
  instanceId: string
  level: LogLevel
  category: LogCategory
  message: string
  meta: Record<string, unknown>
}
