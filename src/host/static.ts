import { createReadStream, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { IdeHostError } from './errors.js'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function inside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'")
  response.setHeader('cross-origin-resource-policy', 'same-origin')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'SAMEORIGIN')
}

export interface StaticHandler {
  (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>
}

/** Build a traversal- and symlink-safe Vite static/SPA handler. */
export function createStaticHandler(staticRoot: string, routePrefix: string): StaticHandler {
  const root = realpathSync(staticRoot)
  const index = realpathSync(resolve(root, 'index.html'))
  if (!inside(root, index) || !statSync(index).isFile()) throw new Error('dsh-code-ide: staticRoot has no index.html')

  return async (request, response, pathname) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    securityHeaders(response)
    let tail = pathname.slice(routePrefix.length)
    try {
      tail = decodeURIComponent(tail)
    } catch {
      throw new IdeHostError('INVALID_STATIC_PATH', 'Invalid static asset path.')
    }
    if (tail.includes('\0') || tail.includes('\\')) {
      throw new IdeHostError('INVALID_STATIC_PATH', 'Invalid static asset path.')
    }
    const segments = tail.split('/').filter(Boolean)
    if (segments.some(segment => segment === '.' || segment === '..')) {
      throw new IdeHostError('INVALID_STATIC_PATH', 'Invalid static asset path.')
    }

    let file = index
    if (segments.length > 0) {
      const unresolved = resolve(root, ...segments)
      if (!inside(root, unresolved)) throw new IdeHostError('INVALID_STATIC_PATH', 'Static path escapes its root.', 403)
      try {
        const candidate = realpathSync(unresolved)
        if (inside(root, candidate) && statSync(candidate).isFile()) file = candidate
        else if (extname(segments.at(-1) ?? '') !== '') throw new IdeHostError('ASSET_NOT_FOUND', 'Static asset not found.', 404)
      } catch (error) {
        if (error instanceof IdeHostError) throw error
        if (extname(segments.at(-1) ?? '') !== '') throw new IdeHostError('ASSET_NOT_FOUND', 'Static asset not found.', 404)
      }
    }
    const info = statSync(file)
    response.setHeader('content-type', MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    response.setHeader('content-length', info.size)
    response.setHeader('cache-control', file === index ? 'no-cache' : segments[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache')
    response.writeHead(200)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(file)
      stream.once('error', rejectStream)
      response.once('finish', resolveStream)
      response.once('close', resolveStream)
      stream.pipe(response)
    })
  }
}
