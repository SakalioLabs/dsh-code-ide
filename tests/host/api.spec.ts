import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createApiHandler } from '../../src/host/api.js'
import type { WorkspaceFileService } from '../../src/host/filesystem.js'
import type { WorkspaceSearchService } from '../../src/host/search.js'

function requestFor(value: unknown): IncomingMessage {
  const body = JSON.stringify(value)
  const request = Readable.from([body]) as IncomingMessage
  request.method = 'POST'
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  }
  // Readable.from emits `close` after consumption; a real fully received
  // IncomingMessage marks that ordinary close as complete, not disconnect.
  Object.defineProperty(request, 'complete', { value: true, configurable: true })
  return request
}

function responseRecorder(): {
  response: ServerResponse
  emitter: EventEmitter
  writes: Array<{ status: number; body: string }>
  closeEarly(): void
} {
  const emitter = new EventEmitter()
  const writes: Array<{ status: number; body: string }> = []
  let status = 0
  let body = ''
  const response = emitter as EventEmitter & ServerResponse
  Object.assign(response, {
    destroyed: false,
    writableEnded: false,
    writeHead(value: number) { status = value; return response },
    end(value?: string) {
      body += value ?? ''
      response.writableEnded = true
      writes.push({ status, body })
      return response
    },
    setHeader() {},
  })
  return {
    response,
    emitter,
    writes,
    closeEarly() {
      response.destroyed = true
      emitter.emit('close')
    },
  }
}

describe('IDE HTTP API', () => {
  it('routes the bounded inspect operation without projecting protocol fields', async () => {
    const targets = [
      { kind: 'file', path: 'src/main.ts' },
      { kind: 'directory', path: 'src' },
    ]
    const result = {
      snapshots: [{
        kind: 'file' as const,
        path: 'src/main.ts',
        state: 'present' as const,
        version: 'opaque',
        size: 4,
      }],
    }
    const inspect = vi.fn().mockResolvedValue(result)
    const files = { inspect } as unknown as WorkspaceFileService
    const request = requestFor({ op: 'inspect', workspaceId: 'workspace-1', targets })
    let status: number | undefined
    let responseBody = ''
    const response = {
      writeHead(value: number) { status = value; return this },
      end(value?: string) { responseBody += value ?? ''; return this },
      setHeader() {},
    } as unknown as ServerResponse
    const logger = {
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    }

    await createApiHandler(files, { maxRequestBytes: 64 * 1024, maxTerminalSessions: 8, logger })(request, response)

    expect(inspect).toHaveBeenCalledWith('workspace-1', targets)
    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toEqual(result)
  })

  it('publishes the configured terminal capacity with the workspace baseline', async () => {
    const workspaces = vi.fn(() => ({ workspaces: [], maxTerminalSessions: 3 }))
    const files = { workspaces } as unknown as WorkspaceFileService
    const request = requestFor({ op: 'workspaces' })
    let responseBody = ''
    const response = {
      writeHead() { return this },
      end(value?: string) { responseBody += value ?? ''; return this },
      setHeader() {},
    } as unknown as ServerResponse
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }

    await createApiHandler(files, { maxRequestBytes: 1024, maxTerminalSessions: 3, logger })(request, response)

    expect(workspaces).toHaveBeenCalledWith(3)
    expect(JSON.parse(responseBody)).toEqual({ workspaces: [], maxTerminalSessions: 3 })
  })

  it('dispatches the exact bounded Quick Open and text-search DTOs with transport signals', async () => {
    const findResult = { items: [{ path: 'src/main.ts' }], incomplete: false, limit: 200 }
    const textResult = {
      items: [{
        path: 'src/main.ts', lineNumber: 2, preview: 'needle', previewStart: 4,
        ranges: [{ start: 4, end: 10 }],
      }],
      matchCount: 1,
      fileCount: 1,
      incomplete: false,
      limit: 500,
    }
    const findFiles = vi.fn().mockResolvedValue(findResult)
    const searchText = vi.fn().mockResolvedValue(textResult)
    const search = { findFiles, searchText } as unknown as WorkspaceSearchService
    const files = {} as WorkspaceFileService
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const handler = createApiHandler(files, { maxRequestBytes: 64 * 1024, maxTerminalSessions: 8, logger }, search)

    const findResponse = responseRecorder()
    await handler(requestFor({ op: 'findFiles', workspaceId: 'workspace-1', query: 'main' }), findResponse.response)
    expect(findFiles).toHaveBeenCalledOnce()
    expect(findFiles.mock.calls[0]?.slice(0, 2)).toEqual(['workspace-1', 'main'])
    expect(findFiles.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    expect(findResponse.writes).toEqual([{ status: 200, body: JSON.stringify(findResult) }])

    const query = {
      pattern: 'needle', mode: 'literal', caseSensitive: false, wholeWord: true,
      include: ['src/**/*.ts'], exclude: ['src/generated/**'],
    }
    const textResponse = responseRecorder()
    await handler(requestFor({ op: 'searchText', workspaceId: 'workspace-2', query }), textResponse.response)
    expect(searchText).toHaveBeenCalledOnce()
    expect(searchText.mock.calls[0]?.slice(0, 2)).toEqual(['workspace-2', query])
    expect(searchText.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    expect(textResponse.writes).toEqual([{ status: 200, body: JSON.stringify(textResult) }])
  })

  it('aborts an active search and writes nothing after the HTTP response disconnects', async () => {
    let observedSignal: AbortSignal | undefined
    const searchText = vi.fn((_workspaceId: unknown, _query: unknown, signal: AbortSignal) => {
      observedSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('transport aborted'))
        }, { once: true })
      })
    })
    const search = { searchText } as unknown as WorkspaceSearchService
    const files = {} as WorkspaceFileService
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const response = responseRecorder()
    const handler = createApiHandler(files, { maxRequestBytes: 64 * 1024, maxTerminalSessions: 8, logger }, search)
    const pending = handler(requestFor({
      op: 'searchText',
      workspaceId: 'workspace-1',
      query: { pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false },
    }), response.response)
    await vi.waitFor(() => { expect(observedSignal).toBeInstanceOf(AbortSignal) })

    response.closeEarly()
    await pending

    expect(observedSignal?.aborted).toBe(true)
    expect(response.writes).toEqual([])
  })
})
