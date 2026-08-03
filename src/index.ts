// src/index.ts
import 'dotenv/config' // Load environment variables from .env file (currently unused by bot instances themselves, kept for future non-instance-specific settings)

import { BotManager } from './core/bot-manager'
import { loadBotInstances } from './config/instances'

function main(): void {
  let configs
  try {
    configs = loadBotInstances()
  } catch (err) {
    console.error('Fatal error loading bot instance configuration:', err)
    process.exitCode = 1
    return
  }

  // BotManager.startAll() never throws -- a failed instance shows up as an
  // 'errored' handle (see src/core/bot.ts), so one bad connection never
  // takes down the others, even though they're all running in this one process.
  const manager = new BotManager(configs)
  manager.startAll()
}

main()
