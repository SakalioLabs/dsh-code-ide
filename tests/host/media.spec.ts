import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdeHostError } from '../../src/host/errors.js'
import { WorkspaceFileService } from '../../src/host/filesystem.js'
import { createMediaHandler } from '../../src/host/media.js'
import { createStaticHandler } from '../../src/host/static.js'

const WORKSPACE_ID = 'media-workspace'

interface LocalResponse {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

async function fetchLocal(
  input: string | URL,
  init: { method?: string, headers?: Record<string, string> } = {},
): Promise<LocalResponse> {
  return await new Promise<LocalResponse>((resolve, reject) => {
    const request = httpRequest(input, {
      method: init.method,
      headers: { connection: 'close', ...init.headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk as Uint8Array)) })
      response.once('error', reject)
      response.once('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get: (name): string | null => {
              const value = response.headers[name.toLowerCase()]
              return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value
            },
          },
          arrayBuffer: async (): Promise<ArrayBuffer> => body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind TCP.')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

describe('workspace media streaming', () => {
  let root: string
  let files: WorkspaceFileService
  let server: Server
  let origin: string

  function mediaUrl(path: string, version?: string): string {
    const url = new URL('/dsh-code-ide/media', origin)
    url.searchParams.set('workspaceId', WORKSPACE_ID)
    url.searchParams.set('path', path)
    if (version !== undefined) url.searchParams.set('version', version)
    return url.href
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-code-ide-media-')))
    await writeFile(join(root, 'index.html'), '<!doctype html><title>IDE</title>')
    files = new WorkspaceFileService({
      list: () => [{ id: WORKSPACE_ID, path: root, title: 'Media' }],
    }, {
      maxFileBytes: 1024,
      maxMediaBytes: 16,
      maxDirectoryEntries: 100,
    })
    const handler = createMediaHandler(files)
    const staticFiles = createStaticHandler(root, '/dsh-code-ide')
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      void (pathname === '/dsh-code-ide/media'
        ? handler(request, response)
        : staticFiles(request, response, pathname))
    })
    origin = `http://127.0.0.1:${String(await listen(server))}`
  })

  afterEach(async () => {
    await close(server)
    await files.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('serves allowlisted media with immutable identity and security headers', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await writeFile(join(root, 'clip.mp4'), bytes)
    const [{ version }] = (await files.list(WORKSPACE_ID, '')).entries
    const response = await fetchLocal(mediaUrl('clip.mp4', version))

    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('10')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(response.headers.get('etag')).toBe(`"${version}"`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)

    const head = await fetchLocal(mediaUrl('clip.mp4', version), { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('allows same-origin media in the workbench content security policy', async () => {
    const response = await fetchLocal(`${origin}/dsh-code-ide/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("media-src 'self' blob:")
  })

  it('supports one bounded byte range, suffixes, If-Range, and 416 responses', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    await writeFile(join(root, 'tone.ogg'), bytes)

    const partial = await fetchLocal(mediaUrl('tone.ogg'), { headers: { range: 'bytes=2-5' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(partial.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.subarray(2, 6))

    const suffix = await fetchLocal(mediaUrl('tone.ogg'), { headers: { range: 'bytes=-3' } })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10')
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.subarray(7))

    const ignored = await fetchLocal(mediaUrl('tone.ogg'), {
      headers: { range: 'bytes=2-5', 'if-range': '"different-version"' },
    })
    expect(ignored.status).toBe(200)
    expect(new Uint8Array(await ignored.arrayBuffer())).toEqual(bytes)

    const invalid = await fetchLocal(mediaUrl('tone.ogg'), { headers: { range: 'bytes=20-30' } })
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */10')
    expect(invalid.headers.get('content-length')).toBe('0')

    const multiple = await fetchLocal(mediaUrl('tone.ogg'), { headers: { range: 'bytes=0-1,4-5' } })
    expect(multiple.status).toBe(416)
  })

  it('enforces type, size, query, method, and observed-version boundaries', async () => {
    await writeFile(join(root, 'unsafe.svg'), '<svg/>')
    expect((await fetchLocal(mediaUrl('unsafe.svg'))).status).toBe(415)

    await writeFile(join(root, 'large.png'), Buffer.alloc(17))
    expect((await fetchLocal(mediaUrl('large.png'))).status).toBe(413)

    await writeFile(join(root, 'photo.png'), Uint8Array.from([1, 2, 3]))
    const photo = (await files.list(WORKSPACE_ID, '')).entries.find(entry => entry.name === 'photo.png')
    expect(photo?.version).toBeTypeOf('string')
    await writeFile(join(root, 'photo.png'), Uint8Array.from([4, 5, 6, 7]))
    expect((await fetchLocal(mediaUrl('photo.png', photo!.version))).status).toBe(409)

    const unknown = new URL(mediaUrl('photo.png'))
    unknown.searchParams.set('extra', 'no')
    expect((await fetchLocal(unknown)).status).toBe(400)
    expect((await fetchLocal(mediaUrl('../photo.png'))).status).toBe(400)
    expect((await fetchLocal(mediaUrl('photo.png'), { method: 'POST' })).status).toBe(405)
  })

  it('does not follow workspace-owned symbolic links', async () => {
    if (process.platform === 'win32') return
    await writeFile(join(root, 'photo.png'), Uint8Array.from([1, 2, 3]))
    await symlink('photo.png', join(root, 'alias.png'))
    expect((await fetchLocal(mediaUrl('alias.png'))).status).toBe(403)
  })

  it('rechecks the nested-mount boundary after pinning the media handle', async () => {
    await close(server)
    await files.dispose()
    await writeFile(join(root, 'photo.png'), Uint8Array.from([1, 2, 3]))
    const calls: Array<{ candidate: string, includeDescendants: boolean }> = []
    files = new WorkspaceFileService({
      list: () => [{ id: WORKSPACE_ID, path: root, title: 'Media' }],
    }, {
      maxFileBytes: 1024,
      maxMediaBytes: 16,
      maxDirectoryEntries: 100,
    }, {
      assertNoNestedMount: async (_root, candidate, options) => {
        calls.push({ candidate, includeDescendants: options.includeDescendants })
        if (calls.length === 2) {
          throw new IdeHostError('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403)
        }
      },
    })
    server = createServer((request, response) => {
      void createMediaHandler(files)(request, response)
    })
    origin = `http://127.0.0.1:${String(await listen(server))}`

    expect((await fetchLocal(mediaUrl('photo.png'))).status).toBe(403)
    expect(calls).toEqual([
      { candidate: join(root, 'photo.png'), includeDescendants: false },
      { candidate: join(root, 'photo.png'), includeDescendants: false },
    ])

    // Rejection must not leak the pinned handle, including on Windows.
    await rm(join(root, 'photo.png'))
  })
})
