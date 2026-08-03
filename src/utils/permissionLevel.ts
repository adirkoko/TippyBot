// src/utils/permissionLevel.ts
// Shared rank table for comparing PermissionLevel values, used by anything
// that needs "is level X at least as high as level Y" (PermissionService, TaskManager, ...).

import type { PermissionLevel } from '../interfaces/permissions'

const LEVEL_RANK: Record<PermissionLevel, number> = {
  user: 0,
  member: 1,
  operator: 2,
  admin: 3
}

export function rankOfLevel(level: PermissionLevel): number {
  return LEVEL_RANK[level]
}

export function levelMeets(actual: PermissionLevel, required: PermissionLevel): boolean {
  return rankOfLevel(actual) >= rankOfLevel(required)
}
