// src/core/permission-service.ts
import type { ICommand, ICommandRegistry } from '../interfaces/command'
import type { ILogger } from '../interfaces/logger'
import type { IPermissionStore } from '../interfaces/permission-store'
import type {
  IPermissionService,
  PermissionGroup,
  PermissionLevel,
  PermissionMutationResult
} from '../interfaces/permissions'
import {
  isValidGroupName,
  isValidPlayerName,
  normalizeGroupName,
  normalizeUsername
} from '../utils/validation'

const LEVEL_RANK: Record<PermissionLevel, number> = {
  user: 0,
  member: 1,
  operator: 2,
  admin: 3
}

function rankOf(level: PermissionLevel): number {
  return LEVEL_RANK[level]
}

function ok(message: string): PermissionMutationResult {
  return { ok: true, message }
}

function fail(message: string): PermissionMutationResult {
  return { ok: false, message }
}

/**
 * Central permission authority, exposed via ctx.permissions. Admins are a
 * fixed set loaded once from config; Operators, Members, the blacklist, and
 * custom groups are dynamic and persisted through an IPermissionStore.
 *
 * Every mutation re-checks the actor's authority itself (not just the
 * command-level gate in CommandRegistry) so the business rules live in one
 * place regardless of how a mutation is ever triggered.
 */
export class PermissionService implements IPermissionService {
  private readonly admins: Set<string>
  private operators = new Set<string>()
  private members = new Set<string>()
  private blacklist = new Set<string>()
  private groups = new Map<string, PermissionGroup>()

  constructor(
    admins: string[],
    private readonly store: IPermissionStore,
    private readonly logger: ILogger
  ) {
    this.admins = new Set(admins.map(normalizeUsername))
  }

  async load(): Promise<void> {
    const data = await this.store.load()

    this.operators = new Set((data.operators ?? []).map(normalizeUsername))
    this.members = new Set((data.members ?? []).map(normalizeUsername))
    this.blacklist = new Set((data.blacklist ?? []).map(normalizeUsername))

    this.groups = new Map()
    for (const [key, group] of Object.entries(data.groups ?? {})) {
      const normalizedKey = normalizeGroupName(key)
      this.groups.set(normalizedKey, {
        name: group?.name ?? key,
        members: [...new Set((group?.members ?? []).map(normalizeUsername))],
        commands: [...new Set((group?.commands ?? []).map((c) => c.toLowerCase()))]
      })
    }
  }

  // ---- queries ----

  getLevel(username: string): PermissionLevel {
    const name = normalizeUsername(username)
    if (this.admins.has(name)) return 'admin'
    if (this.operators.has(name)) return 'operator'
    if (this.members.has(name)) return 'member'
    return 'user'
  }

  meetsLevel(username: string, level: PermissionLevel): boolean {
    return rankOf(this.getLevel(username)) >= rankOf(level)
  }

  isBlacklisted(username: string): boolean {
    return this.blacklist.has(normalizeUsername(username))
  }

  canUseCommand(username: string, command: ICommand): boolean {
    const name = normalizeUsername(username)
    if (this.blacklist.has(name)) return false

    if (rankOf(this.getLevel(name)) >= rankOf(command.requiredLevel)) return true

    // Admin-gated commands are never reachable through a group, even if
    // stored data was somehow hand-edited to associate one.
    if (command.requiredLevel === 'admin') return false

    return this.isInGroupWithCommand(name, command.name)
  }

  private isInGroupWithCommand(normalizedUsername: string, commandName: string): boolean {
    const cmdKey = commandName.toLowerCase()
    for (const group of this.groups.values()) {
      if (group.commands.includes(cmdKey) && group.members.includes(normalizedUsername)) {
        return true
      }
    }
    return false
  }

  // ---- shared guards / plumbing ----

  /** Admins can never be touched via commands; below Admin, Operators can only be touched by an Admin. */
  private targetGuard(actorLevel: PermissionLevel, targetLevel: PermissionLevel): string | null {
    if (targetLevel === 'admin') return 'Admins cannot be modified through commands.'
    if (actorLevel !== 'admin' && targetLevel === 'operator') return 'Only Admins can modify Operators.'
    return null
  }

