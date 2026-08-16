import { describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../../src/client/contracts.ts'
import {
  ExplorerStore,
  MAX_EXPLORER_CACHED_DIRECTORIES,
  MAX_EXPLORER_CACHED_ENTRIES,
  MAX_EXPLORER_EXPANDED_DIRECTORIES,
} from '../../src/client/explorer/store.ts'

const directory = (name: string, path = name): FileEntry => ({ name, path, type: 'directory' })
const file = (name: string, path = name): FileEntry => ({ name, path, type: 'file' })

describe('ExplorerStore', () => {
  it('is a stable uSES source and preserves independent sessions across workspace switches', () => {
    const store = new ExplorerStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)

    store.selectWorkspace('one')
    store.setExpanded('one', 'src', true)
    store.setFocus('one', 'src')
    store.setSelected('one', 'src/a.ts')
    store.setDirectoryEntries('one', '', [directory('src')])
    store.selectWorkspace('two')
    store.setExpanded('two', 'test', true)
    store.selectWorkspace('one')

    expect(store.session().expanded).toEqual(new Set(['', 'src']))
    expect(store.session().focusedPath).toBe('src')
    expect(store.session().selectedPath).toBe('src/a.ts')
    expect(store.session('two').expanded).toEqual(new Set(['', 'test']))
    expect(listener).toHaveBeenCalled()
  })

  it('isolates listeners and rejects state deeper than the presentation ceiling', () => {
    const store = new ExplorerStore()
    store.subscribe(() => { throw new Error('broken view') })
    const healthy = vi.fn()
    store.subscribe(healthy)
    store.selectWorkspace('workspace')
    expect(healthy).toHaveBeenCalledOnce()
    const tooDeep = Array.from({ length: 129 }, () => 'd').join('/')
    expect(store.setExpanded('workspace', tooDeep, true)).toBe(false)
    store.setDirectoryEntries('workspace', tooDeep, [])
    expect(store.session().directories.has(tooDeep)).toBe(false)
  })

  it('keeps root expanded and bounds expanded and cached directory state', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    expect(store.setExpanded('workspace', '', false)).toBe(false)
    for (let index = 0; index < MAX_EXPLORER_CACHED_DIRECTORIES + 20; index += 1) {
      store.setExpanded('workspace', `d${index}`, true)
      store.setDirectoryEntries('workspace', `d${index}`, [])
    }
    expect(store.session().expanded.size).toBe(MAX_EXPLORER_EXPANDED_DIRECTORIES)
    expect(store.session().expanded.has('')).toBe(true)
    expect(store.session().directories.size).toBe(MAX_EXPLORER_CACHED_DIRECTORIES)
    for (const path of store.session().expanded) {
      if (path !== '') expect(store.session().directories.has(path), path).toBe(true)
    }

    store.setDirectoryEntries('workspace', '', [directory('root')])
    for (let index = 0; index < MAX_EXPLORER_CACHED_DIRECTORIES + 2; index += 1) {
      store.setDirectoryEntries('workspace', `x${index}`, [])
    }
    expect(store.session().directories.has('')).toBe(true)
    expect(store.session().directories.size).toBe(MAX_EXPLORER_CACHED_DIRECTORIES)
  })

  it('enforces a total entry budget, evicts cold cache first, and explicitly rejects protected overflow', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    const entries = (parent: string, count: number): FileEntry[] => Array.from({ length: count }, (_value, index) => ({
      name: `f${index}.ts`, path: `${parent}/f${index}.ts`, type: 'file',
    }))
    const perDirectory = 5_000
    store.setDirectoryEntries('workspace', 'cold', entries('cold', perDirectory))
    for (let index = 0; index < MAX_EXPLORER_CACHED_ENTRIES / perDirectory; index += 1) {
      const path = `hot${index}`
      store.setExpanded('workspace', path, true)
      expect(store.setDirectoryEntries('workspace', path, entries(path, perDirectory))).toBe(true)
    }
    expect(store.session().directories.has('cold')).toBe(false)
    const cached = [...store.session().directories.values()]
      .reduce((total, directory) => total + (directory.entries?.length ?? 0), 0)
    expect(cached).toBe(MAX_EXPLORER_CACHED_ENTRIES)

    store.setExpanded('workspace', 'overflow', true)
    expect(store.setDirectoryEntries('workspace', 'overflow', entries('overflow', 1))).toBe(false)
    expect(store.session().directories.get('overflow')).toEqual({
      status: 'error', error: 'Directory cache limit exceeded.',
    })
  })

  it('keeps focus and selection separate and scopes presentation acknowledgement to epoch and request', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setFocus('workspace', 'src')
    store.setSelected('workspace', 'src/a.ts')
    expect(store.session().focusedPath).toBe('src')
    expect(store.session().selectedPath).toBe('src/a.ts')

    const first = store.requestPresentation('workspace', 'src/a.ts', false)!
    const second = store.requestPresentation('workspace', 'src/b.ts', true)!
    expect(store.acknowledgePresentation(first.requestId)).toBe(false)
    expect(store.acknowledgePresentation(second.requestId)).toBe(true)
    expect(store.session().pendingPresentation).toBeUndefined()

    store.requestPresentation('workspace', 'src/a.ts', false)
    store.selectWorkspace('other')
    store.selectWorkspace('workspace')
    expect(store.session().pendingPresentation).toBeUndefined()
  })

  it('atomically collapses only the active workspace while retaining cache and selection', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [directory('src'), directory('test')])
    store.setDirectoryEntries('workspace', 'src', [directory('nested', 'src/nested')])
    store.setDirectoryEntries('workspace', 'src/nested', [file('app.ts', 'src/nested/app.ts')])
    store.setExpanded('workspace', 'src', true)
    store.setExpanded('workspace', 'src/nested', true)
    store.setFocus('workspace', 'src/nested/app.ts')
    store.setSelected('workspace', 'src/nested/app.ts')
    store.requestPresentation('workspace', 'src/nested/app.ts', true)
    const directories = store.session().directories

    expect(store.collapseAll('workspace')).toBe(true)
    expect(store.session().expanded).toEqual(new Set(['']))
    expect(store.session().directories).toBe(directories)
    expect(store.session().selectedPath).toBe('src/nested/app.ts')
    expect(store.session().focusedPath).toBe('src')
    expect(store.session().pendingPresentation).toBeUndefined()

    store.setFocus('workspace', 'missing/deep/file.ts')
    expect(store.collapseAll('workspace')).toBe(true)
    expect(store.session().focusedPath).toBe('src')

    store.selectWorkspace('other')
    expect(store.collapseAll('workspace')).toBe(false)
    expect(store.session('workspace').expanded).toEqual(new Set(['']))

    const empty = new ExplorerStore()
    empty.selectWorkspace('empty')
    empty.setFocus('empty', 'missing/deep/file.ts')
    expect(empty.collapseAll('empty')).toBe(true)
    expect(empty.session().focusedPath).toBeUndefined()
  })

  it('synchronously prunes subtree cache, parent entries, expansion, focus, selection and presentation', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [directory('src')])
    store.setDirectoryEntries('workspace', 'src', [directory('generated', 'src/generated'), file('keep.ts', 'src/keep.ts')])
    store.setDirectoryEntries('workspace', 'src/generated', [file('late.ts', 'src/generated/late.ts')])
    store.setExpanded('workspace', 'src', true)
    store.setExpanded('workspace', 'src/generated', true)
    store.setFocus('workspace', 'src/generated/late.ts')
    store.setSelected('workspace', 'src/generated/late.ts')
    store.requestPresentation('workspace', 'src/generated/late.ts', true)

    store.pruneRemoved('workspace', ['src/generated'])

    expect(store.session().directories.has('src/generated')).toBe(false)
    expect(store.session().directories.get('src')?.entries?.map(entry => entry.path)).toEqual(['src/keep.ts'])
    expect(store.session().expanded.has('src/generated')).toBe(false)
    expect(store.session().expanded.has('')).toBe(true)
    expect(store.session().focusedPath).toBe('src')
    expect(store.session().selectedPath).toBeUndefined()
    expect(store.session().pendingPresentation).toBeUndefined()
  })

  it('keeps an exact kind-replacement row focused while pruning its descendants', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [file('a'), file('b.ts')])
    store.setDirectoryEntries('workspace', 'a', [file('child.ts', 'a/child.ts')])
    store.setExpanded('workspace', 'a', true)
    store.setFocus('workspace', 'a/child.ts')
    store.setSelected('workspace', 'a/child.ts')

    store.pruneReplaced('workspace', ['a'])

    expect(store.session().directories.has('a')).toBe(false)
    expect(store.session().expanded.has('a')).toBe(false)
    expect(store.session().focusedPath).toBe('a')
    expect(store.session().selectedPath).toBeUndefined()
    expect(store.session().directories.get('')?.entries?.map(entry => entry.path)).toEqual(['a', 'b.ts'])
  })

  it('permanently fences writes and clears listeners on dispose', () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSnapshot()
    store.dispose()
    store.setDirectoryEntries('workspace', '', [file('late.ts')])
    store.selectWorkspace('other')
    expect(store.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    const late = vi.fn()
    store.subscribe(late)
    store.setFocus('workspace', 'late.ts')
    expect(late).not.toHaveBeenCalled()
  })
})
