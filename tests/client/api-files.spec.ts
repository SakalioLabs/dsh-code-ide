import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  decodeInspectResponse,
  decodeListFilesResponse,
  decodeReadFileResponse,
  decodeWriteFileResponse,
  decodeWorkspacesResponse,
  fileApi,
} from '../../src/client/api.ts'
import { MAX_CLIENT_DIRECTORY_ENTRIES } from '../../src/client/contracts.ts'
import { DEFAULT_MAX_INSPECT_TARGETS } from '../../src/shared/workspace-observation.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('workspace file API response decoding', () => {
  it('bounds and de-duplicates workspace identities before they reach mutation admission', () => {
    const valid = {
      workspaces: [{ workspaceId: 'workspace-a', title: 'Workspace A', path: 'C:\\workspace-a' }],
      currentWorkspaceId: 'workspace-a',
      maxTerminalSessions: 8,
    }
    expect(decodeWorkspacesResponse(valid)).toEqual(valid)
    expect(decodeWorkspacesResponse({
      ...valid,
      workspaces: [{ ...valid.workspaces[0], workspaceId: '界'.repeat(100) }],
      currentWorkspaceId: undefined,
    })).toBeUndefined()
    expect(decodeWorkspacesResponse({
      ...valid,
      workspaces: [...valid.workspaces, valid.workspaces[0]],
    })).toBeUndefined()
    expect(decodeWorkspacesResponse({ ...valid, currentWorkspaceId: 'missing' })).toBeUndefined()
    expect(decodeWorkspacesResponse({ ...valid, injected: true })).toBeUndefined()
  })

  it('accepts a bounded direct-child listing, including Unicode and newline names', () => {
    expect(decodeListFilesResponse({
      entries: [
        { name: '\u5b9e\u73b0.ts', path: 'src/\u5b9e\u73b0.ts', type: 'file', size: 0, version: 'v1' },
        { name: 'line\nbreak', path: 'src/line\nbreak', type: 'directory' },
        { name: 'device', path: 'src/device', type: 'other', version: 'v2' },
      ],
    }, 'src')).toEqual({
      entries: [
        { name: '\u5b9e\u73b0.ts', path: 'src/\u5b9e\u73b0.ts', type: 'file', size: 0, version: 'v1' },
        { name: 'line\nbreak', path: 'src/line\nbreak', type: 'directory' },
        { name: 'device', path: 'src/device', type: 'other', version: 'v2' },
      ],
    })
    expect(decodeListFilesResponse({
      entries: [{ name: 'root.ts', path: 'root.ts', type: 'file' }],
    }, '')).toEqual({ entries: [{ name: 'root.ts', path: 'root.ts', type: 'file' }] })
  })

  it('rejects forged ancestry, duplicates, invalid metadata, unknown fields and oversized lists', () => {
    const invalidEntries: unknown[] = [
      { name: 'a.ts', path: 'other/a.ts', type: 'file' },
      { name: 'nested/a.ts', path: 'src/nested/a.ts', type: 'file' },
      { name: 'a.ts', path: 'src/a.ts', type: 'file', size: -1 },
      { name: 'a.ts', path: 'src/a.ts', type: 'file', version: '' },
      { name: 'a.ts', path: 'src/a.ts', type: 'unknown' },
      { name: 'a.ts', path: 'src/a.ts', type: 'file', injected: true },
      { name: 'bad\0name', path: 'src/bad\0name', type: 'file' },
    ]
    for (const entry of invalidEntries) {
      expect(decodeListFilesResponse({ entries: [entry] }, 'src'), JSON.stringify(entry)).toBeUndefined()
    }
    expect(decodeListFilesResponse({
      entries: [
        { name: 'a.ts', path: 'src/a.ts', type: 'file' },
        { name: 'a.ts', path: 'src/a.ts', type: 'file' },
      ],
    }, 'src')).toBeUndefined()
    expect(decodeListFilesResponse({ entries: [], extra: true }, '')).toBeUndefined()
    const atLimit = Array.from({ length: MAX_CLIENT_DIRECTORY_ENTRIES }, (_, index) => ({
      name: `${String(index)}.ts`, path: `${String(index)}.ts`, type: 'file',
    }))
    expect(decodeListFilesResponse({ entries: atLimit }, '')?.entries).toHaveLength(MAX_CLIENT_DIRECTORY_ENTRIES)
    expect(decodeListFilesResponse({
      entries: Array.from({ length: MAX_CLIENT_DIRECTORY_ENTRIES + 1 }, () => null),
    }, '')).toBeUndefined()
  })

  it('requires read and write acknowledgements to name the exact requested path', () => {
    expect(decodeReadFileResponse({ path: 'src/a.ts', content: 'text', version: 'v1' }, 'src/a.ts'))
      .toEqual({ path: 'src/a.ts', content: 'text', version: 'v1' })
    expect(decodeReadFileResponse({ path: 'src/b.ts', content: 'text', version: 'v1' }, 'src/a.ts'))
      .toBeUndefined()
    expect(decodeReadFileResponse({ path: 'src/a.ts', content: 'text', version: 'v1', extra: true }, 'src/a.ts'))
      .toBeUndefined()
    expect(decodeReadFileResponse({
      path: 'src/a.ts',
      content: 'preview',
      version: 'v1',
      readOnlyPresentation: {
        reason: 'too-large', sizeBytes: 5_000_000, limitBytes: 4_194_304,
        previewBytes: 7, truncated: true,
      },
    }, 'src/a.ts')).toMatchObject({
      content: 'preview',
      readOnlyPresentation: { reason: 'too-large', previewBytes: 7 },
    })
    expect(decodeReadFileResponse({
      path: 'src/a.ts',
      content: 'forged bytes',
      version: 'v1',
      readOnlyPresentation: {
        reason: 'binary', sizeBytes: 12, limitBytes: 4_194_304,
        previewBytes: 12, truncated: true,
      },
    }, 'src/a.ts')).toBeUndefined()
    expect(decodeWriteFileResponse({ path: 'src/a.ts', version: 'v2' }, 'src/a.ts'))
      .toEqual({ path: 'src/a.ts', version: 'v2' })
    expect(decodeWriteFileResponse({ path: '../a.ts', version: 'v2' }, 'src/a.ts')).toBeUndefined()
    expect(decodeWriteFileResponse({ path: 'src/a.ts', version: 'x'.repeat(257) }, 'src/a.ts')).toBeUndefined()
  })

  it('decodes inspect snapshots against the exact ordered target identity', () => {
    const targets = [
      { kind: 'directory' as const, path: '' },
      { kind: 'file' as const, path: 'src/a.ts' },
      { kind: 'file' as const, path: 'src/a.ts' },
    ]
    const value = {
      snapshots: [
        { path: '', kind: 'directory', state: 'present', version: 'directory-v1' },
        { path: 'src/a.ts', kind: 'file', state: 'present', version: 'file-v1', size: 0 },
      ],
    }
    expect(decodeInspectResponse(value, targets)).toEqual(value)
    expect(decodeInspectResponse({ snapshots: [...value.snapshots].reverse() }, targets)).toBeUndefined()
    expect(decodeInspectResponse({ snapshots: [value.snapshots[0]] }, targets)).toBeUndefined()
    expect(decodeInspectResponse({ snapshots: [
      { ...value.snapshots[0], extra: true }, value.snapshots[1],
    ] }, targets)).toBeUndefined()
    expect(decodeInspectResponse({ snapshots: [
      value.snapshots[0], { ...value.snapshots[1], path: '../outside' },
    ] }, targets)).toBeUndefined()
    expect(decodeInspectResponse({ snapshots: [
      value.snapshots[0], { ...value.snapshots[1], size: -1 },
    ] }, targets)).toBeUndefined()
  })

  it('turns malformed successful file responses into stable 502 protocol errors', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [{ name: 'a.ts', path: '../a.ts', type: 'file' }] }),
    })
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(fileApi.list('workspace', 'src', signal)).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })
    expect(fetch.mock.calls[0]?.[1].signal).toBe(signal)
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body as string)).toEqual({
      op: 'list', workspaceId: 'workspace', path: 'src',
    })

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ path: 'other.ts', content: '', version: 'v1' }) })
    await expect(fileApi.read('workspace', 'a.ts')).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ path: 'other.ts', version: 'v2' }) })
    await expect(fileApi.write('workspace', 'a.ts', 'next', 'v1')).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ snapshots: [
      { path: 'other.ts', kind: 'file', state: 'missing' },
    ] }) })
    await expect(fileApi.inspect('workspace', [{ path: 'a.ts', kind: 'file' }])).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })
  })

  it('normalizes inspect targets before transport and rejects invalid or oversized input locally', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ snapshots: [{ path: '', kind: 'directory', state: 'missing' }] }),
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fileApi.inspect('workspace', [
      { path: '', kind: 'directory' },
      { path: '', kind: 'directory' },
    ])).resolves.toEqual({ snapshots: [{ path: '', kind: 'directory', state: 'missing' }] })
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body as string)).toEqual({
      op: 'inspect', workspaceId: 'workspace', targets: [{ path: '', kind: 'directory' }],
    })

    await expect(fileApi.inspect('workspace', [{ path: '', kind: 'file' }]))
      .rejects.toMatchObject<ApiError>({ code: 'INVALID_INSPECT_TARGETS', status: 400 })
    await expect(fileApi.inspect('workspace', Array.from(
      { length: DEFAULT_MAX_INSPECT_TARGETS + 1 },
      (_, index) => ({ path: `${String(index)}.ts`, kind: 'file' as const }),
    ))).rejects.toMatchObject<ApiError>({ code: 'INVALID_INSPECT_TARGETS', status: 400 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid outbound paths locally and maps invalid JSON on a 200 response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('bad json') },
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fileApi.read('workspace', '../outside')).rejects.toMatchObject<ApiError>({
      code: 'INVALID_PATH', status: 400,
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(fileApi.read('workspace', 'src/a.ts')).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })
  })

  it('does not misreport an aborted response body as a Host protocol violation', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('cancelled', 'AbortError')
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort()
        throw aborted
      },
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fileApi.list('workspace', '', controller.signal)).rejects.toBe(aborted)
  })
})
