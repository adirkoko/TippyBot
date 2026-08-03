// src/interfaces/config.ts

export interface IBotConfig {
  /** Unique instance identifier -- namespaces this instance's data/ and auth_cache/ directories and its log prefix. */
  id: string

  host: string
  port: number
  username: string
  auth: 'microsoft' | 'offline'
  profilesFolder?: string

  commandPrefix: string // Prefix for bot commands in chat, e.g., "!"

  /** Normalized (lowercase) usernames with permanent Admin access; source of truth is bots.config.json, never mutated at runtime. */
  admins: string[]
}
