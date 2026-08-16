import { describe, expect, it, vi } from 'vitest'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import {
  WorkspaceSearchController,
  WorkspaceSearchStore,
  overlayDirtyBufferMatches,
} from '../../src/client/search/workspace-search.ts'
import type { SearchTextResponse, WorkspaceTextSearchQuery } from '../../src/shared/workspace-search.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function readyBuffer(content = 'base\r\n'): DocumentSessionStore {
  const store = new DocumentSessionStore()
  store.selectWorkspace('workspace')
  const intent = store.beginOpen('workspace', 'src/a.ts', 'a.ts')!
  store.completeOpen(intent, { path: 'src/a.ts', content, version: 'v1' })
  return store
}

const literal = (pattern: string, extra: Partial<WorkspaceTextSearchQuery> = {}): WorkspaceTextSearchQuery => ({
  pattern, mode: 'literal', caseSensitive: false, wholeWord: false, ...extra,
})

const emptyResponse = (): SearchTextResponse => ({
  items: [], matchCount: 0, fileCount: 0, incomplete: false, limit: 500,
})

describe('Workspace Search client core', () => {
  it('replaces dirty-path disk hits with current UTF-16/CRLF buffer matches without changing editor bytes', () => {
    const documents = readyBuffer('first\r\n😀 Target targetX TARGET\r\n')
    const tab = documents.activeTab()!
    documents.editDocument('workspace', tab.path, tab.lifecycleId, 'first\r\n😀 Target targetX TARGET\r\nlocal\r\n')
    const before = documents.activeTab()!
    const response: SearchTextResponse = {
      items: [{
        path: 'src/a.ts', lineNumber: 99, preview: 'stale disk', previewStart: 0, ranges: [{ start: 0, end: 5 }],
      }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    }

    const result = overlayDirtyBufferMatches(response, literal('target', { wholeWord: true }), [before])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      path: 'src/a.ts', lineNumber: 2, source: 'buffer', previewStart: 0,
      ranges: [{ start: 3, end: 9 }, { start: 18, end: 24 }],
      bufferLifecycleId: before.lifecycleId, bufferRevision: before.localRevision,
    })
    expect(documents.activeTab()).toBe(before)
    expect(documents.activeTab()?.content).toBe('first\r\n😀 Target targetX TARGET\r\nlocal\r\n')
  })

  it('applies literal case options to dirty buffers and omits filtered dirty buffers', () => {
    const documents = readyBuffer('Name name\n')
    const tab = documents.activeTab()!
    documents.editDocument('workspace', tab.path, tab.lifecycleId, tab.content + 'Name\n')
    const current = documents.activeTab()!

    expect(overlayDirtyBufferMatches(emptyResponse(), {
      pattern: 'Name', mode: 'literal', caseSensitive: true, wholeWord: true,
    }, [current]).matchCount).toBe(2)
    expect(overlayDirtyBufferMatches(emptyResponse(), {
      pattern: 'Name', mode: 'literal', caseSensitive: true, wholeWord: false,
      exclude: ['src/**'],
    }, [current])).toMatchObject({ items: [], truncated: true, dirtyBuffersOmitted: true })

    const bounded = overlayDirtyBufferMatches({ ...emptyResponse(), limit: 1 }, literal('Name'), [current])
    expect(bounded).toMatchObject({ matchCount: 1, truncated: true })
  })

  it('omits dirty regex buffers instead of executing user regex on the browser main thread', () => {
    const documents = readyBuffer('aaaaaaaaaaaaaaaa!\n')
    const tab = documents.activeTab()!
    documents.editDocument('workspace', tab.path, tab.lifecycleId, `${tab.content}dirty\n`)
    const result = overlayDirtyBufferMatches(emptyResponse(), {
      pattern: '(a+)+$', mode: 'regex', caseSensitive: true, wholeWord: false,
    }, [documents.activeTab()!])

    expect(result).toMatchObject({
      items: [], matchCount: 0, fileCount: 0, truncated: true, dirtyBuffersOmitted: true,
    })
  })

  it('keeps literal dirty-buffer scanning within one global byte and match budget', () => {
    const documents = readyBuffer('needle '.repeat(350_000))
    const first = documents.activeTab()!
    documents.editDocument('workspace', first.path, first.lifecycleId, first.content + 'dirty')
    const oversized = documents.activeTab()!
    const second = { ...oversized, path: 'src/b.ts', name: 'b.ts', lifecycleId: oversized.lifecycleId + 1 }
    const result = overlayDirtyBufferMatches({ ...emptyResponse(), limit: 3 }, literal('needle'), [oversized, second])

    expect(result.matchCount).toBeLessThanOrEqual(3)
    expect(result).toMatchObject({ truncated: true, dirtyBuffersOmitted: true })
  })

  it('keeps per-workspace state, cancels/aborts, and fences late completions', async () => {
    const documents = readyBuffer()
    const pending = deferred<SearchTextResponse>()
    let signal: AbortSignal | undefined
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, {
      searchText: async (_workspace, _query, requestSignal) => {
        signal = requestSignal
        return await pending.promise
      },
    }, documents)
    controller.selectWorkspace('workspace')
    const running = controller.run(literal('one'))
    expect(store.session().status).toBe('running')
    controller.selectWorkspace('other')
    expect(signal?.aborted).toBe(true)
    expect(store.session('workspace').status).toBe('cancelled')
    pending.resolve({
      items: [{ path: 'old.ts', lineNumber: 1, preview: 'one', previewStart: 0, ranges: [{ start: 0, end: 3 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })
    await running
    expect(store.session('other')).toMatchObject({ status: 'idle', items: [] })
    expect(store.session('workspace').items).toEqual([])
    controller.dispose()
  })

  it('clears one active projection, preserves its query, and fences late outcomes', () => {
    const store = new WorkspaceSearchStore()
    store.selectWorkspace('workspace')
    const query = literal('needle', {
      caseSensitive: true,
      wholeWord: true,
      include: ['src/**'],
      exclude: ['src/generated/**'],
    })
    const intent = store.begin(query)!
    expect(store.complete(intent, {
      items: [{
        path: 'src/a.ts', lineNumber: 3, preview: 'needle', previewStart: 0,
        ranges: [{ start: 0, end: 6 }], source: 'disk',
      }],
      matchCount: 1,
      fileCount: 1,
      truncated: true,
      dirtyBuffersOmitted: true,
      limit: 500,
    })).toBe(true)

    const published = vi.fn()
    const unsubscribe = store.subscribe(published)
    expect(store.clear('other')).toBe(false)
    expect(published).not.toHaveBeenCalled()
    expect(store.clear('workspace')).toBe(true)
    expect(published).toHaveBeenCalledOnce()
    expect(store.session()).toEqual({
      query,
      requestGeneration: intent.requestGeneration + 1,
      status: 'idle',
      items: [],
      selectedIndex: -1,
      matchCount: 0,
      fileCount: 0,
      truncated: false,
      dirtyBuffersOmitted: false,
    })

    const cleared = store.getSnapshot()
    expect(store.complete(intent, {
      items: [], matchCount: 0, fileCount: 0, truncated: false,
      dirtyBuffersOmitted: false, limit: 500,
    })).toBe(false)
    expect(store.fail(intent, 'late failure')).toBe(false)
    expect(store.getSnapshot()).toBe(cleared)
    unsubscribe()
  })

  it('selects exact results and wraps next or previous movement within the current generation', () => {
    const store = new WorkspaceSearchStore()
    store.selectWorkspace('workspace')
    const intent = store.begin(literal('needle'))!
    const items = ['a.ts', 'b.ts', 'c.ts'].map((path, index) => ({
      path,
      lineNumber: index + 1,
      preview: 'needle',
      previewStart: 0,
      ranges: [{ start: 0, end: 6 }],
      source: 'disk' as const,
    }))
    expect(store.complete(intent, {
      items, matchCount: 3, fileCount: 3, truncated: false,
      dirtyBuffersOmitted: false, limit: 500,
    })).toBe(true)

    expect(store.session().selectedIndex).toBe(0)
    expect(store.moveSelection(1)?.path).toBe('b.ts')
    expect(store.moveSelection(1)?.path).toBe('c.ts')
    expect(store.moveSelection(1)?.path).toBe('a.ts')
    expect(store.moveSelection(-1)?.path).toBe('c.ts')
    expect(store.selectIndex(1)?.path).toBe('b.ts')
    expect(store.session().selectedIndex).toBe(1)

    expect(store.clear('workspace')).toBe(true)
    const cleared = store.getSnapshot()
    expect(store.moveSelection(1)).toBeUndefined()
    expect(store.selectIndex(0)).toBeUndefined()
    expect(store.getSnapshot()).toBe(cleared)
  })

  it('recomputes while a dirty buffer changes and reruns Host search when it becomes clean', async () => {
    const documents = readyBuffer('disk\n')
    const original = documents.activeTab()!
    documents.editDocument('workspace', original.path, original.lifecycleId, 'alpha\n')
    const responses = [emptyResponse(), {
      items: [{ path: 'src/a.ts', lineNumber: 1, preview: 'alpha', previewStart: 0, ranges: [{ start: 0, end: 5 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    } satisfies SearchTextResponse]
    const searchText = vi.fn(async () => responses.shift()!)
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('workspace')
    await controller.run(literal('alpha'))
    expect(store.session().items[0]).toMatchObject({ source: 'buffer', ranges: [{ start: 0, end: 5 }] })

    const dirty = documents.activeTab()!
    documents.editDocument('workspace', dirty.path, dirty.lifecycleId, 'x alpha\n')
    expect(store.session().items[0]).toMatchObject({ source: 'buffer', ranges: [{ start: 2, end: 7 }] })

    const save = documents.beginSave('workspace', dirty.path)!
    documents.completeSave(save, 'v2')
    await vi.waitFor(() => { expect(searchText).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(store.session().items[0]?.source).toBe('disk') })
    expect(store.session().requestGeneration).toBe(2)
    controller.dispose()
  })

  it('discards an in-flight Host snapshot when a dirty path becomes clean before completion', async () => {
    const documents = readyBuffer('disk old\n')
    const original = documents.activeTab()!
    documents.editDocument('workspace', original.path, original.lifecycleId, 'saved new\n')
    const first = deferred<SearchTextResponse>()
    const searchText = vi.fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValueOnce({
        items: [{ path: 'src/a.ts', lineNumber: 1, preview: 'saved new', previewStart: 0, ranges: [{ start: 0, end: 5 }] }],
        matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
      })
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('workspace')
    const searching = controller.run(literal('saved'))
    const dirty = documents.activeTab()!
    const save = documents.beginSave('workspace', dirty.path)!
    documents.completeSave(save, 'v2')
    first.resolve({
      items: [{ path: 'src/a.ts', lineNumber: 1, preview: 'disk old', previewStart: 0, ranges: [{ start: 0, end: 4 }] }],
      matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
    })
    await searching
    expect(searchText).toHaveBeenCalledTimes(2)
    expect(store.session()).toMatchObject({ requestGeneration: 2, status: 'complete' })
    expect(store.session().items[0]).toMatchObject({ source: 'disk', preview: 'saved new' })
    controller.dispose()
  })

  it('detects clean to dirty to clean ABA while a Host request is in flight', async () => {
    const documents = readyBuffer('old\n')
    const first = deferred<SearchTextResponse>()
    const searchText = vi.fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValueOnce({
        items: [{ path: 'src/a.ts', lineNumber: 1, preview: 'new', previewStart: 0, ranges: [{ start: 0, end: 3 }] }],
        matchCount: 1, fileCount: 1, incomplete: false, limit: 500,
      })
    const store = new WorkspaceSearchStore()
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('workspace')
    const searching = controller.run(literal('new'))

    const clean = documents.activeTab()!
    documents.editDocument('workspace', clean.path, clean.lifecycleId, 'new\n')
    const dirty = documents.activeTab()!
    const save = documents.beginSave('workspace', dirty.path)!
    documents.completeSave(save, 'v2')
    first.resolve(emptyResponse())

    await searching
    expect(searchText).toHaveBeenCalledTimes(2)
    expect(store.session()).toMatchObject({ requestGeneration: 2, status: 'complete' })
    expect(store.session().items[0]).toMatchObject({ source: 'disk', preview: 'new' })
    controller.dispose()
  })

  it('reports empty, truncated, cancelled, and error states explicitly', async () => {
    const documents = readyBuffer()
    const store = new WorkspaceSearchStore()
    const searchText = vi.fn()
      .mockResolvedValueOnce({ ...emptyResponse(), incomplete: true })
      .mockRejectedValueOnce(new Error('rg unavailable'))
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('workspace')
    await controller.run(literal('none'))
    expect(store.session()).toMatchObject({ status: 'empty', truncated: true })
    await controller.run(literal('bad'))
    expect(store.session()).toMatchObject({ status: 'error', error: 'rg unavailable' })
    controller.dispose()
  })

  it('revalidates a completed workspace when returning after its Host response cache was dropped', async () => {
    const documents = readyBuffer()
    const store = new WorkspaceSearchStore()
    const searchText = vi.fn(async () => emptyResponse())
    const controller = new WorkspaceSearchController(store, { searchText }, documents)
    controller.selectWorkspace('workspace')
    await controller.run(literal('needle'))
    expect(searchText).toHaveBeenCalledTimes(1)

    controller.selectWorkspace('other')
    controller.selectWorkspace('workspace')
    await vi.waitFor(() => { expect(searchText).toHaveBeenCalledTimes(2) })
    expect(store.session('workspace').requestGeneration).toBe(2)
    controller.dispose()
  })
})
