import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionService } from '../../src/core/permission-service'
import type { ICommand, ICommandRegistry } from '../../src/interfaces/command'
import type { IPermissionStore, PersistedPermissionData } from '../../src/interfaces/permission-store'
import type { PermissionLevel } from '../../src/interfaces/permissions'
import { createFakeLogger } from '../helpers/fakeLogger'

function emptyData(): PersistedPermissionData {
  return { operators: [], members: [], blacklist: [], groups: {} }
}

class MemoryStore implements IPermissionStore {
  data: PersistedPermissionData
  saveCount = 0

  constructor(initial: PersistedPermissionData = emptyData()) {
    this.data = initial
  }

  async load(): Promise<PersistedPermissionData> {
    return this.data
  }

  async save(data: PersistedPermissionData): Promise<void> {
    this.saveCount++
    this.data = data
  }
}

function makeCommand(name: string, requiredLevel: PermissionLevel): ICommand {
  return { name, requiredLevel, execute: vi.fn() }
}

function makeRegistry(commands: ICommand[]): ICommandRegistry {
  const map = new Map(commands.map((c) => [c.name.toLowerCase(), c]))
  return {
    register: vi.fn(),
    get: (name: string) => map.get(name.toLowerCase()),
    handleChatMessage: vi.fn()
  }
}

async function createService(admins: string[] = []) {
  const store = new MemoryStore()
  const service = new PermissionService(admins, store, createFakeLogger())
  await service.load()
  return { service, store }
}

describe('PermissionService: level hierarchy', () => {
  it('resolves admin from config regardless of dynamic lists', async () => {
    const { service } = await createService(['adminuser'])
    expect(service.getLevel('AdminUser')).toBe('admin')
  })

  it('defaults unknown players to user', async () => {
    const { service } = await createService()
    expect(service.getLevel('nobody')).toBe('user')
  })

  it('ranks levels admin > operator > member > user', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')
    await service.addMember('admin1', 'mem1')

    expect(service.meetsLevel('admin1', 'admin')).toBe(true)
    expect(service.meetsLevel('op1', 'admin')).toBe(false)
    expect(service.meetsLevel('op1', 'operator')).toBe(true)
    expect(service.meetsLevel('mem1', 'operator')).toBe(false)
    expect(service.meetsLevel('mem1', 'member')).toBe(true)
    expect(service.meetsLevel('randomuser', 'member')).toBe(false)
    expect(service.meetsLevel('randomuser', 'user')).toBe(true)
  })
})

describe('PermissionService: canUseCommand and inheritance', () => {
  it('lets higher levels use lower-level commands', async () => {
    const { service } = await createService(['admin1'])
    await service.addMember('admin1', 'mem1')
    const memberCommand = makeCommand('come', 'member')

    expect(service.canUseCommand('admin1', memberCommand)).toBe(true)
    expect(service.canUseCommand('mem1', memberCommand)).toBe(true)
    expect(service.canUseCommand('randomuser', memberCommand)).toBe(false)
  })

  it('blocks blacklisted players regardless of level', async () => {
    const { service } = await createService(['admin1'])
    await service.addMember('admin1', 'mem1')
    await service.addToBlacklist('admin1', 'mem1')

    const userCommand = makeCommand('ping', 'user')
    expect(service.canUseCommand('mem1', userCommand)).toBe(false)
    expect(service.isBlacklisted('mem1')).toBe(true)
  })

  it('grants access to a group-assigned command even below the required level', async () => {
    const { service } = await createService(['admin1'])
    const registry = makeRegistry([makeCommand('build', 'operator')])
    await service.createGroup('admin1', 'Builders')
    await service.addGroupMember('admin1', 'Builders', 'randomuser')
    await service.addGroupCommand('admin1', 'Builders', 'build', registry)

    const buildCommand = registry.get('build')!
    expect(service.canUseCommand('randomuser', buildCommand)).toBe(true)
    expect(service.canUseCommand('someoneelse', buildCommand)).toBe(false)
  })

  it('never grants an Admin-required command through a group, even if hand-edited into storage', async () => {
    const store = new MemoryStore({
      operators: [],
      members: [],
      blacklist: [],
      groups: {
        sneaky: { name: 'Sneaky', members: ['bob'], commands: ['shutdown'] }
      }
    })
    const service = new PermissionService([], store, createFakeLogger())
    await service.load()

    const adminCommand = makeCommand('shutdown', 'admin')
    expect(service.canUseCommand('bob', adminCommand)).toBe(false)
  })
})

describe('PermissionService: admins are immutable via commands', () => {
  it('exposes no way to add/remove/change admins at runtime', async () => {
    const { service } = await createService(['adminuser'])
    expect((service as any).addAdmin).toBeUndefined()
    expect((service as any).removeAdmin).toBeUndefined()
  })

  it('never persists the admin list', async () => {
    const { service, store } = await createService(['adminuser'])
    await service.addMember('adminuser', 'someone')

    expect(store.data).not.toHaveProperty('admins')
  })

  it('rejects grant/revoke/member/blacklist actions targeting an admin', async () => {
    const { service } = await createService(['bigboss'])

    expect((await service.grantOperator('bigboss', 'bigboss')).ok).toBe(false)
    expect((await service.addMember('bigboss', 'bigboss')).ok).toBe(false)
    expect((await service.addToBlacklist('bigboss', 'bigboss')).ok).toBe(false)
  })
})

