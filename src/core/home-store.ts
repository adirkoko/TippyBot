// src/core/home-store.ts
import type { IHomeStore } from '../interfaces/home-store'
import type { HomeLocation } from '../interfaces/homes'
import { readJsonFile, writeJsonFileAtomic } from './json-file-store'

function isValidHomeRecord(value: unknown): value is HomeLocation {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.x === 'number' &&
    typeof v.y === 'number' &&
    typeof v.z === 'number' &&
    typeof v.dimension === 'string'
  )
}

export class JsonHomeStore implements IHomeStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Record<string, HomeLocation>> {
    const parsed = await readJsonFile<Record<string, unknown>>(this.filePath, {})
    if (!parsed || typeof parsed !== 'object') return {}

    const result: Record<string, HomeLocation> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isValidHomeRecord(value)) result[key] = value
    }
    return result
  }

  async save(data: Record<string, HomeLocation>): Promise<void> {
    await writeJsonFileAtomic(this.filePath, data)
  }
}
