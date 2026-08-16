import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/client/api.ts'
import { DocumentController, type DocumentFilePort } from '../../src/client/documents/controller.ts'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import type { WorkspaceInvalidation } from '../../src/client/observation/source.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function ready() {
  const store = new DocumentSessionStore()
  store.selectWorkspace('workspace')
  const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
  store.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
  return store
}

function openDirty(store: DocumentSessionStore, path: string) {
  const intent = store.beginOpen('workspace', path, path)!
  store.completeOpen(intent, { path, content: 'base\n', version: `v1-${path}` })
  const tab = store.session('workspace').tabs.find(candidate => candidate.path === path)!
  store.editDocument('workspace', path, tab.lifecycleId, `local ${path}\n`)
  return store.session('workspace').tabs.find(candidate => candidate.path === path)!
}

describe('DocumentController', () => {
  it('saves all eligible dirty tabs while reporting every blocked or conflicted path', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    for (const path of [
      'saved.ts', 'conflict.ts', 'readonly.txt', 'deleted.ts', 'unknown.ts', 'pending.ts', 'leased.ts',
    ]) openDirty(store, path)
    store.updateWorkspaceTabs('workspace', tabs => tabs.map(tab => {
      if (tab.path === 'readonly.txt') return {
        ...tab,
        readOnlyPresentation: {
          reason: 'too-large' as const,
          sizeBytes: 5_000_000,
          limitBytes: 4_194_304,
          previewBytes: tab.content.length,
          truncated: true,
        },
      }
      if (tab.path === 'deleted.ts') return { ...tab, externalState: 'deleted' as const }
      if (tab.path === 'unknown.ts') return { ...tab, saveOutcome: 'unknown' as const }
      if (tab.path === 'pending.ts') return { ...tab, pendingSaveId: 777 }
      return tab
    }))
    expect(store.restoreMutationLease('lease', 'workspace', ['leased.ts'])).toBe(true)
    const writes: string[] = []
    const controller = new DocumentController(store, {
      read: async (_workspace, path) => ({ path, content: 'base\n', version: `v1-${path}` }),
      write: async (_workspace, path) => {
        writes.push(path)
        if (path === 'conflict.ts') throw new ApiError({ code: 'VERSION_CONFLICT', message: 'changed' }, 409)
        return { path, version: `v2-${path}` }
      },
    })

    const summary = await controller.saveAll()

    expect(summary).toMatchObject({
      workspaceId: 'workspace', totalDirty: 7, attempted: 2, saved: 1, blocked: 5,
      conflicts: 1, failed: 0, unknown: 0, stale: 0,
    })
    expect(writes.sort()).toEqual(['conflict.ts', 'saved.ts'])
    expect(summary?.results).toEqual([
      expect.objectContaining({ path: 'saved.ts', status: 'saved' }),
      expect.objectContaining({ path: 'conflict.ts', status: 'conflict' }),
      expect.objectContaining({ path: 'readonly.txt', status: 'blocked', blockers: ['read-only'] }),
      expect.objectContaining({ path: 'deleted.ts', status: 'blocked', blockers: ['deleted'] }),
      expect.objectContaining({ path: 'unknown.ts', status: 'blocked', blockers: ['unknown-save'] }),
      expect.objectContaining({ path: 'pending.ts', status: 'blocked', blockers: ['pending-save'] }),
      expect.objectContaining({ path: 'leased.ts', status: 'blocked', blockers: ['mutation-lease'] }),
    ])
  })

  it('bounds Save All writes to four concurrent requests', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    for (let index = 0; index < 7; index += 1) openDirty(store, `file-${index}.ts`)
    let active = 0
    let maximum = 0
    const controller = new DocumentController(store, {
      read: async (_workspace, path) => ({ path, content: 'base\n', version: 'v1' }),
      write: async (_workspace, path) => {
        active += 1
        maximum = Math.max(maximum, active)
        await Promise.resolve()
        active -= 1
        return { path, version: `v2-${path}` }
      },
    })

    const summary = await controller.saveAll()

    expect(maximum).toBe(4)
    expect(summary).toMatchObject({ totalDirty: 7, attempted: 7, saved: 7, blocked: 0 })
  })

  it('opens a bounded read-only presentation without admitting edits or writes', async () => {
    let writes = 0
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const controller = new DocumentController(store, {
      read: async (_workspace, path) => ({
        path,
        content: 'bounded preview',
        version: 'v-large',
        readOnlyPresentation: {
          reason: 'too-large', sizeBytes: 5_000_000, limitBytes: 4_194_304,
          previewBytes: 15, truncated: true,
        },
      }),
      write: async (_workspace, path) => { writes += 1; return { path, version: 'unexpected' } },
    })

    await expect(controller.open('workspace', 'large.txt', 'large.txt')).resolves.toBe(true)
    const tab = store.activeTab()!
    expect(tab).toMatchObject({ content: 'bounded preview', dirty: false })
    expect(tab.baselineContent).toBeUndefined()
    expect(tab.readOnlyPresentation?.reason).toBe('too-large')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'attempted edit')
    store.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
      ? { ...candidate, dirty: true }
      : candidate))
    await expect(controller.save('workspace', tab.path)).resolves.toBe('not-needed')
    expect(store.activeTab()?.content).toBe('bounded preview')
    expect(writes).toBe(0)
  })

  it('keeps a save acknowledgement scoped to the submitted payload while typing continues', async () => {
    const write = deferred<{ path: string; version: string }>()
    const files: DocumentFilePort = {
      read: async (_workspace, path) => ({ path, content: 'base\n', version: 'v1' }),
      write: async () => await write.promise,
    }
    const store = ready()
    const controller = new DocumentController(store, files)
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const saving = controller.save('workspace', tab.path)
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'continued\n')
    write.resolve({ path: tab.path, version: 'v2' })

    await expect(saving).resolves.toBe('saved')
    expect(store.activeTab()).toMatchObject({ content: 'continued\n', baselineContent: 'submitted\n', dirty: true, version: 'v2' })
  })

  it('turns a lost write response into a known success only after reading matching disk bytes', async () => {
    let reads = 0
    const store = ready()
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const controller = new DocumentController(store, {
      write: async () => { throw new TypeError('connection reset') },
      read: async (_workspace, path) => {
        reads += 1
        return { path, content: 'submitted\n', version: 'v2' }
      },
    })

    await expect(controller.save('workspace', tab.path)).resolves.toBe('saved')
    expect(reads).toBe(1)
    expect(store.activeTab()).toMatchObject({ dirty: false, version: 'v2' })
  })

  it('reconciles a lost response against submitted bytes while later typing stays dirty', async () => {
    let diskReadable = false
    const store = ready()
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted A\n')
    const controller = new DocumentController(store, {
      write: async () => { throw new TypeError('connection reset') },
      read: async (_workspace, path) => {
        if (!diskReadable) throw new TypeError('still disconnected')
        return { path, content: 'submitted A\n', version: 'v2' }
      },
    })

    await expect(controller.save('workspace', tab.path)).resolves.toBe('unknown')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'continued B\n')
    diskReadable = true
    await controller.reconcileUnknownSave('workspace', tab.path, tab.lifecycleId)
    expect(store.activeTab()).toMatchObject({
      content: 'continued B\n', baselineContent: 'submitted A\n', version: 'v2', dirty: true,
    })
    expect(store.activeTab()?.saveOutcome).toBeUndefined()
  })

  it('preserves a dirty buffer on a 409 and does not issue an unsafe reconciliation read', async () => {
    let reads = 0
    const store = ready()
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'local\n')
    const controller = new DocumentController(store, {
      write: async () => { throw new ApiError({ code: 'VERSION_CONFLICT', message: 'changed' }, 409) },
      read: async (_workspace, path) => { reads += 1; return { path, content: 'disk\n', version: 'v2' } },
    })

    await expect(controller.save('workspace', tab.path)).resolves.toBe('conflict')
    expect(reads).toBe(0)
    expect(store.activeTab()).toMatchObject({ content: 'local\n', dirty: true, version: 'v1', externalState: 'modified' })
  })

  it('uses authoritative reads for clean invalidations but never reloads dirty documents', async () => {
    const store = ready()
    let reads = 0
    const controller = new DocumentController(store, {
      read: async (_workspace, path) => { reads += 1; return { path, content: 'external\n', version: 'v2' } },
      write: async () => ({ path: 'a.ts', version: 'unused' }),
    })
    const invalidation = (): WorkspaceInvalidation => ({
      target: { kind: 'file', path: 'a.ts', knownVersion: 'v1' },
      current: { kind: 'file', path: 'a.ts', state: 'present', version: 'v2', size: 9 },
      reason: 'changed',
    })
    await controller.reconcileFileInvalidations('workspace', [invalidation()])
    expect(store.activeTab()).toMatchObject({ content: 'external\n', version: 'v2', dirty: false, historyEpoch: 1 })
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'local\n')
    await controller.reconcileFileInvalidations('workspace', [{
      ...invalidation(),
      target: { kind: 'file', path: 'a.ts', knownVersion: 'v2' },
      current: { kind: 'file', path: 'a.ts', state: 'present', version: 'v3', size: 9 },
    }])
    expect(reads).toBe(1)
    expect(store.activeTab()).toMatchObject({ content: 'local\n', dirty: true, externalState: 'modified' })
  })

  it('reverts one exact active dirty editor from an authoritative disk read', async () => {
    const store = ready()
    const before = store.activeTab()!
    store.editDocument('workspace', before.path, before.lifecycleId, 'local\n')
    store.updateWorkspaceTabs('workspace', tabs => tabs.map(tab => tab.path === before.path
      ? { ...tab, externalState: 'modified' as const, saveError: 'old failure' }
      : tab))
    const controller = new DocumentController(store, {
      read: async (_workspace, path) => ({ path, content: 'disk\n', version: 'v2' }),
      write: async () => ({ path: before.path, version: 'unused' }),
    })
    const snapshot = store.getSnapshot()

    await expect(controller.revert({
      workspaceId: 'workspace', workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: before.path, lifecycleId: before.lifecycleId,
    })).resolves.toBe('reverted')

    expect(store.activeTab()).toMatchObject({
      content: 'disk\n', baselineContent: 'disk\n', version: 'v2', dirty: false,
      lifecycleId: before.lifecycleId, historyEpoch: before.historyEpoch + 1,
    })
    expect(store.activeTab()?.externalState).toBeUndefined()
    expect(store.activeTab()?.saveError).toBeUndefined()
    expect(store.activeTab()?.pendingReloadId).toBeUndefined()
  })

  it('preserves local bytes when a revert read fails or an edit supersedes it', async () => {
    const store = ready()
    const before = store.activeTab()!
    store.editDocument('workspace', before.path, before.lifecycleId, 'local one\n')
    const read = deferred<{ path: string; content: string; version: string }>()
    const controller = new DocumentController(store, {
      read: async () => await read.promise,
      write: async () => ({ path: before.path, version: 'unused' }),
    })
    const identity = {
      workspaceId: 'workspace', workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: before.path, lifecycleId: before.lifecycleId,
    }
    const reverting = controller.revert(identity)
    store.editDocument('workspace', before.path, before.lifecycleId, 'local two\n')
    read.resolve({ path: before.path, content: 'disk\n', version: 'v2' })

    await expect(reverting).resolves.toBe('stale')
    expect(store.activeTab()).toMatchObject({ content: 'local two\n', dirty: true, version: 'v1' })
    expect(store.activeTab()?.pendingReloadId).toBeUndefined()

    await expect(new DocumentController(store, {
      read: async () => { throw new Error('offline') },
      write: async () => ({ path: before.path, version: 'unused' }),
    }).revert({ ...identity, workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch })).resolves.toBe('failed')
    expect(store.activeTab()).toMatchObject({ content: 'local two\n', dirty: true, loadError: 'offline' })
    expect(store.activeTab()?.pendingReloadId).toBeUndefined()
  })
})
