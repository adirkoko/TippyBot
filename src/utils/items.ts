// src/utils/items.ts
// Shared item-name resolution and inventory helpers for inventory/equipment commands.

import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

/** The type of bot.registry -- avoids a direct dependency on prismarine-registry for just this. */
export type ItemRegistry = Bot['registry']

export type ItemResolution =
  | { ok: true; name: string; id: number; displayName: string }
  | { ok: false; message: string }

const MAX_AMBIGUOUS_SUGGESTIONS = 5

/**
 * Resolves a player-typed item query against the registry. Exact name matches win outright;
 * otherwise falls back to substring matching. Never picks arbitrarily among multiple matches --
 * returns a clear "which one?" message instead.
 */
export function resolveItemName(registry: ItemRegistry, query: string): ItemResolution {
  const q = query.trim().toLowerCase()
  if (!q) return { ok: false, message: 'I need an item name.' }

  const exact = registry.itemsByName[q]
  if (exact) {
    return { ok: true, name: exact.name, id: exact.id, displayName: exact.displayName }
  }

  const matches = registry.itemsArray.filter((item) => item.name.includes(q))

  if (matches.length === 0) {
    return { ok: false, message: `I don't know an item called "${query}".` }
  }

  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_AMBIGUOUS_SUGGESTIONS).map((item) => item.name)
    const suffix = matches.length > MAX_AMBIGUOUS_SUGGESTIONS ? ', ...' : ''
    return {
      ok: false,
      message: `"${query}" could mean several items: ${shown.join(', ')}${suffix}. Be more specific.`
    }
  }

  const match = matches[0]
  return { ok: true, name: match.name, id: match.id, displayName: match.displayName }
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
