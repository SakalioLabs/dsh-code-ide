import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, ListFilesResponse } from '../../src/client/contracts.ts'
import {
  ExplorerController,
  MAX_EXPLORER_CONCURRENT_LOADS,
  type ExplorerListPort,
} from '../../src/client/explorer/controller.ts'
import { ExplorerStore } from '../../src/client/explorer/store.ts'

const directory = (name: string, path = name): FileEntry => ({ name, path, type: 'directory' })
const file = (name: string, path = name): FileEntry => ({ name, path, type: 'file' })

interface PendingCall {
  workspaceId: string
  path: string
  signal: AbortSignal | undefined
  resolve(response: ListFilesResponse): void
  reject(error: unknown): void
}

class DeferredListPort implements ExplorerListPort {
  readonly calls: PendingCall[] = []

  list(workspaceId: string, path: string, signal?: AbortSignal): Promise<ListFilesResponse> {
    return new Promise((resolve, reject) => {
      const call: PendingCall = { workspaceId, path, signal, resolve, reject }
      this.calls.push(call)
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  }
}

describe('ExplorerController', () => {
  it('loads roots through the sole port owner and fences a switched workspace by AbortSignal and epoch', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    const first = controller.selectWorkspace('one')
    expect(port.calls[0]?.path).toBe('')

    const second = controller.selectWorkspace('two')
    expect(port.calls[0]?.signal?.aborted).toBe(true)
    expect(port.calls[1]).toMatchObject({ workspaceId: 'two', path: '' })
    port.calls[1]?.resolve({ entries: [file('two.ts')] })
    await Promise.all([first, second])

    expect(store.getSnapshot().activeWorkspaceId).toBe('two')
    expect(store.session('one').directories.get('')).toBeUndefined()
    expect(store.session('two').directories.get('')?.entries?.[0]?.path).toBe('two.ts')
  })

  it('aborts a superseded path generation and contains list failures as presentation state', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    store.selectWorkspace('workspace')
    const first = controller.load('', true)
    const second = controller.load('', true)
    expect(port.calls[0]?.signal?.aborted).toBe(true)
    port.calls[1]?.reject(new Error('offline'))
    await Promise.all([first, second])
    expect(store.session().directories.get('')).toMatchObject({ status: 'error', error: 'offline' })
  })

  it('separates logical focus and selection while applying APG keys and 800ms type-ahead', async () => {
    const list = vi.fn(async (_workspaceId: string, path: string) => ({
      entries: path === ''
        ? [directory('src'), file('Alpha.ts'), file('Alpine.ts')]
        : [file('child.ts', 'src/child.ts')],
    }))
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, { list })
    await controller.selectWorkspace('workspace')
    controller.setFocus('src')
    expect(store.session().selectedPath).toBeUndefined()
    await controller.handleTreeKey('ArrowRight')
    expect(store.session().expanded.has('src')).toBe(true)
    await controller.handleTreeKey('ArrowRight')
    expect(store.session().focusedPath).toBe('src/child.ts')
    await controller.handleTreeKey(' ')
    expect(store.session().selectedPath).toBe('src/child.ts')

    controller.setFocus('Alpha.ts')
    expect(controller.typeahead('A', 0)).toBe('Alpine.ts')
    expect(controller.typeahead('A', 100)).toBe('Alpha.ts')
    expect(controller.typeahead('l', 1_000)).toBeUndefined()
  })

