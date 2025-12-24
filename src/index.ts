// src/index.ts
import 'dotenv/config' // Load environment variables from .env file

import { startBot } from './core/bot'
import { botConfig } from './config/bot.config'

async function main() {
  await startBot(botConfig)
}

main().catch((err) => {
  console.error('Fatal error starting bot:', err)
})
