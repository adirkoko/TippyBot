import { vi } from 'vitest'
import type { ILogger } from '../../src/interfaces/logger'

export function createFakeLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}