  it('refreshes only the requested directories and all expanded directories on command refresh', async () => {
    const list = vi.fn(async (_workspaceId: string, path: string) => ({ entries: path === '' ? [directory('src')] : [] }))
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, { list })
    await controller.selectWorkspace('workspace')
    await controller.toggle('src')
    list.mockClear()
    await controller.refreshDirectories(['src', 'src', '../bad'])
    expect(list.mock.calls.map(call => call[1])).toEqual(['src'])
    list.mockClear()
    await controller.refreshExpanded()
    expect(new Set(list.mock.calls.map(call => call[1]))).toEqual(new Set(['', 'src']))
  })

  it('treats a refreshed direct-child list as authoritative and prunes removed focused identity', async () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [directory('src')])
    store.setDirectoryEntries('workspace', 'src', [directory('nested', 'src/nested')])
    store.setDirectoryEntries('workspace', 'src/nested', [
      file('message.ts', 'src/nested/message.ts'),
      file('observed.ts', 'src/nested/observed.ts'),
    ])
    store.setExpanded('workspace', 'src', true)
    store.setExpanded('workspace', 'src/nested', true)
    store.setFocus('workspace', 'src/nested/observed.ts')
    store.setSelected('workspace', 'src/nested/observed.ts')
    const controller = new ExplorerController(store, {
      list: async () => ({ entries: [file('message.ts', 'src/nested/message.ts')] }),
    })

    await controller.refreshDirectories(['src/nested'])

    expect(store.session().directories.get('src/nested')?.entries?.map(entry => entry.path))
      .toEqual(['src/nested/message.ts'])
    expect(store.session().focusedPath).toBe('src/nested/message.ts')
    expect(store.session().selectedPath).toBeUndefined()
  })

  it('prunes kind-replaced cache while preserving the exact replacement row focus', async () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [directory('a'), file('b.ts')])
    store.setDirectoryEntries('workspace', 'a', [file('child.ts', 'a/child.ts')])
    store.setExpanded('workspace', 'a', true)
    store.setFocus('workspace', 'a')
    const controller = new ExplorerController(store, {
      list: async () => ({ entries: [file('a'), file('b.ts')] }),
    })

    await controller.refreshDirectories([''])

    expect(store.session().directories.get('')?.entries?.[0]).toMatchObject({ path: 'a', type: 'file' })
    expect(store.session().directories.has('a')).toBe(false)
    expect(store.session().expanded.has('a')).toBe(false)
    expect(store.session().focusedPath).toBe('a')
  })

  it('bounds refresh concurrency and fences remaining batch work to its captured workspace epoch', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    store.selectWorkspace('one')
    const paths = Array.from({ length: MAX_EXPLORER_CONCURRENT_LOADS + 5 }, (_value, index) => `d${index}`)
    const refresh = controller.refreshDirectories(paths)
    expect(port.calls).toHaveLength(MAX_EXPLORER_CONCURRENT_LOADS)

    const switched = controller.selectWorkspace('two')
    await vi.waitFor(() => expect(port.calls).toHaveLength(MAX_EXPLORER_CONCURRENT_LOADS + 1))
    expect(port.calls.at(-1)).toMatchObject({ workspaceId: 'two', path: '' })
    port.calls.at(-1)?.resolve({ entries: [] })
    await Promise.all([refresh, switched])
    expect(port.calls.filter(call => call.workspaceId === 'two')).toHaveLength(1)
  })

  it('prunes synchronously, aborts intersecting requests, and rejects late resurrection', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', 'src', [directory('generated', 'src/generated')])
    const pending = controller.load('src', true)

    controller.pruneRemoved(['src/generated'])

    expect(port.calls[0]?.signal?.aborted).toBe(true)
    expect(store.session().directories.get('src')?.entries).toEqual([])
    await pending
    expect(store.session().directories.get('src')?.entries).toEqual([])
  })

  it('reveals ancestor-by-ancestor, verifies direct directories, and publishes an acknowledged intent', async () => {
    const calls: string[] = []
    const list = async (_workspaceId: string, path: string): Promise<ListFilesResponse> => {
      calls.push(path)
      if (path === '') return { entries: [directory('src')] }
      if (path === 'src') return { entries: [directory('deep', 'src/deep')] }
      return { entries: [file('target.ts', 'src/deep/target.ts')] }
    }
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, { list })
    store.selectWorkspace('workspace')

    await expect(controller.revealPath('src/deep/target.ts')).resolves.toBe(true)
    expect(calls).toEqual(['', 'src', 'src/deep'])
    expect(store.session().expanded).toEqual(new Set(['', 'src', 'src/deep']))
    expect(store.session().selectedPath).toBe('src/deep/target.ts')
    expect(store.session().focusedPath).toBeUndefined()
    const pending = store.session().pendingPresentation!
    expect(pending).toMatchObject({ path: 'src/deep/target.ts', focus: false })
    expect(controller.acknowledgePresentation(pending.requestId)).toBe(true)
  })

  it('does not accept stale cached ancestry when the reveal revalidation fails', async () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    store.setDirectoryEntries('workspace', '', [directory('src')])
    const controller = new ExplorerController(store, {
      list: async () => { throw new Error('revalidation failed') },
    })
    await expect(controller.revealPath('src/a.ts')).resolves.toBe(false)
    expect(store.session().directories.get('')?.status).toBe('error')
    expect(store.session().pendingPresentation).toBeUndefined()
  })

  it('contains a synchronous ListPort throw without leaving a loading request', async () => {
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    const controller = new ExplorerController(store, {
      list: () => { throw new Error('sync failure') },
    })
    await expect(controller.load('', true)).resolves.toBeUndefined()
    expect(store.session().directories.get('')).toMatchObject({ status: 'error', error: 'sync failure' })
  })

  it('makes reveal latest-wins and rejects a non-directory ancestor', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    store.selectWorkspace('workspace')
    const first = controller.revealPath('old/a.ts')
    const second = controller.revealPath('new/b.ts')
    expect(port.calls[0]?.signal?.aborted).toBe(true)
    port.calls[1]?.resolve({ entries: [directory('new')] })
    await vi.waitFor(() => expect(port.calls).toHaveLength(3))
    port.calls[2]?.resolve({ entries: [file('b.ts', 'new/b.ts')] })
    await expect(second).resolves.toBe(true)
    await expect(first).resolves.toBe(false)
    expect(store.session().pendingPresentation?.path).toBe('new/b.ts')

    const invalid = controller.revealPath('plain/child.ts')
    await vi.waitFor(() => expect(port.calls).toHaveLength(4))
    port.calls[3]?.resolve({ entries: [file('plain')] })
    await expect(invalid).resolves.toBe(false)
  })

  it('lets an independent active selection fence and withdraw an in-flight reveal', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    const controller = new ExplorerController(store, port)
    store.selectWorkspace('workspace')
    const reveal = controller.revealPath('old/a.ts')
    controller.setSelected(undefined)
    expect(port.calls[0]?.signal?.aborted).toBe(true)
    await expect(reveal).resolves.toBe(false)
    expect(store.session().selectedPath).toBeUndefined()
    expect(store.session().pendingPresentation).toBeUndefined()
  })

  it('dispose permanently aborts effects, fences late completion, and clears store listeners', async () => {
    const port = new DeferredListPort()
    const store = new ExplorerStore()
    store.selectWorkspace('workspace')
    const listener = vi.fn()
    store.subscribe(listener)
    const controller = new ExplorerController(store, port)
    const pending = controller.load('', true)
    listener.mockClear()
    controller.dispose()
    expect(port.calls[0]?.signal?.aborted).toBe(true)
    await pending
    await controller.selectWorkspace('other')
    await controller.refreshExpanded()
    expect(store.getSnapshot().activeWorkspaceId).toBe('workspace')
    expect(listener).not.toHaveBeenCalled()
  })
})
