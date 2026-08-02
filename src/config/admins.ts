// src/config/admins.ts
import { isValidPlayerName, normalizeUsername } from '../utils/validation'

/**
 * Parses BOT_ADMINS into a deduped list of normalized usernames.
 *
 * Throws on an invalid entry rather than silently dropping it: a typo'd
 * Admin name is a security-relevant misconfiguration, not something to
 * paper over at startup.
 */
export function parseAdminList(raw: string | undefined): string[] {
  if (!raw) return []

  const admins: string[] = []
  const seen = new Set<string>()

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    if (!isValidPlayerName(trimmed)) {
      throw new Error(`BOT_ADMINS contains an invalid Minecraft username: "${trimmed}"`)
    }

    const normalized = normalizeUsername(trimmed)
    if (seen.has(normalized)) continue

    seen.add(normalized)
    admins.push(normalized)
  }

  return admins
}
