// src/utils/validation.ts
// Shared validation/normalization for player and permission-group names

const PLAYER_NAME_REGEX = /^[A-Za-z0-9_]{1,16}$/
const GROUP_NAME_REGEX = /^[A-Za-z0-9_-]{1,32}$/

/** Checks a string against Minecraft's username character/length rules. */
export function isValidPlayerName(name: string): boolean {
  return PLAYER_NAME_REGEX.test(name)
}

/** Checks a string against the allowed permission-group name format. */
export function isValidGroupName(name: string): boolean {
  return GROUP_NAME_REGEX.test(name)
}

/** Canonical form used for storing/comparing usernames (trimmed, lowercased). */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase()
}

/** Canonical form used for storing/comparing group names (trimmed, lowercased). */
export function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase()
}
