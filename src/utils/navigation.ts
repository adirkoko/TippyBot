// src/utils/navigation.ts
// Utility functions for bot navigation and distance calculations

import type { IBotContext } from '../interfaces/bot-context'

/** Type representing a 3D vector-like object */
export type Vec3Like = {
  x: number
  y: number
  z: number
}

/**
 * Waits for the bot to reach its navigation goal, times out, or is aborted via `signal`
 * (e.g. from a TaskManager task that was cancelled or force-ended).
 * @param ctx The bot context
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param signal Optional abort signal for external cancellation
 * @returns A promise that resolves when the goal is reached, or rejects on timeout/abort
 */
export function waitForGoalReached(
  ctx: IBotContext,
  timeoutMs = 15000,
  signal?: AbortSignal
): Promise<void> {
  const { bot } = ctx

  return new Promise((resolve, reject) => {
    let done = false

    const onReached = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }

    const onTimeout = () => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('Timeout while walking to goal'))
    }

    const onAbort = () => {
      if (done) return
      done = true
      cleanup()
      reject(new Error('Navigation aborted'))
    }

    const cleanup = () => {
      bot.removeListener('goal_reached', onReached as any)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    bot.once('goal_reached', onReached as any)
    const timer = setTimeout(onTimeout, timeoutMs)
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Computes the squared distance between two positions.
 * @param a The first position
 * @param b The second position
 * @returns The squared distance between a and b
 */
export function distanceSquared(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

/**
 * Checks if two positions are within a certain distance.
 * @param a The first position
 * @param b The second position
 * @param maxDistance The maximum allowed distance
 * @returns True if the positions are within maxDistance, false otherwise
 */
export function isWithinDistance(
  a: Vec3Like,
  b: Vec3Like,
  maxDistance: number
): boolean {
  return distanceSquared(a, b) <= maxDistance * maxDistance
}

/**
 * Picks the closest position to `from`, deterministically -- so "which chest/item did you
 * mean" never depends on unspecified iteration order. Ties are broken by a stable position
 * string comparison rather than left to whatever order the candidates happened to arrive in.
 * @param candidates The candidate positions
 * @param from The reference position
 * @returns The closest candidate, or null if candidates is empty
 */
export function nearestPosition<T extends Vec3Like>(candidates: T[], from: Vec3Like): T | null {
  if (candidates.length === 0) return null

  return [...candidates].sort((a, b) => {
    const diff = distanceSquared(a, from) - distanceSquared(b, from)
    if (diff !== 0) return diff
    return positionKey(a).localeCompare(positionKey(b))
  })[0]
}

function positionKey(pos: Vec3Like): string {
  return `${pos.x},${pos.y},${pos.z}`
}
