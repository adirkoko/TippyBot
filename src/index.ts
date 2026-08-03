// src/index.ts
import 'dotenv/config' // Load process-wide bot/web/log settings from .env before startup setup runs.

import { BotManager } from './core/bot-manager'
import { startBot } from './core/bot'
import { LogStore } from './core/log-store'
import { loadBotInstances, resolveConfigPath } from './config/instances'
import { loadWebConfig } from './config/webConfig'
import { ensureWebPassword } from './web/setup/ensureWebPassword'
import { startWebServer } from './web/server'

async function main(): Promise<void> {
  try {
    // This setup path is intentionally isolated from ILogger/LogStore. It
    // prints only a generic notice when it creates a password, never the
    // password itself. Reusing DOTENV_CONFIG_PATH (the same variable dotenv's
    // own preload already honors) keeps a single source of truth for where
    // .env lives -- important in Docker, where it's mounted outside the
    // container's working directory (see docs/docker.md).
    await ensureWebPassword({ envPath: process.env.DOTENV_CONFIG_PATH || undefined })
  } catch (err) {
    console.error('Fatal error preparing the web password:', err)
    process.exitCode = 1
    return
  }

  let webConfig
  try {
    webConfig = loadWebConfig()
  } catch (err) {
    console.error('Fatal error loading web configuration:', err)
    process.exitCode = 1
    return
  }

  let configs
  try {
    configs = loadBotInstances()
  } catch (err) {
    console.error('Fatal error loading bot instance configuration:', err)
    process.exitCode = 1
    return
  }

  const createLogStore = (instanceId: string): LogStore =>
    new LogStore({
      instanceId,
      diskWarnMb: webConfig.logDiskWarnMb,
      diskCheckIntervalMs: webConfig.logDiskCheckIntervalMs
    })

  // BotManager.startAll() never throws -- a failed instance shows up as an
  // 'errored' handle (see src/core/bot.ts), so one bad connection never
  // takes down the others, even though they're all running in this one process.
  const logStores = new Map(configs.map((config) => [config.id, createLogStore(config.id)]))

  try {
    await Promise.all([...logStores.values()].map((store) => store.ready()))
  } catch (err) {
    await Promise.all([...logStores.values()].map((store) => store.close()))
    console.error('Fatal error initializing log storage:', err)
    process.exitCode = 1
    return
  }

  const manager = new BotManager(configs, startBot, logStores, resolveConfigPath())
  manager.startAll()

  if (!webConfig.enabled) {
    process.stdout.write('TippyBot web server is disabled.\n')
    return
  }

  try {
    await startWebServer({
      manager,
      getLogStore: (instanceId) => manager.getLogStore(instanceId),
      createLogStore,
      password: webConfig.password,
      secureCookies: webConfig.secureCookies,
      dashboardIntervalMs: webConfig.dashboardIntervalMs,
      host: webConfig.host,
      port: webConfig.port,
      rateLimiterOptions: {
        maxAttempts: webConfig.loginMaxAttempts,
        lockoutMs: webConfig.loginLockoutMs
      }
    })
    process.stdout.write(`TippyBot web server listening on ${webConfig.host}:${webConfig.port}.\n`)
  } catch (err) {
    // Web startup failure must not take already-running bot instances down.
    console.error('Failed to start the TippyBot web server:', err)
    process.exitCode = 1
  }
}

void main()
