import { vi } from 'vitest'
import type { ILogger } from '../../src/interfaces/logger'

export function createFakeLogger(): ILogger {
  const logger: ILogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withCategory: vi.fn(() => logger)
  }
  return logger
}
