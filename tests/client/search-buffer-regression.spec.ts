import { describe, expect, it, vi } from 'vitest'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import {
  WorkspaceSearchController,
  WorkspaceSearchStore,
  overlayDirtyBufferMatches,
} from '../../src/client/search/workspace-search.ts'
import {
  searchTextContent,
  type SearchTextResponse,
  type WorkspaceTextSearchQuery,
} from '../../src/shared/workspace-search.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

const literal = (
  pattern: string,
  extra: Partial<WorkspaceTextSearchQuery> = {},
): WorkspaceTextSearchQuery => ({
  pattern, mode: 'literal', caseSensitive: false, wholeWord: false, ...extra,
})

const emptyResponse = (limit = 500): SearchTextResponse => ({
  items: [], matchCount: 0, fileCount: 0, incomplete: false, limit,
})

function dirtyWorkspace(): DocumentSessionStore {
  const documents = new DocumentSessionStore()
  documents.selectWorkspace('w1')
  documents.restoreWorkspace('w1', [
    {
      path: 'src/live.ts', name: 'live.ts', content: 'disk bytes', baselineContent: 'disk bytes',
      version: 'v1', dirty: false,
    },
    {
      path: 'src/live.spec.ts', name: 'live.spec.ts', content: 'disk spec', baselineContent: 'disk spec',
      version: 'v1', dirty: false,
    },
  ], 'src/live.ts')
  for (const tab of documents.session('w1').tabs) {
    documents.editDocument('w1', tab.path, tab.lifecycleId, tab.path.endsWith('.spec.ts')
      ? 'target excluded'
      : '😀 TARGET targetX\r\ncafé target\r汉target字 target\n')
  }
  return documents
}

describe('dirty-buffer workspace search regressions', () => {
  it('uses shared glob, Unicode whole-word, UTF-16, and ripgrep CRLF semantics', () => {
    const query = literal('target', {
      wholeWord: true,
      include: ['src/**'],
      exclude: ['**/*.spec.ts'],
    })
    const content = '😀 TARGET targetX\r\ncafé target\r汉target字 target\n'

    expect(searchTextContent('src/live.spec.ts', content, query)).toEqual([])
    expect(searchTextContent('src/live.ts', content, query)).toMatchObject([
      { lineNumber: 1, previewStart: 0, ranges: [{ start: 3, end: 9 }] },
      { lineNumber: 2, previewStart: 0, ranges: [{ start: 5, end: 11 }, { start: 21, end: 27 }] },
    ])
  })

  it('drops stale dirty-path disk hits and retains clean disk hits when filters omit dirty buffers', () => {
    const documents = dirtyWorkspace()
    const response: SearchTextResponse = {
      items: [
        {
          path: 'src/live.ts', lineNumber: 99, preview: 'stale disk', previewStart: 0,
          ranges: [{ start: 0, end: 5 }],
        },
        {
          path: 'src/clean.ts', lineNumber: 1, preview: 'target on disk', previewStart: 0,
          ranges: [{ start: 0, end: 6 }],
        },
      ],
      matchCount: 2, fileCount: 2, incomplete: false, limit: 500,
    }
    const query = literal('target', {
      wholeWord: true, include: ['src/**'], exclude: ['**/*.spec.ts'],
    })

    const result = overlayDirtyBufferMatches(response, query, documents.session('w1').tabs)
    expect(result.items.some(item => item.path === 'src/live.spec.ts')).toBe(false)
    expect(result.items.find(item => item.path === 'src/clean.ts')).toMatchObject({ source: 'disk' })
    expect(result.items.filter(item => item.path === 'src/live.ts')).toEqual([])
    expect(result).toMatchObject({
      matchCount: 1, fileCount: 1, truncated: true, dirtyBuffersOmitted: true,
    })
  })

  it('does not resurrect a saved disk hit when the buffer becomes dirty again during refresh', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('w1')
    documents.restoreWorkspace('w1', [{
      path: 'src/a.ts', name: 'a.ts', content: 'old disk\n', baselineContent: 'old disk\n',
      version: 'v1', dirty: false,
    }], 'src/a.ts')
    const original = documents.activeTab()!
    documents.editDocument('w1', original.path, original.lifecycleId, 'target saved\n')

    const refresh = deferred<SearchTextResponse>()
    const searchText = vi.fn()
      .mockResolvedValueOnce(emptyResponse())
      .mockImplementationOnce(async () => await refresh.promise)
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('w1')
    await controller.run(literal('target'))
    expect(store.session().items[0]).toMatchObject({ source: 'buffer' })

    const dirty = documents.activeTab()!
    const save = documents.beginSave('w1', dirty.path)!
    documents.completeSave(save, 'v2')
    expect(searchText).toHaveBeenCalledTimes(2)
    const clean = documents.activeTab()!
    documents.editDocument('w1', clean.path, clean.lifecycleId, 'no match now\n')

    refresh.resolve({
      items: [{
        path: 'src/a.ts', lineNumber: 1, preview: 'target saved', previewStart: 0,
        ranges: [{ start: 0, end: 6 }],
      }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })
    await vi.waitFor(() => { expect(store.session().status).toBe('empty') })
    expect(store.session().items).toEqual([])
    expect(documents.activeTab()).toMatchObject({ content: 'no match now\n', dirty: true })
    controller.dispose()
  })

  it('fences same-query Host completions across W1 to W2 to W1', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('w1')
    const oldRequest = deferred<SearchTextResponse>()
    const newRequest = deferred<SearchTextResponse>()
    const signals: AbortSignal[] = []
    let calls = 0
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, {
      searchText: async (_workspaceId, _query, signal) => {
        signals.push(signal!)
        calls += 1
        return await (calls === 1 ? oldRequest.promise : newRequest.promise)
      },
    }, documents)

    controller.selectWorkspace('w1')
    const oldRun = controller.run(literal('same'))
    controller.selectWorkspace('w2')
    controller.selectWorkspace('w1')
    expect(signals[0]?.aborted).toBe(true)
    const newRun = controller.run(literal('same'))

    oldRequest.resolve({
      items: [{ path: 'old.ts', lineNumber: 1, preview: 'same', previewStart: 0, ranges: [{ start: 0, end: 4 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })
    await oldRun
    expect(store.session('w1')).toMatchObject({ status: 'running', items: [] })

    newRequest.resolve({
      items: [{ path: 'new.ts', lineNumber: 1, preview: 'same', previewStart: 0, ranges: [{ start: 0, end: 4 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })
    await newRun
    expect(store.session('w1').items).toMatchObject([{ path: 'new.ts', source: 'disk' }])
    controller.dispose()
  })
})
