import { describe, expect, it } from 'vitest'
import { DocumentController } from '../../src/client/documents/controller.ts'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import { EditorNavigationController } from '../../src/client/navigation/editor-navigation.ts'
import type { TextSearchItem } from '../../src/shared/workspace-search.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function match(overrides: Partial<TextSearchItem> = {}): TextSearchItem {
  return {
    path: 'src/a.ts', lineNumber: 2, preview: '😀 target here', previewStart: 0,
    ranges: [{ start: 3, end: 9 }], ...overrides,
  }
}

function identity(store: DocumentSessionStore) {
  const tab = store.activeTab()!
  return {
    workspaceId: store.getSnapshot().activeWorkspaceId!,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
    historyEpoch: tab.historyEpoch,
    localRevision: tab.localRevision,
  }
}

describe('editor navigation lifecycle regressions', () => {
  it('rejects a range outside the validated preview or logical line', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    const documents = new DocumentController(store, {
      read: async (_workspaceId, path) => ({ path, content: 'one\r\nneedle and other\r\n', version: 'v1' }),
      write: async (_workspaceId, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)

    await expect(navigation.openSearchMatch('w1', match({
      preview: 'needle', previewStart: 0, ranges: [{ start: 11, end: 16 }],
    }))).resolves.toBe('stale')
    expect(navigation.getRevealRequest()).toBeUndefined()

    await expect(navigation.openSearchMatch('w1', match({
      preview: 'needle and other', previewStart: 0, ranges: [{ start: 11, end: 99 }],
    }))).resolves.toBe('stale')
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('keeps an open dirty buffer authoritative while validating UTF-16 CRLF offsets', async () => {
    let reads = 0
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    const documents = new DocumentController(store, {
      read: async (_workspaceId, path) => {
        reads += 1
        return { path, content: 'disk\n', version: 'v1' }
      },
      write: async (_workspaceId, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)
    await navigation.openPath('w1', 'src/a.ts')
    const opened = store.activeTab()!
    store.editDocument('w1', opened.path, opened.lifecycleId, 'local\r\n😀 target here\r\n')
    const dirty = store.activeTab()!

    await expect(navigation.openSearchMatch('w1', match())).resolves.toBe('revealed')
    expect(reads).toBe(1)
    expect(store.activeTab()).toBe(dirty)
    expect(store.activeTab()).toMatchObject({ dirty: true, content: 'local\r\n😀 target here\r\n' })
    expect(navigation.revealFor(identity(store))).toMatchObject({ from: 10, to: 16 })
  })

  it('rejects raw lone-CR search coordinates after editable text is normalized to LF', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    const documents = new DocumentController(store, {
      read: async (_workspaceId, path) => ({ path, content: 'one\rtarget here\r', version: 'v1' }),
      write: async (_workspaceId, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)

    await expect(navigation.openSearchMatch('w1', match({
      lineNumber: 1, preview: 'one\rtarget here', previewStart: 0, ranges: [{ start: 4, end: 10 }],
    }))).resolves.toBe('stale')
    expect(store.activeTab()?.content).toBe('one\ntarget here\n')
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('rejects a pending open after W1 to W2 to W1 and accepts only the fresh lifecycle', async () => {
    const firstRead = deferred<{ path: string; content: string; version: string }>()
    const secondRead = deferred<{ path: string; content: string; version: string }>()
    let reads = 0
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    const documents = new DocumentController(store, {
      read: async () => {
        reads += 1
        return await (reads === 1 ? firstRead.promise : secondRead.promise)
      },
      write: async (_workspaceId, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)

    const staleOpen = navigation.openSearchMatch('w1', match())
    store.selectWorkspace('w2')
    store.selectWorkspace('w1')
    firstRead.resolve({ path: 'src/a.ts', content: 'one\r\n😀 target here\r\n', version: 'old' })
    await expect(staleOpen).resolves.toBe('stale')
    expect(store.session('w1').tabs).toEqual([])
    expect(navigation.getRevealRequest()).toBeUndefined()

    const freshOpen = navigation.openSearchMatch('w1', match())
    secondRead.resolve({ path: 'src/a.ts', content: 'one\r\n😀 target here\r\n', version: 'new' })
    await expect(freshOpen).resolves.toBe('revealed')
    expect(store.activeTab()?.version).toBe('new')
    expect(navigation.revealFor(identity(store))).toBeDefined()
  })

  it('keeps the latest navigation active when an older different-path read finishes last', async () => {
    const reads = new Map([
      ['src/a.ts', deferred<{ path: string; content: string; version: string }>()],
      ['src/b.ts', deferred<{ path: string; content: string; version: string }>()],
    ])
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    const documents = new DocumentController(store, {
      read: async (_workspaceId, path) => await reads.get(path)!.promise,
      write: async (_workspaceId, path) => ({ path, version: 'saved' }),
    })
    const navigation = new EditorNavigationController(documents)
    const a = navigation.openSearchMatch('w1', match({
      path: 'src/a.ts', lineNumber: 1, preview: 'target', ranges: [{ start: 0, end: 6 }],
    }))
    const b = navigation.openSearchMatch('w1', match({
      path: 'src/b.ts', lineNumber: 1, preview: 'target', ranges: [{ start: 0, end: 6 }],
    }))

    reads.get('src/b.ts')!.resolve({ path: 'src/b.ts', content: 'target\n', version: 'b1' })
    await expect(b).resolves.toBe('revealed')
    const latest = navigation.getRevealRequest()
    expect(store.session('w1').activePath).toBe('src/b.ts')

    reads.get('src/a.ts')!.resolve({ path: 'src/a.ts', content: 'target\n', version: 'a1' })
    await expect(a).resolves.toBe('stale')
    expect(store.session('w1')).toMatchObject({ activePath: 'src/b.ts' })
    expect(store.session('w1').tabs.map(tab => tab.path)).toEqual(['src/b.ts'])
    expect(navigation.getRevealRequest()).toBe(latest)
  })

  it('workspace ABA and close/reopen both invalidate an old reveal identity', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('w1')
    let version = 0
    const documents = new DocumentController(store, {
      read: async (_workspaceId, path) => ({
        path, content: 'one\r\n😀 target here\r\n', version: `v${String(++version)}`,
      }),
      write: async (_workspaceId, path) => ({ path, version: 'saved' }),
    })
    const navigation = new EditorNavigationController(documents)

    await navigation.openSearchMatch('w1', match())
    const beforeSwitch = identity(store)
    expect(navigation.revealFor(beforeSwitch)).toBeDefined()
    store.selectWorkspace('w2')
    store.selectWorkspace('w1')
    expect(navigation.revealFor(beforeSwitch)).toBeUndefined()

    await navigation.openSearchMatch('w1', match())
    const beforeClose = identity(store)
    expect(navigation.revealFor(beforeClose)).toBeDefined()
    expect(store.closeDocument('w1', 'src/a.ts')).toBeDefined()
    expect(navigation.revealFor(beforeClose)).toBeUndefined()
    await navigation.openSearchMatch('w1', match())
    const afterReopen = identity(store)
    expect(afterReopen.lifecycleId).not.toBe(beforeClose.lifecycleId)
    expect(navigation.revealFor(beforeClose)).toBeUndefined()
    expect(navigation.revealFor(afterReopen)).toBeDefined()
  })
})
