import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BotManager } from '../../src/core/bot-manager'
import { BotInstanceConflictError } from '../../src/core/bot-errors'
import type { IBotConfig } from '../../src/interfaces/config'
import type { LogStore } from '../../src/core/log-store'
import type {
  BotInstanceStatus,
  IBotInstanceHandle,
  MicrosoftAuthStatus,
  MicrosoftDeviceCode
} from '../../src/interfaces/bot-instance'
import { SessionStore } from '../../src/web/auth/session'
import { createWebServer } from '../../src/web/server'

let activeServer: Server | undefined
let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tippybot-bots-route-'))
  configPath = path.join(tmpDir, 'bots.config.json')
})

afterEach(async () => {
  if (activeServer) {
    const server = activeServer
    activeServer = undefined
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function fakeConfig(id: string, overrides: Partial<IBotConfig> = {}): IBotConfig {
  return {
    id,
    host: 'example.com',
    port: 25565,
    username: `${id}Bot`,
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true,
    msaCacheKey: `${id}Bot`,
    ...overrides
  }
}

function fakeLogStore(): LogStore {
  return { ready: () => Promise.resolve(), close: () => Promise.resolve() } as unknown as LogStore
}

interface AuthAttemptControl {
  resolve: (profileName: string) => void
  reject: (err: Error) => void
}

const FAKE_DEVICE_CODE: MicrosoftDeviceCode = {
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://www.microsoft.com/link',
  message: 'To sign in, use a web browser to open https://www.microsoft.com/link and enter ABCD-EFGH.'
}

/** A minimal but real state machine (no network), so connect()/disconnect()/authenticate()/cancelAuthentication() guard rejections behave like the real BotInstance. */
function trackingFakeHandle(config: IBotConfig, authAttempts: AuthAttemptControl[] = []): IBotInstanceHandle {
  let status: BotInstanceStatus = 'disconnected'
  let lastError: { message: string; at: number } | undefined
  let authStatus: MicrosoftAuthStatus | undefined = config.auth === 'microsoft' ? 'unknown' : undefined
  let authError: { message: string; at: number } | undefined
  let minecraftProfileName: string | undefined
  let deviceCode: MicrosoftDeviceCode | undefined
  let currentAuthAttempt: object | undefined

  const handle: IBotInstanceHandle = {
    id: config.id,
    config,
    getStatus: () => status,
    getLastError: () => lastError,
    getAuthStatus: () => authStatus,
    getAuthError: () => authError,
    getMinecraftProfileName: () => minecraftProfileName,
    getDeviceCode: () => deviceCode,
    getSnapshot: () => ({
      id: config.id,
      status,
      lastError,
      host: config.host,
      port: config.port,
      username: config.username,
      uptimeMs: undefined,
      ping: undefined,
      health: undefined,
      food: undefined,
      position: undefined,
      dimension: undefined,
      activeTask: undefined,
      authStatus,
      authError,
      minecraftProfileName,
      deviceCode
    }),
    connect: () => {
      if (!config.host) {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" has no host configured yet.`))
      }
      if (authStatus === 'authenticating') {
        return Promise.reject(
          new BotInstanceConflictError(`Bot instance "${config.id}" is currently authenticating; wait for it to finish or cancel it first.`)
        )
      }
      if (status === 'connecting' || status === 'online' || status === 'reconnecting') {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" is already ${status}.`))
      }
      status = 'online'
      return Promise.resolve()
    },
    disconnect: () => {
      if (status === 'disconnected' || status === 'errored') {
        return Promise.reject(
          new BotInstanceConflictError(`Bot instance "${config.id}" is not currently connected.`)
        )
      }
      status = 'disconnected'
      return Promise.resolve()
    },
    authenticate: () => {
      if (config.auth !== 'microsoft') {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" does not use Microsoft authentication.`))
      }
      if (status === 'connecting' || status === 'online' || status === 'reconnecting') {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" is currently ${status}; disconnect first.`))
      }
      if (authStatus === 'authenticating') {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" is already authenticating.`))
      }

      authStatus = 'authenticating'
      authError = undefined
      deviceCode = FAKE_DEVICE_CODE
      const attempt = {}
      currentAuthAttempt = attempt

      return new Promise<void>((resolve, reject) => {
        authAttempts.push({
          // Mirrors BotInstance's own staleness guard: a cancelled or
          // superseded attempt's eventual result must not overwrite newer
          // state -- without this, the fake wouldn't accurately model what
          // these tests are trying to verify.
          resolve: (profileName) => {
            if (currentAuthAttempt !== attempt) return resolve()
            authStatus = 'authenticated'
            minecraftProfileName = profileName
            deviceCode = undefined
            resolve()
          },
          reject: (err) => {
            // Matches BotInstance.doAuthenticate(): a superseded failure
            // resolves quietly instead of rejecting -- nobody is waiting on
            // this specific attempt's outcome anymore.
            if (currentAuthAttempt !== attempt) return resolve()
            authStatus = 'auth_error'
            authError = { message: err.message, at: Date.now() }
            deviceCode = undefined
            reject(err)
          }
        })
      })
    },
    cancelAuthentication: () => {
      if (authStatus !== 'authenticating') {
        return Promise.reject(new BotInstanceConflictError(`Bot instance "${config.id}" is not currently authenticating.`))
      }
      currentAuthAttempt = undefined
      authStatus = 'unauthenticated'
      deviceCode = undefined
      return Promise.resolve()
    }
  }
  return handle
}

async function launch(
  initialConfigs: IBotConfig[] = [],
  authAttempts: AuthAttemptControl[] = []
): Promise<{ baseUrl: string; manager: BotManager }> {
  await fs.writeFile(configPath, JSON.stringify({ instances: initialConfigs }), 'utf8')
  const manager = new BotManager(
    initialConfigs,
    (config) => trackingFakeHandle(config, authAttempts),
    new Map(),
    configPath
  )
  manager.startAll()

  activeServer = createWebServer({
    manager,
    getLogStore: () => undefined,
    createLogStore: () => fakeLogStore(),
    password: 'correct-password',
    sessions: new SessionStore(),
    publicDir: path.resolve(process.cwd(), 'src/web/public')
  })
  await new Promise<void>((resolve, reject) => {
    activeServer?.once('error', reject)
    activeServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = activeServer?.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}`, manager }
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' })
  })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

async function savedIds(): Promise<string[]> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as { instances: IBotConfig[] }
  return raw.instances.map((c) => c.id)
}

describe('bot management routes', () => {
  it('protects every /api/bots route', async () => {
    const { baseUrl } = await launch([fakeConfig('steve')])
    const jsonBody = { headers: { 'Content-Type': 'application/json' }, body: '{}' }

    const results = await Promise.all([
      fetch(`${baseUrl}/api/bots`),
      fetch(`${baseUrl}/api/bots`, { method: 'POST', ...jsonBody }),
      fetch(`${baseUrl}/api/bots/steve`, { method: 'PUT', ...jsonBody }),
      fetch(`${baseUrl}/api/bots/steve`, { method: 'DELETE' }),
      fetch(`${baseUrl}/api/bots/steve/connect`, { method: 'POST' }),
      fetch(`${baseUrl}/api/bots/steve/disconnect`, { method: 'POST' }),
      fetch(`${baseUrl}/api/bots/steve/restart`, { method: 'POST' }),
      fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST' }),
      fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'DELETE' })
    ])

    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401])
  })

  describe('GET /api/bots', () => {
    it('returns a safe-to-display config and up-to-date status for every instance', async () => {
      const { baseUrl } = await launch([fakeConfig('steve', { admins: ['playerone'] })])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      expect(response.status).toBe(200)
      const body = await response.json()

      expect(body.instances).toEqual([
        {
          id: 'steve',
          host: 'example.com',
          port: 25565,
          username: 'steveBot',
          auth: 'offline',
          commandPrefix: '!',
          admins: ['playerone'],
          profilesFolder: undefined,
          msaCacheKey: 'steveBot',
          autoConnect: true,
          status: 'online', // startAll() already connected it since autoConnect: true
          lastError: undefined,
          authStatus: undefined, // 'offline' auth
          authError: undefined,
          minecraftProfileName: undefined,
          deviceCode: undefined
        }
      ])
    })

    it('never includes anything beyond the documented safe fields -- no auth_cache content, no tokens', async () => {
      const { baseUrl } = await launch([fakeConfig('steve', { profilesFolder: './auth_cache/steve' })])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      const body = await response.json()

      // undefined-valued fields (e.g. lastError when there is none) are
      // dropped entirely by JSON.stringify, so this only asserts every key
      // that *is* present is on the allow-list -- the security-relevant
      // property -- rather than requiring an exact, always-identical shape.
      const allowedKeys = new Set([
        'id',
        'host',
        'port',
        'username',
        'auth',
        'commandPrefix',
        'admins',
        'profilesFolder',
        'msaCacheKey',
        'autoConnect',
        'status',
        'lastError',
        'authStatus',
        'authError',
        'minecraftProfileName',
        'deviceCode'
      ])
      expect(Object.keys(body.instances[0]).every((key) => allowedKeys.has(key))).toBe(true)
      // profilesFolder is a path, not file content -- confirm it's the path we set, nothing more.
      expect(body.instances[0].profilesFolder).toBe('./auth_cache/steve')
    })

    it('redacts secret-shaped content inside lastError.message', async () => {
      const { baseUrl, manager } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)
      const handle = manager.getInstance('steve')
      expect(handle).toBeDefined()
      // Simulate a fatal error whose message happens to contain a secret shape.
      handle!.getLastError = () => ({ message: 'boom WEB_PASSWORD=super-secret-value', at: 1 })

      const response = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      const body = await response.json()

      expect(body.instances[0].lastError.message).toBe('boom WEB_PASSWORD=[REDACTED]')
    })
  })

  describe('POST /api/bots', () => {
    it('creates an instance, saves before responding, and connects it when autoConnect is true', async () => {
      const { baseUrl, manager } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'alex',
          host: 'play.example.com',
          port: 25565,
          username: 'AlexBot',
          auth: 'offline'
        })
      })

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.id).toBe('alex')
      expect(body.status).toBe('online')

      // Saved to disk by the time the client sees success.
      expect(await savedIds()).toEqual(['alex'])
      expect(manager.getInstance('alex')).toBeDefined()
    })

    it('does not connect the new instance when autoConnect is false', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'alex',
          host: 'play.example.com',
          port: 25565,
          username: 'AlexBot',
          auth: 'offline',
          autoConnect: false
        })
      })

      const body = await response.json()
      expect(body.status).toBe('disconnected')
    })

    it('returns 400 with a clear message for an invalid field', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'alex', host: 'play.example.com', port: 'not-a-number', username: 'AlexBot', auth: 'offline' })
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toMatch(/"port"/)
    })

    it('returns 400 for an invalid admin username, not a 500', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'alex',
          host: 'play.example.com',
          port: 25565,
          username: 'AlexBot',
          auth: 'offline',
          admins: ['Not A Valid Name']
        })
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toMatch(/Invalid Minecraft username/)
    })

    it('returns 400 for a profilesFolder that escapes the project directory, not a 500', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'alex',
          host: 'play.example.com',
          port: 25565,
          username: 'AlexBot',
          auth: 'offline',
          profilesFolder: '../../etc'
        })
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toMatch(/"profilesFolder"/)
    })

    it('returns 409 for a duplicate id and does not touch the saved file', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)
      const before = await savedIds()

      const response = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'steve', host: 'other.example.com', port: 25565, username: 'SteveBot', auth: 'offline' })
      })

      expect(response.status).toBe(409)
      expect(await savedIds()).toEqual(before)
    })
  })

  describe('PUT /api/bots/:id', () => {
    it('updates the config, saves before responding, and returns the new values', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'steve',
          host: 'new-host.example.com',
          port: 25566,
          username: 'steveBot',
          auth: 'offline'
        })
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.host).toBe('new-host.example.com')
      expect(body.port).toBe(25566)

      const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as { instances: IBotConfig[] }
      expect(raw.instances[0].host).toBe('new-host.example.com')
    })

    it('preserves msaCacheKey across an edit that only adds a host, when the client sends it back unchanged', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const created = await fetch(`${baseUrl}/api/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'steve', auth: 'microsoft', autoConnect: false })
      })
      const createdBody = await created.json()
      expect(createdBody.msaCacheKey).toBe('steve') // auto-generated from id

      const updated = await fetch(`${baseUrl}/api/bots/steve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          id: 'steve',
          host: '127.0.0.1',
          port: 25565,
          auth: 'microsoft',
          msaCacheKey: createdBody.msaCacheKey,
          autoConnect: false
        })
      })

      expect(updated.status).toBe(200)
      const updatedBody = await updated.json()
      expect(updatedBody.msaCacheKey).toBe('steve')
      expect(updatedBody.host).toBe('127.0.0.1')
    })

    it('rejects an attempt to change the id with 400, not 500 or a silent id change', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'someone-else', host: 'example.com', port: 25565, username: 'x', auth: 'offline' })
      })

      expect(response.status).toBe(400)
      expect(await savedIds()).toEqual(['steve'])
    })

    it('returns 404 for an unknown id', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/missing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'missing', host: 'example.com', port: 25565, username: 'x', auth: 'offline' })
      })

      expect(response.status).toBe(404)
    })

    it('returns 400 for an invalid field instead of reaching BotManager', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ id: 'steve', host: '', port: 25565, username: 'x', auth: 'offline' })
      })

      expect(response.status).toBe(400)
    })
  })

  describe('DELETE /api/bots/:id', () => {
    it('removes the instance and saves before responding', async () => {
      const { baseUrl, manager } = await launch([fakeConfig('steve'), fakeConfig('alex')])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve`, { method: 'DELETE', headers: { Cookie: cookie } })

      expect(response.status).toBe(204)
      expect(await savedIds()).toEqual(['alex'])
      expect(manager.getInstance('steve')).toBeUndefined()
    })

    it('returns 404 for an unknown id', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/missing`, { method: 'DELETE', headers: { Cookie: cookie } })

      expect(response.status).toBe(404)
    })
  })

  describe('connect / disconnect / restart', () => {
    it('disconnects a connected instance, then rejects a second disconnect with 409', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')]) // autoConnect: true -> already online
      const cookie = await login(baseUrl)

      const first = await fetch(`${baseUrl}/api/bots/steve/disconnect`, { method: 'POST', headers: { Cookie: cookie } })
      expect(first.status).toBe(200)
      expect((await first.json()).status).toBe('disconnected')

      const second = await fetch(`${baseUrl}/api/bots/steve/disconnect`, { method: 'POST', headers: { Cookie: cookie } })
      expect(second.status).toBe(409)
    })

    it('connects a disconnected instance, then rejects a second connect with 409', async () => {
      const { baseUrl } = await launch([fakeConfig('steve', { autoConnect: false })])
      const cookie = await login(baseUrl)

      const first = await fetch(`${baseUrl}/api/bots/steve/connect`, { method: 'POST', headers: { Cookie: cookie } })
      expect(first.status).toBe(200)
      expect((await first.json()).status).toBe('online')

      const second = await fetch(`${baseUrl}/api/bots/steve/connect`, { method: 'POST', headers: { Cookie: cookie } })
      expect(second.status).toBe(409)
    })

    it('restarts an online instance (disconnect then connect)', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve/restart`, { method: 'POST', headers: { Cookie: cookie } })

      expect(response.status).toBe(200)
      expect((await response.json()).status).toBe('online')
    })

    it('returns 404 from connect/disconnect/restart for an unknown id', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const results = await Promise.all(
        ['connect', 'disconnect', 'restart'].map((action) =>
          fetch(`${baseUrl}/api/bots/missing/${action}`, { method: 'POST', headers: { Cookie: cookie } })
        )
      )

      expect(results.map((r) => r.status)).toEqual([404, 404, 404])
    })
  })

  describe('authenticate / cancel authentication', () => {
    it('starts authentication and shows the device code in the response, from a single click', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'POST',
        headers: { Cookie: cookie }
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.authStatus).toBe('authenticating')
      expect(body.deviceCode).toEqual({
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://www.microsoft.com/link',
        message: expect.stringContaining('ABCD-EFGH')
      })
      expect(authAttempts).toHaveLength(1) // exactly one device code requested

      authAttempts[0].resolve('RealMcName')
    })

    it('rejects a double-click with 409 instead of requesting a second device code', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      const [first, second] = await Promise.all([
        fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST', headers: { Cookie: cookie } }),
        fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST', headers: { Cookie: cookie } })
      ])

      const statuses = [first.status, second.status].sort()
      expect(statuses).toEqual([200, 409])
      expect(authAttempts).toHaveLength(1)

      authAttempts[0].resolve('RealMcName')
    })

    it('cancel updates the UI immediately and ignores a later completion of the old attempt', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      await fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST', headers: { Cookie: cookie } })
      const cancelResponse = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
      })

      expect(cancelResponse.status).toBe(200)
      const cancelBody = await cancelResponse.json()
      expect(cancelBody.authStatus).toBe('unauthenticated')

      // The old (cancelled) attempt finally "completes" -- must not resurrect 'authenticated'.
      authAttempts[0].resolve('ShouldBeIgnored')

      const after = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      const afterBody = await after.json()
      expect(afterBody.instances[0].authStatus).toBe('unauthenticated')
      expect(afterBody.instances[0].minecraftProfileName).toBeUndefined()
    })

    it('cancel returns 409 when nothing is authenticating', async () => {
      const { baseUrl } = await launch([fakeConfig('steve', { auth: 'microsoft', autoConnect: false })])
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
      })

      expect(response.status).toBe(409)
    })

    it('a successful authentication shows the real Minecraft profile name', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      await fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST', headers: { Cookie: cookie } })
      authAttempts[0].resolve('RealMcName')

      const response = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      const body = await response.json()
      expect(body.instances[0].authStatus).toBe('authenticated')
      expect(body.instances[0].minecraftProfileName).toBe('RealMcName')
      expect(body.instances[0].deviceCode).toBeUndefined()
    })

    it('a failed authentication shows a clear auth_error', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      await fetch(`${baseUrl}/api/bots/steve/authenticate`, { method: 'POST', headers: { Cookie: cookie } })
      authAttempts[0].reject(new Error('device code expired'))

      const response = await fetch(`${baseUrl}/api/bots`, { headers: { Cookie: cookie } })
      const body = await response.json()
      expect(body.instances[0].authStatus).toBe('auth_error')
      expect(body.instances[0].authError.message).toBe('device code expired')
    })

    it('an unconfigured instance (no host) can authenticate but not connect', async () => {
      const authAttempts: AuthAttemptControl[] = []
      const { baseUrl } = await launch(
        [fakeConfig('steve', { auth: 'microsoft', autoConnect: false, host: undefined, port: undefined })],
        authAttempts
      )
      const cookie = await login(baseUrl)

      const authResponse = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'POST',
        headers: { Cookie: cookie }
      })
      expect(authResponse.status).toBe(200)
      authAttempts[0].resolve('RealMcName')

      const connectResponse = await fetch(`${baseUrl}/api/bots/steve/connect`, {
        method: 'POST',
        headers: { Cookie: cookie }
      })
      expect(connectResponse.status).toBe(409)
      const connectBody = await connectResponse.json()
      expect(connectBody.error).toMatch(/no host configured/)
    })

    it('returns 409 for an offline-auth instance', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')]) // default auth: 'offline'
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'POST',
        headers: { Cookie: cookie }
      })

      expect(response.status).toBe(409)
      const body = await response.json()
      expect(body.error).toMatch(/does not use Microsoft authentication/)
    })

    it('returns 409 for an instance that is currently connected', async () => {
      const { baseUrl } = await launch([fakeConfig('steve', { auth: 'microsoft' })]) // autoConnect: true -> online
      const cookie = await login(baseUrl)

      const response = await fetch(`${baseUrl}/api/bots/steve/authenticate`, {
        method: 'POST',
        headers: { Cookie: cookie }
      })

      expect(response.status).toBe(409)
    })

    it('returns 404 for an unknown id', async () => {
      const { baseUrl } = await launch()
      const cookie = await login(baseUrl)

      const results = await Promise.all([
        fetch(`${baseUrl}/api/bots/missing/authenticate`, { method: 'POST', headers: { Cookie: cookie } }),
        fetch(`${baseUrl}/api/bots/missing/authenticate`, { method: 'DELETE', headers: { Cookie: cookie } })
      ])

      expect(results.map((r) => r.status)).toEqual([404, 404])
    })
  })

  describe('concurrent requests on the same instance', () => {
    it('coordinates overlapping create/update calls through BotManager without corrupting the saved file', async () => {
      const { baseUrl } = await launch([fakeConfig('steve')])
      const cookie = await login(baseUrl)

      const results = await Promise.all([
        fetch(`${baseUrl}/api/bots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ id: 'alex', host: 'a.example.com', port: 25565, username: 'AlexBot', auth: 'offline' })
        }),
        fetch(`${baseUrl}/api/bots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ id: 'bob', host: 'b.example.com', port: 25565, username: 'BobBot', auth: 'offline' })
        }),
        fetch(`${baseUrl}/api/bots/steve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ id: 'steve', host: 'new-host.example.com', port: 25565, username: 'steveBot', auth: 'offline' })
        })
      ])

      expect(results.map((r) => r.status)).toEqual([201, 201, 200])
      expect((await savedIds()).sort()).toEqual(['alex', 'bob', 'steve'])
    })
  })
})
