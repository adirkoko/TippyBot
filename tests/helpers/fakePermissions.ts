import { vi } from 'vitest'
import type { IPermissionService } from '../../src/interfaces/permissions'

/** A permissions fake that allows everything and blacklists no one, for tests that aren't about permissions. */
export function createAllowAllPermissions(): IPermissionService {
  return {
    load: vi.fn().mockResolvedValue(undefined),
    getLevel: vi.fn().mockReturnValue('user'),
    meetsLevel: vi.fn().mockReturnValue(true),
    isBlacklisted: vi.fn().mockReturnValue(false),
    canUseCommand: vi.fn().mockReturnValue(true),
    grantOperator: vi.fn(),
    revokeOperator: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    addToBlacklist: vi.fn(),
    removeFromBlacklist: vi.fn(),
    listBlacklist: vi.fn().mockReturnValue([]),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    renameGroup: vi.fn(),
    listGroups: vi.fn().mockReturnValue([]),
    getGroup: vi.fn().mockReturnValue(undefined),
    addGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
    addGroupCommand: vi.fn(),
    removeGroupCommand: vi.fn()
  }
}
