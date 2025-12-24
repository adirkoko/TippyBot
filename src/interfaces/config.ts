// src/interfaces/config.ts

export interface IBotConfig {
  host: string
  port: number
  username: string
  auth: 'microsoft' | 'offline'
  profilesFolder?: string

  commandPrefix: string // Prefix for bot commands in chat, e.g., "!"
}
