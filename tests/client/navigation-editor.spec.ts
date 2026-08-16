import { describe, expect, it } from 'vitest'
import { DocumentController } from '../../src/client/documents/controller.ts'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import {
  EditorNavigationController,
  parseEditorLocation,
} from '../../src/client/navigation/editor-navigation.ts'
import type { TextSearchItem } from '../../src/shared/workspace-search.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function setup(content = 'one\r\n😀 target here\r\n') {
  let reads = 0
  const store = new DocumentSessionStore()
  store.selectWorkspace('workspace')
  const documents = new DocumentController(store, {
    read: async (_workspace, path) => { reads += 1; return { path, content, version: 'v1' } },
    write: async (_workspace, path) => ({ path, version: 'v2' }),
  })
  return { store, documents, navigation: new EditorNavigationController(documents), reads: () => reads }
}

function match(overrides: Partial<TextSearchItem> = {}): TextSearchItem {
  return {
    path: 'src/a.ts', lineNumber: 2, preview: '😀 target here', previewStart: 0,
    ranges: [{ start: 3, end: 9 }], ...overrides,
  }
}

function observeActive(
  store: DocumentSessionStore,
  navigation: EditorNavigationController,
  lineNumber: number,
  columnNumber: number,
) {
  const snapshot = store.getSnapshot()
  const tab = store.activeTab()!
  expect(navigation.observeActiveLocation({
    workspaceId: 'workspace',
    workspaceEpoch: snapshot.activeWorkspaceEpoch,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
    historyEpoch: tab.historyEpoch,
    localRevision: tab.localRevision,
  }, { lineNumber, columnNumber })).toBe(true)
  return tab
}

