// src/core/permission-store.ts
import type { IPermissionStore, PersistedPermissionData } from '../interfaces/permission-store'
import { readJsonFile, writeJsonFileAtomic } from './json-file-store'

/**
 * JSON-file-backed IPermissionStore. Writes go to a temp file and are then
 * renamed into place, so a crash mid-write can never leave a corrupt or
 * half-written permissions file behind.
 */
export class JsonPermissionStore implements IPermissionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedPermissionData> {
    const parsed = await readJsonFile<any>(this.filePath, {})
    return {
      operators: Array.isArray(parsed?.operators) ? parsed.operators : [],
      members: Array.isArray(parsed?.members) ? parsed.members : [],
      blacklist: Array.isArray(parsed?.blacklist) ? parsed.blacklist : [],
      groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {}
    }
  }

  async save(data: PersistedPermissionData): Promise<void> {
    await writeJsonFileAtomic(this.filePath, data)
  }
}
