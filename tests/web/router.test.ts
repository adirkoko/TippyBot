import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Router, type RouteContext } from '../../src/web/router'

function fakeRequest(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage
}

function fakeResponse(): ServerResponse {
  return {} as unknown as ServerResponse
}

describe('Router', () => {
  it('dispatches a registered PUT route and extracts its params', async () => {
    const router = new Router()
    let received: RouteContext | undefined
    router.add('PUT', '/api/bots/:id', (ctx) => {
      received = ctx
    })

    const handled = await router.handle(fakeRequest('PUT', '/api/bots/steve'), fakeResponse())

    expect(handled).toBe(true)
    expect(received?.params).toEqual({ id: 'steve' })
  })

  it('dispatches a registered DELETE route and extracts its params', async () => {
    const router = new Router()
    let received: RouteContext | undefined
    router.add('DELETE', '/api/bots/:id', (ctx) => {
      received = ctx
    })

    const handled = await router.handle(fakeRequest('DELETE', '/api/bots/alex'), fakeResponse())

    expect(handled).toBe(true)
    expect(received?.params).toEqual({ id: 'alex' })
  })

  it('is case-insensitive on the registered method', async () => {
    const router = new Router()
    let calls = 0
    router.add('put', '/api/bots/:id', () => {
      calls += 1
    })

    const handled = await router.handle(fakeRequest('PUT', '/api/bots/steve'), fakeResponse())

    expect(handled).toBe(true)
    expect(calls).toBe(1)
  })

  it('does not dispatch a PUT request to a route registered only for POST', async () => {
    const router = new Router()
    let calls = 0
    router.post('/api/bots', () => {
      calls += 1
    })

    const handled = await router.handle(fakeRequest('PUT', '/api/bots'), fakeResponse())

    expect(handled).toBe(false)
    expect(calls).toBe(0)
  })

  it('does not dispatch a DELETE request to a route registered only for GET', async () => {
    const router = new Router()
    let calls = 0
    router.get('/api/bots/:id', () => {
      calls += 1
    })

    const handled = await router.handle(fakeRequest('DELETE', '/api/bots/steve'), fakeResponse())

    expect(handled).toBe(false)
    expect(calls).toBe(0)
  })

  it('keeps GET and POST dispatch working exactly as before alongside PUT/DELETE routes on the same router', async () => {
    const router = new Router()
    const calls: string[] = []
    router.get('/api/bots', () => {
      calls.push('get')
    })
    router.post('/api/bots', () => {
      calls.push('post')
    })
    router.add('PUT', '/api/bots/:id', () => {
      calls.push('put')
    })
    router.add('DELETE', '/api/bots/:id', () => {
      calls.push('delete')
    })

    await router.handle(fakeRequest('GET', '/api/bots'), fakeResponse())
    await router.handle(fakeRequest('POST', '/api/bots'), fakeResponse())
    await router.handle(fakeRequest('PUT', '/api/bots/steve'), fakeResponse())
    await router.handle(fakeRequest('DELETE', '/api/bots/steve'), fakeResponse())

    expect(calls).toEqual(['get', 'post', 'put', 'delete'])
  })

  it('returns false for an unmatched path regardless of method', async () => {
    const router = new Router()
    router.add('PUT', '/api/bots/:id', () => {})

    const handled = await router.handle(fakeRequest('PUT', '/api/nonexistent'), fakeResponse())

    expect(handled).toBe(false)
  })
})
