import { vi } from 'vitest'
import type { ICooldownService } from '../../src/interfaces/cooldown'

/** A cooldown fake that always reports "ready", for tests that aren't about cooldowns. */
export function createAllowAllCooldowns(): ICooldownService {
  return {
    getRemainingMs: vi.fn().mockReturnValue(0),
    recordUse: vi.fn()
  }
}
