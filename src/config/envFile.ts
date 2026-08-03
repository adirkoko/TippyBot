import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'
import { parse as parseDotenv } from 'dotenv'

const LOCK_WAIT_MS = 10
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

interface LockOwner {
  pid: number
  nonce: string
  createdAt: number
}

export interface EnsureEnvVariableResult {
  value: string
  created: boolean
}

/**
 * Adds an environment variable without changing any existing bytes other than
 * the newline needed before the new assignment. A short-lived adjacent lock
 * prevents two processes starting together from generating different values.
 */
export async function ensureEnvVariableAtomic(
  envPath: string,
  key: string,
  createValue: () => string
): Promise<EnsureEnvVariableResult> {
  validateKey(key)
  await fs.mkdir(path.dirname(path.resolve(envPath)), { recursive: true })

  const release = await acquireLock(`${envPath}.lock`)
  try {
    const existing = await readFileIfPresent(envPath)
    if (hasAssignment(existing.contents, key)) {
      const value = parseDotenv(existing.contents)[key]
      if (value === undefined || value.length === 0) {
        throw new Error(`${key} exists in ${envPath} but has no value.`)
      }
      return { value, created: false }
    }

    const value = createValue()
    validateValue(value, key)
    const nextContents = appendAssignment(existing.contents, key, value)
    await writeFileAtomic(envPath, nextContents, existing.mode)
    return { value, created: true }
  } finally {
    await release()
  }
}

/** A value-based convenience wrapper for callers that do not need lazy creation. */
export function appendEnvVariableAtomic(
  envPath: string,
  key: string,
  value: string
): Promise<EnsureEnvVariableResult> {
  return ensureEnvVariableAtomic(envPath, key, () => value)
}

interface ExistingFile {
  contents: string
  mode: number
}

async function readFileIfPresent(filePath: string): Promise<ExistingFile> {
  try {
    const [contents, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)])
    return { contents, mode: stat.mode }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { contents: '', mode: 0o600 }
    }
    throw error
  }
}

function appendAssignment(contents: string, key: string, value: string): string {
  if (contents.length === 0) return `${key}=${value}\n`

  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const separator = contents.endsWith('\n') || contents.endsWith('\r') ? '' : newline
  return `${contents}${separator}${key}=${value}${newline}`
}

function hasAssignment(contents: string, key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`, 'm').test(contents)
}

function validateKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`)
  }
}

function validateValue(value: string, key: string): void {
  if (value.length === 0) throw new Error(`${key} cannot be empty.`)
  if (/\r|\n/.test(value)) throw new Error(`${key} cannot contain a newline.`)
}

async function writeFileAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  const directory = path.dirname(path.resolve(filePath))
  const basename = path.basename(filePath)
  const suffix = randomBytes(8).toString('hex')
  const tempPath = path.join(directory, `.${basename}.${process.pid}.${suffix}.tmp`)

  try {
    // An env file containing generated credentials must never inherit a
    // group/world-readable mode from an older non-secret file. On Windows the
    // mode is advisory; platform ACLs remain the administrator's boundary.
    const secureMode = process.platform === 'win32' ? mode : 0o600
    await fs.writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx', mode: secureMode })
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now()
  const owner: LockOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
    createdAt: Date.now()
  }

  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(owner), 'utf8')
      } catch (error) {
        await handle.close().catch(() => undefined)
        // We just created this path and a fresh lock is never considered
        // stale, so no other owner can have replaced it in this branch.
        await fs.rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
      return async () => {
        await handle.close().catch(() => undefined)
        await removeLockIfOwned(lockPath, owner.nonce)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      if (await isStaleLock(lockPath)) {
        await recoverStaleLock(lockPath)
        await delay(LOCK_WAIT_MS)
        continue
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting to update ${lockPath.replace(/\.lock$/, '')}.`)
      }
      await delay(LOCK_WAIT_MS)
    }
  }
}

/**
 * Serializes stale takeover through a second exclusive file. Every contender
 * rechecks the primary lock only after winning this recovery election, so a
 * waiter that observed the old owner can never delete a freshly acquired
 * primary lock.
 */
async function recoverStaleLock(lockPath: string): Promise<void> {
  const recoveryPath = `${lockPath}.recovery`
  const owner: LockOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
    createdAt: Date.now()
  }

  let handle
  try {
    handle = await fs.open(recoveryPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }

  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8')
    if (await isStaleLock(lockPath)) {
      await fs.rm(lockPath, { force: true })
    }
  } finally {
    await handle.close().catch(() => undefined)
    await removeLockIfOwned(recoveryPath, owner.nonce)
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const [stat, rawOwner] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, 'utf8').catch(() => '')
    ])
    const owner = parseLockOwner(rawOwner)
    if (owner && isProcessAlive(owner.pid)) return false
    if (owner) return true
    return Date.now() - stat.mtimeMs >= STALE_LOCK_MS
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>
    if (
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.nonce === 'string' &&
      /^[a-f0-9]{32}$/.test(value.nonce) &&
      typeof value.createdAt === 'number'
    ) {
      return value as LockOwner
    }
  } catch {
    // Legacy/partially-written locks fall back to the mtime lease above.
  }
  return undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function removeLockIfOwned(lockPath: string, nonce: string): Promise<void> {
  try {
    const owner = parseLockOwner(await fs.readFile(lockPath, 'utf8'))
    if (owner?.nonce === nonce) await fs.rm(lockPath, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
