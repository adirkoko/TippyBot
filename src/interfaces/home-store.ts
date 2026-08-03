// src/interfaces/home-store.ts
import type { HomeLocation } from './homes'

/** Hides the on-disk storage format behind an interface, same rationale as IPermissionStore. */
export interface IHomeStore {
  load(): Promise<Record<string, HomeLocation>>
  save(data: Record<string, HomeLocation>): Promise<void>
}
