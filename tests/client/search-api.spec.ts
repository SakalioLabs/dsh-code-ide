import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  decodeFindFilesResponse,
  decodeSearchTextResponse,
  fileApi,
} from '../../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('workspace search API decoding', () => {
  it('accepts complete wire values and reconstructs them without a bare response cast', () => {
    expect(decodeFindFilesResponse({ items: [{ path: 'src/a.ts' }], incomplete: false, limit: 200 }))
      .toEqual({ items: [{ path: 'src/a.ts' }], incomplete: false, limit: 200 })
    expect(decodeSearchTextResponse({
      items: [{
        path: 'src/a.ts', lineNumber: 2, preview: '😀 target', previewStart: 4,
        ranges: [{ start: 7, end: 13 }],
      }],
      matchCount: 1, fileCount: 1, incomplete: true, limit: 500,
    })).toEqual({
      items: [{
        path: 'src/a.ts', lineNumber: 2, preview: '😀 target', previewStart: 4,
        ranges: [{ start: 7, end: 13 }],
      }],
      matchCount: 1, fileCount: 1, incomplete: true, limit: 500,
    })
  })

  it('rejects malformed nested values and malformed successful HTTP responses', async () => {
    expect(decodeFindFilesResponse({ items: [{ path: 4 }], incomplete: false, limit: 200 })).toBeUndefined()
    expect(decodeFindFilesResponse({ items: [{ path: '../outside' }], incomplete: false, limit: 200 })).toBeUndefined()
    expect(decodeFindFilesResponse({
      items: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }], incomplete: false, limit: 200,
    })).toBeUndefined()
    expect(decodeSearchTextResponse({
      items: [{ path: 'a', lineNumber: 0, preview: '', previewStart: 0, ranges: [{ start: 3, end: 2 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })).toBeUndefined()
    expect(decodeSearchTextResponse({
      items: [{
        path: 'C:/outside', lineNumber: 1, preview: 'x', previewStart: 0,
        ranges: [{ start: 0, end: 1 }],
      }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })).toBeUndefined()
    expect(decodeSearchTextResponse({
      items: [{ path: 'a', lineNumber: 1, preview: 'x', previewStart: 0, ranges: [{ start: 0, end: 1 }] }],
      matchCount: 2, fileCount: 1, incomplete: false, limit: 500,
    })).toBeUndefined()
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: 'not-an-array', incomplete: false, limit: 200 }),
    })
    vi.stubGlobal('fetch', fetch)
    await expect(fileApi.findFiles('workspace', 'src')).rejects.toMatchObject<ApiError>({
      code: 'INVALID_RESPONSE', status: 502,
    })
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      op: 'findFiles', workspaceId: 'workspace', query: 'src',
    })
  })

  it('sends explicit text options and forwards AbortSignal', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], matchCount: 0, fileCount: 0, incomplete: false, limit: 500 }),
    })
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await fileApi.searchText('workspace', {
      pattern: 'name', mode: 'regex', caseSensitive: true, wholeWord: true,
      include: ['src/**'], exclude: ['**/*.spec.ts'],
    }, signal)
    const init = fetch.mock.calls[0]![1]
    expect(init.signal).toBe(signal)
    expect(JSON.parse(init.body as string)).toEqual({
      op: 'searchText', workspaceId: 'workspace',
      query: {
        pattern: 'name', mode: 'regex', caseSensitive: true, wholeWord: true,
        include: ['src/**'], exclude: ['**/*.spec.ts'],
      },
    })
  })
})
