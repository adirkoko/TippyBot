import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { JsonPermissionStore } from '../../src/core/permission-store'
import type { PersistedPermissionData } from '../../src/interfaces/permission-store'

let tmpDir: string
let filePath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-permstore-'))
  filePath = path.join(tmpDir, 'nested', 'permissions.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const sampleData: PersistedPermissionData = {
  operators: ['op1'],
  members: ['mem1', 'mem2'],
  blacklist: ['bad1'],
  groups: {
    builders: { name: 'Builders', members: ['mem1'], commands: ['come'] }
  }
}

describe('JsonPermissionStore', () => {
  it('returns empty data when the file does not exist yet', async () => {
    const store = new JsonPermissionStore(filePath)

    await expect(store.load()).resolves.toEqual({
      operators: [],
      members: [],
      blacklist: [],
      groups: {}
    })
  })

  it('creates missing parent directories on save', async () => {
    const store = new JsonPermissionStore(filePath)

    await store.save(sampleData)

    await expect(fs.stat(filePath)).resolves.toBeTruthy()
  })

  it('round-trips data through save and load', async () => {
    const store = new JsonPermissionStore(filePath)

    await store.save(sampleData)
    const loaded = await store.load()

    expect(loaded).toEqual(sampleData)
  })

  it('does not leave a temp file behind after a successful save', async () => {
    const store = new JsonPermissionStore(filePath)

    await store.save(sampleData)

    const entries = await fs.readdir(path.dirname(filePath))
    const tmpFiles = entries.filter((name) => name.includes('.tmp'))
    expect(tmpFiles).toEqual([])
  })

  it('overwrites previous contents on a second save', async () => {
    const store = new JsonPermissionStore(filePath)

    await store.save(sampleData)
    await store.save({ operators: [], members: [], blacklist: [], groups: {} })
    const loaded = await store.load()

    expect(loaded.operators).toEqual([])
  })
})
