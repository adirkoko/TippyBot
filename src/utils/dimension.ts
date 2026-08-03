// src/utils/dimension.ts
import type { Dimension } from 'mineflayer'

/** Friendlier chat text than mineflayer's raw dimension identifiers. */
export function formatDimension(dimension: Dimension): string {
  switch (dimension) {
    case 'the_nether':
      return 'nether'
    case 'the_end':
      return 'end'
    default:
      return 'overworld'
  }
}
