// src/interfaces/config.ts

export interface IBotConfig {
  /** Unique instance identifier -- namespaces this instance's data/ and auth_cache/ directories and its log prefix. */
  id: string

  /**
   * The connection target. Both absent means this instance is
   * "unconfigured" -- it exists (and, for 'microsoft' auth, can be signed
   * in) but has nothing to connect to yet. connect()/autoConnect/reconnect
   * are all no-ops until a host is set. `port` defaults to 25565 whenever a
   * host is given without one.
   */
  host?: string
  port?: number
  username: string
  auth: 'microsoft' | 'offline'
  profilesFolder?: string
  /**
   * Internal, stable identity used only as prismarine-auth's cache key for
   * 'microsoft' auth -- never shown to the user, and unrelated to the
   * account's real Minecraft name. Absent in bots.config.json defaults to
   * the resolved `username`, so an instance saved before this field existed
   * keeps its existing cached token instead of being forced to re-auth.
   * Meaningless (but always present) for 'offline' auth.
   */
  msaCacheKey: string

  commandPrefix: string // Prefix for bot commands in chat, e.g., "!"

  /** Normalized (lowercase) usernames with permanent Admin access; source of truth is bots.config.json, never mutated at runtime. */
  admins: string[]

  /** Whether this instance connects automatically at boot (or when added). Absent in bots.config.json defaults to true. */
  autoConnect: boolean
}
