// src/core/microsoft-auth-options.ts
// Fixed Microsoft-auth flow parameters, shared by mineflayer's own connect path
// (bot.ts) and the standalone authenticateMicrosoft() flow. prismarine-auth's
// on-disk token cache is keyed by (username, flow, cacheName) -- NOT by host or
// port -- so both paths must pass identical values here, or they'd silently
// read/write different cache files and force a fresh device code even when a
// valid cached token already exists. minecraft-protocol defaults to exactly
// these values when no authTitle is given; they're restated explicitly (via
// prismarine-auth's own Titles constant, not a hand-copied literal) so both
// call sites are provably in sync rather than relying on an implicit default
// that could silently drift on a future dependency bump.

import { Titles } from 'prismarine-auth'

export const MICROSOFT_AUTH_FLOW_OPTIONS = {
  flow: 'live' as const,
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo' as const
}
