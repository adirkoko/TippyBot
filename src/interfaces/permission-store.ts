// src/interfaces/permission-store.ts
import type { PermissionGroup } from './permissions'

/** The dynamic (persisted) slice of the permission system. Admins are deliberately excluded. */
export interface PersistedPermissionData {
  operators: string[]
  members: string[]
  blacklist: string[]
  groups: Record<string, PermissionGroup>
}

/**
 * Hides the on-disk storage format behind an interface, so the permission
 * system can move to a database later without touching PermissionService
 * or any module.
 */
export interface IPermissionStore {
  load(): Promise<PersistedPermissionData>
  save(data: PersistedPermissionData): Promise<void>
}
