// src/config/instances.ts
// Loads and validates the multi-instance bot configuration file (bots.config.json by
// default). Fails loudly and specifically on any malformed entry -- a bad config here
// means the affected instance (or all of them, if the file itself is broken) can't
// safely start, so silent defaults would just turn into confusing runtime failures.

import { readFileSync } from 'fs'
import type { IBotConfig } from '../interfaces/config'
import { normalizeAdminList } from './admins'
import { isValidInstanceId, defaultProfilesFolder } from './instancePaths'

const DEFAULT_CONFIG_PATH = './bots.config.json'

export function loadBotInstances(configPath = process.env.BOTS_CONFIG_PATH || DEFAULT_CONFIG_PATH): IBotConfig[] {
  const raw = readConfigFile(configPath)
  const parsed = parseJson(raw, configPath)

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).instances)) {
    throw new Error(`${configPath}: expected a top-level "instances" array.`)
  }

  const rawInstances = (parsed as { instances: unknown[] }).instances
  if (rawInstances.length === 0) {
    throw new Error(`${configPath}: "instances" array is empty -- configure at least one bot.`)
  }

  const seenIds = new Set<string>()
  return rawInstances.map((entry, index) => {
    const config = validateInstance(entry, index)
    if (seenIds.has(config.id)) {
      throw new Error(`${configPath}: duplicate instance id "${config.id}".`)
    }
    seenIds.add(config.id)
    return config
  })
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

function validateInstance(entry: unknown, index: number): IBotConfig {
  const label = `Bot instance #${index + 1}`

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

  const profilesFolder =
    typeof raw.profilesFolder === 'string' && raw.profilesFolder.length > 0
      ? raw.profilesFolder
      : defaultProfilesFolder(id)

  return { id, host, port, username, auth, commandPrefix, admins, profilesFolder }
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
