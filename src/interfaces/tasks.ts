// src/interfaces/tasks.ts
import type { PermissionLevel } from './permissions'

/** Why an active task ended without a normal finish(). */
export type TaskEndReason = 'timeout' | 'cancelled' | 'disconnected' | 'death'

export interface ActiveTaskInfo {
  id: number
  /** Short machine name shown in !status, e.g. 'come', 's'. */
  name: string
  requestedBy: string
  startedAt: number
}

export interface StartTaskOptions {
  name: string
  requestedBy: string
  timeoutMs: number
  /** Called once if the task ends abnormally (timeout, !cancel, or a bot lifecycle abort). Never called after finish(). */
  onEnd: (reason: TaskEndReason) => void
}

export interface TaskHandle {
  readonly id: number
  /** Aborts when the task is cancelled, times out, or is force-aborted; pass into cancellable awaits. */
  readonly signal: AbortSignal
  /** Marks the task done (success or failure) and frees the slot. Idempotent. */
  finish(): void
}

export type TaskCancelResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

/**
 * Tracks the single long-running/cancelable operation the bot is currently
 * performing (if any). No queue: a second start() while one is active is
 * refused outright, so two navigation-driven commands can never run at once.
 */
export interface ITaskManager {
  /** Claims the single task slot, or returns null if the bot is already busy. */
  start(options: StartTaskOptions): TaskHandle | null
  getActive(): ActiveTaskInfo | undefined
  /** Cancels the active task if actorUsername is its requester or actorLevel meets minStaffLevel (default Operator). */
  cancel(actorUsername: string, actorLevel: PermissionLevel, minStaffLevel?: PermissionLevel): TaskCancelResult
  /** Force-ends the active task (if any) from a bot lifecycle event, e.g. disconnect or death. */
  abort(reason: Extract<TaskEndReason, 'disconnected' | 'death'>): void
}
