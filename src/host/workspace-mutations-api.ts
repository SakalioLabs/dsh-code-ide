import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiErrorBody, HostLogger } from './contracts.js'
import { hostError, IdeHostError } from './errors.js'
import type { WorkspaceMutationService } from './workspace-mutations.js'

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new IdeHostError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415)
  }
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new IdeHostError('REQUEST_TOO_LARGE', 'Request body exceeds the mutation limit.', 413)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    size += chunk.length
    if (size > maxBytes) throw new IdeHostError('REQUEST_TOO_LARGE', 'Request body exceeds the mutation limit.', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  } catch (error) {
    throw new IdeHostError('INVALID_JSON', 'Request body is not valid JSON.', 400, { cause: error })
  }
}

function transportAbort(request: IncomingMessage, response: ServerResponse): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  const requestClose = (): void => { if (!request.complete) abort() }
  const responseClose = (): void => { if (!response.writableEnded) abort() }
  request.once('aborted', abort)
  request.once('close', requestClose)
  response.once('close', responseClose)
  return {
    signal: controller.signal,
    dispose() {
      request.off('aborted', abort)
      request.off('close', requestClose)
      response.off('close', responseClose)
    },
  }
}

export interface WorkspaceMutationsApiOptions {
  maxRequestBytes: number
  logger: HostLogger
}

/** Exact-route JSON carrier for the workspace-mutations.v1 capability. */
export function createWorkspaceMutationsApi(
  mutations: WorkspaceMutationService,
  options: WorkspaceMutationsApiOptions,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const transport = transportAbort(request, response)
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new IdeHostError('METHOD_NOT_ALLOWED', 'Only POST is accepted.', 405)
      }
      const result = await mutations.request(await readJson(request, options.maxRequestBytes), transport.signal)
      if (!transport.signal.aborted && !response.destroyed && !response.writableEnded) sendJson(response, 200, result)
    } catch (error) {
      const projected = hostError(error)
      if (projected.status >= 500) {
        // Never project or log raw native/path errors at this browser boundary.
        options.logger.warn('dsh-code-ide: workspace mutation request failed (%s)', projected.code)
      }
      const body: ApiErrorBody = { error: { code: projected.code, message: projected.message } }
      if (!transport.signal.aborted && !response.destroyed && !response.writableEnded) {
        sendJson(response, projected.status, body)
      }
    } finally {
      transport.dispose()
    }
  }
}
