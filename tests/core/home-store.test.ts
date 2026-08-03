import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { JsonHomeStore } from '../../src/core/home-store'
import type { HomeLocation } from '../../src/interfaces/homes'

let tmpDir: string
let filePath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-homestore-'))
  filePath = path.join(tmpDir, 'homes.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const alice: HomeLocation = { x: 10, y: 64, z: -20, dimension: 'overworld' }

describe('JsonHomeStore', () => {
  it('returns an empty object when the file does not exist yet', async () => {
    const store = new JsonHomeStore(filePath)

    await expect(store.load()).resolves.toEqual({})
  })

  it('round-trips data through save and load', async () => {
    const store = new JsonHomeStore(filePath)

    await store.save({ alice })
    const loaded = await store.load()

    expect(loaded).toEqual({ alice })
  })

  it('drops malformed records instead of throwing', async () => {
    const store = new JsonHomeStore(filePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({ alice, bob: { x: 'not-a-number', y: 0, z: 0, dimension: 'overworld' } }),
      'utf8'
    )

    const loaded = await store.load()

    expect(loaded).toEqual({ alice })
  })
})
