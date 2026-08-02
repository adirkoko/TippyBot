// src/core/permission-store.ts
import { promises as fs } from 'fs'
import * as path from 'path'
import type { IPermissionStore, PersistedPermissionData } from '../interfaces/permission-store'

function emptyData(): PersistedPermissionData {
  return { operators: [], members: [], blacklist: [], groups: {} }
}

/**
 * JSON-file-backed IPermissionStore. Writes go to a temp file and are then
 * renamed into place, so a crash mid-write can never leave a corrupt or
 * half-written permissions file behind.
 */
export class JsonPermissionStore implements IPermissionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedPermissionData> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return emptyData()
      throw err
    }

    const parsed = JSON.parse(raw)
    return {
      operators: Array.isArray(parsed?.operators) ? parsed.operators : [],
      members: Array.isArray(parsed?.members) ? parsed.members : [],
      blacklist: Array.isArray(parsed?.blacklist) ? parsed.blacklist : [],
      groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {}
    }
  }

  async save(data: PersistedPermissionData): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })

    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`)
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmpPath, this.filePath)
  }
}
