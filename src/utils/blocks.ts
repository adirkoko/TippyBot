// src/utils/blocks.ts
// Shared block-name resolution for mining/gathering commands.

import { resolveRegistryName, type GameRegistry } from './registryLookup'

export type BlockResolution =
  | { ok: true; name: string; id: number; displayName: string }
  | { ok: false; message: string }

/**
 * Resolves a player-typed block query against the registry, same rules as resolveItemName:
 * exact match wins, otherwise an unambiguous substring match, otherwise a clear error --
 * never a guess.
 */
export function resolveBlockName(registry: GameRegistry, query: string): BlockResolution {
  const result = resolveRegistryName(registry.blocksByName, registry.blocksArray, query, 'block')
  if (!result.ok) return result

  const { name, id, displayName } = result.entry
  return { ok: true, name, id, displayName }
}
