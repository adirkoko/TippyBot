import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  params: Readonly<Record<string, string>>
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>

interface CompiledRoute {
  method: string
  segments: RouteSegment[]
  handler: RouteHandler
}

interface RouteSegment {
  value: string
  parameter: boolean
}

/** An error which can safely be rendered as a small HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * A deliberately small exact-match router. It supports named path parameters,
 * but no wildcards; static-file paths are handled separately by the server.
 */
export class Router {
  private readonly routes: CompiledRoute[] = []

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler)
  }

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: compilePattern(pattern),
      handler
    })
    return this
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const method = (request.method ?? 'GET').toUpperCase()
    const url = parseRequestUrl(request)
    const pathSegments = decodePath(url.pathname)

    for (const route of this.routes) {
      if (route.method !== method) continue

      const params = matchSegments(route.segments, pathSegments)
      if (!params) continue

      await route.handler({ request, response, url, params })
      return true
    }

    return false
  }
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded) return

  const payload = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(payload))
  response.end(payload)
}

export function sendNoContent(response: ServerResponse, statusCode = 204): void {
  if (response.writableEnded) return
  response.statusCode = statusCode
  response.end()
}

export async function readJsonBody<T = unknown>(
  request: IncomingMessage,
  maxBytes = 16 * 1024
): Promise<T> {
  const contentType = request.headers['content-type']
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'Expected an application/json request body')
  }

  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume()
    throw new HttpError(413, 'Request body is too large')
  }

  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
    }
    const fail = (error: Error, drain = false): void => {
      if (settled) return
      settled = true
      cleanup()
      if (drain) request.resume()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > maxBytes) {
        fail(new HttpError(413, 'Request body is too large'), true)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (totalBytes === 0) {
        reject(new HttpError(400, 'A JSON request body is required'))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T)
      } catch {
        reject(new HttpError(400, 'Malformed JSON request body'))
      }
    }
    const onAborted = (): void => fail(new HttpError(400, 'Request body was aborted'))
    const onError = (): void => fail(new HttpError(400, 'Unable to read request body'))

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
  })
}

export function getClientIp(request: IncomingMessage): string {
  // Do not trust X-Forwarded-For by default. A deployment can put its own
  // trusted-proxy adapter in front of the server if that is ever needed.
  const address = request.socket.remoteAddress ?? 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  )
}

function parseRequestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://localhost')
  } catch {
    throw new HttpError(400, 'Malformed request URL')
  }
}

function compilePattern(pattern: string): RouteSegment[] {
  if (!pattern.startsWith('/')) throw new Error(`Route pattern must start with /: ${pattern}`)

  return splitPath(pattern).map((segment) => {
    if (segment.startsWith(':')) {
      const name = segment.slice(1)
      if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid route parameter: ${segment}`)
      }
      return { value: name, parameter: true }
    }
    return { value: decodeURIComponent(segment), parameter: false }
  })
}

function decodePath(pathname: string): string[] {
  try {
    return splitPath(pathname).map((segment) => decodeURIComponent(segment))
  } catch {
    throw new HttpError(400, 'Malformed URL encoding')
  }
}

function splitPath(path: string): string[] {
  if (path === '/') return []
  return path.replace(/\/+$/, '').slice(1).split('/')
}

function matchSegments(
  routeSegments: RouteSegment[],
  pathSegments: string[]
): Record<string, string> | undefined {
  if (routeSegments.length !== pathSegments.length) return undefined

  const params: Record<string, string> = Object.create(null) as Record<string, string>
  for (let index = 0; index < routeSegments.length; index += 1) {
    const route = routeSegments[index]
    const actual = pathSegments[index]
    if (route.parameter) {
      params[route.value] = actual
    } else if (route.value !== actual) {
      return undefined
    }
  }
  return params
}
