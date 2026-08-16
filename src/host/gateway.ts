import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiHandler } from './api.js'
import {
  TERMINAL_CAPABILITY,
  WORKSPACE_FILES_CAPABILITY,
  WORKSPACE_SEARCH_CAPABILITY,
  type IdeGatewayContext,
} from './capabilities.js'
import { hostError, IdeHostError } from './errors.js'
import { createStaticHandler } from './static.js'
import { rejectUpgrade } from './terminal.js'
import { isTrustedLocalRequest } from './trust.js'

export interface GatewayConfig {
  routePrefix: string
  staticRoot: string
  maxRequestBytes: number
  maxTerminalSessions: number
}

function sendHttpError(response: ServerResponse, error: unknown): void {
  const projected = hostError(error)
  const body = JSON.stringify({ error: { code: projected.code, message: projected.message } })
  response.writeHead(projected.status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

/** Own every browser route while all versioned Host capabilities are live. */
export function ideGateway(ctx: IdeGatewayContext, config: GatewayConfig): void {
  const files = ctx[WORKSPACE_FILES_CAPABILITY]
  const terminal = ctx[TERMINAL_CAPABILITY]
  const search = ctx[WORKSPACE_SEARCH_CAPABILITY]
  const api = createApiHandler(files, {
    maxRequestBytes: config.maxRequestBytes,
    maxTerminalSessions: config.maxTerminalSessions,
    logger: ctx.logger,
  }, search)
  const staticFiles = createStaticHandler(config.staticRoot, config.routePrefix)
  const apiPath = `${config.routePrefix}/api`
  const terminalPath = `${config.routePrefix}/terminal`

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.routePrefix,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (!isTrustedLocalRequest(request)) {
        sendHttpError(response, new IdeHostError('FORBIDDEN', 'The IDE is available only to a same-origin loopback browser.', 403))
        return
      }
      let pathname: string
      try {
        pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      } catch (error) {
        sendHttpError(response, new IdeHostError('INVALID_URL', 'Invalid request URL.', 400, { cause: error }))
        return
      }
      if (pathname === apiPath) {
        await api(request, response)
        return
      }
      if (pathname === terminalPath) {
        response.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
        response.end('WebSocket upgrade required')
        return
      }
      if (pathname.startsWith(`${apiPath}/`)) {
        sendHttpError(response, new IdeHostError('NOT_FOUND', 'Unknown IDE API route.', 404))
        return
      }
      try {
        await staticFiles(request, response, pathname)
      } catch (error) {
        if (!response.headersSent) sendHttpError(response, error)
        else response.destroy()
      }
    },
  }), 'dsh-code-ide: HTTP routes')

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: terminalPath,
    handler: async (request, socket, head) => {
      if (!isTrustedLocalRequest(request)) {
        rejectUpgrade(socket, 403, 'Forbidden')
        return
      }
      await terminal.upgrade(request, socket, head)
    },
  }), 'dsh-code-ide: terminal WebSocket')
}

ideGateway.inject = [
  'webServer',
  WORKSPACE_FILES_CAPABILITY,
  TERMINAL_CAPABILITY,
  WORKSPACE_SEARCH_CAPABILITY,
]
