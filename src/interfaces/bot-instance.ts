// src/interfaces/bot-instance.ts
import type { IBotConfig } from './config'
import type { ActiveTaskInfo } from './tasks'

/**
 * 'disconnected' -- not currently trying to connect (never started, or connect() /
 *                   disconnect() was explicitly requested) -- no auto-retry
 * 'connecting'   -- starting up, no successful login yet
 * 'online'       -- currently logged in to the server
 * 'reconnecting' -- lost connection unexpectedly, retrying on a backoff schedule
 * 'errored'      -- startup failed fatally (e.g. corrupt config/data on disk) and is not retrying
 */
export type BotInstanceStatus = 'disconnected' | 'connecting' | 'online' | 'reconnecting' | 'errored'

/** Statuses where the instance is trying to reach (or already on) a server. */
export const ACTIVE_BOT_STATUSES: readonly BotInstanceStatus[] = ['connecting', 'online', 'reconnecting']
/** Statuses where the instance is at rest -- not connected and not retrying. */
export const INACTIVE_BOT_STATUSES: readonly BotInstanceStatus[] = ['disconnected', 'errored']

export interface BotInstanceError {
  message: string
  at: number
}

export interface BotInstancePosition {
  x: number
  y: number
  z: number
}

/**
 * Everything a control surface (e.g. a web admin panel) needs to render one
 * instance, expressed as plain data -- never mineflayer's Bot type, never
 * IBotContext. Fields that only make sense with a live connection are
 * undefined whenever the instance isn't currently 'online'.
 */
export interface BotInstanceSnapshot {
  id: string
  status: BotInstanceStatus
  lastError: BotInstanceError | undefined

  host: string
  port: number
  username: string

  /** ms since the current connection's login, or undefined when not online. */
  uptimeMs: number | undefined
  ping: number | undefined
  health: number | undefined
  food: number | undefined
  position: BotInstancePosition | undefined
  /** Friendly dimension name ('overworld' | 'nether' | 'end'), or undefined when not online. */
  dimension: string | undefined
  activeTask: ActiveTaskInfo | undefined
}

/**
 * Handle to a bot instance, returned by startBot and held by BotManager.
 * getSnapshot() is the intended read API for any control surface -- it never
 * hands out mineflayer's Bot instance or IBotContext, so that surface stays
 * decoupled from mineflayer and from the framework's internal wiring.
 *
 * connect()/disconnect() are the only lifecycle control points; both queue
 * behind any operation already in flight for this instance, so overlapping
 * calls can never race each other.
 */
export interface IBotInstanceHandle {
  readonly id: string
  readonly config: IBotConfig
  getStatus(): BotInstanceStatus
  getLastError(): BotInstanceError | undefined
  getSnapshot(): BotInstanceSnapshot
  /** Starts (or resumes) connecting. Rejects if already connecting/online/reconnecting. */
  connect(): Promise<void>
  /** Cleanly disconnects and stops auto-reconnecting until connect() is called again. Rejects if already disconnected/errored. */
  disconnect(reason?: string): Promise<void>
}
