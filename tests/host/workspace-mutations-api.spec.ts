import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceMutationService } from '../../src/host/workspace-mutations.js'
import { createWorkspaceMutationsApi } from '../../src/host/workspace-mutations-api.js'

function requestForBody(body: string): IncomingMessage {
  const request = Readable.from([body]) as IncomingMessage
  request.method = 'POST'
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  }
  Object.defineProperty(request, 'complete', { value: true, configurable: true })
  return request
}

function recorder(): { response: ServerResponse; status(): number; body(): unknown } {
  let status = 0
  let body = ''
  const response = {
    destroyed: false,
    writableEnded: false,
    writeHead(value: number) { status = value; return this },
    end(value?: string) { body += value ?? ''; this.writableEnded = true; return this },
    setHeader() {},
    once() { return this },
    off() { return this },
  } as unknown as ServerResponse
  return { response, status: () => status, body: () => JSON.parse(body) as unknown }
}

describe('workspace-mutations exact HTTP API', () => {
  it('accepts exactly the cap and rejects cap plus one before JSON dispatch', async () => {
    const maxRequestBytes = 1024
    const prefix = '{"op":"provider","padding":"'
    const suffix = '"}'
    const atCap = `${prefix}${'x'.repeat(maxRequestBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`
    expect(Buffer.byteLength(atCap)).toBe(maxRequestBytes)
    const overCap = `${atCap}x`
    const request = vi.fn(async () => ({ providerEpoch: 'not-called' }))
    const service = { request } as unknown as WorkspaceMutationService
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const api = createWorkspaceMutationsApi(service, { maxRequestBytes, logger })

    const accepted = recorder()
    await api(requestForBody(atCap), accepted.response)
    expect(request).toHaveBeenCalledOnce()
    expect(accepted.status()).toBe(200)

    const rejected = recorder()
    await api(requestForBody(overCap), rejected.response)
    expect(request).toHaveBeenCalledOnce()
    expect(rejected.status()).toBe(413)
    expect(rejected.body()).toEqual({
      error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the mutation limit.' },
    })
  })

  it('logs only the projected stable code for internal failures', async () => {
    const request = vi.fn(async () => { throw new Error('C:\\secret-workspace\\private.txt') })
    const service = { request } as unknown as WorkspaceMutationService
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const api = createWorkspaceMutationsApi(service, { maxRequestBytes: 1024, logger })
    const response = recorder()
    await api(requestForBody('{"op":"provider"}'), response.response)

    expect(response.status()).toBe(500)
    expect(response.body()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'The IDE Host operation failed.' } })
    expect(logger.warn).toHaveBeenCalledWith(
      'dsh-code-ide: workspace mutation request failed (%s)',
      'INTERNAL_ERROR',
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-workspace')
  })
})
