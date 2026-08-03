// src/interfaces/cooldown.ts

export interface CommandCooldownConfig {
  /** Minimum time between uses of this command by the same player, in ms. */
  perPlayerMs?: number
  /** Minimum time between uses of this command by anyone, in ms. */
  globalMs?: number
}

/**
 * Central cooldown tracker, checked by CommandRegistry before a command with
 * a `cooldown` config runs. Modules never manage their own cooldown state.
 */
export interface ICooldownService {
  /** Ms remaining before `username` may use `commandName` again under `config`; 0 if usable now. */
  getRemainingMs(commandName: string, username: string, config: CommandCooldownConfig): number
  /** Records a use "now" for both per-player and global tracking, per `config`. */
  recordUse(commandName: string, username: string, config: CommandCooldownConfig): void
}
