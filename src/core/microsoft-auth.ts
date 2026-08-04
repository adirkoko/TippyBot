// src/core/microsoft-auth.ts
// Standalone Microsoft device-code authentication, entirely decoupled from
// connecting to any Minecraft server -- see bot.ts for the connect path.
// prismarine-auth's on-disk cache is keyed by (cacheUsername, flow,
// cacheName) only, never by host/port (see microsoft-auth-options.ts), so a
// token obtained here is transparently reused by mineflayer's own internal
// auth on the next connect(), and vice versa, as long as both pass the exact
// same flow options -- which is the whole reason that constant is shared.

import { Authflow } from 'prismarine-auth'
import { MICROSOFT_AUTH_FLOW_OPTIONS } from './microsoft-auth-options'

export interface MicrosoftDeviceCode {
  userCode: string
  verificationUri: string
  /** Human-readable instructions, already including the code and URL. */
  message: string
}

export interface MicrosoftAuthResult {
  /** The account's real Minecraft Java username, learned from its profile. */
  profileName: string
}

/**
 * Resolves once a usable Minecraft Java token is cached: immediately if a
 * valid cached token already exists, or after the user completes the device
 * code flow (onCode is called at most once, synchronously within the
 * underlying library's request, with the code to show them). Rejects if the
 * account doesn't own Minecraft, or on any auth failure.
 */
export async function authenticateMicrosoft(
  cacheUsername: string,
  profilesFolder: string,
  onCode: (code: MicrosoftDeviceCode) => void
): Promise<MicrosoftAuthResult> {
  const authflow = new Authflow(cacheUsername, profilesFolder, MICROSOFT_AUTH_FLOW_OPTIONS, (data) => {
    onCode({ userCode: data.user_code, verificationUri: data.verification_uri, message: data.message })
  })

  const { profile } = await authflow.getMinecraftJavaToken({ fetchProfile: true })
  if (!profile?.name) {
    throw new Error(
      'Microsoft authentication succeeded, but no Minecraft profile was returned -- does this account own Minecraft?'
    )
  }
  return { profileName: profile.name }
}
