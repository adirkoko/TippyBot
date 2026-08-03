// src/core/home-service.ts
import type { IHomeStore } from '../interfaces/home-store'
import type { HomeLocation, IHomeService } from '../interfaces/homes'
import { normalizeUsername } from '../utils/validation'

export class HomeService implements IHomeService {
  private homes = new Map<string, HomeLocation>()

  constructor(private readonly store: IHomeStore) {}

  async load(): Promise<void> {
    const data = await this.store.load()
    this.homes = new Map(Object.entries(data).map(([key, value]) => [normalizeUsername(key), value]))
  }

  getHome(username: string): HomeLocation | undefined {
    return this.homes.get(normalizeUsername(username))
  }

  async setHome(username: string, location: HomeLocation): Promise<void> {
    this.homes.set(normalizeUsername(username), location)
    await this.persist()
  }

  private async persist(): Promise<void> {
    const data: Record<string, HomeLocation> = {}
    for (const [key, value] of this.homes) data[key] = value
    await this.store.save(data)
  }
}
