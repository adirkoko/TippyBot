// src/core/bot-manager.ts
// Central registry of every running bot instance, keyed by id. This is the
// single object a future control surface (e.g. a web admin panel) is meant
// to talk to instead of knowing about individual instances -- it doesn't run
// any connection logic itself (that's startBot/runInstance in bot.ts), it
// only starts each configured instance and keeps track of the handle it
// gets back.

import type { IBotConfig } from '../interfaces/config'
import type { IBotInstanceHandle } from '../interfaces/bot-instance'
import type { LogStore } from './log-store'
import { startBot } from './bot'

type StartBot = (config: IBotConfig, logStore?: LogStore) => IBotInstanceHandle

export class BotManager {
  private readonly instances = new Map<string, IBotInstanceHandle>()

  constructor(
    private readonly configs: IBotConfig[],
    private readonly start: StartBot = startBot,
    private readonly logStores: ReadonlyMap<string, LogStore> = new Map()
  ) {}

  /** Starts every configured instance. startBot never throws -- a failed instance shows up as an 'errored' handle, not a rejection. */
  startAll(): void {
    for (const config of this.configs) {
      const logStore = this.logStores.get(config.id)
      const handle = logStore ? this.start(config, logStore) : this.start(config)
      this.instances.set(config.id, handle)
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
}