describe('EditorNavigationController', () => {
  it('parses only safe positive one-based line and optional column forms', () => {
    expect(parseEditorLocation('42')).toEqual({ lineNumber: 42, columnNumber: 1 })
    expect(parseEditorLocation(':42')).toEqual({ lineNumber: 42, columnNumber: 1 })
    expect(parseEditorLocation('42:7')).toEqual({ lineNumber: 42, columnNumber: 7 })
    expect(parseEditorLocation(' :42:7 ')).toEqual({ lineNumber: 42, columnNumber: 7 })
    for (const invalid of ['', '0', ':0', '42:0', '42:', '4:2:1', '9007199254740992']) {
      expect(parseEditorLocation(invalid)).toBeUndefined()
    }
  })

  it('reveals a clamped UTF-16 column in the current dirty buffer without another read', async () => {
    const { store, navigation, reads } = setup('one\r\n\u{1F600}target\r\nthree')
    await navigation.openPath('workspace', 'src/a.ts')
    const opened = store.activeTab()!
    store.editDocument('workspace', opened.path, opened.lifecycleId, 'local\r\n\u{1F600}target\r\nthree')
    const tab = store.activeTab()!

    expect(navigation.revealActiveLocation({ lineNumber: 2, columnNumber: 99 })).toBe('revealed')
    const identity = {
      workspaceId: 'workspace', path: tab.path, lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch, localRevision: tab.localRevision,
    }
    // "local\r\n" is 7 UTF-16 units; the emoji is 2 and "target" is 6.
    expect(navigation.revealFor(identity)).toMatchObject({ from: 15, to: 15, lineNumber: 2 })
    expect(reads()).toBe(1)
    expect(store.activeTab()).toMatchObject({ content: 'local\r\n\u{1F600}target\r\nthree', dirty: true })

    expect(navigation.revealActiveLocation({ lineNumber: 4, columnNumber: 1 })).toBe('invalid')
    expect(navigation.revealActiveLocation({ lineNumber: 2, columnNumber: 0 })).toBe('invalid')
  })

  it('refuses caret navigation for a read-only presentation without publishing a reveal', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async (_workspace, path) => ({
        path,
        content: '',
        version: 'v1',
        readOnlyPresentation: {
          reason: 'binary' as const,
          sizeBytes: 8,
          limitBytes: 64 * 1024 * 1024,
          previewBytes: 0,
          truncated: true as const,
        },
      }),
      write: async (_workspace, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)
    await navigation.openPath('workspace', 'image.bin')

    expect(navigation.revealActiveLocation({ lineNumber: 1, columnNumber: 1 })).toBe('invalid')
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('opens through DocumentController and maps one-based line plus UTF-16 range to absolute offsets', async () => {
    const { store, navigation, reads } = setup()
    await expect(navigation.openSearchMatch('workspace', match())).resolves.toBe('revealed')
    expect(reads()).toBe(1)
    const tab = store.activeTab()!
    expect(tab).toMatchObject({ path: 'src/a.ts', name: 'a.ts', dirty: false })
    const identity = {
      workspaceId: 'workspace', path: tab.path, lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch, localRevision: tab.localRevision,
    }
    const request = navigation.revealFor(identity)!
    // Editable buffers are canonical LF: "one\n" is 4 UTF-16 units; emoji is 2, then a space.
    expect(request).toMatchObject({ from: 7, to: 13, lineNumber: 2 })
    expect(navigation.acknowledge(request.requestId)).toBe(true)
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('opens a path and publishes a clamped caret under the same exact navigation generation', async () => {
    const { store, navigation } = setup('one\n\u{1F600}target\nthree')
    await expect(navigation.openPathAtLocation(
      'workspace',
      'src/a.ts',
      { lineNumber: 2, columnNumber: 99 },
    )).resolves.toBe('revealed')
    const tab = store.activeTab()!
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: tab.path, lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch, localRevision: tab.localRevision,
    })).toMatchObject({ lineNumber: 2, from: 12, to: 12 })

    await expect(navigation.openPathAtLocation(
      'workspace',
      'src/a.ts',
      { lineNumber: 4, columnNumber: 1 },
    )).resolves.toBe('invalid')
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('contains an invalidated path-location read before it can open or reveal', async () => {
    const pending = deferred<{ path: string; content: string; version: string }>()
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async (_workspace, path) => path === 'target.ts'
        ? await pending.promise
        : { path, content: 'fallback', version: 'v1' },
      write: async (_workspace, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)
    await navigation.openPath('workspace', 'fallback.ts')
    let accepted = true
    const opening = navigation.openPathAtLocation(
      'workspace',
      'target.ts',
      { lineNumber: 1, columnNumber: 1 },
      () => accepted,
    )
    accepted = false
    pending.resolve({ path: 'target.ts', content: 'target', version: 'v1' })

    await expect(opening).resolves.toBe('stale')
    expect(store.session('workspace').activePath).toBe('fallback.ts')
    expect(store.session('workspace').tabs.map(tab => tab.path)).toEqual(['fallback.ts'])
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('rejects an invalidated search completion before it can open or reveal the file', async () => {
    const pending = deferred<{ path: string; content: string; version: string }>()
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async () => await pending.promise,
      write: async (_workspace, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)
    let current = true
    const opening = navigation.openSearchMatch('workspace', match(), () => current)

    current = false
    pending.resolve({ path: 'src/a.ts', content: 'one\r\n馃榾 target here\r\n', version: 'v1' })

    await expect(opening).resolves.toBe('stale')
    expect(store.session('workspace').tabs).toEqual([])
    expect(store.session('workspace').activePath).toBeUndefined()
    expect(navigation.getRevealRequest()).toBeUndefined()
  })

  it('activates and reveals against dirty editor bytes without rereading or overwriting them', async () => {
    const { store, navigation, reads } = setup()
    await navigation.openPath('workspace', 'src/a.ts')
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'local\r\n😀 target local\r\n')
    const dirty = store.activeTab()!

    await expect(navigation.openSearchMatch('workspace', match({ preview: '😀 target local' }))).resolves.toBe('revealed')
    expect(reads()).toBe(1)
    expect(store.activeTab()).toBe(dirty)
    expect(store.activeTab()).toMatchObject({ content: 'local\r\n😀 target local\r\n', dirty: true })
  })

  it('rejects stale preview/ranges and lifecycle-fences a reveal after editing or workspace switch', async () => {
    const { store, navigation } = setup()
    await expect(navigation.openSearchMatch('workspace', match({ preview: 'old disk bytes' }))).resolves.toBe('stale')
    expect(navigation.getRevealRequest()).toBeUndefined()

    await navigation.openSearchMatch('workspace', match())
    const tab = store.activeTab()!
    const oldIdentity = {
      workspaceId: 'workspace', path: tab.path, lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch, localRevision: tab.localRevision,
    }
    expect(navigation.revealFor(oldIdentity)).toBeDefined()
    store.editDocument('workspace', tab.path, tab.lifecycleId, `${tab.content}later`)
    expect(navigation.revealFor({ ...oldIdentity, localRevision: oldIdentity.localRevision + 1 })).toBeUndefined()
    store.selectWorkspace('other')
    expect(navigation.revealFor(oldIdentity)).toBeUndefined()
  })

  it('keeps the latest navigation authoritative when file reads complete out of order', async () => {
    const reads = new Map([
      ['a.ts', deferred<{ path: string; content: string; version: string }>()],
      ['b.ts', deferred<{ path: string; content: string; version: string }>()],
    ])
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async (_workspace, path) => await reads.get(path)!.promise,
      write: async (_workspace, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)
    const first = navigation.openPath('workspace', 'a.ts')
    const latest = navigation.openPath('workspace', 'b.ts')
    reads.get('b.ts')!.resolve({ path: 'b.ts', content: 'b', version: 'b1' })
    await expect(latest).resolves.toBe(true)
    reads.get('a.ts')!.resolve({ path: 'a.ts', content: 'a', version: 'a1' })
    await expect(first).resolves.toBe(false)
    expect(store.session('workspace')).toMatchObject({ activePath: 'b.ts' })
    expect(store.session('workspace').tabs.map(tab => tab.path)).toEqual(['b.ts', 'a.ts'])
  })

  it('contains an older entry point failure after a newer cross-entry navigation succeeds', async () => {
    const oldRead = deferred<{ path: string; content: string; version: string }>()
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async (_workspace, path) => path === 'old.ts'
        ? await oldRead.promise
        : { path, content: 'one\r\n😀 target here\r\n', version: 'v1' },
      write: async (_workspace, path) => ({ path, version: 'v2' }),
    })
    const navigation = new EditorNavigationController(documents)

    const oldExplorerOpen = navigation.openPath('workspace', 'old.ts')
    await expect(navigation.openSearchMatch('workspace', match({ path: 'new.ts' }))).resolves.toBe('revealed')
    oldRead.reject(new Error('old read failed'))

    await expect(oldExplorerOpen).resolves.toBe(false)
    expect(store.session('workspace').activePath).toBe('new.ts')
  })

  it('moves exact cursor locations atomically through bounded per-workspace back and forward history', async () => {
    const { store, navigation } = setup('one\nsecond\nthird')
    const initialSnapshot = navigation.getHistorySnapshot()
    await navigation.openPath('workspace', 'a.ts')
    const initial = observeActive(store, navigation, 2, 3)
    expect(navigation.getHistorySnapshot()).toBe(initialSnapshot)
    expect(navigation.activateOpenDocument({
      workspaceId: 'workspace', workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: initial.path, lifecycleId: initial.lifecycleId,
    })).toBe(true)
    await expect(navigation.openPath('workspace', initial.path)).resolves.toBe(true)
    expect(navigation.getHistorySnapshot()).toBe(initialSnapshot)

    await navigation.openPath('workspace', 'b.ts')
    const b = observeActive(store, navigation, 3, 2)
    expect(navigation.getHistorySnapshot()).toMatchObject({
      revision: 1,
      workspaces: new Map([['workspace', { back: 1, forward: 0 }]]),
    })

    await expect(navigation.navigateBack()).resolves.toBe('revealed')
    const a = store.activeTab()!
    expect(a.path).toBe('a.ts')
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: a.path, lifecycleId: a.lifecycleId,
      historyEpoch: a.historyEpoch, localRevision: a.localRevision,
    })).toMatchObject({ lineNumber: 2, from: 6, to: 6 })
    expect(navigation.getHistorySnapshot().workspaces.get('workspace')).toEqual({ back: 0, forward: 1 })

    await expect(navigation.navigateForward()).resolves.toBe('revealed')
    expect(store.activeTab()).toBe(b)
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: b.path, lifecycleId: b.lifecycleId,
      historyEpoch: b.historyEpoch, localRevision: b.localRevision,
    })).toMatchObject({ lineNumber: 3, from: 12, to: 12 })

    for (let index = 0; index <= 100; index += 1) {
      await navigation.openPath('workspace', `generated/${index}.ts`)
    }
    expect(navigation.getHistorySnapshot().workspaces.get('workspace')).toEqual({ back: 100, forward: 0 })
  })

  it('restores the exact captured source and leaves stacks stable when a history or search target is invalid', async () => {
    const { store, navigation } = setup('one\nsecond\nthird')
    await navigation.openPath('workspace', 'target.ts')
    const target = observeActive(store, navigation, 3, 2)
    await navigation.openPath('workspace', 'source.ts')
    const source = observeActive(store, navigation, 2, 4)
    store.updateWorkspaceTabs('workspace', tabs => tabs.map(tab => tab.path === target.path
      ? { ...tab, content: 'one', localRevision: tab.localRevision + 1, dirty: true }
      : tab))
    const beforeInvalidHistory = navigation.getHistorySnapshot()

    await expect(navigation.navigateBack()).resolves.toBe('invalid')
    expect(store.activeTab()).toBe(source)
    expect(navigation.getHistorySnapshot()).toBe(beforeInvalidHistory)
    expect(navigation.getHistorySnapshot().workspaces.get('workspace')).toEqual({ back: 1, forward: 0 })
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: source.path, lifecycleId: source.lifecycleId,
      historyEpoch: source.historyEpoch, localRevision: source.localRevision,
    })).toMatchObject({ lineNumber: 2, from: 7, to: 7 })

    const beforeStaleSearch = navigation.getHistorySnapshot()
    await expect(navigation.openSearchMatch('workspace', {
      path: 'stale.ts',
      lineNumber: 2,
      preview: 'disk bytes no longer present',
      previewStart: 0,
      ranges: [{ start: 0, end: 1 }],
    })).resolves.toBe('stale')
    expect(store.activeTab()).toBe(source)
    expect(navigation.getHistorySnapshot()).toBe(beforeStaleSearch)
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: source.path, lifecycleId: source.lifecycleId,
      historyEpoch: source.historyEpoch, localRevision: source.localRevision,
    })).toMatchObject({ lineNumber: 2, from: 7, to: 7 })
  })
})
