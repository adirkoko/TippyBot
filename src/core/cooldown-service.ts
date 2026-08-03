// src/core/cooldown-service.ts
import type { CommandCooldownConfig, ICooldownService } from '../interfaces/cooldown'
import { normalizeUsername } from '../utils/validation'

export class CooldownService implements ICooldownService {
  /** key: `${commandName}:${username}` -> timestamp the cooldown expires at */
  private perPlayerExpiry = new Map<string, number>()
  /** key: commandName -> timestamp the cooldown expires at */
  private globalExpiry = new Map<string, number>()

  getRemainingMs(commandName: string, username: string, config: CommandCooldownConfig): number {
    const now = Date.now()
    let remaining = 0

    if (config.perPlayerMs) {
      const expiry = this.perPlayerExpiry.get(this.playerKey(commandName, username))
      if (expiry !== undefined) remaining = Math.max(remaining, expiry - now)
    }

    if (config.globalMs) {
      const expiry = this.globalExpiry.get(commandName.toLowerCase())
      if (expiry !== undefined) remaining = Math.max(remaining, expiry - now)
    }

    return Math.max(0, remaining)
  }

  recordUse(commandName: string, username: string, config: CommandCooldownConfig): void {
    const now = Date.now()

    if (config.perPlayerMs) {
      this.perPlayerExpiry.set(this.playerKey(commandName, username), now + config.perPlayerMs)
    }
    if (config.globalMs) {
      this.globalExpiry.set(commandName.toLowerCase(), now + config.globalMs)
    }

    this.sweep(now)
  }

  private playerKey(commandName: string, username: string): string {
    return `${commandName.toLowerCase()}:${normalizeUsername(username)}`
  }

  /** Drops entries whose cooldown has already expired, so long-running bots don't accumulate stale keys. */
  private sweep(now: number): void {
    for (const [key, expiry] of this.perPlayerExpiry) {
      if (now >= expiry) this.perPlayerExpiry.delete(key)
    }
    for (const [key, expiry] of this.globalExpiry) {
      if (now >= expiry) this.globalExpiry.delete(key)
    }
  }
}
