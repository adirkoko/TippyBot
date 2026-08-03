// src/core/bot-manager.ts
// Central registry of every running bot instance, keyed by id. This is the
// single object a future control surface (e.g. a web admin panel) is meant
// to talk to instead of knowing about individual instances -- it doesn't run
// any connection logic itself (that's startBot/runInstance in bot.ts), it
// only creates a handle per configured instance, connects it, and keeps
// track of the handle it gets back.
//
// addInstance/removeInstance/updateInstance all mutate the same shared
// config file and the same instances Map, so they're serialized through one
// manager-level queue regardless of which id they target -- two overlapping
// CRUD calls (even for different instances) execute in submission order
// rather than racing each other's read-modify-write of the config file.
// connect()/disconnect() are NOT queued here: they only touch one
// BotInstance's own state, already serialized by that instance's own queue
// (see bot.ts), so an unrelated instance's connect/disconnect never waits
// behind a CRUD operation for a different id.

import type { IBotConfig } from '../interfaces/config'
import { ACTIVE_BOT_STATUSES, type IBotInstanceHandle } from '../interfaces/bot-instance'
import type { LogStore } from './log-store'
import { startBot } from './bot'
import { BotInstanceConflictError, BotInstanceNotFoundError } from './bot-errors'
import { resolveConfigPath, saveBotInstances } from '../config/instances'

type StartBot = (config: IBotConfig, logStore?: LogStore) => IBotInstanceHandle

export class BotManager {
  private readonly instances = new Map<string, IBotInstanceHandle>()
  private readonly logStores: Map<string, LogStore>
  private readonly configPath: string
  private crudQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly configs: IBotConfig[],
    private readonly start: StartBot = startBot,
    initialLogStores: ReadonlyMap<string, LogStore> = new Map(),
    configPath?: string
  ) {
    this.logStores = new Map(initialLogStores)
    this.configPath = resolveConfigPath(configPath)
  }

  /**
   * Creates and connects every configured instance. connect() rejections are
   * swallowed here -- they already leave the handle in an 'errored' status
   * (see BotInstance in bot.ts), so one bad instance never stops the others
   * or produces an unhandled rejection at boot.
   */
  startAll(): void {
    for (const config of this.configs) {
      const logStore = this.logStores.get(config.id)
      const handle = logStore ? this.start(config, logStore) : this.start(config)
      this.instances.set(config.id, handle)
      if (config.autoConnect) {
        void handle.connect().catch(() => undefined)
      }
    }
  }

  getInstances(): IBotInstanceHandle[] {
    return [...this.instances.values()]
  }

  getInstance(id: string): IBotInstanceHandle | undefined {
    return this.instances.get(id)
  }

  /** Read-only access for web/reporting surfaces; never exposes the Mineflayer bot context. */
  getLogStore(id: string): LogStore | undefined {
    return this.logStores.get(id)
  }

  /**
   * Adds a new instance: saves the full instance list (this one included)
   * before touching any in-memory state, so a failed save leaves nothing
   * added and nothing connected. Connects it afterward only if
   * config.autoConnect is true; other instances are never touched.
   */
  addInstance(config: IBotConfig, logStore: LogStore): Promise<IBotInstanceHandle> {
    return this.enqueueCrud(async () => {
      if (this.instances.has(config.id)) {
        throw new BotInstanceConflictError(`Bot instance "${config.id}" already exists.`)
      }

      await saveBotInstances([...this.currentConfigs(), config], this.configPath)

      const handle = this.start(config, logStore)
      this.instances.set(config.id, handle)
      this.logStores.set(config.id, logStore)

      if (config.autoConnect) {
        await handle.connect().catch(() => undefined)
      }
      return handle
    })
  }

  /**
   * Removes an instance: disconnects it first, then saves the instance list
   * without it, and only then drops it from the in-memory map -- a failed
   * save leaves the instance disconnected but still tracked, never lost.
   * Never touches that instance's data/, logs/, or auth_cache/ directories;
   * only stops its LogStore's timers.
   */
  removeInstance(id: string): Promise<void> {
    return this.enqueueCrud(async () => {
      const handle = this.instances.get(id)
      if (!handle) {
        throw new BotInstanceNotFoundError(id)
      }

      if (ACTIVE_BOT_STATUSES.includes(handle.getStatus())) {
        await handle.disconnect()
      }

      await saveBotInstances(
        this.currentConfigs().filter((config) => config.id !== id),
        this.configPath
      )

      this.instances.delete(id)
      const logStore = this.logStores.get(id)
      this.logStores.delete(id)
      await logStore?.close()
    })
  }

  /**
   * Replaces an instance's config. The id can never change -- config.id must
   * match id. If the instance was active, it's disconnected before saving
   * and reconnected with the new config after; if the save itself fails,
   * the disconnect is rolled back (best-effort) so the failure leaves the
   * instance running exactly as it was, and the file/memory config always
   * agree (memory is only swapped after a successful save).
   */
  updateInstance(id: string, config: IBotConfig): Promise<IBotInstanceHandle> {
    return this.enqueueCrud(async () => {
      if (config.id !== id) {
        throw new BotInstanceConflictError(
          `Changing a bot instance's id is not supported (got "${config.id}" for "${id}").`
        )
      }
      const existing = this.instances.get(id)
      if (!existing) {
        throw new BotInstanceNotFoundError(id)
      }

      const wasActive = ACTIVE_BOT_STATUSES.includes(existing.getStatus())
      if (wasActive) {
        await existing.disconnect()
      }

      try {
        await saveBotInstances(
          this.currentConfigs().map((current) => (current.id === id ? config : current)),
          this.configPath
        )
      } catch (err) {
        if (wasActive) await existing.connect().catch(() => undefined)
        throw err
      }

      const logStore = this.logStores.get(id)
      const handle = logStore ? this.start(config, logStore) : this.start(config)
      this.instances.set(id, handle)

      if (wasActive) {
        await handle.connect().catch(() => undefined)
      }
      return handle
    })
  }

  /**
   * Connects/disconnects/restarts one instance -- the only way any external
   * caller (the web API) should ever drive an instance's connection state.
   * Routed through the same CRUD queue as add/remove/update so, e.g., a
   * connect() can never land in the gap between removeInstance's disconnect
   * and its removal from the map. Internal callers (startAll and the CRUD
   * methods above) call handle.connect()/disconnect() directly instead --
   * they already run inside this queue, and re-entering it here would
   * deadlock.
   */
  connectInstance(id: string): Promise<void> {
    return this.enqueueCrud(() => this.requireInstance(id).connect())
  }

  disconnectInstance(id: string, reason?: string): Promise<void> {
    return this.enqueueCrud(() => this.requireInstance(id).disconnect(reason))
  }

  /** Disconnects first only if currently active, then connects -- works from any status, including 'errored'. */
  restartInstance(id: string): Promise<void> {
    return this.enqueueCrud(async () => {
      const handle = this.requireInstance(id)
      if (ACTIVE_BOT_STATUSES.includes(handle.getStatus())) {
        await handle.disconnect()
      }
      await handle.connect()
    })
  }

  private requireInstance(id: string): IBotInstanceHandle {
    const handle = this.instances.get(id)
    if (!handle) throw new BotInstanceNotFoundError(id)
    return handle
  }

  /** The full current instance list, derived from the live handles -- the single source of truth for what gets saved next. */
  private currentConfigs(): IBotConfig[] {
    return [...this.instances.values()].map((handle) => handle.config)
  }

  private enqueueCrud<T>(work: () => Promise<T>): Promise<T> {
    const result = this.crudQueue.then(work)
    this.crudQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
