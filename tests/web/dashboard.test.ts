import { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { BotInstanceSnapshot, IBotInstanceHandle } from '../../src/interfaces/bot-instance'
import type { IBotConfig } from '../../src/interfaces/config'
import { SessionStore } from '../../src/web/auth/session'
import type { BotInstanceRegistry, LogStoreView } from '../../src/web/routes/logs'
import { createWebServer } from '../../src/web/server'

let activeServer: Server | undefined

afterEach(async () => {
  if (!activeServer) return
  const server = activeServer
  activeServer = undefined
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
})

describe('dashboard routes', () => {
  it('requires authentication for the page, API and SSE stream', async () => {
    const { baseUrl } = await launch([fakeHandle(onlineSnapshot())])

    const page = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/login')
    const logsPage = await fetch(`${baseUrl}/logs`, { redirect: 'manual' })
    expect(logsPage.status).toBe(302)
    expect(logsPage.headers.get('location')).toBe('/login')

    const [api, stream] = await Promise.all([
      fetch(`${baseUrl}/api/dashboard`),
      fetch(`${baseUrl}/api/dashboard/stream`)
    ])
    expect(api.status).toBe(401)
    expect(stream.status).toBe(401)
    await expect(api.json()).resolves.toEqual({ error: 'Authentication required' })
    await expect(stream.json()).resolves.toEqual({ error: 'Authentication required' })
  })

  it('returns all snapshots and redacts lastError without mutating the handle snapshot', async () => {
    const online = onlineSnapshot()
    const errored = erroredSnapshot('Connection failed with WEB_PASSWORD=very-secret-value')
    const handles = [fakeHandle(online), fakeHandle(errored)]
    const { baseUrl } = await launch(handles)
    const cookie = await login(baseUrl)

    const [dashboardPage, logsPage] = await Promise.all([
      fetch(`${baseUrl}/`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/logs`, { headers: { Cookie: cookie } })
    ])
    expect(dashboardPage.status).toBe(200)
    expect(logsPage.status).toBe(200)

    const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(jsonSafe({
      instances: [
        online,
        {
          ...errored,
          lastError: {
            ...errored.lastError,
            message: 'Connection failed with WEB_PASSWORD=[REDACTED]'
          }
        }
      ]
    }))
    expect(errored.lastError?.message).toBe(
      'Connection failed with WEB_PASSWORD=very-secret-value'
    )
  })

  it('sends immediate and interval snapshots, then stops its timer after disconnect', async () => {
    const intervalMs = 40
    const calls = { count: 0, times: [] as number[] }
    const handle = fakeHandle(onlineSnapshot(), () => {
      calls.count += 1
      calls.times.push(Date.now())
    })
    const { baseUrl } = await launch([handle], { dashboardIntervalMs: intervalMs })
    const cookie = await login(baseUrl)
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/dashboard/stream`, {
      headers: { Cookie: cookie },
      signal: controller.signal
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) return

    const first = await readUntil(reader, 'event: snapshots')
    expect(first).toContain('"instances"')
    const second = await readUntil(reader, 'event: snapshots')
    expect(second).toContain('"status":"online"')
    expect(calls.count).toBeGreaterThanOrEqual(2)
    expect(calls.times[1] - calls.times[0]).toBeGreaterThanOrEqual(intervalMs - 5)

    controller.abort()
    await delay(intervalMs * 2)
    const callsAfterDisconnect = calls.count
    await delay(intervalMs * 2)
    expect(calls.count).toBe(callsAfterDisconnect)
  })

  it('redacts SSE snapshots and closes the stream when its session is revoked', async () => {
    const source = erroredSnapshot('Authorization: Bearer dashboard-secret')
    const calls = { count: 0 }
    const handle = fakeHandle(source, () => {
      calls.count += 1
    })
    const { baseUrl } = await launch([handle], { dashboardIntervalMs: 20 })
    const cookie = await login(baseUrl)
    const response = await fetch(`${baseUrl}/api/dashboard/stream`, {
      headers: { Cookie: cookie }
    })
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) return

    const initial = await readUntil(reader, 'event: snapshots')
    expect(initial).toContain('Authorization: [REDACTED]')
    expect(initial).not.toContain('dashboard-secret')
    expect(source.lastError?.message).toBe('Authorization: Bearer dashboard-secret')

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    })
    expect(logout.status).toBe(204)

    const expired = await readUntil(reader, 'event: auth-expired')
    expect(expired).toContain('event: auth-expired')
    await delay(60)
    const callsAfterExpiry = calls.count
    await delay(60)
    expect(calls.count).toBe(callsAfterExpiry)
  })
})

interface LaunchOptions {
  dashboardIntervalMs?: number
}

async function launch(
  handles: IBotInstanceHandle[],
  options: LaunchOptions = {}
): Promise<{ baseUrl: string }> {
  const manager: BotInstanceRegistry = {
    getInstances: () => handles,
    getInstance: (id) => handles.find((handle) => handle.id === id)
  }
  const unavailableLogStore = (): LogStoreView | undefined => undefined

  activeServer = createWebServer({
    manager,
    getLogStore: unavailableLogStore,
    password: 'correct-password',
    sessions: new SessionStore(),
    publicDir: path.resolve(process.cwd(), 'src/web/public'),
    dashboardIntervalMs: options.dashboardIntervalMs
  })
  await new Promise<void>((resolve, reject) => {
    activeServer?.once('error', reject)
    activeServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = activeServer.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}` }
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' })
  })
  expect(response.status).toBe(200)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

function fakeHandle(snapshot: BotInstanceSnapshot, onSnapshot?: () => void): IBotInstanceHandle {
  const config: IBotConfig = {
    id: snapshot.id,
    host: snapshot.host,
    port: snapshot.port,
    username: snapshot.username,
    auth: 'offline',
    commandPrefix: '!',
    admins: [],
    autoConnect: true
  }
  return {
    id: snapshot.id,
    config,
    getStatus: () => snapshot.status,
    getLastError: () => snapshot.lastError,
    getSnapshot: () => {
      onSnapshot?.()
      return snapshot
    },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve()
  }
}

function onlineSnapshot(): BotInstanceSnapshot {
  return {
    id: 'alpha',
    status: 'online',
    lastError: undefined,
    host: 'example.test',
    port: 25565,
    username: 'AlphaBot',
    uptimeMs: 12_345,
    ping: 42,
    health: 18,
    food: 17,
    position: { x: 1.5, y: 64, z: -2.25 },
    dimension: 'overworld',
    activeTask: {
      id: 7,
      name: 'come',
      requestedBy: 'Admin',
      startedAt: 1_754_220_000_000
    }
  }
}

function erroredSnapshot(message: string): BotInstanceSnapshot {
  return {
    id: 'bravo',
    status: 'errored',
    lastError: { message, at: 1_754_220_001_000 },
    host: 'other.example.test',
    port: 25566,
    username: 'BravoBot',
    uptimeMs: undefined,
    ping: undefined,
    health: undefined,
    food: undefined,
    position: undefined,
    dimension: undefined,
    activeTask: undefined
  }
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string
): Promise<string> {
  const decoder = new TextDecoder()
  let output = ''
  while (!output.includes(expected)) {
    const result = await withTimeout(reader.read(), 2_000)
    if (result.done) break
    output += decoder.decode(result.value, { stream: true })
  }
  return output
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for SSE data')), milliseconds)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
