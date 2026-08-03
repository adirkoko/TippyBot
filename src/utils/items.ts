// src/utils/items.ts
// Shared item-name resolution and inventory helpers for inventory/equipment commands.

import type { Item } from 'prismarine-item'
import { resolveRegistryName, type GameRegistry } from './registryLookup'

/** @deprecated import GameRegistry from './registryLookup' instead; kept as an alias so existing imports don't break. */
export type ItemRegistry = GameRegistry

export type ItemResolution =
  | { ok: true; name: string; id: number; displayName: string }
  | { ok: false; message: string }

/**
 * Resolves a player-typed item query against the registry. Exact name matches win outright;
 * otherwise falls back to substring matching. Never picks arbitrarily among multiple matches --
 * returns a clear "which one?" message instead.
 */
export function resolveItemName(registry: GameRegistry, query: string): ItemResolution {
  const result = resolveRegistryName(registry.itemsByName, registry.itemsArray, query, 'item')
  if (!result.ok) return result

  const { name, id, displayName } = result.entry
  return { ok: true, name, id, displayName }
}

/** Total count of an item (by registry name) currently held across all inventory stacks. */
export function countItem(items: Item[], itemName: string): number {
  return items.filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0)
}

const MAX_SUMMARY_ENTRIES = 10

/** A short, chat-friendly summary of inventory contents, grouped by item and capped in length. */
export function summarizeInventory(items: Item[]): string {
  if (items.length === 0) return 'empty'

  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }

  const parts = [...counts.entries()].map(([name, count]) => `${name} x${count}`)

  if (parts.length > MAX_SUMMARY_ENTRIES) {
    const shown = parts.slice(0, MAX_SUMMARY_ENTRIES)
    return `${shown.join(', ')}, and ${parts.length - MAX_SUMMARY_ENTRIES} more`
  }

  return parts.join(', ')
}
