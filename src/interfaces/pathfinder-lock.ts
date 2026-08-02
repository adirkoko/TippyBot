// src/interfaces/pathfinder-lock.ts

export interface PathfinderOwner {
  id: string
  since: number
}

/**
 * Coordinates exclusive use of the bot's pathfinder across modules so that
 * two navigation-driven commands can't set conflicting goals at once.
 */
export interface IPathfinderLock {
  /** Claims the lock for ownerId. Returns false if another owner already holds it. */
  acquire(ownerId: string): boolean
  /** Releases the lock, but only if ownerId is the current holder. */
  release(ownerId: string): void
  /** Returns the current holder, if any. */
  getOwner(): PathfinderOwner | undefined
  /** Returns true if ownerId currently holds the lock. */
  isOwnedBy(ownerId: string): boolean
}
