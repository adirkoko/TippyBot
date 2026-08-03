import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LogStore } from '../../src/core/log-store'
import type { LogEntry } from '../../src/interfaces/log-entry'

const gunzip = promisify(gunzipCallback)
const gzip = promisify(gzipCallback)

describe('LogStore', () => {
  let rootDir: string
  const stores: LogStore[] = []

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-logs-'))
  })

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close()))
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  function makeStore(now: () => Date, diskWarnMb = 500): LogStore {
    const store = new LogStore({
      instanceId: 'alpha',
      rootDir,
      now,
      diskWarnMb,
      diskCheckIntervalMs: 24 * 60 * 60 * 1_000
    })
    stores.push(store)
    return store
  }

  it('rejects instance ids that could escape the configured log root', () => {
    expect(() => new LogStore({ instanceId: '../outside', rootDir })).toThrow(/instanceId/)
    expect(() => new LogStore({ instanceId: 'nested/child', rootDir })).toThrow(/instanceId/)
  })

  it('surfaces initialization failures through ready without an unhandled rejection', async () => {
    const notADirectory = path.join(rootDir, 'plain-file')
    await fs.writeFile(notADirectory, 'not a directory', 'utf8')
    const store = new LogStore({
      instanceId: 'alpha',
      rootDir: notADirectory,
      diskCheckIntervalMs: 24 * 60 * 60 * 1_000
    })
    stores.push(store)

    await expect(store.ready()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('redacts before persistence and before notifying subscribers', async () => {
    const now = new Date(2026, 0, 5, 12, 0, 0)
    const store = makeStore(() => now)
    const received: LogEntry[] = []
    store.subscribe((entry) => received.push(entry))

    await store.append(
      'info',
      'modules',
      'Login used WEB_PASSWORD=hunter2 and Code: ABCD-EFGH',
      {
        password: 'hunter2',
        nested: { accessToken: 'top-secret-token', safe: 'kept' }
      }
    )

    const file = await fs.readFile(path.join(store.directory, '2026-01-05.jsonl'), 'utf8')
    expect(file).not.toContain('hunter2')
    expect(file).not.toContain('ABCD-EFGH')
    expect(file).not.toContain('top-secret-token')
    expect(file).toContain('[REDACTED]')
    expect(received).toHaveLength(1)
    expect(received[0].message).not.toContain('hunter2')
    expect(received[0].meta).toEqual({
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]', safe: 'kept' }
    })
  })

  it('rotates at a local calendar-day boundary and gzips the closed day', async () => {
    let now = new Date(2026, 0, 5, 23, 59, 59)
    const store = makeStore(() => now)

    await store.append('info', 'connection', 'day one')
    now = new Date(2026, 0, 6, 0, 0, 1)
    await store.append('warn', 'connection', 'day two')

    await expect(fs.access(path.join(store.directory, '2026-01-05.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    const compressed = await fs.readFile(path.join(store.directory, '2026-01-05.jsonl.gz'))
    expect((await gunzip(compressed)).toString('utf8')).toContain('day one')
    expect(await fs.readFile(path.join(store.directory, '2026-01-06.jsonl'), 'utf8')).toContain('day two')

    const history = await store.readRecent({ limit: 10 })
    expect(history.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'storage', message: 'Rotated to a new daily log' }),
      expect.objectContaining({ category: 'storage', message: 'Compressed closed daily log' })
    ]))
  })

  it('reads and paginates across compressed and live files with stable cursors', async () => {
    let now = new Date(2026, 2, 10, 12, 0, 0)
    const store = makeStore(() => now)

    await store.append('info', 'modules', 'old-1')
    await store.append('info', 'modules', 'old-2')
    await store.append('info', 'modules', 'old-3')
    now = new Date(2026, 2, 11, 12, 0, 0)
    await store.append('info', 'modules', 'new-1')

    const newest = await store.readRecent({ limit: 4 })
    expect(newest.entries.map((entry) => entry.message)).toEqual([
      'old-3',
      'Rotated to a new daily log',
      'Compressed closed daily log',
      'new-1'
    ])
    expect(newest.nextBefore).toBeTypeOf('string')

    // A new live record does not move the day+line cursor for the older page.
    await store.append('info', 'modules', 'new-2')
    const older = await store.readRecent({ limit: 2, before: newest.nextBefore })
    expect(older.entries.map((entry) => entry.message)).toEqual(['old-1', 'old-2'])
    expect(older.nextBefore).toBeUndefined()
  })

  it('does not open an unrelated older gzip after the newest day fills the page', async () => {
    const instanceDir = path.join(rootDir, 'alpha')
    await fs.mkdir(instanceDir, { recursive: true })
    // If readRecent touches this older day, streaming gunzip raises a controlled error.
    await fs.writeFile(path.join(instanceDir, '2026-02-01.jsonl.gz'), 'not-a-gzip-file')
    const now = new Date(2026, 2, 11, 12, 0, 0)
    const store = makeStore(() => now)
    await store.append('info', 'modules', 'newest-1')
    await store.append('info', 'modules', 'newest-2')

    const page = await store.readRecent({ limit: 2 })

    expect(page.entries.map((entry) => entry.message)).toEqual(['newest-1', 'newest-2'])
    expect(page.nextBefore).toBeTypeOf('string')
    await expect(store.readRecent({ limit: 10 })).rejects.toThrow(
      'Failed to read compressed log file 2026-02-01.jsonl.gz'
    )
  })

  it('preserves archived and newly reopened records across a clock rollback', async () => {
    let now = new Date(2026, 0, 5, 12, 0, 0)
    const store = makeStore(() => now)
    await store.append('info', 'modules', 'archived-record')

    now = new Date(2026, 0, 6, 12, 0, 0)
    await store.append('info', 'modules', 'current-record')
    now = new Date(2026, 0, 5, 18, 0, 0)
    await store.append('warn', 'modules', 'rollback-record')
    now = new Date(2026, 0, 6, 18, 0, 0)
    await store.append('info', 'modules', 'current-record-2')

    await expect(fs.access(path.join(store.directory, '2026-01-05.jsonl.gz'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(store.directory, '2026-01-05.jsonl'))).resolves.toBeUndefined()
    const history = await store.readRecent({ limit: 20 })
    const messages = history.entries.map((entry) => entry.message)
    expect(messages).toContain('archived-record')
    expect(messages).toContain('rollback-record')
  })

  it('removes a leftover JSONL only after validating it matches the gzip exactly', async () => {
    const instanceDir = path.join(rootDir, 'alpha')
    await fs.mkdir(instanceDir, { recursive: true })
    const timestamp = new Date(2026, 0, 5, 12, 0, 0).toISOString()
    const jsonl = `${JSON.stringify({
      timestamp,
      instanceId: 'alpha',
      level: 'info',
      category: 'modules',
      message: 'one copy',
      meta: {}
    })}\n`
    await fs.writeFile(path.join(instanceDir, '2026-01-05.jsonl'), jsonl)
    await fs.writeFile(path.join(instanceDir, '2026-01-05.jsonl.gz'), await gzip(jsonl))
    const now = new Date(2026, 0, 6, 12, 0, 0)
    const store = makeStore(() => now)

    const history = await store.readRecent({ limit: 10 })

    await expect(fs.access(path.join(instanceDir, '2026-01-05.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(history.entries.filter((entry) => entry.message === 'one copy')).toHaveLength(1)
  })

  it('keeps recoverable JSONL when a colliding gzip is corrupt', async () => {
    const instanceDir = path.join(rootDir, 'alpha')
    await fs.mkdir(instanceDir, { recursive: true })
    const timestamp = new Date(2026, 0, 5, 12, 0, 0).toISOString()
    await fs.writeFile(path.join(instanceDir, '2026-01-05.jsonl'), `${JSON.stringify({
      timestamp,
      instanceId: 'alpha',
      level: 'info',
      category: 'modules',
      message: 'recoverable',
      meta: {}
    })}\n`)
    await fs.writeFile(path.join(instanceDir, '2026-01-05.jsonl.gz'), 'corrupt')
    const store = makeStore(() => new Date(2026, 0, 6, 12, 0, 0))

    await expect(store.readRecent({ limit: 10 })).rejects.toThrow(/Failed to read compressed log file/)
    await expect(fs.access(path.join(instanceDir, '2026-01-05.jsonl'))).resolves.toBeUndefined()
  })

  it('stops publishing to a subscriber immediately after unsubscribe', async () => {
    const now = new Date(2026, 3, 2, 12, 0, 0)
    const store = makeStore(() => now)
    const messages: string[] = []
    const unsubscribe = store.subscribe((entry) => messages.push(entry.message))

    await store.append('info', 'modules', 'first')
    unsubscribe()
    await store.append('info', 'modules', 'second')

    expect(messages).toEqual(['first'])
  })

  it('emits one storage warning when the directory crosses its threshold', async () => {
    const now = new Date(2026, 4, 1, 12, 0, 0)
    const store = makeStore(() => now, 0)
    const received: LogEntry[] = []
    store.subscribe((entry) => received.push(entry))

    await store.append('info', 'modules', 'takes some space')
    await store.checkDiskUsage()
    await store.checkDiskUsage()

    const warnings = received.filter((entry) => entry.category === 'storage')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      category: 'storage',
      instanceId: 'alpha'
    })
  })

  it('redacts manually imported legacy content again when reading history', async () => {
    const now = new Date(2026, 6, 1, 12, 0, 0)
    const instanceDir = path.join(rootDir, 'alpha')
    await fs.mkdir(instanceDir, { recursive: true })
    await fs.writeFile(
      path.join(instanceDir, '2026-07-01.jsonl'),
      `${JSON.stringify({
        timestamp: now.toISOString(),
        instanceId: 'alpha',
        level: 'info',
        category: 'modules',
        message: 'password=plain-text',
        meta: { refreshToken: 'plain-token' }
      })}\n`,
      'utf8'
    )
    const store = makeStore(() => now)

    const result = await store.readRecent()

    expect(result.entries[0].message).toBe('password=[REDACTED]')
    expect(result.entries[0].meta).toEqual({ refreshToken: '[REDACTED]' })
  })
})
