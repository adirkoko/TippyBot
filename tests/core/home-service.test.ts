import { describe, expect, it } from 'vitest'
import { HomeService } from '../../src/core/home-service'
import type { IHomeStore } from '../../src/interfaces/home-store'
import type { HomeLocation } from '../../src/interfaces/homes'

class MemoryHomeStore implements IHomeStore {
  data: Record<string, HomeLocation>
  saveCount = 0

  constructor(initial: Record<string, HomeLocation> = {}) {
    this.data = initial
  }

  async load(): Promise<Record<string, HomeLocation>> {
    return this.data
  }

  async save(data: Record<string, HomeLocation>): Promise<void> {
    this.saveCount++
    this.data = data
  }
}

const overworldHome: HomeLocation = { x: 1, y: 2, z: 3, dimension: 'overworld' }

describe('HomeService', () => {
  it('has no home before one is set', async () => {
    const service = new HomeService(new MemoryHomeStore())
    await service.load()

    expect(service.getHome('alice')).toBeUndefined()
  })

  it('saves and retrieves a home, case-insensitively by username', async () => {
    const store = new MemoryHomeStore()
    const service = new HomeService(store)
    await service.load()

    await service.setHome('Alice', overworldHome)

    expect(service.getHome('alice')).toEqual(overworldHome)
    expect(service.getHome('ALICE')).toEqual(overworldHome)
  })

  it('persists through the store on every set', async () => {
    const store = new MemoryHomeStore()
    const service = new HomeService(store)
    await service.load()

    await service.setHome('alice', overworldHome)

    expect(store.data.alice).toEqual(overworldHome)
    expect(store.saveCount).toBe(1)
  })

  it('overwrites a previous home for the same player', async () => {
    const service = new HomeService(new MemoryHomeStore())
    await service.load()

    await service.setHome('alice', overworldHome)
    const netherHome: HomeLocation = { x: 5, y: 6, z: 7, dimension: 'the_nether' }
    await service.setHome('alice', netherHome)

    expect(service.getHome('alice')).toEqual(netherHome)
  })

  it('keeps separate homes per player', async () => {
    const service = new HomeService(new MemoryHomeStore())
    await service.load()

    await service.setHome('alice', overworldHome)

    expect(service.getHome('bob')).toBeUndefined()
  })

  it('reloads state from the store on load()', async () => {
    const store = new MemoryHomeStore({ alice: overworldHome })
    const service = new HomeService(store)

    await service.load()

    expect(service.getHome('alice')).toEqual(overworldHome)
  })
})
