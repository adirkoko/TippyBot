import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendEnvVariableAtomic, ensureEnvVariableAtomic } from '../../src/config/envFile'

let tempDirectory: string
let envPath: string

beforeEach(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-env-file-'))
  envPath = path.join(tempDirectory, '.env')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tempDirectory, { recursive: true, force: true })
})

describe('environment file updates', () => {
  it('appends without changing existing content', async () => {
    const original = '# Keep this comment\nMINECRAFT_HOST=example.test'
    await fs.writeFile(envPath, original, 'utf8')

    const result = await appendEnvVariableAtomic(envPath, 'WEB_PASSWORD', 'new-secret')

    expect(result).toEqual({ value: 'new-secret', created: true })
    expect(await fs.readFile(envPath, 'utf8')).toBe(`${original}\nWEB_PASSWORD=new-secret\n`)
    if (process.platform !== 'win32') {
      expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('is idempotent and never calls the value factory for an existing key', async () => {
    await fs.writeFile(envPath, 'WEB_PASSWORD=already-there\nOTHER=value\n', 'utf8')
    const createValue = vi.fn(() => 'replacement')

    const result = await ensureEnvVariableAtomic(envPath, 'WEB_PASSWORD', createValue)

    expect(result).toEqual({ value: 'already-there', created: false })
    expect(createValue).not.toHaveBeenCalled()
    expect(await fs.readFile(envPath, 'utf8')).toBe('WEB_PASSWORD=already-there\nOTHER=value\n')
  })

  it('does not mistake comments for assignments', async () => {
    await fs.writeFile(envPath, '# WEB_PASSWORD=old\nOTHER=value\n', 'utf8')

    await appendEnvVariableAtomic(envPath, 'WEB_PASSWORD', 'fresh')

    expect(await fs.readFile(envPath, 'utf8')).toBe(
      '# WEB_PASSWORD=old\nOTHER=value\nWEB_PASSWORD=fresh\n'
    )
  })

  it('serializes concurrent attempts so exactly one value is stored and returned', async () => {
    const factories = Array.from({ length: 8 }, (_, index) => vi.fn(() => `secret-${index}`))

    const results = await Promise.all(
      factories.map((factory) => ensureEnvVariableAtomic(envPath, 'WEB_PASSWORD', factory))
    )
    const stored = (await fs.readFile(envPath, 'utf8')).match(/^WEB_PASSWORD=(.+)$/m)?.[1]

    expect(stored).toBeTruthy()
    expect(results.every((result) => result.value === stored)).toBe(true)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(factories.reduce((count, factory) => count + factory.mock.calls.length, 0)).toBe(1)
    expect((await fs.readFile(envPath, 'utf8')).match(/^WEB_PASSWORD=/gm)).toHaveLength(1)
  })

  it('serializes concurrent recovery of a stale lock without deleting a new owner', async () => {
    const lockPath = `${envPath}.lock`
    await fs.writeFile(lockPath, 'legacy lock without owner metadata', 'utf8')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)
    const factories = Array.from({ length: 8 }, (_, index) => vi.fn(() => `recovered-${index}`))

    const results = await Promise.all(
      factories.map((factory) => ensureEnvVariableAtomic(envPath, 'WEB_PASSWORD', factory))
    )
    const stored = (await fs.readFile(envPath, 'utf8')).match(/^WEB_PASSWORD=(.+)$/m)?.[1]

    expect(stored).toBeTruthy()
    expect(results.every((result) => result.value === stored)).toBe(true)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(factories.reduce((count, factory) => count + factory.mock.calls.length, 0)).toBe(1)
    await expect(fs.access(`${lockPath}.recovery`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an existing empty assignment without duplicating it', async () => {
    await fs.writeFile(envPath, 'KEEP=this\nWEB_PASSWORD=\n', 'utf8')

    await expect(appendEnvVariableAtomic(envPath, 'WEB_PASSWORD', 'new')).rejects.toThrow(/no value/)
    expect(await fs.readFile(envPath, 'utf8')).toBe('KEEP=this\nWEB_PASSWORD=\n')
  })
})
