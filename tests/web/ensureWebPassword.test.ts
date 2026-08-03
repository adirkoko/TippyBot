import { gzipSync, gunzipSync } from 'zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ensureWebPassword } from '../../src/web/setup/ensureWebPassword'
import { LogStore } from '../../src/core/log-store'

let tempDirectory: string
let envPath: string

beforeEach(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-password-'))
  envPath = path.join(tempDirectory, '.env')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDirectory, { recursive: true, force: true })
})

describe('ensureWebPassword', () => {
  it('generates 24 random bytes as base64url, persists them and sets the current env', async () => {
    const bytes = Buffer.from(Array.from({ length: 24 }, (_, index) => index))
    const random = vi.fn(() => bytes)
    const stdout = { write: vi.fn(() => true) }
    const env: NodeJS.ProcessEnv = {}

    const password = await ensureWebPassword({ env, envPath, stdout, randomBytes: random })

    expect(password).toBe(bytes.toString('base64url'))
    expect(password).toHaveLength(32)
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(env.WEB_PASSWORD).toBe(password)
    expect(await fs.readFile(envPath, 'utf8')).toBe(`WEB_PASSWORD=${password}\n`)
    expect(random).toHaveBeenCalledOnce()
    expect(stdout.write).toHaveBeenCalledOnce()
    expect(stdout.write.mock.calls[0][0]).not.toContain(password)
  })

  it('does not touch the file, regenerate, or print when process.env already has a password', async () => {
    await fs.writeFile(envPath, 'KEEP=unchanged\n', 'utf8')
    const random = vi.fn(() => Buffer.alloc(24))
    const stdout = { write: vi.fn(() => true) }

    const password = await ensureWebPassword({
      env: { WEB_PASSWORD: 'from-process-env' },
      envPath,
      stdout,
      randomBytes: random
    })

    expect(password).toBe('from-process-env')
    expect(random).not.toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
    expect(await fs.readFile(envPath, 'utf8')).toBe('KEEP=unchanged\n')
  })

  it('loads an existing .env password without generating or duplicating it', async () => {
    await fs.writeFile(envPath, '# existing\nWEB_PASSWORD=stored-secret\nOTHER=preserved\n', 'utf8')
    const env: NodeJS.ProcessEnv = {}
    const random = vi.fn(() => Buffer.alloc(24))
    const stdout = { write: vi.fn(() => true) }

    await expect(ensureWebPassword({ env, envPath, stdout, randomBytes: random })).resolves.toBe(
      'stored-secret'
    )
    await expect(ensureWebPassword({ env, envPath, stdout, randomBytes: random })).resolves.toBe(
      'stored-secret'
    )

    expect(random).not.toHaveBeenCalled()
    expect(stdout.write).not.toHaveBeenCalled()
    expect(await fs.readFile(envPath, 'utf8')).toBe(
      '# existing\nWEB_PASSWORD=stored-secret\nOTHER=preserved\n'
    )
  })

  it('never sends the password through console logging or existing JSONL/GZIP logs', async () => {
    const logDirectory = path.join(tempDirectory, 'logs', 'bot-one')
    await fs.mkdir(logDirectory, { recursive: true })
    const safeEntry = '{"message":"safe existing entry"}\n'
    const plainLog = path.join(logDirectory, '2026-08-03.jsonl')
    const compressedLog = path.join(logDirectory, '2026-08-02.jsonl.gz')
    await fs.writeFile(plainLog, safeEntry, 'utf8')
    await fs.writeFile(compressedLog, gzipSync(safeEntry))
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    ]
    const stdout = { write: vi.fn(() => true) }
    const appendSpy = vi.spyOn(LogStore.prototype, 'append')
    const password = await ensureWebPassword({
      env: {},
      envPath,
      stdout,
      randomBytes: () => Buffer.alloc(24, 0xab)
    })

    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(appendSpy).not.toHaveBeenCalled()
    expect(stdout.write.mock.calls.flat().join('')).not.toContain(password)
    expect(await fs.readFile(plainLog, 'utf8')).not.toContain(password)
    expect(gunzipSync(await fs.readFile(compressedLog)).toString('utf8')).not.toContain(password)
  })

  it('redacts an accidental password before both JSONL and compressed history', async () => {
    let now = new Date(2026, 7, 3, 12, 0, 0)
    const password = await ensureWebPassword({
      env: {},
      envPath,
      stdout: { write: vi.fn(() => true) },
      randomBytes: () => Buffer.alloc(24, 0xcd)
    })
    const store = new LogStore({
      instanceId: 'alpha',
      rootDir: path.join(tempDirectory, 'logs'),
      now: () => now,
      diskCheckIntervalMs: 24 * 60 * 60 * 1_000
    })

    try {
      await store.ready()
      await store.append('info', 'modules', `WEB_PASSWORD=${password}`, { password })
      const liveJsonl = await fs.readFile(path.join(store.directory, '2026-08-03.jsonl'), 'utf8')
      expect(liveJsonl).not.toContain(password)

      now = new Date(2026, 7, 4, 0, 0, 1)
      await store.append('info', 'storage', 'new day')
      const archived = gunzipSync(
        await fs.readFile(path.join(store.directory, '2026-08-03.jsonl.gz'))
      ).toString('utf8')
      expect(archived).not.toContain(password)
      expect(archived).toContain('[REDACTED]')
    } finally {
      await store.close()
    }
  })
})
