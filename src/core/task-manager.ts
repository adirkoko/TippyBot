// src/core/task-manager.ts
import type {
  ActiveTaskInfo,
  ITaskManager,
  StartTaskOptions,
  TaskCancelResult,
  TaskEndReason,
  TaskHandle
} from '../interfaces/tasks'
import type { PermissionLevel } from '../interfaces/permissions'
import { levelMeets } from '../utils/permissionLevel'
import { normalizeUsername } from '../utils/validation'

interface ActiveTaskRecord {
  id: number
  name: string
  requestedBy: string
  startedAt: number
  timeoutHandle: ReturnType<typeof setTimeout>
  controller: AbortController
  onEnd: (reason: TaskEndReason) => void
  ended: boolean
}

export class TaskManager implements ITaskManager {
  private nextId = 0
  private active: ActiveTaskRecord | null = null

  start(options: StartTaskOptions): TaskHandle | null {
    if (this.active) return null

    const id = ++this.nextId
    const controller = new AbortController()

    const record: ActiveTaskRecord = {
      id,
      name: options.name,
      requestedBy: normalizeUsername(options.requestedBy),
      startedAt: Date.now(),
      controller,
      onEnd: options.onEnd,
      ended: false,
      timeoutHandle: setTimeout(() => this.end(id, 'timeout'), options.timeoutMs)
    }
    this.active = record

    return {
      id,
      signal: controller.signal,
      finish: () => this.finish(id)
    }
  }

  getActive(): ActiveTaskInfo | undefined {
    if (!this.active) return undefined
    const { id, name, requestedBy, startedAt } = this.active
    return { id, name, requestedBy, startedAt }
  }

  cancel(actorUsername: string, actorLevel: PermissionLevel): TaskCancelResult {
    if (!this.active) return { ok: false, message: "There's nothing running right now." }

    const actor = normalizeUsername(actorUsername)
    const isOwner = actor === this.active.requestedBy
    const isStaff = levelMeets(actorLevel, 'operator')
    if (!isOwner && !isStaff) {
      return { ok: false, message: 'Only the requester or an Operator can cancel this.' }
    }

    const name = this.active.name
    this.end(this.active.id, 'cancelled')
    return { ok: true, message: `Cancelled "${name}".` }
  }

  abort(reason: Extract<TaskEndReason, 'disconnected' | 'death'>): void {
    if (this.active) this.end(this.active.id, reason)
  }

  /** Normal completion (success or failure) -- clears state without notifying onEnd. */
  private finish(id: number): void {
    if (!this.active || this.active.id !== id || this.active.ended) return
    this.active.ended = true
    clearTimeout(this.active.timeoutHandle)
    this.active = null
  }

  /** Abnormal end -- notifies onEnd, then clears. */
  private end(id: number, reason: TaskEndReason): void {
    if (!this.active || this.active.id !== id || this.active.ended) return
    const record = this.active
    record.ended = true
    clearTimeout(record.timeoutHandle)
    record.controller.abort()
    this.active = null
    record.onEnd(reason)
  }
}
