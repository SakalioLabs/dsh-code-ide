import { describe, expect, it, vi } from 'vitest'
import {
  QuickOpenController,
  QuickOpenStore,
  fuzzyQuickOpenMatch,
  parseQuickOpenQuery,
  rankQuickOpenItems,
  type DebounceScheduler,
} from '../../src/client/search/quick-open.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

class ManualScheduler implements DebounceScheduler {
  callbacks: Array<() => void> = []
  after(_milliseconds: number, callback: () => void): () => void {
    this.callbacks.push(callback)
    let cancelled = false
    return () => { cancelled = true; this.callbacks = this.callbacks.filter(item => item !== callback) }
  }
  flush(): void { for (const callback of this.callbacks.splice(0)) callback() }
}

describe('Quick Open client core', () => {
  it('separates only a safe rightmost line and optional column suffix from the file query', () => {
    expect(parseQuickOpenQuery(' src/App.ts:42 ')).toEqual({
      fileQuery: 'src/App.ts', location: { lineNumber: 42, columnNumber: 1 },
    })
    expect(parseQuickOpenQuery('C:\\src\\App.ts:42:7')).toEqual({
      fileQuery: 'C:\\src\\App.ts', location: { lineNumber: 42, columnNumber: 7 },
    })
    expect(parseQuickOpenQuery('name:part')).toEqual({ fileQuery: 'name:part' })
    expect(parseQuickOpenQuery('name:0')).toEqual({ fileQuery: 'name:0' })
    expect(parseQuickOpenQuery('name:9007199254740992:2')).toEqual({
      fileQuery: 'name:9007199254740992:2',
    })
  })

  it('fuzzy-ranks basename, boundary, and contiguous hits with stable ties', () => {
    expect(fuzzyQuickOpenMatch('src/components/App.tsx', 'app')?.positions).toEqual([15, 16, 17])
    expect(rankQuickOpenItems([
      { path: 'src/my-app.ts' },
      { path: 'src/app.ts' },
      { path: 'test/app.ts' },
      { path: 'src/application.ts' },
    ], 'app').map(item => item.path)).toEqual([
      'src/app.ts', 'test/app.ts', 'src/application.ts', 'src/my-app.ts',
    ])
  })

  it('debounces, aborts superseded work, and rejects a late workspace generation', async () => {
    const scheduler = new ManualScheduler()
    const first = deferred<{ items: { path: string }[]; incomplete: boolean; limit: number }>()
    const second = deferred<{ items: { path: string }[]; incomplete: boolean; limit: number }>()
    const signals: AbortSignal[] = []
    let calls = 0
    const store = new QuickOpenStore()
    const controller = new QuickOpenController(store, {
      findFiles: async (_workspace, _query, signal) => {
        signals.push(signal!)
        calls += 1
        return await (calls === 1 ? first.promise : second.promise)
      },
    }, { scheduler })
    controller.selectWorkspace('one')
    controller.setQuery('old')
    scheduler.flush()
    controller.setQuery('new')
    expect(signals[0]?.aborted).toBe(true)
    scheduler.flush()
    second.resolve({ items: [{ path: 'new.ts' }], incomplete: false, limit: 200 })
    await vi.waitFor(() => {
      expect(store.getSnapshot()).toMatchObject({ status: 'complete', query: 'new' })
    })
    expect(store.activeItem()?.path).toBe('new.ts')

    controller.selectWorkspace('two')
    first.resolve({ items: [{ path: 'old.ts' }], incomplete: false, limit: 200 })
    await Promise.resolve()
    expect(store.getSnapshot()).toMatchObject({ workspaceId: 'two', status: 'idle', items: [] })
  })

  it('sends only the file portion to Host search and fuzzy ranking', async () => {
    const scheduler = new ManualScheduler()
    const queries: string[] = []
    const store = new QuickOpenStore()
    const controller = new QuickOpenController(store, {
      findFiles: async (_workspace, query) => {
        queries.push(query)
        return { items: [{ path: 'src/App.ts' }], incomplete: false, limit: 200 }
      },
    }, { scheduler })
    controller.selectWorkspace('workspace')
    controller.setQuery('src/App.ts:42:7')
    scheduler.flush()

    await vi.waitFor(() => { expect(store.getSnapshot().status).toBe('complete') })
    expect(queries).toEqual(['src/App.ts'])
    expect(store.getSnapshot().query).toBe('src/App.ts:42:7')
    expect(store.activeItem()?.path).toBe('src/App.ts')
  })

  it('wraps keyboard selection and exposes empty/error/incomplete states', () => {
    const store = new QuickOpenStore()
    store.selectWorkspace('workspace')
    const intent = store.setQuery('a')!
    store.begin(intent)
    store.complete(intent, { items: [{ path: 'a.ts' }, { path: 'a.js' }], incomplete: true, limit: 2 })
    expect(store.moveSelection(-1)?.path).toBe('a.js')
    expect(store.moveSelection(1)?.path).toBe('a.ts')
    expect(store.getSnapshot().incomplete).toBe(true)
    const empty = store.setQuery('none')!
    store.complete(empty, { items: [], incomplete: false, limit: 200 })
    expect(store.getSnapshot().status).toBe('empty')
    const failed = store.setQuery('fail')!
    store.fail(failed, 'offline')
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'offline' })
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    store.moveSelection(1)
    stop()
  })
})