  private async persist(): Promise<void> {
    const groups: Record<string, PermissionGroup> = {}
    for (const [key, group] of this.groups) {
      groups[key] = group
    }

    await this.store.save({
      operators: [...this.operators],
      members: [...this.members],
      blacklist: [...this.blacklist],
      groups
    })
  }

  private audit(actor: string, action: string, target: string): void {
    this.logger.info(`permissions: ${action}`, {
      actor: normalizeUsername(actor),
      target
    })
  }

  // ---- operator management (Admin only) ----

  async grantOperator(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (actorLevel !== 'admin') return fail('Only Admins can grant Operator.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    const targetLevel = this.getLevel(targetName)
    const blocked = this.targetGuard(actorLevel, targetLevel)
    if (blocked) return fail(blocked)
    if (targetLevel === 'operator') return fail(`${target} is already an Operator.`)

    this.members.delete(targetName)
    this.operators.add(targetName)
    await this.persist()
    this.audit(actor, 'grantOperator', targetName)
    return ok(`${target} is now an Operator.`)
  }

  async revokeOperator(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (actorLevel !== 'admin') return fail('Only Admins can revoke Operator.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    const targetLevel = this.getLevel(targetName)
    if (targetLevel === 'admin') return fail('Admins cannot be modified through commands.')
    if (targetLevel !== 'operator') return fail(`${target} is not an Operator.`)

    this.operators.delete(targetName)
    await this.persist()
    this.audit(actor, 'revokeOperator', targetName)
    return ok(`${target} is no longer an Operator.`)
  }

  // ---- member management (Operator and up) ----

  async addMember(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (rankOf(actorLevel) < rankOf('operator')) return fail('You need Operator or higher to manage Members.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    const targetLevel = this.getLevel(targetName)
    const blocked = this.targetGuard(actorLevel, targetLevel)
    if (blocked) return fail(blocked)
    if (targetLevel === 'member') return fail(`${target} is already a Member.`)

    this.members.add(targetName)
    await this.persist()
    this.audit(actor, 'addMember', targetName)
    return ok(`${target} is now a Member.`)
  }

  async removeMember(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (rankOf(actorLevel) < rankOf('operator')) return fail('You need Operator or higher to manage Members.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    const targetLevel = this.getLevel(targetName)
    const blocked = this.targetGuard(actorLevel, targetLevel)
    if (blocked) return fail(blocked)
    if (targetLevel !== 'member') return fail(`${target} is not a Member.`)

    this.members.delete(targetName)
    await this.persist()
    this.audit(actor, 'removeMember', targetName)
    return ok(`${target} is no longer a Member.`)
  }

  // ---- blacklist management (Operator and up) ----

  async addToBlacklist(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (rankOf(actorLevel) < rankOf('operator')) return fail('You need Operator or higher to manage the blacklist.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    const targetLevel = this.getLevel(targetName)
    const blocked = this.targetGuard(actorLevel, targetLevel)
    if (blocked) return fail(blocked)
    if (this.blacklist.has(targetName)) return fail(`${target} is already blacklisted.`)

    this.blacklist.add(targetName)
    await this.persist()
    this.audit(actor, 'addToBlacklist', targetName)
    return ok(`${target} has been blacklisted.`)
  }

  async removeFromBlacklist(actor: string, target: string): Promise<PermissionMutationResult> {
    const actorLevel = this.getLevel(actor)
    if (rankOf(actorLevel) < rankOf('operator')) return fail('You need Operator or higher to manage the blacklist.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const targetName = normalizeUsername(target)
    if (!this.blacklist.has(targetName)) return fail(`${target} is not blacklisted.`)

    this.blacklist.delete(targetName)
    await this.persist()
    this.audit(actor, 'removeFromBlacklist', targetName)
    return ok(`${target} has been removed from the blacklist.`)
  }

  listBlacklist(): string[] {
    return [...this.blacklist]
  }

  // ---- groups (Operator and up) ----

  async createGroup(actor: string, name: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')
    if (!isValidGroupName(name)) return fail("That group name doesn't look right.")

    const key = normalizeGroupName(name)
    if (this.groups.has(key)) return fail(`Group "${name}" already exists.`)

    this.groups.set(key, { name, members: [], commands: [] })
    await this.persist()
    this.audit(actor, 'createGroup', name)
    return ok(`Group "${name}" created.`)
  }

  async deleteGroup(actor: string, name: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')

    const key = normalizeGroupName(name)
    if (!this.groups.has(key)) return fail(`Group "${name}" does not exist.`)

    this.groups.delete(key)
    await this.persist()
    this.audit(actor, 'deleteGroup', name)
    return ok(`Group "${name}" deleted.`)
  }

  async renameGroup(actor: string, oldName: string, newName: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')
    if (!isValidGroupName(newName)) return fail("That group name doesn't look right.")

    const oldKey = normalizeGroupName(oldName)
    const newKey = normalizeGroupName(newName)
    const group = this.groups.get(oldKey)
    if (!group) return fail(`Group "${oldName}" does not exist.`)
    if (oldKey !== newKey && this.groups.has(newKey)) return fail(`Group "${newName}" already exists.`)

    this.groups.delete(oldKey)
    this.groups.set(newKey, { ...group, name: newName })
    await this.persist()
    this.audit(actor, 'renameGroup', `${oldName} -> ${newName}`)
    return ok(`Group "${oldName}" renamed to "${newName}".`)
  }

  listGroups(): PermissionGroup[] {
    return [...this.groups.values()]
  }

  getGroup(name: string): PermissionGroup | undefined {
    return this.groups.get(normalizeGroupName(name))
  }

  async addGroupMember(actor: string, groupName: string, target: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')
    if (!isValidPlayerName(target)) return fail("That name doesn't look right.")

    const group = this.groups.get(normalizeGroupName(groupName))
    if (!group) return fail(`Group "${groupName}" does not exist.`)

    const targetName = normalizeUsername(target)
    if (group.members.includes(targetName)) return fail(`${target} is already in "${group.name}".`)

    group.members.push(targetName)
    await this.persist()
    this.audit(actor, 'addGroupMember', `${targetName} -> ${group.name}`)
    return ok(`${target} added to "${group.name}".`)
  }

  async removeGroupMember(actor: string, groupName: string, target: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')

    const group = this.groups.get(normalizeGroupName(groupName))
    if (!group) return fail(`Group "${groupName}" does not exist.`)

    const targetName = normalizeUsername(target)
    if (!group.members.includes(targetName)) return fail(`${target} is not in "${group.name}".`)

    group.members = group.members.filter((m) => m !== targetName)
    await this.persist()
    this.audit(actor, 'removeGroupMember', `${targetName} -> ${group.name}`)
    return ok(`${target} removed from "${group.name}".`)
  }

  async addGroupCommand(
    actor: string,
    groupName: string,
    commandName: string,
    commands: ICommandRegistry
  ): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')

    const group = this.groups.get(normalizeGroupName(groupName))
    if (!group) return fail(`Group "${groupName}" does not exist.`)

    const command = commands.get(commandName)
    if (!command) return fail(`Command "${commandName}" does not exist.`)
    if (command.requiredLevel === 'admin') {
      return fail(`"${command.name}" requires Admin and cannot be assigned to a group.`)
    }

    const cmdKey = command.name.toLowerCase()
    if (group.commands.includes(cmdKey)) return fail(`"${command.name}" is already assigned to "${group.name}".`)

    group.commands.push(cmdKey)
    await this.persist()
    this.audit(actor, 'addGroupCommand', `${command.name} -> ${group.name}`)
    return ok(`"${command.name}" assigned to "${group.name}".`)
  }

  async removeGroupCommand(actor: string, groupName: string, commandName: string): Promise<PermissionMutationResult> {
    if (rankOf(this.getLevel(actor)) < rankOf('operator')) return fail('You need Operator or higher to manage groups.')

    const group = this.groups.get(normalizeGroupName(groupName))
    if (!group) return fail(`Group "${groupName}" does not exist.`)

    const cmdKey = commandName.toLowerCase()
    if (!group.commands.includes(cmdKey)) return fail(`"${commandName}" is not assigned to "${group.name}".`)

    group.commands = group.commands.filter((c) => c !== cmdKey)
    await this.persist()
    this.audit(actor, 'removeGroupCommand', `${commandName} -> ${group.name}`)
    return ok(`"${commandName}" removed from "${group.name}".`)
  }
}
