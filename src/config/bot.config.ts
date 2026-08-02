// src/config/bot.config.ts
import type { IBotConfig } from '../interfaces/config'
import { parseAdminList } from './admins'

export const botConfig: IBotConfig = {
  host: process.env.BOT_HOST!,
  port: Number(process.env.BOT_PORT),
  username: process.env.BOT_USERNAME!, // Can be anything when using 'microsoft' auth. and when using 'offline' auth, it's the bot's username
  auth: process.env.BOT_AUTH as 'microsoft' | 'offline',
  profilesFolder: './auth_cache',
  commandPrefix: process.env.BOT_PREFIX || '!',
  admins: parseAdminList(process.env.BOT_ADMINS)
}

