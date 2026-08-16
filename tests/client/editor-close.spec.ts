import { describe, expect, it, vi } from 'vitest'
import {
  EditorCloseController,
  EditorCloseStore,
  type EditorCloseOutcome,
  type EditorCloseSavePort,
} from '../../src/client/editor/close.ts'
import { EditorCloseBatchCoordinator } from '../../src/client/editor/close-batch.ts'
import {
  DocumentSessionStore,
  type DocumentIdentity,
  type EditorTab,
} from '../../src/client/documents/session.ts'

function open(
  documents: DocumentSessionStore,
  path = 'src/index.ts',
  content = 'base\n',
  version = 'v1',
): EditorTab {
  documents.selectWorkspace('workspace')
  const intent = documents.beginOpen('workspace', path, path.split('/').at(-1) ?? path)!
  expect(documents.completeOpen(intent, { path, content, version })).toBe(true)
  return documents.activeTab()!
}

function exact(documents: DocumentSessionStore, tab: EditorTab): DocumentIdentity {
  return {
    workspaceId: 'workspace',
    workspaceEpoch: documents.getSnapshot().activeWorkspaceEpoch,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function savingThrough(documents: DocumentSessionStore, gate?: Promise<void>): EditorCloseSavePort {
  return {
    save: vi.fn(async (workspaceId, path) => {
      const intent = documents.beginSave(workspaceId, path)
      if (intent === undefined) return 'not-needed'
      await gate
      return documents.completeSave(intent, 'v2') ? 'saved' : 'stale'
    }),
    recreateDeleted: vi.fn(async (workspaceId, path) => {
      const intent = documents.beginRecreateDeleted(workspaceId, path)
      if (intent === undefined) return 'not-needed'
      await gate
      return documents.completeRecreateDeleted(intent, 'v-created') ? 'saved' : 'stale'
    }),
  }
}

function fixture(options: { dirty?: boolean; deleted?: boolean; gate?: Promise<void> } = {}) {
  const documents = new DocumentSessionStore()
  const tab = open(documents)
  if (options.dirty === true) documents.editDocument('workspace', tab.path, tab.lifecycleId, 'local\n')
  if (options.deleted === true) {
    documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate.path === tab.path
      ? { ...candidate, externalState: 'deleted' as const }
      : candidate))
  }
  const store = new EditorCloseStore()
  const saves = savingThrough(documents, options.gate)
  const retirement = { deleteDocument: vi.fn() }
  const controller = new EditorCloseController(store, documents, saves, retirement)
  const identity = exact(documents, tab)
  expect(controller.selectWorkspace(identity.workspaceId, identity.workspaceEpoch)).toBe(true)
  return { documents, tab, identity, store, saves, retirement, controller }
}

