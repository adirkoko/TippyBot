// src/interfaces/permissions.ts
import type { ICommand, ICommandRegistry } from './command'

/**
 * Fixed permission tiers, highest to lowest. Higher tiers automatically
 * inherit access to everything a lower tier can do.
 */
export type PermissionLevel = 'admin' | 'operator' | 'member' | 'user'

export interface PermissionGroup {
  name: string
  /** Normalized (lowercase) usernames belonging to this group */
  members: string[]
  /** Canonical (lowercase) command names this group grants access to */
  commands: string[]
}

export type PermissionMutationResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

/**
 * Central authority for "who can do what". Admins come from static config
 * and are never persisted or mutable at runtime; everything else (Operators,
 * Members, the blacklist, and custom groups) is dynamic and persisted.
 */
export interface IPermissionService {
  /** Loads dynamic state (Operators/Members/blacklist/groups) from storage. Must be awaited before handling chat. */
  load(): Promise<void>

  getLevel(username: string): PermissionLevel
  meetsLevel(username: string, level: PermissionLevel): boolean
  isBlacklisted(username: string): boolean
  /** The single check that gates whether a player may run a given command. */
  canUseCommand(username: string, command: ICommand): boolean

  grantOperator(actor: string, target: string): Promise<PermissionMutationResult>
  revokeOperator(actor: string, target: string): Promise<PermissionMutationResult>
  addMember(actor: string, target: string): Promise<PermissionMutationResult>
  removeMember(actor: string, target: string): Promise<PermissionMutationResult>

  addToBlacklist(actor: string, target: string): Promise<PermissionMutationResult>
  removeFromBlacklist(actor: string, target: string): Promise<PermissionMutationResult>
  listBlacklist(): string[]

  createGroup(actor: string, name: string): Promise<PermissionMutationResult>
  deleteGroup(actor: string, name: string): Promise<PermissionMutationResult>
  renameGroup(actor: string, oldName: string, newName: string): Promise<PermissionMutationResult>
  listGroups(): PermissionGroup[]
  getGroup(name: string): PermissionGroup | undefined
  addGroupMember(actor: string, groupName: string, target: string): Promise<PermissionMutationResult>
  removeGroupMember(actor: string, groupName: string, target: string): Promise<PermissionMutationResult>
  addGroupCommand(
    actor: string,
    groupName: string,
    commandName: string,
    commands: ICommandRegistry
  ): Promise<PermissionMutationResult>
  removeGroupCommand(actor: string, groupName: string, commandName: string): Promise<PermissionMutationResult>
}
