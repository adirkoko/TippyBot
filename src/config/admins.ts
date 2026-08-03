// src/config/admins.ts
import { isValidPlayerName, normalizeUsername } from '../utils/validation'

/**
 * Validates and normalizes a raw list of admin usernames (deduped, case-insensitive).
 *
 * Throws on an invalid entry rather than silently dropping it: a typo'd
 * Admin name is a security-relevant misconfiguration, not something to
 * paper over at startup.
 */
export function normalizeAdminList(rawNames: string[]): string[] {
  const admins: string[] = []
  const seen = new Set<string>()

  for (const entry of rawNames) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    if (!isValidPlayerName(trimmed)) {
      throw new Error(`Invalid Minecraft username in admins list: "${trimmed}"`)
    }

    const normalized = normalizeUsername(trimmed)
    if (seen.has(normalized)) continue

    seen.add(normalized)
    admins.push(normalized)
  }

  return admins
}