describe('EditorCloseController', () => {
  it('closes a clean exact identity immediately and retires its editor lifecycle exactly once', () => {
    const current = fixture()

    expect(current.controller.requestClose(current.identity, 'tab')).toEqual({
      status: 'closed', disposition: 'clean',
    })
    expect(current.documents.inspect(current.identity)).toBeUndefined()
    expect(current.retirement.deleteDocument).toHaveBeenCalledOnce()
    expect(current.retirement.deleteDocument).toHaveBeenCalledWith({
      workspaceId: current.identity.workspaceId,
      path: current.identity.path,
      lifecycleId: current.identity.lifecycleId,
    })
    expect(current.controller.requestClose(current.identity, 'tab')).toEqual({ status: 'stale' })
    expect(current.retirement.deleteDocument).toHaveBeenCalledOnce()
  })

  it('presents dirty Save, Discard, and Cancel decisions with an acknowledged focus request', () => {
    const current = fixture({ dirty: true })

    expect(current.controller.requestClose(current.identity, 'editor')).toEqual({ status: 'confirming' })
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'confirming',
      identity: current.identity,
      name: 'index.ts',
      deleted: false,
      origin: 'editor',
      presentationRequest: { target: 'cancel' },
    })
    const request = current.store.getSnapshot().presentationRequest!
    expect(current.controller.acknowledgePresentation(request.requestId)).toBe(true)
    expect(current.store.getSnapshot()).not.toHaveProperty('presentationRequest')
    expect(current.controller.cancel()).toBe(true)
    expect(current.store.getSnapshot()).toMatchObject({ phase: 'idle' })
    expect(current.documents.inspect(current.identity)).toBeDefined()

    expect(current.controller.requestClose(current.identity, 'tab')).toEqual({ status: 'confirming' })
    expect(current.controller.discard()).toEqual({ status: 'closed', disposition: 'discarded' })
    expect(current.documents.inspect(current.identity)).toBeUndefined()
    expect(current.retirement.deleteDocument).toHaveBeenCalledOnce()
  })

  it('saves ordinary dirty documents, recreates deleted dirty documents, then closes only clean identities', async () => {
    const ordinary = fixture({ dirty: true })
    ordinary.controller.requestClose(ordinary.identity, 'tab')
    await expect(ordinary.controller.save()).resolves.toEqual({ status: 'closed', disposition: 'saved' })
    expect(ordinary.saves.save).toHaveBeenCalledWith('workspace', ordinary.tab.path)
    expect(ordinary.saves.recreateDeleted).not.toHaveBeenCalled()
    expect(ordinary.retirement.deleteDocument).toHaveBeenCalledOnce()

    const deleted = fixture({ dirty: true, deleted: true })
    deleted.controller.requestClose(deleted.identity, 'tab')
    expect(deleted.store.getSnapshot()).toMatchObject({ phase: 'confirming', deleted: true })
    await expect(deleted.controller.save()).resolves.toEqual({ status: 'closed', disposition: 'saved' })
    expect(deleted.saves.recreateDeleted).toHaveBeenCalledWith('workspace', deleted.tab.path)
    expect(deleted.saves.save).not.toHaveBeenCalled()
  })

  it('keeps a document open when more edits make it dirty during the save', async () => {
    const gate = deferred()
    const current = fixture({ dirty: true, gate: gate.promise })
    current.controller.requestClose(current.identity, 'tab')
    const saving = current.controller.save()
    expect(current.store.getSnapshot()).toMatchObject({ phase: 'saving' })
    current.documents.editDocument('workspace', current.tab.path, current.tab.lifecycleId, 'continued\n')
    gate.resolve()

    await expect(saving).resolves.toMatchObject({
      status: 'failed', error: { code: 'DOCUMENT_STILL_DIRTY' },
    })
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'error', actions: 'decide', error: { code: 'DOCUMENT_STILL_DIRTY' },
      presentationRequest: { target: 'cancel' },
    })
    expect(current.documents.inspect(current.identity)).toMatchObject({ dirty: true, content: 'continued\n' })
    expect(current.retirement.deleteDocument).not.toHaveBeenCalled()
  })

  it('revalidates exact identity and blockers before admitting a requested save', async () => {
    const stale = fixture({ dirty: true })
    stale.controller.requestClose(stale.identity, 'tab')
    stale.documents.restoreWorkspace('workspace', [{
      path: stale.identity.path,
      name: stale.tab.name,
      content: 'replacement must not be saved\n',
      version: 'v8',
      dirty: true,
      baselineContent: 'disk replacement\n',
    }], stale.identity.path)

    await expect(stale.controller.save()).resolves.toEqual({ status: 'stale' })
    expect(stale.saves.save).not.toHaveBeenCalled()
    expect(stale.saves.recreateDeleted).not.toHaveBeenCalled()
    expect(stale.documents.activeTab()).toMatchObject({ content: 'replacement must not be saved\n', dirty: true })

    const leased = fixture({ dirty: true })
    leased.controller.requestClose(leased.identity, 'tab')
    expect(leased.documents.restoreMutationLease('operation', 'workspace', [leased.identity.path])).toBe(true)
    await expect(leased.controller.save()).resolves.toMatchObject({
      status: 'blocked', error: { code: 'MUTATION_LEASE' },
    })
    expect(leased.saves.save).not.toHaveBeenCalled()
    expect(leased.store.getSnapshot()).toMatchObject({ phase: 'error', actions: 'dismiss' })
  })

  it('fails closed when the save port throws or reports an unclassified commit outcome', async () => {
    for (const save of [
      vi.fn(async () => { throw new Error('transport vanished') }),
      vi.fn(async () => 'unknown' as const),
      vi.fn(async () => 'stale' as const),
    ]) {
      const current = fixture({ dirty: true })
      const retirement = { deleteDocument: vi.fn() }
      const controller = new EditorCloseController(current.store, current.documents, {
        save,
        recreateDeleted: vi.fn(async () => 'unknown'),
      }, retirement)
      expect(controller.selectWorkspace('workspace', current.identity.workspaceEpoch)).toBe(true)
      expect(controller.requestClose(current.identity, 'tab')).toEqual({ status: 'confirming' })

      await expect(controller.save()).resolves.toMatchObject({
        status: 'failed', error: { code: expect.stringMatching(/^SAVE_(?:UNKNOWN|STALE)$/u) },
      })
      expect(current.store.getSnapshot()).toMatchObject({
        phase: 'error', actions: 'dismiss', presentationRequest: { target: 'dismiss' },
      })
      expect(current.documents.inspect(current.identity)).toMatchObject({ dirty: true })
      expect(retirement.deleteDocument).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['pending save', (documents: DocumentSessionStore, tab: EditorTab) => {
      documents.editDocument('workspace', tab.path, tab.lifecycleId, 'dirty\n')
      documents.beginSave('workspace', tab.path)
    }, 'PENDING_SAVE'],
    ['pending reload', (documents: DocumentSessionStore, tab: EditorTab) => {
      documents.beginReload('workspace', tab.path, tab.version)
    }, 'PENDING_RELOAD'],
    ['unknown save', (documents: DocumentSessionStore, tab: EditorTab) => {
      documents.editDocument('workspace', tab.path, tab.lifecycleId, 'dirty\n')
      const intent = documents.beginSave('workspace', tab.path)!
      documents.failSave(intent, 'lost', 'unknown')
    }, 'UNKNOWN_SAVE'],
    ['pending conflict', (documents: DocumentSessionStore, tab: EditorTab) => {
      documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
        ? { ...candidate, externalState: 'modified' as const }
        : candidate))
      documents.beginConflictCompare(exact(documents, tab))
    }, 'PENDING_CONFLICT'],
    ['mutation lease', (documents: DocumentSessionStore, tab: EditorTab) => {
      documents.restoreMutationLease('operation', 'workspace', [tab.path])
    }, 'MUTATION_LEASE'],
  ] as const)('blocks close for %s without retiring the lifecycle', (_label, arrange, code) => {
    const current = fixture()
    arrange(current.documents, current.tab)

    expect(current.controller.requestClose(current.identity, 'tab')).toMatchObject({
      status: 'blocked', error: { code },
    })
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'error', actions: 'dismiss', error: { code },
      presentationRequest: { target: 'dismiss' },
    })
    expect(current.documents.inspect(current.identity)).toBeDefined()
    expect(current.retirement.deleteDocument).not.toHaveBeenCalled()
  })

  it('fences an in-flight save across workspace switches and lifecycle replacement', async () => {
    const gate = deferred()
    const current = fixture({ dirty: true, gate: gate.promise })
    current.controller.requestClose(current.identity, 'tab')
    const saving = current.controller.save()

    current.documents.selectWorkspace('other')
    expect(current.controller.selectWorkspace(
      'other', current.documents.getSnapshot().activeWorkspaceEpoch,
    )).toBe(true)
    gate.resolve()

    await expect(saving).resolves.toEqual({ status: 'stale' })
    expect(current.store.getSnapshot()).toMatchObject({ phase: 'idle', workspaceId: 'other' })
    expect(current.documents.session('workspace').tabs).toHaveLength(1)
    expect(current.retirement.deleteDocument).not.toHaveBeenCalled()

    current.documents.selectWorkspace('workspace')
    current.documents.restoreWorkspace('workspace', [{
      path: current.identity.path,
      name: current.tab.name,
      content: 'replacement\n',
      version: 'v9',
      dirty: false,
    }], current.identity.path)
    expect(current.documents.inspect({
      ...current.identity,
      workspaceEpoch: current.documents.getSnapshot().activeWorkspaceEpoch,
    })).toBeUndefined()

    const lifecycleGate = deferred()
    const lifecycle = fixture({ dirty: true, gate: lifecycleGate.promise })
    lifecycle.controller.requestClose(lifecycle.identity, 'tab')
    const lifecycleSave = lifecycle.controller.save()
    lifecycle.documents.restoreWorkspace('workspace', [{
      path: lifecycle.identity.path,
      name: lifecycle.tab.name,
      content: 'same path, new lifecycle\n',
      version: 'v10',
      dirty: false,
    }], lifecycle.identity.path)
    lifecycleGate.resolve()

    await expect(lifecycleSave).resolves.toEqual({ status: 'stale' })
    expect(lifecycle.documents.activeTab()).toMatchObject({
      path: lifecycle.identity.path,
      content: 'same path, new lifecycle\n',
      dirty: false,
    })
    expect(lifecycle.documents.activeTab()?.lifecycleId).not.toBe(lifecycle.identity.lifecycleId)
    expect(lifecycle.retirement.deleteDocument).not.toHaveBeenCalled()
  })

  it('fences completion after dispose and isolates retirement failures without retrying the port', async () => {
    const gate = deferred()
    const pending = fixture({ dirty: true, gate: gate.promise })
    pending.controller.requestClose(pending.identity, 'tab')
    const saving = pending.controller.save()
    pending.controller.dispose()
    gate.resolve()
    await expect(saving).resolves.toEqual({ status: 'stale' })
    expect(pending.documents.session('workspace').tabs).toHaveLength(1)
    expect(pending.retirement.deleteDocument).not.toHaveBeenCalled()

    const failed = fixture()
    failed.retirement.deleteDocument.mockImplementation(() => { throw new Error('cache unavailable') })
    expect(failed.controller.requestClose(failed.identity, 'tab')).toMatchObject({
      status: 'failed', error: { code: 'RETIREMENT_FAILED' },
    })
    expect(failed.store.getSnapshot()).toMatchObject({
      phase: 'error', actions: 'dismiss', error: { code: 'RETIREMENT_FAILED' },
    })
    expect(failed.controller.cancel()).toBe(true)
    expect(failed.controller.requestClose(failed.identity, 'tab')).toEqual({ status: 'stale' })
    expect(failed.retirement.deleteDocument).toHaveBeenCalledOnce()
  })
})

