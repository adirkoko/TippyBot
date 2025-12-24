// src/utils/signWorld.ts
// Utility functions for extracting sign text from world state

import { linesFromTileEntityNBT } from './signUtils'

/** Type representing the lines on the front and back of a sign */
export type SignLines = { front: string[]; back: string[] }

/** Extract sign lines from a block's world state
 * @param block The block to extract from
 * @returns The sign lines, or null if not a sign or no lines found
 */
export function getSignLinesFromWorldState(block: any | null): SignLines | null {
  if (!block) return null

  try {
    const anyBlock: any = block

    // Try to get the block entity / NBT data
    const be =
      anyBlock.blockEntity ||
      anyBlock.entity ||
      anyBlock.nbt ||
      anyBlock.blockEntityData

    const val =
      be?.value?.data?.value || // for some versions
      be?.value ||
      be

    if (!val) return null

    const lines = linesFromTileEntityNBT(val)
    if (lines.front.length || lines.back.length) return lines
  } catch {
    // ignore errors
  }

  return null
}
