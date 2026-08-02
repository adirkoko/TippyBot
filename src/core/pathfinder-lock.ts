// src/core/pathfinder-lock.ts
import type { IPathfinderLock, PathfinderOwner } from '../interfaces/pathfinder-lock'

export class PathfinderLock implements IPathfinderLock {
  private owner: PathfinderOwner | undefined

  acquire(ownerId: string): boolean {
    if (this.owner && this.owner.id !== ownerId) return false
    this.owner = { id: ownerId, since: Date.now() }
    return true
  }

  release(ownerId: string): void {
    if (this.owner && this.owner.id === ownerId) {
      this.owner = undefined
    }
  }

  getOwner(): PathfinderOwner | undefined {
    return this.owner
  }

  isOwnedBy(ownerId: string): boolean {
    return this.owner?.id === ownerId
  }
}
