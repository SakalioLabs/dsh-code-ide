import { describe, expect, it, vi } from 'vitest'
import {
  DocumentSessionStore,
  MAX_RESOURCE_FENCES,
  type DocumentIdentity,
} from '../../src/client/documents/session.ts'

function open(store: DocumentSessionStore, workspaceId: string, path = 'src/index.ts', content = 'base\n', version = 'v1') {
  if (store.getSnapshot().activeWorkspaceId !== workspaceId) store.selectWorkspace(workspaceId)
  const intent = store.beginOpen(workspaceId, path, path.split('/').at(-1) ?? path)
  expect(intent).toBeDefined()
  expect(store.completeOpen(intent!, { path, content, version })).toBe(true)
  return store.session(workspaceId).tabs.find(tab => tab.path === path)!
}

describe('DocumentSessionStore', () => {
  it('reuses one frozen empty session projection for absent workspaces', () => {
    const store = new DocumentSessionStore()
    const empty = store.session(undefined)

    expect(store.session(undefined)).toBe(empty)
    expect(store.session('missing')).toBe(empty)
    expect(Object.isFrozen(empty)).toBe(true)
    expect(Object.isFrozen(empty.tabs)).toBe(true)
  })

  it('keeps independent desired sessions when switching workspaces', () => {
    const store = new DocumentSessionStore()
    const first = open(store, 'workspace-1')
    store.editDocument('workspace-1', first.path, first.lifecycleId, 'dirty one\n')
    open(store, 'workspace-2', 'src/index.ts', 'other workspace\n')

    store.selectWorkspace('workspace-1')
    expect(store.activeTab()).toMatchObject({ content: 'dirty one\n', dirty: true })
    store.selectWorkspace('workspace-2')
    expect(store.activeTab()).toMatchObject({ content: 'other workspace\n', dirty: false })
  })

  it('rejects an open completion after a W1 -> W2 -> W1 ABA switch', () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace-1')
    const intent = store.beginOpen('workspace-1', 'late.ts', 'late.ts')!
    store.selectWorkspace('workspace-2')
    store.selectWorkspace('workspace-1')

    expect(store.completeOpen(intent, { path: 'late.ts', content: 'stale', version: 'v1' })).toBe(false)
    expect(store.session('workspace-1').tabs).toHaveLength(0)
  })

  it('bounds resource fences while preserving path-specific stale completion checks', () => {
    const workspaceId = 'workspace'
    const store = new DocumentSessionStore()
    store.selectWorkspace(workspaceId)
    const workspaceEpoch = store.getSnapshot().activeWorkspaceEpoch

    const unrelated = store.beginOpen(workspaceId, 'pending.ts', 'pending.ts')!
    expect(store.commitDeleteMutation(
      workspaceId, workspaceEpoch, 'other.ts', 'file', 'other-v1',
    ).applied).toBe(true)
    expect(store.completeOpen(unrelated, {
      path: unrelated.path, content: 'current\n', version: 'pending-v1',
    })).toBe(true)

    const samePath = store.beginOpen(workspaceId, 'same.ts', 'same.ts')!
    expect(store.commitDeleteMutation(
      workspaceId, workspaceEpoch, samePath.path, 'file', 'same-v1',
    ).applied).toBe(true)
    expect(store.completeOpen(samePath, {
      path: samePath.path, content: 'stale\n', version: 'same-v1',
    })).toBe(false)

    const descendant = store.beginOpen(workspaceId, 'src/late.ts', 'late.ts')!
    expect(store.commitDeleteMutation(
      workspaceId, workspaceEpoch, 'src', 'directory', 'src-v1',
    ).applied).toBe(true)
    expect(store.completeOpen(descendant, {
      path: descendant.path, content: 'stale\n', version: 'late-v1',
    })).toBe(false)

    const bounded = new DocumentSessionStore()
    bounded.selectWorkspace(workspaceId)
    const boundedEpoch = bounded.getSnapshot().activeWorkspaceEpoch
    const beforeEviction = bounded.beginOpen(workspaceId, 'survivor.ts', 'survivor.ts')!
    for (let index = 0; index <= MAX_RESOURCE_FENCES; index += 1) {
      expect(bounded.commitDeleteMutation(
        workspaceId, boundedEpoch, `churn/${String(index)}.ts`, 'file', `v${String(index)}`,
      ).applied).toBe(true)
    }
    expect(bounded.resourceFenceUsage()).toMatchObject({
      retained: MAX_RESOURCE_FENCES,
      limit: MAX_RESOURCE_FENCES,
      current: MAX_RESOURCE_FENCES + 1,
      floor: 1,
    })
    expect(bounded.completeOpen(beforeEviction, {
      path: beforeEviction.path, content: 'too old\n', version: 'old-v1',
    })).toBe(false)

    const fresh = bounded.beginOpen(workspaceId, 'fresh.ts', 'fresh.ts')!
    expect(fresh.resourceGeneration).toBe(bounded.resourceFenceUsage().current)
    expect(bounded.completeOpen(fresh, {
      path: fresh.path, content: 'fresh\n', version: 'fresh-v1',
    })).toBe(true)
    expect(bounded.resourceFenceUsage().retained).toBe(MAX_RESOURCE_FENCES)
  })

  it('rejects an old reload after close and reopening the same path', () => {
    const store = new DocumentSessionStore()
    const original = open(store, 'workspace')
    const reload = store.beginReload('workspace', original.path, original.version)!
    store.closeDocument('workspace', original.path)
    const reopened = open(store, 'workspace', original.path, 'new lifecycle\n', 'v2')

    expect(store.completeReload(reload, { content: 'late old read\n', version: 'v-old' })).toBe(false)
    expect(store.activeTab()).toBe(reopened)
  })

  it('commits the sent save baseline while preserving edits typed during the request', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'sent payload\n')
    const save = store.beginSave('workspace', tab.path)!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'typing continued\n')

    expect(store.completeSave(save, 'v2')).toBe(true)
    expect(store.activeTab()).toMatchObject({
      content: 'typing continued\n',
      baselineContent: 'sent payload\n',
      version: 'v2',
      dirty: true,
    })
  })

  it('does not let a clean reload overwrite a buffer dirtied while the read is in flight', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    const reload = store.beginReload('workspace', tab.path, tab.version)!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'local typing\n')

    expect(store.completeReload(reload, { content: 'external\n', version: 'v2' })).toBe(false)
    expect(store.activeTab()).toMatchObject({ content: 'local typing\n', dirty: true })
  })

  it('reconciles an unknown save only from an authoritative disk read', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const save = store.beginSave('workspace', tab.path)!
    store.failSave(save, 'response lost', 'unknown')

    expect(store.beginSave('workspace', tab.path)).toBeUndefined()
    expect(store.reconcileSaveOutcome('workspace', tab.path, tab.lifecycleId, {
      content: 'submitted\n', version: 'v2',
    })).toBe('committed')
    expect(store.activeTab()).toMatchObject({ content: 'submitted\n', baselineContent: 'submitted\n', dirty: false, version: 'v2' })
  })

  it('adopts the submitted payload as baseline when an unknown save committed before more typing', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted A\n')
    const save = store.beginSave('workspace', tab.path)!
    store.failSave(save, 'response lost', 'unknown')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'continued B\n')

    expect(store.reconcileSaveOutcome('workspace', tab.path, tab.lifecycleId, {
      content: 'submitted A\n', version: 'v2',
    })).toBe('committed')
    expect(store.activeTab()).toMatchObject({
      content: 'continued B\n', baselineContent: 'submitted A\n', version: 'v2', dirty: true,
    })
    expect(store.activeTab()?.saveOutcome).toBeUndefined()
    expect(store.beginSave('workspace', tab.path)?.expectedVersion).toBe('v2')
  })

  it('turns a checked third disk state into a retryable explicit conflict', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const save = store.beginSave('workspace', tab.path)!
    store.failSave(save, 'response lost', 'unknown')

    expect(store.reconcileSaveOutcome('workspace', tab.path, tab.lifecycleId, {
      content: 'third party\n', version: 'v3',
    })).toBe('conflict')
    expect(store.activeTab()).toMatchObject({ content: 'submitted\n', dirty: true, externalState: 'modified' })
    expect(store.activeTab()?.saveOutcome).toBeUndefined()
    expect(store.beginSave('workspace', tab.path)).toBeDefined()
  })

  it('refuses to close while a Host write is in flight or its outcome is unknown', () => {
    const store = new DocumentSessionStore()
    const tab = open(store, 'workspace')
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const save = store.beginSave('workspace', tab.path)!
    expect(store.closeDocument('workspace', tab.path)).toBeUndefined()
    expect(store.activeTab()?.pendingSaveId).toBe(save.requestId)

    store.failSave(save, 'response lost', 'unknown')
    expect(store.closeDocument('workspace', tab.path)).toBeUndefined()
    expect(store.activeTab()?.saveOutcome).toBe('unknown')
  })

  it('inspects and closes only the exact active workspace epoch and document lifecycle', () => {
    const store = new DocumentSessionStore()
    const original = open(store, 'workspace')
    const identity: DocumentIdentity = {
      workspaceId: 'workspace',
      workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: original.path,
      lifecycleId: original.lifecycleId,
    }

    expect(store.inspect(identity)).toBe(original)
    expect(store.inspect({ ...identity, workspaceEpoch: identity.workspaceEpoch + 1 })).toBeUndefined()
    expect(store.inspect({ ...identity, lifecycleId: identity.lifecycleId + 1 })).toBeUndefined()

    store.selectWorkspace('other')
    store.selectWorkspace('workspace')
    expect(store.inspect(identity)).toBeUndefined()
    expect(store.closeIfCurrent(identity)).toBeUndefined()
    expect(store.session('workspace').tabs).toContain(original)

    const current = { ...identity, workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch }
    expect(store.closeIfCurrent(current)).toBe(original)
    expect(store.inspect(current)).toBeUndefined()
  })

  it('fences exact close while reload, save, conflict, unknown outcome, or a path mutation lease is active', () => {
    const identity = (store: DocumentSessionStore, lifecycleId: number): DocumentIdentity => ({
      workspaceId: 'workspace',
      workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: 'src/index.ts',
      lifecycleId,
    })

    const reloading = new DocumentSessionStore()
    const reloadTab = open(reloading, 'workspace')
    expect(reloading.beginReload('workspace', reloadTab.path, reloadTab.version)).toBeDefined()
    expect(reloading.closeIfCurrent(identity(reloading, reloadTab.lifecycleId))).toBeUndefined()

    const saving = new DocumentSessionStore()
    const saveTab = open(saving, 'workspace')
    saving.editDocument('workspace', saveTab.path, saveTab.lifecycleId, 'dirty\n')
    const save = saving.beginSave('workspace', saveTab.path)!
    expect(saving.closeIfCurrent(identity(saving, saveTab.lifecycleId))).toBeUndefined()
    saving.failSave(save, 'lost', 'unknown')
    expect(saving.closeIfCurrent(identity(saving, saveTab.lifecycleId))).toBeUndefined()

    const conflicting = new DocumentSessionStore()
    const conflictTab = open(conflicting, 'workspace')
    conflicting.updateWorkspaceTabs('workspace', tabs => tabs.map(tab => tab === conflictTab
      ? { ...tab, externalState: 'modified' as const }
      : tab))
    const conflict = conflicting.beginConflictCompare(identity(conflicting, conflictTab.lifecycleId))!
    expect(conflict).toMatchObject({
      workspaceEpoch: conflicting.getSnapshot().activeWorkspaceEpoch,
      lifecycleId: conflictTab.lifecycleId,
      localRevision: conflictTab.localRevision,
      baseVersion: conflictTab.version,
      local: conflictTab.content,
      base: conflictTab.baselineContent,
    })
    expect(conflicting.closeIfCurrent(identity(conflicting, conflictTab.lifecycleId))).toBeUndefined()
    expect(conflicting.beginReload('workspace', conflictTab.path, conflictTab.version)).toBeUndefined()
    expect(conflicting.inspectRenameMutation(
      'workspace', conflictTab.path, 'src/renamed.ts', 'file', conflictTab.version,
    ).blockers).toContainEqual({ code: 'pending-conflict', path: conflictTab.path })
    expect(conflicting.restoreMutationLease('late-operation', 'workspace', [conflictTab.path])).toBe(false)
    expect(conflicting.cancelConflict(conflict)).toBe(true)

    const leased = new DocumentSessionStore()
    const leasedTab = open(leased, 'workspace')
    expect(leased.restoreMutationLease('operation', 'workspace', [leasedTab.path])).toBe(true)
    expect(leased.closeIfCurrent(identity(leased, leasedTab.lifecycleId))).toBeUndefined()
  })

  it('removes only the exact lifecycle if restored state contains a duplicate path', () => {
    const store = new DocumentSessionStore()
    store.restoreWorkspace('workspace', [
      { path: 'same.ts', name: 'same.ts', content: 'first\n', version: 'v1', dirty: false },
      { path: 'same.ts', name: 'same.ts', content: 'second\n', version: 'v2', dirty: false },
    ], 'same.ts')
    store.selectWorkspace('workspace')
    const [first, second] = store.session('workspace').tabs
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    const identity: DocumentIdentity = {
      workspaceId: 'workspace',
      workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: 'same.ts',
      lifecycleId: first!.lifecycleId,
    }

    expect(store.closeIfCurrent(identity)).toBe(first)
    expect(store.session('workspace').tabs).toEqual([second])
    expect(store.session('workspace').activePath).toBe('same.ts')
  })

  it('publishes stable snapshots through the framework-neutral subscription port', () => {
    const store = new DocumentSessionStore()
    const listener = vi.fn()
    const dispose = store.subscribe(listener)
    store.selectWorkspace('workspace')
    dispose()
    store.selectWorkspace('other')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('isolates snapshot observers so they cannot interrupt an exact close commit', () => {
    const store = new DocumentSessionStore()
    const throwing = vi.fn(() => { throw new Error('observer failed') })
    const observing = vi.fn()
    store.subscribe(throwing)
    store.subscribe(observing)
    const tab = open(store, 'workspace')
    const identity: DocumentIdentity = {
      workspaceId: 'workspace',
      workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    }
    const beforeClose = observing.mock.calls.length

    expect(store.closeIfCurrent(identity)).toBe(tab)
    expect(observing).toHaveBeenCalledTimes(beforeClose + 1)
    expect(store.inspect(identity)).toBeUndefined()
  })
})
