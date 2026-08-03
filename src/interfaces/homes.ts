// src/interfaces/homes.ts
import type { Dimension } from 'mineflayer'

export interface HomeLocation {
  x: number
  y: number
  z: number
  dimension: Dimension
}

/**
 * Per-player home locations, exposed via ctx.homes. Dimension is stored
 * alongside the coordinates so a home saved in one dimension is never
 * silently walked to as if it were in another.
 */
export interface IHomeService {
  load(): Promise<void>
  getHome(username: string): HomeLocation | undefined
  setHome(username: string, location: HomeLocation): Promise<void>
}
