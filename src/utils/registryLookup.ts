// src/utils/registryLookup.ts
// Shared "resolve a player-typed name against a minecraft-data registry list" algorithm,
// used for both items (resolveItemName) and blocks (resolveBlockName).

import type { Bot } from 'mineflayer'

/** The type of bot.registry -- avoids a direct dependency on prismarine-registry for just this. */
export type GameRegistry = Bot['registry']

export type NameResolution<T> =
  | { ok: true; entry: T }
  | { ok: false; message: string }

const MAX_AMBIGUOUS_SUGGESTIONS = 5

/**
 * Resolves a query against a registry's name -> entry map (+ full array for substring search).
 * Exact name matches win outright; otherwise falls back to substring matching. Never picks
 * arbitrarily among multiple matches -- returns a clear "which one?" message instead.
 * @param kind Used only in messages, e.g. 'item' or 'block'.
 */
export function resolveRegistryName<T extends { name: string }>(
  byName: Record<string, T>,
  all: T[],
  query: string,
  kind: string
): NameResolution<T> {
  const q = query.trim().toLowerCase()
  if (!q) return { ok: false, message: `I need a ${kind} name.` }

  const exact = byName[q]
  if (exact) return { ok: true, entry: exact }

  const matches = all.filter((entry) => entry.name.includes(q))

  if (matches.length === 0) {
    return { ok: false, message: `I don't know a ${kind} called "${query}".` }
  }

  if (matches.length > 1) {
    const shown = matches.slice(0, MAX_AMBIGUOUS_SUGGESTIONS).map((entry) => entry.name)
    const suffix = matches.length > MAX_AMBIGUOUS_SUGGESTIONS ? ', ...' : ''
    return {
      ok: false,
      message: `"${query}" could mean several ${kind}s: ${shown.join(', ')}${suffix}. Be more specific.`
    }
  }

  return { ok: true, entry: matches[0] }
}
