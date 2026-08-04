// src/config/instances.ts
// Loads, validates, and saves the multi-instance bot configuration file
// (bots.config.json by default). Fails loudly and specifically on any
// malformed entry -- a bad config here means the affected instance (or all
// of them, if the file itself is broken) can't safely start, so silent
// defaults would just turn into confusing runtime failures.

import { readFileSync } from 'fs'
import type { IBotConfig } from '../interfaces/config'
import { normalizeAdminList } from './admins'
import { isValidInstanceId, defaultProfilesFolder, isSafeRelativeFolder } from './instancePaths'
import { writeJsonFileAtomic } from '../core/json-file-store'

export const DEFAULT_CONFIG_PATH = './bots.config.json'

export function resolveConfigPath(configPath?: string): string {
  return configPath || process.env.BOTS_CONFIG_PATH || DEFAULT_CONFIG_PATH
}

export function loadBotInstances(configPath = resolveConfigPath()): IBotConfig[] {
  const raw = readConfigFile(configPath)
  const parsed = parseJson(raw, configPath)

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).instances)) {
    throw new Error(`${configPath}: expected a top-level "instances" array.`)
  }

  const rawInstances = (parsed as { instances: unknown[] }).instances

  const seenIds = new Set<string>()
  return rawInstances.map((entry, index) => {
    const config = validateInstance(entry, `Bot instance #${index + 1}`)
    if (seenIds.has(config.id)) {
      throw new Error(`${configPath}: duplicate instance id "${config.id}".`)
    }
    seenIds.add(config.id)
    return config
  })
}

/**
 * Atomically overwrites the instance config file with exactly these
 * instances -- the caller decides the full desired set (e.g. "all current
 * instances plus one new one"), this function never merges. Callers must
 * treat a rejection as "nothing was written": writeJsonFileAtomic either
 * completes the temp-file-then-rename swap or leaves the existing file
 * untouched, and this function does not touch any in-memory state itself.
 */
export async function saveBotInstances(
  configs: IBotConfig[],
  configPath = resolveConfigPath()
): Promise<void> {
  await writeJsonFileAtomic(configPath, { instances: configs })
}

function readConfigFile(configPath: string): string {
  try {
    return readFileSync(configPath, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `Bot instance config not found at "${configPath}". Copy bots.config.example.json to bots.config.json and edit it.`
      )
    }
    throw err
  }
}

function parseJson(raw: string, configPath: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${configPath}: invalid JSON (${(err as Error).message}).`)
  }
}

/**
 * Validates and normalizes one instance entry. Shared by loadBotInstances
 * (called once per array position, at boot) and, later, the bot-management
 * API (called once per submitted instance) -- both paths get the exact same
 * rules, including defaults for every optional field. `label` is only used
 * to prefix error messages, so each caller can phrase it for its own context
 * (e.g. "Bot instance #3" while loading, "New bot instance" from the API).
 */
export function validateInstance(entry: unknown, label: string): IBotConfig {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${label}: must be an object.`)
  }
  const raw = entry as Record<string, unknown>

  const id = raw.id
  if (typeof id !== 'string' || !isValidInstanceId(id)) {
    throw new Error(
      `${label}: "id" is required and must be 1-32 characters of letters, digits, "_", or "-".`
    )
  }

  const named = `${label} ("${id}")`

  const host = requireString(raw.host, named, 'host')
  const port = requireNumber(raw.port, named, 'port')
  const username = requireString(raw.username, named, 'username')

  if (raw.auth !== 'microsoft' && raw.auth !== 'offline') {
    throw new Error(`${named}: "auth" must be "microsoft" or "offline".`)
  }
  const auth = raw.auth

  const commandPrefix =
    typeof raw.commandPrefix === 'string' && raw.commandPrefix.length > 0 ? raw.commandPrefix : '!'

  if (raw.admins !== undefined && !Array.isArray(raw.admins)) {
    throw new Error(`${named}: "admins" must be an array of strings.`)
  }
  let admins: string[]
  try {
    admins = normalizeAdminList((raw.admins as string[] | undefined) ?? [])
  } catch (err) {
    throw new Error(`${named}: ${(err as Error).message}`)
  }

  let profilesFolder = defaultProfilesFolder(id)
  if (typeof raw.profilesFolder === 'string' && raw.profilesFolder.length > 0) {
    if (!isSafeRelativeFolder(raw.profilesFolder)) {
      throw new Error(
        `${named}: "profilesFolder" must be a relative path within the project directory (no absolute paths or "..").`
      )
    }
    profilesFolder = raw.profilesFolder
  }

  // Absent means true: every bots.config.json written before this field
  // existed must keep auto-connecting exactly as it always has.
  if (raw.autoConnect !== undefined && typeof raw.autoConnect !== 'boolean') {
    throw new Error(`${named}: "autoConnect" must be a boolean.`)
  }
  const autoConnect = raw.autoConnect === undefined ? true : raw.autoConnect

  return { id, host, port, username, auth, commandPrefix, admins, profilesFolder, autoConnect }
}

function requireString(value: unknown, label: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}: "${field}" is required and must be a non-empty string.`)
  }
  return value
}

function requireNumber(value: unknown, label: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: "${field}" is required and must be a number.`)
  }
  return value
}
