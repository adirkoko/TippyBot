import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleLogger } from '../../src/utils/logger'

describe('createConsoleLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefixes every level with the given label', () => {
    const logger = createConsoleLogger('steve')

    logger.info('hello')
    logger.warn('careful')
    logger.error('oops')
    logger.debug('details')

    expect(console.log).toHaveBeenCalledWith('[steve]', '[INFO]', 'hello', '')
    expect(console.warn).toHaveBeenCalledWith('[steve]', '[WARN]', 'careful', '')
    expect(console.error).toHaveBeenCalledWith('[steve]', '[ERROR]', 'oops', '')
    expect(console.debug).toHaveBeenCalledWith('[steve]', '[DEBUG]', 'details', '')
  })

  it('passes through metadata when provided', () => {
    const logger = createConsoleLogger('alex')

    logger.info('event', { count: 3 })

    expect(console.log).toHaveBeenCalledWith('[alex]', '[INFO]', 'event', { count: 3 })
  })

  it('keeps loggers for different labels independent', () => {
    const steve = createConsoleLogger('steve')
    const alex = createConsoleLogger('alex')

    steve.info('from steve')
    alex.info('from alex')

    expect(console.log).toHaveBeenNthCalledWith(1, '[steve]', '[INFO]', 'from steve', '')
    expect(console.log).toHaveBeenNthCalledWith(2, '[alex]', '[INFO]', 'from alex', '')
  })
})
