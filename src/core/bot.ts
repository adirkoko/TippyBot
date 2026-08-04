// src/core/bot.ts
import mineflayer, { type Bot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'

import type { IBotConfig } from '../interfaces/config'
import type { IBotContext } from '../interfaces/bot-context'
import type { IModule } from '../interfaces/module'
import type { ILogger } from '../interfaces/logger'
import type { LogStore } from './log-store'
import {
  ACTIVE_BOT_STATUSES,
  INACTIVE_BOT_STATUSES,
  type BotInstanceError,
  type BotInstanceSnapshot,
  type BotInstanceStatus,
  type IBotInstanceHandle,
  type MicrosoftAuthStatus,
  type MicrosoftDeviceCode
} from '../interfaces/bot-instance'

import { createConsoleLogger } from '../utils/logger'
import { buildSnapshot } from './bot-instance-snapshot'
import { BotInstanceConflictError } from './bot-errors'
import { ActionRegistry } from './actions'
import { CommandRegistry } from './commands'
import { PathfinderLock } from './pathfinder-lock'
import { PermissionService } from './permission-service'
import { JsonPermissionStore } from './permission-store'
import { TaskManager } from './task-manager'
import { CooldownService } from './cooldown-service'
import { HomeService } from './home-service'
import { JsonHomeStore } from './home-store'
import { computeReconnectDelay } from './reconnect'
import { isFatalConnectionError } from './connection-errors'
import { MICROSOFT_AUTH_FLOW_OPTIONS } from './microsoft-auth-options'
import { authenticateMicrosoft as defaultAuthenticateMicrosoft } from './microsoft-auth'
import { permissionsFilePath, homesFilePath, defaultProfilesFolder } from '../config/instancePaths'
import { modules } from '../modules/index'

/** How long disconnect() waits for mineflayer's 'end' event before forcing the state anyway. */
const DISCONNECT_TIMEOUT_MS = 5_000

/**
 * Concrete IBotInstanceHandle. Everything below `getSnapshot()` is internal
 * book-keeping (`ctx`, `connectedSince`, `currentBot`, `reconnectTimer`,
 * `stopRequested`) -- intentionally not part of IBotInstanceHandle, so
 * nothing outside this module can reach mineflayer's Bot instance or
 * IBotContext through the handle.
 *
 * connect()/disconnect() both go through `operation`, a per-instance promise
 * chain, so two overlapping calls (e.g. a double-clicked button) execute in
 * submission order instead of racing each other's state changes.
 */
class BotInstance implements IBotInstanceHandle {
  status: BotInstanceStatus = 'disconnected'
  lastError: BotInstanceError | undefined
  ctx: IBotContext | undefined
  connectedSince: number | undefined

  /** Set by disconnect() before tearing anything down, so the 'end' handler knows not to reconnect. */
  stopRequested = false
  currentBot: Bot | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined

  /** undefined for 'offline' auth -- see MicrosoftAuthStatus. */
  authStatus: MicrosoftAuthStatus | undefined
  authError: BotInstanceError | undefined
  minecraftProfileName: string | undefined
  deviceCode: MicrosoftDeviceCode | undefined
  /**
   * Identity token for the in-flight authenticate() call, if any. The
   * eventual result only applies if this still matches when it settles --
   * cancelAuthentication() clears it immediately (see there for why a
   * bounded wait, not real cancellation, is the right tradeoff here, same
   * as disconnect()'s DISCONNECT_TIMEOUT_MS fallback below).
   */
  private currentAuthAttempt: object | undefined

  private operation: Promise<void> = Promise.resolve()

  constructor(
    readonly id: string,
    readonly config: IBotConfig,
    private readonly logger: ILogger,
    private readonly createMineflayerBot: typeof mineflayer.createBot,
    private readonly authenticateMicrosoft: typeof defaultAuthenticateMicrosoft
  ) {
    this.authStatus = config.auth === 'microsoft' ? 'unknown' : undefined
  }

  getStatus(): BotInstanceStatus {
    return this.status
  }

  getLastError(): BotInstanceError | undefined {
    return this.lastError
  }

  getAuthStatus(): MicrosoftAuthStatus | undefined {
    return this.authStatus
  }

  getAuthError(): BotInstanceError | undefined {
    return this.authError
  }

  getMinecraftProfileName(): string | undefined {
    return this.minecraftProfileName
  }

  getDeviceCode(): MicrosoftDeviceCode | undefined {
    return this.deviceCode
  }

  getSnapshot(): BotInstanceSnapshot {
    return buildSnapshot({
      id: this.id,
      config: this.config,
      status: this.status,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
      bot: this.status === 'online' ? this.ctx?.bot : undefined,
      activeTask: this.ctx?.tasks.getActive(),
      authStatus: this.authStatus,
      authError: this.authError,
      minecraftProfileName: this.minecraftProfileName,
      deviceCode: this.deviceCode
    })
  }

  connect(): Promise<void> {
    // "Unconfigured" instance (see IBotConfig) -- checked before ever
    // touching mineflayer/runInstance, so an unconfigured instance never
    // gets a reconnect loop, an 'errored' status, or any other side effect
    // from an attempt that could only ever fail the same way.
    if (!this.config.host) {
      return Promise.reject(
        new BotInstanceConflictError(`Bot instance "${this.id}" has no host configured yet.`)
      )
    }
    // Checked synchronously, same reasoning as authenticate() below: without
    // this, a connect() issued while authenticate() is still waiting on the
    // user would silently queue behind it (possibly for minutes) instead of
    // being rejected right away.
    if (this.authStatus === 'authenticating') {
      return Promise.reject(
        new BotInstanceConflictError(
          `Bot instance "${this.id}" is currently authenticating; wait for it to finish or cancel it first.`
        )
      )
    }
    return this.enqueue(() => this.doConnect())
  }

  disconnect(reason?: string): Promise<void> {
    return this.enqueue(() => this.doDisconnect(reason))
  }

  /**
   * Guards are checked and authStatus flips to 'authenticating' synchronously,
   * right here -- NOT inside the queued work. authenticateMicrosoft() can
   * stay pending for as long as the user takes to complete the device code
   * (unlike doConnect(), whose promise resolves quickly regardless of the
   * actual network connect), so if this state only changed once the queued
   * function actually ran, a second authenticate() (or a connect()) issued
   * before that turn would see stale state and wrongly proceed instead of
   * being rejected immediately.
   */
  authenticate(): Promise<void> {
    if (this.config.auth !== 'microsoft') {
      return Promise.reject(
        new BotInstanceConflictError(`Bot instance "${this.id}" does not use Microsoft authentication.`)
      )
    }
    if (ACTIVE_BOT_STATUSES.includes(this.status)) {
      return Promise.reject(
        new BotInstanceConflictError(`Bot instance "${this.id}" is currently ${this.status}; disconnect first.`)
      )
    }
    if (this.authStatus === 'authenticating') {
      return Promise.reject(new BotInstanceConflictError(`Bot instance "${this.id}" is already authenticating.`))
    }

    const attempt = {}
    this.currentAuthAttempt = attempt
    this.authStatus = 'authenticating'
    this.authError = undefined
    this.deviceCode = undefined

    return this.enqueue(() => this.doAuthenticate(attempt))
  }

  /**
   * Deliberately NOT queued through `enqueue()`: that chain only runs the
   * next operation once the current one settles, which is exactly wrong for
   * "stop waiting on the one that's currently running". This mutates state
   * directly and immediately instead.
   */
  cancelAuthentication(): Promise<void> {
    if (this.authStatus !== 'authenticating') {
      return Promise.reject(
        new BotInstanceConflictError(`Bot instance "${this.id}" is not currently authenticating.`)
      )
    }
    this.currentAuthAttempt = undefined
    this.authStatus = 'unauthenticated'
    this.deviceCode = undefined
    return Promise.resolve()
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.operation.then(work)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async doConnect(): Promise<void> {
    if (ACTIVE_BOT_STATUSES.includes(this.status)) {
      throw new BotInstanceConflictError(`Bot instance "${this.id}" is already ${this.status}.`)
    }
    if (this.authStatus === 'authenticating') {
      throw new BotInstanceConflictError(
        `Bot instance "${this.id}" is currently authenticating; wait for it to finish or cancel it first.`
      )
    }

    this.stopRequested = false
    this.status = 'connecting'
    try {
      await runInstance(this.config, this.logger, this, this.createMineflayerBot)
    } catch (err) {
      this.status = 'errored'
      this.lastError = { message: err instanceof Error ? err.message : String(err), at: Date.now() }
      this.logger.error('Fatal error starting bot instance', { err })
      throw err
    }
  }

  private async doDisconnect(reason = 'manual disconnect'): Promise<void> {
    if (INACTIVE_BOT_STATUSES.includes(this.status)) {
      throw new BotInstanceConflictError(`Bot instance "${this.id}" is not currently connected.`)
    }

    this.stopRequested = true
    if (this.reconnectTimer) {
      // Only a pending retry, nothing live to close -- the 'end' handler
      // already ran for the drop that scheduled this timer.
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      this.finishDisconnect()
      return
    }

    const bot = this.currentBot
    if (!bot) {
      this.finishDisconnect()
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const timer = setTimeout(() => {
        this.logger.warn("Bot did not confirm disconnect in time; forcing 'disconnected' state", {
          timeoutMs: DISCONNECT_TIMEOUT_MS
        })
        finish()
      }, DISCONNECT_TIMEOUT_MS)
      bot.once('end', () => {
        clearTimeout(timer)
        finish()
      })
      bot.end(reason)
    })

    // Idempotent with whatever the 'end' handler already set -- this is the
    // authoritative outcome, including the timeout-forced fallback above.
    this.finishDisconnect()
  }

  private finishDisconnect(): void {
    this.status = 'disconnected'
    this.connectedSince = undefined
    this.currentBot = undefined
    this.ctx = undefined
  }

  /** Guards already ran and authStatus is already 'authenticating' -- see authenticate() above. `attempt` identifies this specific call for the staleness checks below. */
  private async doAuthenticate(attempt: object): Promise<void> {
    // Cancelled (or superseded) while queued behind a connect()/disconnect()
    // that was already in flight -- skip the network call entirely instead
    // of spending a device code on an attempt nobody is waiting for anymore.
    if (this.currentAuthAttempt !== attempt) return

    try {
      const result = await this.authenticateMicrosoft(
        this.config.msaCacheKey,
        this.config.profilesFolder ?? defaultProfilesFolder(this.id),
        (code) => {
          // Still logged, for anyone watching the console/log file directly --
          // but the web UI (see routes/bots.ts) reads this off the instance
          // instead of parsing logs, so it shows up in the /bots page itself.
          console.log('================================================')
          console.log(`TippyBot Microsoft Authentication [${this.id}]`)
          console.log('Link: https://www.microsoft.com/link')
          console.log(`Code: ${code.userCode}`)
          console.log('================================================')
          if (this.currentAuthAttempt === attempt) this.deviceCode = code
        }
      )
      if (this.currentAuthAttempt !== attempt) return // superseded by cancelAuthentication() or a later attempt

      this.authStatus = 'authenticated'
      this.minecraftProfileName = result.profileName
      this.deviceCode = undefined
      this.logger.info('Microsoft authentication succeeded', { profileName: result.profileName })
    } catch (err) {
      if (this.currentAuthAttempt !== attempt) return // superseded -- don't overwrite a newer attempt's outcome

      this.authStatus = 'auth_error'
      this.authError = { message: err instanceof Error ? err.message : String(err), at: Date.now() }
      this.deviceCode = undefined
      this.logger.error('Microsoft authentication failed', { err })
      throw err
    } finally {
      if (this.currentAuthAttempt === attempt) this.currentAuthAttempt = undefined
    }
  }
}

/**
 * Creates a handle for a bot instance without connecting it -- callers
 * decide when (and whether) to call handle.connect(). Every piece of state
 * this instance owns (permissions, homes, auth cache, log lines) is
 * namespaced under `config.id`, so multiple instances can run in the same
 * process without ever touching each other's data.
 */
export function startBot(
  config: IBotConfig,
  logStore?: LogStore,
  createMineflayerBot: typeof mineflayer.createBot = mineflayer.createBot,
  authenticateMicrosoft: typeof defaultAuthenticateMicrosoft = defaultAuthenticateMicrosoft
): IBotInstanceHandle {
  const logger = createConsoleLogger(config.id, logStore).withCategory('connection')
  return new BotInstance(config.id, config, logger, createMineflayerBot, authenticateMicrosoft)
}

async function runInstance(
  config: IBotConfig,
  logger: ILogger,
  instance: BotInstance,
  createMineflayerBot: typeof mineflayer.createBot
): Promise<void> {
  // Services rebuilt fresh on every connect() -- cheap, and avoids carrying
  // state (e.g. a stale active task) across a disconnect/reconnect cycle.
  const moduleLogger = logger.withCategory('modules')
  const permissionLogger = logger.withCategory('permissions')
  const actions = new ActionRegistry()
  const commands = new CommandRegistry()
  const pathfinderLock = new PathfinderLock()
  const permissionStore = new JsonPermissionStore(permissionsFilePath(config.id))
  const permissions = new PermissionService(config.admins, permissionStore, permissionLogger)
  const tasks = new TaskManager()
  const cooldowns = new CooldownService()
  const homeStore = new JsonHomeStore(homesFilePath(config.id))
  const homes = new HomeService(homeStore)

  await permissions.load()
  await homes.load()

  let reconnectAttempts = 0

  async function connect(): Promise<void> {
    let fatalError: Error | undefined

    const bot = createMineflayerBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      profilesFolder: config.profilesFolder,
      ...MICROSOFT_AUTH_FLOW_OPTIONS,

      onMsaCode: (data) => {
        console.log('================================================')
        console.log(`TippyBot Microsoft Authentication [${config.id}]`)
        console.log('Link: https://www.microsoft.com/link')
        console.log(`Code: ${data.user_code}`)
        console.log('================================================')
      }
    })
    instance.currentBot = bot

    bot.loadPlugin(pathfinder)

    const ctx: IBotContext = {
      bot,
      config,
      logger: moduleLogger,
      actions,
      commands,
      pathfinderLock,
      permissions,
      tasks,
      cooldowns,
      homes
    }
    instance.ctx = ctx

    bot.once('login', () => {
      reconnectAttempts = 0
      instance.status = 'online'
      instance.connectedSince = Date.now()
      // A successful login only proves a still-valid token for 'microsoft'
      // auth; instance.authStatus is undefined for 'offline', so this is a
      // no-op there.
      if (instance.authStatus !== undefined) {
        instance.authStatus = 'authenticated'
        instance.minecraftProfileName = bot.username
      }
      logger.info('TippyBot joined the server')
    })

    bot.on('error', (err) => {
      logger.error('Bot error', { err })
      // Recorded, not acted on immediately: 'end' always follows 'error' for a
      // failed connection attempt, and it's the single place that already
      // decides the handle's next status -- duplicating that decision here
      // would risk the two disagreeing.
      if (isFatalConnectionError(err)) fatalError = err
    })

    bot.on('kicked', (reason, loggedIn) => {
      logger.warn('Bot was kicked from the server', { reason, loggedIn })
    })

    bot.on('death', () => {
      tasks.abort('death')
    })

    bot.on('end', (reason) => {
      // disconnect() gives up waiting for 'end' after DISCONNECT_TIMEOUT_MS and
      // forces the handle to 'disconnected' regardless -- if this bot's real
      // teardown was merely slow (not lost), its 'end' can still arrive after
      // that timeout, and possibly after a subsequent connect() has already
      // installed a new bot as instance.currentBot. Once that's happened, this
      // handler belongs to an abandoned connection: touching instance state or
      // scheduling a reconnect here would corrupt the newer connection's status
      // or resurrect a stale reconnect loop alongside it.
      if (instance.currentBot !== bot) return

      tasks.abort('disconnected')
      instance.connectedSince = undefined
      instance.currentBot = undefined

      if (instance.stopRequested) {
        instance.status = 'disconnected'
        instance.ctx = undefined
        logger.info('Bot disconnected (requested)', { reason })
        return
      }

      if (fatalError) {
        instance.status = 'errored'
        instance.lastError = { message: fatalError.message, at: Date.now() }
        instance.ctx = undefined
        logger.error('Bot connection failed with a non-retryable error; not scheduling a reconnect', {
          err: fatalError
        })
        return
      }

      instance.status = 'reconnecting'
      logger.warn('Bot disconnected from the server', { reason })
      scheduleReconnect()
    })

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      void commands.handleChatMessage(username, message, ctx)
    })

    await loadModules(modules, ctx)
  }

  function scheduleReconnect(): void {
    if (instance.reconnectTimer) return // a reconnect is already scheduled -- never run two in parallel

    reconnectAttempts++
    const delay = computeReconnectDelay(reconnectAttempts)
    logger.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`)

    instance.reconnectTimer = setTimeout(() => {
      instance.reconnectTimer = undefined
      connect().catch((err) => logger.error('Reconnect attempt failed', { err }))
    }, delay)
  }

  await connect()
}

async function loadModules(allModules: IModule[], ctx: IBotContext): Promise<void> {
  for (const mod of allModules) {
    try {
      await mod.init(ctx)
      ctx.logger.info(`Loaded module: ${mod.id}`)
    } catch (err) {
      ctx.logger.error(`Failed to init module: ${mod.id}`, { err })
    }
  }
}
