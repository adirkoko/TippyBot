// src/config/instancePaths.ts
// Per-instance filesystem locations, kept in one place so every piece of
// state a bot instance owns (permissions, homes, auth cache) is namespaced
// under the same rule and never collides with another instance's.

const INSTANCE_ID_REGEX = /^[A-Za-z0-9_-]{1,32}$/

/** Whether a string is safe to use as an instance id (and therefore as a path segment). */
export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_REGEX.test(id)
}

export function permissionsFilePath(instanceId: string): string {
  return `./data/${instanceId}/permissions.json`
}

export function homesFilePath(instanceId: string): string {
  return `./data/${instanceId}/homes.json`
}

export function defaultProfilesFolder(instanceId: string): string {
  return `./auth_cache/${instanceId}`
}