describe('PermissionService: operator management (Admin only)', () => {
  it('lets an Admin grant and revoke Operator', async () => {
    const { service } = await createService(['admin1'])

    const grant = await service.grantOperator('admin1', 'newop')
    expect(grant.ok).toBe(true)
    expect(service.getLevel('newop')).toBe('operator')

    const revoke = await service.revokeOperator('admin1', 'newop')
    expect(revoke.ok).toBe(true)
    expect(service.getLevel('newop')).toBe('user')
  })

  it('refuses grant/revoke Operator from a non-Admin actor', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')

    const result = await service.grantOperator('op1', 'someone')
    expect(result.ok).toBe(false)
    expect(service.getLevel('someone')).toBe('user')
  })
})

describe('PermissionService: member management (Operator and up)', () => {
  it('lets an Operator add and remove Members', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')

    const add = await service.addMember('op1', 'newmember')
    expect(add.ok).toBe(true)
    expect(service.getLevel('newmember')).toBe('member')

    const remove = await service.removeMember('op1', 'newmember')
    expect(remove.ok).toBe(true)
    expect(service.getLevel('newmember')).toBe('user')
  })

  it('refuses member management from a plain Member or User', async () => {
    const { service } = await createService(['admin1'])
    await service.addMember('admin1', 'mem1')

    const byMember = await service.addMember('mem1', 'someone')
    const byUser = await service.addMember('randomguy', 'someone')
    expect(byMember.ok).toBe(false)
    expect(byUser.ok).toBe(false)
  })

  it('prevents an Operator from modifying another Operator', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')
    await service.grantOperator('admin1', 'op2')

    const result = await service.addMember('op1', 'op2')
    expect(result.ok).toBe(false)
    expect(service.getLevel('op2')).toBe('operator')
  })
})

describe('PermissionService: blacklist', () => {
  it('lets an Operator blacklist and unblacklist a player', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')

    const add = await service.addToBlacklist('op1', 'troublemaker')
    expect(add.ok).toBe(true)
    expect(service.isBlacklisted('troublemaker')).toBe(true)

    const remove = await service.removeFromBlacklist('op1', 'troublemaker')
    expect(remove.ok).toBe(true)
    expect(service.isBlacklisted('troublemaker')).toBe(false)
  })

  it('blacklist overrides level and group access on canUseCommand', async () => {
    const { service } = await createService(['admin1'])
    await service.grantOperator('admin1', 'op1')
    await service.addToBlacklist('admin1', 'op1')

    const userCommand = makeCommand('ping', 'user')
    expect(service.canUseCommand('op1', userCommand)).toBe(false)
  })
})

describe('PermissionService: groups', () => {
  it('creates, renames, and deletes groups', async () => {
    const { service } = await createService(['admin1'])

    expect((await service.createGroup('admin1', 'Builders')).ok).toBe(true)
    expect((await service.createGroup('admin1', 'Builders')).ok).toBe(false) // duplicate

    const rename = await service.renameGroup('admin1', 'Builders', 'Architects')
    expect(rename.ok).toBe(true)
    expect(service.getGroup('Builders')).toBeUndefined()
    expect(service.getGroup('Architects')).toBeDefined()

    const del = await service.deleteGroup('admin1', 'Architects')
    expect(del.ok).toBe(true)
    expect(service.getGroup('Architects')).toBeUndefined()
  })

  it('rejects duplicate group names case-insensitively', async () => {
    const { service } = await createService(['admin1'])
    await service.createGroup('admin1', 'Builders')

    const result = await service.createGroup('admin1', 'builders')
    expect(result.ok).toBe(false)
  })

  it('rejects assigning an Admin-required command to a group', async () => {
    const { service } = await createService(['admin1'])
    await service.createGroup('admin1', 'Builders')
    const registry = makeRegistry([makeCommand('shutdown', 'admin')])

    const result = await service.addGroupCommand('admin1', 'Builders', 'shutdown', registry)
    expect(result.ok).toBe(false)

    const group = service.getGroup('Builders')
    expect(group?.commands).toEqual([])
  })

  it('rejects assigning a command that does not exist in the registry', async () => {
    const { service } = await createService(['admin1'])
    await service.createGroup('admin1', 'Builders')
    const registry = makeRegistry([])

    const result = await service.addGroupCommand('admin1', 'Builders', 'nonexistent', registry)
    expect(result.ok).toBe(false)
  })

  it('deleting a group removes its members and command assignments entirely', async () => {
    const { service } = await createService(['admin1'])
    const registry = makeRegistry([makeCommand('build', 'operator')])
    await service.createGroup('admin1', 'Builders')
    await service.addGroupMember('admin1', 'Builders', 'someone')
    await service.addGroupCommand('admin1', 'Builders', 'build', registry)

    await service.deleteGroup('admin1', 'Builders')

    expect(service.listGroups()).toEqual([])
    expect(service.canUseCommand('someone', registry.get('build')!)).toBe(false)
  })
})

describe('PermissionService: persistence', () => {
  it('persists mutations through the store', async () => {
    const { service, store } = await createService(['admin1'])

    await service.addMember('admin1', 'mem1')
    expect(store.data.members).toContain('mem1')
    expect(store.saveCount).toBeGreaterThan(0)
  })

  it('reloads dynamic state from the store on load()', async () => {
    const store = new MemoryStore({
      operators: ['op1'],
      members: ['mem1'],
      blacklist: ['bad1'],
      groups: {}
    })
    const service = new PermissionService([], store, createFakeLogger())
    await service.load()

    expect(service.getLevel('op1')).toBe('operator')
    expect(service.getLevel('mem1')).toBe('member')
    expect(service.isBlacklisted('bad1')).toBe(true)
  })
})