describe('EditorCloseStore', () => {
  it('owns immutable page presentation and isolates subscribers on cancellation and disposal', () => {
    const current = fixture({ dirty: true })
    const throwing = vi.fn(() => { throw new Error('observer') })
    const observing = vi.fn()
    current.store.subscribe(throwing)
    current.store.subscribe(observing)
    current.controller.requestClose(current.identity, 'tab')
    expect(observing).toHaveBeenCalledOnce()
    expect(current.controller.cancel()).toBe(true)
    expect(observing).toHaveBeenCalledTimes(2)
    current.controller.dispose()
    expect(current.controller.requestClose(current.identity, 'tab')).toEqual({ status: 'unavailable' })
  })
})

describe('EditorCloseBatchCoordinator', () => {
  it('freezes the starting queue, pauses for dirty confirmation, and resumes only after an exact close', () => {
    const selection = { activeWorkspaceId: 'workspace' as string | undefined, activeWorkspaceEpoch: 7 }
    const first = { workspaceId: 'workspace', workspaceEpoch: 7, path: 'first.ts', lifecycleId: 1 }
    const dirty = { workspaceId: 'workspace', workspaceEpoch: 7, path: 'dirty.ts', lifecycleId: 2 }
    const last = { workspaceId: 'workspace', workspaceEpoch: 7, path: 'last.ts', lifecycleId: 3 }
    const replacement = { ...dirty, lifecycleId: 20 }
    const outcomes = new Map<string, EditorCloseOutcome>([
      ['first.ts', { status: 'closed', disposition: 'clean' }],
      ['dirty.ts', { status: 'confirming' }],
      ['last.ts', { status: 'closed', disposition: 'clean' }],
    ])
    const requestClose = vi.fn((identity: DocumentIdentity) => outcomes.get(identity.path)!)
    const batch = new EditorCloseBatchCoordinator({ requestClose }, () => selection)
    const callerQueue = [first, dirty, last]

    const started = batch.start({ workspaceId: 'workspace', workspaceEpoch: 7 }, callerQueue)
    callerQueue.splice(0, callerQueue.length, replacement)
    expect(started).toEqual({ status: 'confirming', target: dirty, closed: [first] })
    expect(requestClose.mock.calls.map(([identity]) => identity)).toEqual([first, dirty])
    expect(batch.resume(replacement, { status: 'closed', disposition: 'discarded' })).toEqual({
      status: 'ignored', closed: [],
    })

    expect(batch.resume(dirty, { status: 'closed', disposition: 'discarded' })).toEqual({
      status: 'completed', closed: [dirty, last],
    })
    expect(requestClose.mock.calls.map(([identity]) => identity)).toEqual([first, dirty, last])
    expect(batch.isActive).toBe(false)
  })

  it('terminates the remaining frozen queue on cancellation, failure, or workspace ABA', () => {
    const selection = { activeWorkspaceId: 'workspace' as string | undefined, activeWorkspaceEpoch: 3 }
    const dirty = { workspaceId: 'workspace', workspaceEpoch: 3, path: 'dirty.ts', lifecycleId: 1 }
    const remaining = { workspaceId: 'workspace', workspaceEpoch: 3, path: 'remaining.ts', lifecycleId: 2 }
    const requestClose = vi.fn((): EditorCloseOutcome => ({ status: 'confirming' }))
    const batch = new EditorCloseBatchCoordinator({ requestClose }, () => selection)

    expect(batch.start({ workspaceId: 'workspace', workspaceEpoch: 3 }, [dirty, remaining]).status).toBe('confirming')
    expect(batch.cancel(dirty)).toEqual({ status: 'terminated', reason: 'cancelled', closed: [] })
    expect(requestClose).toHaveBeenCalledOnce()

    expect(batch.start({ workspaceId: 'workspace', workspaceEpoch: 3 }, [dirty, remaining]).status).toBe('confirming')
    expect(batch.resume(dirty, { status: 'failed', error: { code: 'SAVE_FAILED', message: 'failed' } })).toEqual({
      status: 'terminated', reason: 'failed', closed: [],
    })
    expect(requestClose).toHaveBeenCalledTimes(2)

    expect(batch.start({ workspaceId: 'workspace', workspaceEpoch: 3 }, [dirty, remaining]).status).toBe('confirming')
    selection.activeWorkspaceId = 'other'
    selection.activeWorkspaceEpoch = 4
    expect(batch.resume(dirty, { status: 'closed', disposition: 'saved' })).toEqual({
      status: 'terminated', reason: 'workspace-changed', closed: [dirty],
    })
    expect(requestClose).toHaveBeenCalledTimes(3)
    expect(batch.isActive).toBe(false)
  })
})
