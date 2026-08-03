import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from '../../src/core/json-file-store'

let tmpDir: string
let filePath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-jsonstore-'))
  filePath = path.join(tmpDir, 'nested', 'data.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('readJsonFile', () => {
  it('returns the fallback when the file does not exist', async () => {
    await expect(readJsonFile(filePath, { hello: 'world' })).resolves.toEqual({ hello: 'world' })
  })

  it('parses an existing file', async () => {
    await writeJsonFileAtomic(filePath, { a: 1 })

    await expect(readJsonFile(filePath, {})).resolves.toEqual({ a: 1 })
  })
})

describe('writeJsonFileAtomic', () => {
  it('creates missing parent directories', async () => {
    await writeJsonFileAtomic(filePath, { a: 1 })

    await expect(fs.stat(filePath)).resolves.toBeTruthy()
  })

  it('does not leave a temp file behind after a successful write', async () => {
    await writeJsonFileAtomic(filePath, { a: 1 })

    const entries = await fs.readdir(path.dirname(filePath))
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('overwrites previous contents on a second write', async () => {
    await writeJsonFileAtomic(filePath, { a: 1 })
    await writeJsonFileAtomic(filePath, { a: 2 })

    await expect(readJsonFile(filePath, {})).resolves.toEqual({ a: 2 })
  })
})
