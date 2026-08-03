// src/core/bot-instance-snapshot.ts
// Pure mapping from raw connection state to the BotInstanceSnapshot DTO,
// kept separate from bot.ts so it's unit-testable without a real
// mineflayer connection.

import type { Dimension } from 'mineflayer'
import type { IBotConfig } from '../interfaces/config'
import type { ActiveTaskInfo } from '../interfaces/tasks'
import type { BotInstanceError, BotInstanceSnapshot, BotInstanceStatus } from '../interfaces/bot-instance'
import { formatDimension } from '../utils/dimension'

/** The handful of live mineflayer Bot fields the snapshot needs -- never the whole Bot type. */
export interface SnapshotBotSource {
  player?: { ping: number }
  health: number
  food: number
  entity?: { position: { x: number; y: number; z: number } }
  game?: { dimension: Dimension }
}

export interface BuildSnapshotParams {
  id: string
  config: IBotConfig
  status: BotInstanceStatus
  lastError: BotInstanceError | undefined
  connectedSince: number | undefined
  /** Pass only while status is 'online' -- undefined otherwise, so stale/disconnected stats never leak into the snapshot. */
  bot: SnapshotBotSource | undefined
  activeTask: ActiveTaskInfo | undefined
}

export function buildSnapshot(params: BuildSnapshotParams): BotInstanceSnapshot {
  const { id, config, status, lastError, connectedSince, bot, activeTask } = params

  return {
    id,
    status,
    lastError,

    host: config.host,
    port: config.port,
    username: config.username,

    uptimeMs: bot && connectedSince !== undefined ? Date.now() - connectedSince : undefined,
    ping: bot?.player?.ping,
    health: bot?.health,
    food: bot?.food,
    position: bot?.entity
      ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
      : undefined,
    dimension: bot?.game ? formatDimension(bot.game.dimension) : undefined,
    activeTask
  }
}
