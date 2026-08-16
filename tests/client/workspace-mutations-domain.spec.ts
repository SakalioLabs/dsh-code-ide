import { history, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'
import { DocumentController, type DocumentFilePort } from '../../src/client/documents/controller.ts'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import { EditorSessionRegistry } from '../../src/client/editor/session-registry.ts'
import { ExplorerStore } from '../../src/client/explorer/store.ts'
import {
  MUTATION_MANUAL_RECONCILIATION_REQUIRED,
  WorkspaceMutationController,
  type MutationApiPort,
  type MutationExplorerPort,
  type MutationRecoveryPort,
  type ProtocolMutationReceipt,
} from '../../src/client/mutations/controller.ts'
import { WorkspaceMutationStore } from '../../src/client/mutations/store.ts'

const PROVIDER_EPOCH = '11111111-1111-4111-8111-111111111111'
const OPERATION_ID = '22222222-2222-4222-8222-222222222222'

function open(
  store: DocumentSessionStore,
  workspaceId: string,
  path: string,
  content = 'base\n',
  version = 'v1',
) {
  if (store.getSnapshot().activeWorkspaceId !== workspaceId) store.selectWorkspace(workspaceId)
  const intent = store.beginOpen(workspaceId, path, path.split('/').at(-1) ?? path)
  expect(intent).toBeDefined()
  expect(store.completeOpen(intent!, { path, content, version })).toBe(true)
  return store.session(workspaceId).tabs.find(tab => tab.path === path)!
}

function provider() {
  return {
    providerEpoch: PROVIDER_EPOCH,
    capabilities: { createFile: true, createDirectory: true, rename: true, delete: true },
  }
}

function documentPort(
  store: DocumentSessionStore,
  read: DocumentFilePort['read'] = async (_workspaceId, path) => ({ path, content: '', version: 'v1' }),
): DocumentController {
  return new DocumentController(store, { read, write: vi.fn() })
}

function editorRegistry(store: DocumentSessionStore): EditorSessionRegistry {
  return new EditorSessionRegistry(identity => store.session(identity.workspaceId).tabs.some(tab => (
    tab.path === identity.path && tab.lifecycleId === identity.lifecycleId
  )))
}

function apiWith(
  mutate: MutationApiPort['mutate'],
  status: MutationApiPort['status'] = async () => ({
    providerEpoch: PROVIDER_EPOCH,
    operationId: OPERATION_ID,
    state: 'expired',
  }),
): MutationApiPort & { mutate: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  return {
    provider: vi.fn(async () => provider()),
    mutate: vi.fn(mutate),
    status: vi.fn(status),
  }
}

function committedRename(path = 'src/a.ts', destinationPath = 'src/b.ts'): ProtocolMutationReceipt {
  return {
    providerEpoch: PROVIDER_EPOCH,
    operationId: OPERATION_ID,
    state: 'committed',
    result: {
      kind: 'file', path, destinationPath, version: 'v2', refreshDirectories: ['src'],
    },
  }
}

describe('workspace mutation domain', () => {
  it('rejects every disabled provider capability before operation identity, recovery, or mutation admission', async () => {
    const scenarios: readonly {
      begin(controller: WorkspaceMutationController): boolean
      disabled: keyof ReturnType<typeof provider>['capabilities']
    }[] = [
      { disabled: 'createFile', begin: controller => controller.beginCreate('', 'file', 'a.ts') },
      { disabled: 'createDirectory', begin: controller => controller.beginCreate('', 'directory', 'folder') },
      {
        disabled: 'rename',
        begin: controller => controller.beginRename({ path: 'a.ts', type: 'file', version: 'v1' })
          && controller.updateName('b.ts'),
      },
      {
        disabled: 'delete',
        begin: controller => controller.beginDelete({ path: 'a.ts', type: 'file', version: 'v1' }),
      },
    ]

    for (const scenario of scenarios) {
      const mutate = vi.fn<MutationApiPort['mutate']>()
      const operationId = vi.fn(() => OPERATION_ID)
      const recovery = {
        prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
        notCommitted: vi.fn(), acknowledged: vi.fn(),
      }
      const capabilities = { ...provider().capabilities, [scenario.disabled]: false }
      const api: MutationApiPort = {
        provider: vi.fn(async () => ({ providerEpoch: PROVIDER_EPOCH, capabilities })),
        mutate,
        status: vi.fn(),
      }
      const store = new WorkspaceMutationStore()
      const controller = new WorkspaceMutationController(store, api, { operationId, recovery })
      controller.selectWorkspace('w', 1)
      expect(scenario.begin(controller)).toBe(true)
      if (store.getSnapshot().phase === 'editing') expect(controller.requestConfirmation()).toBe(true)

      expect(await controller.submit()).toBe('failed')
      expect(operationId).not.toHaveBeenCalled()
      expect(recovery.prepared).not.toHaveBeenCalled()
      expect(mutate).not.toHaveBeenCalled()
      expect(store.getSnapshot()).toMatchObject({ error: { code: 'UNSUPPORTED_MUTATION' } })
    }
  })

  it('treats a local mutation request validation error as definitely not admitted', async () => {
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const api = apiWith(async () => {
      throw Object.assign(new Error('workspaceId exceeds its wire budget'), { code: 'INVALID_MUTATION_REQUEST' })
    })
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      recovery, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('界'.repeat(100), 1)
    controller.beginCreate('', 'file', 'a.ts')
    controller.requestConfirmation()

    expect(await controller.submit()).toBe('failed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'editing', error: { code: 'INVALID_MUTATION_REQUEST' } })
    expect(recovery.prepared).toHaveBeenCalledOnce()
    expect(recovery.notCommitted).toHaveBeenCalledOnce()
    expect(recovery.unknown).not.toHaveBeenCalled()
  })

  it('allows dirty rename while retaining pending, reload, conflict, and unknown document blockers', async () => {
    const documents = new DocumentSessionStore()
    const dirty = open(documents, 'w', 'src/a.ts')
    documents.editDocument('w', dirty.path, dirty.lifecycleId, 'dirty\n')

    const api = apiWith(async () => committedRename())
    const mutationStore = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(mutationStore, api, {
      documents: documentPort(documents),
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    expect(controller.beginRename({ path: dirty.path, type: 'file', version: dirty.version })).toBe(true)
    controller.updateName('b.ts')
    controller.requestConfirmation()
    expect(mutationStore.getSnapshot()).toMatchObject({ phase: 'confirming', impact: { blockers: [] } })
    expect(controller.cancel()).toBe(true)
    expect(api.provider).not.toHaveBeenCalled()

    const save = documents.beginSave('w', dirty.path)!
    expect(documents.inspectRenameMutation('w', dirty.path, 'src/b.ts', 'file', dirty.version).blockers.map(value => value.code))
      .toContain('pending-save')
    documents.failSave(save, 'lost', 'unknown')
    expect(documents.inspectRenameMutation('w', dirty.path, 'src/b.ts', 'file', dirty.version).blockers.map(value => value.code))
      .toContain('unknown-save')

    const clean = open(documents, 'w', 'src/clean.ts')
    documents.beginReload('w', clean.path, clean.version)
    expect(documents.inspectRenameMutation('w', clean.path, 'src/clean-2.ts', 'file', clean.version).blockers.map(value => value.code))
      .toContain('pending-reload')

    const conflicts = new DocumentSessionStore()
    const conflict = open(conflicts, 'w', 'src/conflict.ts')
    conflicts.updateWorkspaceTabs('w', tabs => tabs.map(tab => tab === conflict
      ? { ...tab, externalState: 'modified' as const }
      : tab))
    expect(conflicts.beginConflictCompare({
      workspaceId: 'w',
      workspaceEpoch: conflicts.getSnapshot().activeWorkspaceEpoch,
      path: conflict.path,
      lifecycleId: conflict.lifecycleId,
    })).toBeDefined()
    const conflictApi = apiWith(async () => committedRename())
    const conflictStore = new WorkspaceMutationStore()
    const conflictController = new WorkspaceMutationController(conflictStore, conflictApi, {
      documents: documentPort(conflicts),
      operationId: () => OPERATION_ID,
    })
    conflictController.selectWorkspace('w', conflicts.getSnapshot().activeWorkspaceEpoch)
    expect(conflictController.beginRename({ path: conflict.path, type: 'file', version: conflict.version })).toBe(true)
    conflictController.updateName('conflict-2.ts')
    conflictController.requestConfirmation()
    expect(await conflictController.submit()).toBe('blocked')
    expect(conflictStore.getSnapshot()).toMatchObject({ phase: 'editing', error: { code: 'pending-conflict' } })
    expect(conflictApi.provider).not.toHaveBeenCalled()
  })

  it('blocks a file rename when Explorer source version is newer than the open clean document', async () => {
    const documents = new DocumentSessionStore()
    open(documents, 'w', 'src/a.ts', 'old bytes', 'v1')
    const api = apiWith(async () => committedRename())
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentPort(documents),
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    expect(controller.beginRename({ path: 'src/a.ts', type: 'file', version: 'v2' })).toBe(true)
    expect(controller.updateName('b.ts')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)

    expect(await controller.submit()).toBe('blocked')
    expect(store.getSnapshot()).toMatchObject({ phase: 'editing', error: { code: 'external-state' } })
    expect(api.provider).not.toHaveBeenCalled()
    expect(api.mutate).not.toHaveBeenCalled()
  })

  it('blocks file deletion when Explorer source version is newer than the open clean or dirty document', async () => {
    for (const dirty of [false, true]) {
      const documents = new DocumentSessionStore()
      const tab = open(documents, 'w', 'src/a.ts', 'old bytes', 'v1')
      if (dirty) documents.editDocument('w', tab.path, tab.lifecycleId, 'unsaved old bytes')
      const api = apiWith(async () => ({
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        state: 'committed',
        result: { kind: 'file', path: tab.path, recursive: false, refreshDirectories: ['src'] },
      }))
      const store = new WorkspaceMutationStore()
      const controller = new WorkspaceMutationController(store, api, {
        documents: documentPort(documents), operationId: () => OPERATION_ID,
      })
      controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
      expect(controller.beginDelete({ path: tab.path, type: 'file', version: 'v2' })).toBe(true)
      expect(await controller.submit()).toBe('blocked')
      expect(store.getSnapshot()).toMatchObject({ phase: 'confirming' })
      const state = store.getSnapshot()
      if (state.phase === 'confirming') {
        expect(state.impact.blockers.map(blocker => blocker.code)).toContain('external-state')
      }
      expect(api.provider).not.toHaveBeenCalled()
      expect(api.mutate).not.toHaveBeenCalled()
      expect(documents.session('w').tabs).toHaveLength(1)
    }
  })

  it('fences an in-flight read of a replaced path when create commits before that read returns', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('w')
    const staleOpen = documents.beginOpen('w', 'new.ts', 'new.ts')
    expect(staleOpen).toBeDefined()
    const api = apiWith(async (_input) => ({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'committed',
      result: { kind: 'file', path: 'new.ts', version: 'new-v1', refreshDirectories: [''] },
    }))
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentPort(documents),
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    expect(controller.beginCreate('', 'file', 'new.ts')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)
    expect(await controller.submit()).toBe('committed')

    expect(documents.completeOpen(staleOpen!, {
      path: 'new.ts', content: 'OLD BYTES', version: 'old-v',
    })).toBe(false)
    expect(documents.session('w').tabs).toHaveLength(0)
  })

  it('opens a committed created file through the exact mutation lease and then releases it', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('w')
    const files: DocumentFilePort = {
      read: vi.fn(async (_workspaceId, path) => ({ path, content: 'created bytes\n', version: 'v1' })),
      write: vi.fn(),
    }
    const documentController = new DocumentController(documents, files)
    const api = apiWith(async () => ({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'committed',
      result: { kind: 'file', path: 'new.ts', version: 'v1', refreshDirectories: [''] },
    }))
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentController,
      navigation: {
        openCreatedFile: async (operationId, workspaceId, _workspaceEpoch, path) =>
          documentController.openCommittedCreate(operationId, workspaceId, path, path),
      },
      recovery,
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    expect(controller.beginCreate('', 'file', 'new.ts')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)
    expect(await controller.submit()).toBe('committed')

    expect(store.getSnapshot()).toMatchObject({ phase: 'idle' })
    expect(documents.activeTab()).toMatchObject({ path: 'new.ts', content: 'created bytes\n', version: 'v1' })
    expect(documents.isPathMutationLeased('w', 'new.ts')).toBe(false)
    expect(recovery.applied).toHaveBeenCalledOnce()
  })

  it('rejects provider-wait ABA completions and refuses workspace switches once an operation is admitted', async () => {
    let resolveProvider!: (value: ReturnType<typeof provider>) => void
    const providerPromise = new Promise<ReturnType<typeof provider>>(resolve => { resolveProvider = resolve })
    const mutate = vi.fn<MutationApiPort['mutate']>(async () => ({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'notCommitted',
      error: { code: 'NO', message: 'no' },
    }))
    const api: MutationApiPort = { provider: vi.fn(() => providerPromise), mutate, status: vi.fn() }
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, { operationId: () => OPERATION_ID })
    controller.selectWorkspace('w1', 1)
    controller.beginCreate('', 'file', 'a.ts')
    controller.requestConfirmation()
    const submission = controller.submit()
    expect(controller.selectWorkspace('w2', 2)).toBe(true)
    expect(controller.selectWorkspace('w1', 3)).toBe(true)
    resolveProvider(provider())
    expect(await submission).toBe('stale')
    expect(mutate).not.toHaveBeenCalled()

    const admittedApi = apiWith(async () => new Promise(() => {}))
    const admittedStore = new WorkspaceMutationStore()
    const admitted = new WorkspaceMutationController(admittedStore, admittedApi, { operationId: () => OPERATION_ID })
    admitted.selectWorkspace('w1', 1)
    admitted.beginCreate('', 'file', 'a.ts')
    admitted.requestConfirmation()
    void admitted.submit()
    await vi.waitFor(() => expect(admittedStore.getSnapshot().phase).toBe('submitting'))
    expect(admitted.selectWorkspace('w2', 2)).toBe(false)
    expect(admittedStore.getSnapshot()).toMatchObject({ phase: 'submitting', workspaceId: 'w1', operationId: OPERATION_ID })
    admitted.dispose()
  })

  it('clears a cached provider epoch after a proven pre-admission mismatch and retries only on a new intent', async () => {
    const secondEpoch = '33333333-3333-4333-8333-333333333333'
    const operationIds = [
      '22222222-2222-4222-8222-222222222221',
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222223',
    ]
    const providerCall = vi.fn()
      .mockResolvedValueOnce(provider())
      .mockResolvedValueOnce({ ...provider(), providerEpoch: secondEpoch })
    let mutationCall = 0
    const mutate = vi.fn<MutationApiPort['mutate']>(async input => {
      mutationCall += 1
      if (mutationCall === 1) return {
        providerEpoch: input.providerEpoch,
        operationId: input.operationId,
        state: 'notCommitted',
        error: { code: 'DESTINATION_EXISTS', message: 'exists' },
      }
      if (mutationCall === 2) {
        throw Object.assign(new Error('provider restarted'), { code: 'PROVIDER_EPOCH_MISMATCH' })
      }
      return {
        providerEpoch: input.providerEpoch,
        operationId: input.operationId,
        state: 'committed',
        result: { kind: 'file', path: 'c.ts', version: 'v1', refreshDirectories: [''] },
      }
    })
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const api: MutationApiPort = { provider: providerCall, mutate, status: vi.fn() }
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      recovery,
      operationId: () => operationIds.shift()!,
    })
    controller.selectWorkspace('w', 1)

    for (const name of ['a.ts', 'b.ts']) {
      expect(controller.beginCreate('', 'file', name)).toBe(true)
      expect(controller.requestConfirmation()).toBe(true)
      expect(await controller.submit()).toBe('failed')
      expect(controller.cancel()).toBe(true)
    }
    expect(providerCall).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle' })

    expect(controller.beginCreate('', 'file', 'c.ts')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)
    expect(await controller.submit()).toBe('committed')
    expect(providerCall).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[2]?.[0]).toMatchObject({ providerEpoch: secondEpoch })
    expect(recovery.unknown).not.toHaveBeenCalled()
    expect(recovery.notCommitted).toHaveBeenCalledTimes(2)
  })

  it('treats a provider restart during status as terminal unknown without releasing the admitted lease', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'src/a.ts')
    const status = vi.fn<MutationApiPort['status']>(async () => {
      throw Object.assign(new Error('provider restarted'), { code: 'PROVIDER_EPOCH_MISMATCH' })
    })
    const api = apiWith(async () => { throw new Error('response lost') }, status)
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentPort(documents), recovery, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    controller.beginRename({ path: tab.path, type: 'file', version: tab.version })
    controller.updateName('b.ts')
    controller.requestConfirmation()

    expect(await controller.submit()).toBe('unknown')
    expect(await controller.acknowledgeUnresolvedOutcome()).toBe('stale')
    expect(await controller.reconcileUnknown()).toBe('unknown')
    expect(store.getSnapshot()).toMatchObject({
      phase: 'unknown', error: { code: MUTATION_MANUAL_RECONCILIATION_REQUIRED },
    })
    expect(await controller.reconcileUnknown()).toBe('unknown')
    expect(status).toHaveBeenCalledOnce()
    expect(recovery.notCommitted).not.toHaveBeenCalled()
    expect(recovery.committed).not.toHaveBeenCalled()
    documents.editDocument('w', tab.path, tab.lifecycleId, 'must remain fenced\n')
    expect(documents.activeTab()?.content).toBe('base\n')
  })

  it('keeps a lost-response lease and reconciles only through status without a blind retry', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'src/a.ts')
    const registry = editorRegistry(documents)
    const state = EditorState.create({ doc: tab.content, extensions: [history()] })
    registry.set({ workspaceId: 'w', path: tab.path, lifecycleId: tab.lifecycleId, historyEpoch: 0 }, {
      state, scrollTop: 10, scrollLeft: 2,
    })
    const api = apiWith(
      async () => { throw new Error('response lost') },
      async () => committedRename(),
    )
    const mutationStore = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(mutationStore, api, {
      documents: documentPort(documents, async (_workspaceId, path) => ({
        path, content: 'base\n', version: 'v2',
      })),
      editorSessions: registry,
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    controller.beginRename({ path: tab.path, type: 'file', version: tab.version })
    controller.updateName('b.ts')
    controller.requestConfirmation()
    expect(await controller.submit()).toBe('unknown')
    expect(mutationStore.getSnapshot()).toMatchObject({
      phase: 'unknown', operationId: OPERATION_ID, providerEpoch: PROVIDER_EPOCH,
    })

    documents.editDocument('w', tab.path, tab.lifecycleId, 'must be fenced\n')
    expect(documents.session('w').tabs[0]?.content).toBe('base\n')
    expect(await controller.reconcileUnknown()).toBe('committed')
    expect(api.mutate).toHaveBeenCalledOnce()
    expect(api.status).toHaveBeenCalledOnce()
    expect(documents.session('w').tabs[0]).toMatchObject({ path: 'src/b.ts', version: 'v2' })
    expect(registry.get({ workspaceId: 'w', path: 'src/b.ts', lifecycleId: tab.lifecycleId, historyEpoch: 0 }))
      .toMatchObject({ scrollTop: 10 })
    documents.editDocument('w', 'src/b.ts', tab.lifecycleId, 'lease released\n')
    expect(documents.session('w').tabs[0]?.content).toBe('lease released\n')
  })

  it('keeps committed reconciliation applying and blocks workspace/admission until authoritative recovery finishes', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'src/a.ts', 'old\n', 'v1')
    let resolveRead!: (value: { path: string; content: string; version: string }) => void
    const read = vi.fn<DocumentFilePort['read']>((_workspaceId, path) => new Promise(resolve => {
      resolveRead = resolve
      expect(path).toBe('src/b.ts')
    }))
    const api = apiWith(
      async () => { throw new Error('response lost') },
      async () => committedRename(),
    )
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentPort(documents, read), operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    controller.beginRename({ path: tab.path, type: 'file', version: tab.version })
    controller.updateName('b.ts')
    controller.requestConfirmation()
    expect(await controller.submit()).toBe('unknown')

    const reconciliation = controller.reconcileUnknown()
    await vi.waitFor(() => expect(store.getSnapshot().phase).toBe('applying'))
    expect(controller.selectWorkspace('other', documents.getSnapshot().activeWorkspaceEpoch + 1)).toBe(false)
    expect(controller.beginCreate('', 'file', 'other.ts')).toBe(false)
    documents.editDocument('w', tab.path, tab.lifecycleId, 'must remain fenced')
    expect(documents.activeTab()?.content).toBe('old\n')

    resolveRead({ path: 'src/b.ts', content: 'authoritative\n', version: 'v3' })
    expect(await reconciliation).toBe('committed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle', workspaceId: 'w' })
    expect(documents.activeTab()).toMatchObject({ path: 'src/b.ts', content: 'authoritative\n', version: 'v3' })
    expect(documents.isPathMutationLeased('w', 'src/b.ts')).toBe(false)
  })

  it('requires explicit acknowledgement for an expired receipt without deciding or replaying the mutation', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'src/a.ts')
    let acknowledgementAttempts = 0
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(() => {
        acknowledgementAttempts += 1
        if (acknowledgementAttempts === 1) throw new Error('storage unavailable')
      }),
    }
    const api = apiWith(
      async () => { throw new Error('response lost') },
      async () => ({ providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, state: 'expired' }),
    )
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      documents: documentPort(documents), recovery, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    controller.beginRename({ path: tab.path, type: 'file', version: tab.version })
    controller.updateName('b.ts')
    controller.requestConfirmation()
    expect(await controller.submit()).toBe('unknown')
    expect(await controller.reconcileUnknown()).toBe('unknown')
    expect(store.getSnapshot()).toMatchObject({
      phase: 'unknown', error: { code: MUTATION_MANUAL_RECONCILIATION_REQUIRED },
    })
    expect(await controller.reconcileUnknown()).toBe('unknown')
    expect(api.status).toHaveBeenCalledOnce()
    expect(recovery.committed).not.toHaveBeenCalled()
    expect(recovery.notCommitted).not.toHaveBeenCalled()

    expect(await controller.acknowledgeUnresolvedOutcome()).toBe('unknown')
    expect(store.getSnapshot()).toMatchObject({
      phase: 'unknown', error: { code: MUTATION_MANUAL_RECONCILIATION_REQUIRED },
    })
    documents.editDocument('w', tab.path, tab.lifecycleId, 'still fenced')
    expect(documents.activeTab()?.content).toBe('base\n')
    expect(await controller.acknowledgeUnresolvedOutcome()).toBe('acknowledged')
    expect(recovery.acknowledged).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'idle', error: { code: 'MUTATION_TRACKING_RELEASED' },
    })
    documents.editDocument('w', tab.path, tab.lifecycleId, 'editing is explicit after review')
    expect(documents.activeTab()?.content).toBe('editing is explicit after review')
    expect(api.mutate).toHaveBeenCalledOnce()
  })

  it('bounds terminal recovery errors and can acknowledge a prepared checkpoint when unknown persistence failed', async () => {
    const longMessage = '界'.repeat(3_000)
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(),
      unknown: vi.fn(() => { throw new Error('storage write failed') }),
      committed: vi.fn(),
      applied: vi.fn(),
      notCommitted: vi.fn(),
      acknowledged: vi.fn(),
    }
    const api = apiWith(
      async () => { throw new Error('response lost') },
      async () => ({
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        state: 'recoveryRequired',
        error: { code: 'RECOVERY_REQUIRED', message: longMessage },
      }),
    )
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      recovery, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', 1)
    controller.beginCreate('', 'directory', 'folder')
    controller.requestConfirmation()
    expect(await controller.submit()).toBe('unknown')
    expect(await controller.reconcileUnknown()).toBe('unknown')
    const unresolved = store.getSnapshot()
    expect(unresolved).toMatchObject({
      phase: 'unknown', error: { code: MUTATION_MANUAL_RECONCILIATION_REQUIRED },
    })
    if (unresolved.phase === 'unknown') expect(unresolved.error.message.length).toBeLessThanOrEqual(2_000)
    expect(await controller.acknowledgeUnresolvedOutcome()).toBe('acknowledged')
    expect(recovery.acknowledged).toHaveBeenCalledOnce()
    expect(recovery.committed).not.toHaveBeenCalled()
  })

  it('restores an already-admitted delete lease even when reload observes the file as deleted', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'note.ts')
    documents.editDocument('w', tab.path, tab.lifecycleId, 'unsaved after reload')
    documents.commitDeleteMutation('w', documents.getSnapshot().activeWorkspaceEpoch, tab.path, 'file', tab.version)
    expect(documents.activeTab()).toMatchObject({ externalState: 'deleted' })

    const api = apiWith(
      async () => { throw new Error('must not resubmit') },
      async () => ({
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        state: 'committed',
        result: { kind: 'file', path: 'note.ts', recursive: false, refreshDirectories: [''] },
      }),
    )
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, { documents })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    const record = {
      providerEpoch: PROVIDER_EPOCH,
      workspaceId: 'w',
      workspaceEpoch: documents.getSnapshot().activeWorkspaceEpoch,
      operationId: OPERATION_ID,
      draft: { kind: 'delete' as const, source: { path: 'note.ts', type: 'file' as const, version: 'v1' } },
    }
    expect(controller.resumeUnknown(record)).toBe(true)
    documents.editDocument('w', tab.path, tab.lifecycleId, 'must stay fenced')
    expect(documents.activeTab()?.content).toBe('unsaved after reload')
    expect(await controller.reconcileUnknown()).toBe('committed')
    expect(api.mutate).not.toHaveBeenCalled()
    expect(api.status).toHaveBeenCalledOnce()
  })

  it('leases a create destination before Host admission and refuses an already-open path', async () => {
    const documents = new DocumentSessionStore()
    open(documents, 'w', 'occupied.ts')
    const api = apiWith(async () => new Promise(() => {}))
    const occupiedStore = new WorkspaceMutationStore()
    const occupied = new WorkspaceMutationController(occupiedStore, api, {
      documents: documentPort(documents), operationId: () => OPERATION_ID,
    })
    occupied.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    occupied.beginCreate('', 'file', 'occupied.ts')
    occupied.requestConfirmation()
    expect(await occupied.submit()).toBe('blocked')
    expect(api.mutate).not.toHaveBeenCalled()

    occupied.cancel()
    occupied.beginCreate('', 'file', 'new.ts')
    occupied.requestConfirmation()
    void occupied.submit()
    await vi.waitFor(() => expect(occupiedStore.getSnapshot().phase).toBe('submitting'))
    expect(documents.beginOpen('w', 'new.ts', 'new.ts')).toBeUndefined()
    occupied.dispose()
  })

  it('routes a cross-folder move through the existing atomic rename and recovery transaction', async () => {
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const api = apiWith(async request => {
      expect(request).toMatchObject({
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        workspaceId: 'w',
        mutation: {
          kind: 'rename',
          path: 'src/a.ts',
          destinationPath: 'lib/a.ts',
          expected: { kind: 'file', version: 'v1' },
        },
      })
      return committedRename('src/a.ts', 'lib/a.ts')
    })
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      recovery,
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', 3)

    expect(controller.beginMove({ path: 'src', type: 'directory', version: 'dir-v1' }, 'src/child')).toBe(false)
    expect(controller.beginMove({ path: 'src/a.ts', type: 'file', version: 'v1' }, 'src')).toBe(false)
    expect(store.getSnapshot().phase).toBe('idle')
    expect(api.mutate).not.toHaveBeenCalled()

    expect(controller.beginMove({ path: 'src/a.ts', type: 'file', version: 'v1' }, 'lib')).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      phase: 'editing',
      draft: {
        kind: 'rename',
        name: 'a.ts',
        destinationParentPath: 'lib',
      },
    })
    expect(controller.requestConfirmation()).toBe(true)
    expect(await controller.submit()).toBe('committed')
    expect(api.mutate).toHaveBeenCalledOnce()
    expect(recovery.prepared).toHaveBeenCalledOnce()
    expect(recovery.committed).toHaveBeenCalledOnce()
    expect(recovery.applied).toHaveBeenCalledOnce()
  })

  it('leases and commits a dirty file rename without losing bytes, identity, history, or the fresh version', async () => {
    const documents = new DocumentSessionStore()
    const opened = open(documents, 'w', 'src/a.ts', 'base\n', 'v1')
    documents.editDocument('w', opened.path, opened.lifecycleId, 'local dirty\n')
    const dirty = documents.activeTab()!
    const registry = editorRegistry(documents)
    let editorState = EditorState.create({ doc: 'base\n', extensions: [history()] })
    editorState = editorState.update({
      changes: { from: 0, to: editorState.doc.length, insert: 'local dirty\n' },
    }).state
    const sourceIdentity = {
      workspaceId: 'w', path: dirty.path, lifecycleId: dirty.lifecycleId, historyEpoch: dirty.historyEpoch,
    }
    registry.set(sourceIdentity, { state: editorState, scrollTop: 7, scrollLeft: 3 })

    let settleReceipt: (receipt: ProtocolMutationReceipt) => void = () => {}
    const receipt = new Promise<ProtocolMutationReceipt>(resolve => { settleReceipt = resolve })
    const api = apiWith(async () => await receipt)
    const mutationStore = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(mutationStore, api, {
      documents: documentPort(documents),
      editorSessions: registry,
      operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    expect(controller.beginRename({ path: dirty.path, type: 'file', version: dirty.version })).toBe(true)
    expect(controller.updateName('b.ts')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)
    const submission = controller.submit()
    await vi.waitFor(() => expect(api.mutate).toHaveBeenCalledOnce())

    expect(documents.isPathMutationLeased('w', 'src/a.ts')).toBe(true)
    expect(documents.isPathMutationLeased('w', 'src/b.ts')).toBe(true)
    documents.editDocument('w', dirty.path, dirty.lifecycleId, 'late edit must be fenced\n')
    expect(documents.activeTab()?.content).toBe('local dirty\n')

    settleReceipt(committedRename())
    expect(await submission).toBe('committed')
    expect(documents.activeTab()).toMatchObject({
      path: 'src/b.ts',
      content: 'local dirty\n',
      baselineContent: 'base\n',
      dirty: true,
      lifecycleId: dirty.lifecycleId,
      localRevision: dirty.localRevision,
      historyEpoch: dirty.historyEpoch,
      version: 'v2',
    })
    expect(documents.isPathMutationLeased('w', 'src/a.ts')).toBe(false)
    expect(documents.isPathMutationLeased('w', 'src/b.ts')).toBe(false)
    const movedEditor = registry.get({ ...sourceIdentity, path: 'src/b.ts' })
    expect(movedEditor?.state.doc.toString()).toBe('local dirty\n')
    expect(undoDepth(movedEditor!.state)).toBe(1)
    expect(registry.get(sourceIdentity)).toBeUndefined()
  })

  it('leases and commits a directory rename while preserving a dirty descendant and its history', async () => {
    const documents = new DocumentSessionStore()
    const opened = open(documents, 'w', 'src/n/b.ts', 'disk child\n', 'child-v1')
    documents.editDocument('w', opened.path, opened.lifecycleId, 'local child\n')
    const dirty = documents.activeTab()!
    const registry = editorRegistry(documents)
    let editorState = EditorState.create({ doc: 'disk child\n', extensions: [history()] })
    editorState = editorState.update({
      changes: { from: 0, to: editorState.doc.length, insert: 'local child\n' },
    }).state
    const sourceIdentity = {
      workspaceId: 'w', path: dirty.path, lifecycleId: dirty.lifecycleId, historyEpoch: dirty.historyEpoch,
    }
    registry.set(sourceIdentity, { state: editorState, scrollTop: 11, scrollLeft: 2 })

    let settleReceipt: (receipt: ProtocolMutationReceipt) => void = () => {}
    const receipt = new Promise<ProtocolMutationReceipt>(resolve => { settleReceipt = resolve })
    const api = apiWith(async () => await receipt)
    const explorer: MutationExplorerPort = {
      commitCreateMutation: vi.fn(async () => true),
      commitRenameMutation: vi.fn(async () => true),
      commitDeleteMutation: vi.fn(async () => true),
    }
    const mutationStore = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(mutationStore, api, {
      documents: documentPort(documents),
      editorSessions: registry,
      explorer,
      operationId: () => OPERATION_ID,
    })
    const workspaceEpoch = documents.getSnapshot().activeWorkspaceEpoch
    controller.selectWorkspace('w', workspaceEpoch)
    expect(controller.beginRename({ path: 'src', type: 'directory', version: 'dir-v1' })).toBe(true)
    expect(controller.updateName('lib')).toBe(true)
    expect(controller.requestConfirmation()).toBe(true)
    const submission = controller.submit()
    await vi.waitFor(() => expect(api.mutate).toHaveBeenCalledOnce())

    expect(documents.isPathMutationLeased('w', 'src/n/b.ts')).toBe(true)
    expect(documents.isPathMutationLeased('w', 'lib/n/b.ts')).toBe(true)
    documents.editDocument('w', dirty.path, dirty.lifecycleId, 'late child edit must be fenced\n')
    expect(documents.activeTab()?.content).toBe('local child\n')

    settleReceipt({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'committed',
      result: {
        kind: 'directory',
        path: 'src',
        destinationPath: 'lib',
        version: 'dir-v2',
        refreshDirectories: [''],
      },
    })
    expect(await submission).toBe('committed')
    expect(documents.activeTab()).toMatchObject({
      path: 'lib/n/b.ts',
      content: 'local child\n',
      baselineContent: 'disk child\n',
      dirty: true,
      lifecycleId: dirty.lifecycleId,
      localRevision: dirty.localRevision,
      historyEpoch: dirty.historyEpoch,
      version: 'child-v1',
    })
    expect(explorer.commitRenameMutation).toHaveBeenCalledWith(
      'w', workspaceEpoch, 'src', 'lib', 'dir-v2', [''],
    )
    expect(documents.isPathMutationLeased('w', 'src/n/b.ts')).toBe(false)
    expect(documents.isPathMutationLeased('w', 'lib/n/b.ts')).toBe(false)
    const movedEditor = registry.get({ ...sourceIdentity, path: 'lib/n/b.ts' })
    expect(movedEditor?.state.doc.toString()).toBe('local child\n')
    expect(undoDepth(movedEditor!.state)).toBe(1)
    expect(registry.get(sourceIdentity)).toBeUndefined()
  })

  it('atomically rebases document and Explorer prefixes while fencing old async completions', () => {
    const documents = new DocumentSessionStore()
    const first = open(documents, 'w', 'src/a.ts', 'a', 'a1')
    const second = open(documents, 'w', 'src/n/b.ts', 'b', 'b1')
    const pending = documents.beginOpen('w', 'src/late.ts', 'late.ts')!
    const epoch = documents.getSnapshot().activeWorkspaceEpoch
    const renamed = documents.commitRenameMutation('w', epoch, 'src', 'lib', 'directory', 'dir-v1', 'dir-v2')
    expect(renamed.applied).toBe(true)
    expect(documents.session('w').tabs.map(tab => tab.path)).toEqual(['lib/a.ts', 'lib/n/b.ts'])
    expect(documents.session('w').activePath).toBe('lib/n/b.ts')
    expect(documents.session('w').tabs.map(tab => tab.lifecycleId)).toEqual([first.lifecycleId, second.lifecycleId])
    expect(documents.completeOpen(pending, { path: 'src/late.ts', content: 'late', version: 'v1' })).toBe(false)

    const fileRename = documents.commitRenameMutation('w', epoch, 'lib/a.ts', 'lib/c.ts', 'file', 'v1', 'fresh-v9')
    expect(fileRename.applied).toBe(true)
    expect(documents.session('w').tabs[0]).toMatchObject({
      path: 'lib/c.ts', version: 'fresh-v9', lifecycleId: first.lifecycleId, content: 'a', historyEpoch: 0,
    })

    const explorer = new ExplorerStore()
    explorer.selectWorkspace('w')
    explorer.setDirectoryEntries('w', '', [{ name: 'src', path: 'src', type: 'directory', version: 'old' }])
    explorer.setDirectoryEntries('w', 'src', [
      { name: 'a.ts', path: 'src/a.ts', type: 'file', version: 'a1' },
      { name: 'n', path: 'src/n', type: 'directory', version: 'n1' },
    ])
    explorer.setDirectoryEntries('w', 'src/n', [{ name: 'b.ts', path: 'src/n/b.ts', type: 'file', version: 'b1' }])
    explorer.setExpanded('w', 'src', true)
    explorer.setExpanded('w', 'src/n', true)
    explorer.setFocus('w', 'src/n/b.ts')
    explorer.setSelected('w', 'src/a.ts')
    explorer.requestPresentation('w', 'src/n/b.ts', true)
    expect(explorer.rebasePath('w', 'src', 'lib', 'dir-v2')).toBe(true)
    const session = explorer.session('w')
    expect(session.expanded).toEqual(new Set(['', 'lib', 'lib/n']))
    expect([...session.directories.keys()]).toEqual(['', 'lib', 'lib/n'])
    expect(session.directories.get('')?.entries?.[0]).toMatchObject({ path: 'lib', name: 'lib', version: 'dir-v2' })
    expect(session.focusedPath).toBe('lib/n/b.ts')
    expect(session.selectedPath).toBe('lib/a.ts')
    expect(session.pendingPresentation?.path).toBe('lib/n/b.ts')
  })

  it('preserves CodeMirror history across a rebase and fences a stale destination lifecycle', () => {
    let current = { workspaceId: 'w', path: 'src/a.ts', lifecycleId: 1 }
    const registry = new EditorSessionRegistry(identity => (
      identity.workspaceId === current.workspaceId
      && identity.path === current.path
      && identity.lifecycleId === current.lifecycleId
    ))
    const identity = { workspaceId: 'w', path: 'src/a.ts', lifecycleId: 1, historyEpoch: 0 }
    let state = EditorState.create({ doc: 'one', extensions: [history()] })
    state = state.update({ changes: { from: 0, to: 3, insert: 'two' } }).state
    registry.set(identity, { state, scrollTop: 7, scrollLeft: 3 })
    current = { ...current, path: 'src/b.ts' }
    expect(registry.rebaseDocument(identity, 'src/b.ts')).toBe(true)
    const moved = registry.get({ ...identity, path: 'src/b.ts' })!
    expect(moved.state.doc.toString()).toBe('two')
    expect(undoDepth(moved.state)).toBe(1)
    expect(registry.get(identity)).toBeUndefined()
    registry.set({ ...identity, path: 'src/b.ts', lifecycleId: 9 }, {
      state: EditorState.create({ doc: 'stale' }), scrollTop: 0, scrollLeft: 0,
    })
    expect(registry.get({ ...identity, path: 'src/b.ts' })?.state.doc.toString()).toBe('two')
    registry.set(identity, {
      state: EditorState.create({ doc: 'stale source cleanup' }), scrollTop: 0, scrollLeft: 0,
    })
    expect(registry.get({ ...identity, path: 'src/b.ts' })?.state.doc.toString()).toBe('two')
    expect(registry.rebaseDocument({ ...identity, lifecycleId: 9 }, 'src/b.ts')).toBe(false)
    current = { ...current, lifecycleId: 2 }
    expect(registry.rebaseDocument(identity, 'src/b.ts')).toBe(false)
  })

  it('keeps one dirty deleted file recoverable and never overwrites a recreate collision', async () => {
    const documents = new DocumentSessionStore()
    const tab = open(documents, 'w', 'note.ts')
    documents.editDocument('w', tab.path, tab.lifecycleId, 'unsaved\n')
    const impact = documents.inspectDeleteMutation('w', tab.path, 'file', tab.version)
    expect(impact).toMatchObject({ preservesDirtyFile: true, blockers: [] })
    const deleted = documents.commitDeleteMutation(
      'w', documents.getSnapshot().activeWorkspaceEpoch, tab.path, 'file', tab.version,
    )
    expect(deleted).toMatchObject({ applied: true, retired: [] })
    expect(deleted.retainedDeleted).toHaveLength(1)
    expect(documents.activeTab()).toMatchObject({ content: 'unsaved\n', dirty: true, externalState: 'deleted' })

    const collision = Object.assign(new Error('already exists'), { code: 'VERSION_CONFLICT' })
    const files: DocumentFilePort = {
      read: vi.fn(),
      write: vi.fn(async () => { throw collision }),
    }
    const controller = new DocumentController(documents, files)
    expect(await controller.recreateDeleted('w', 'note.ts')).toBe('conflict')
    expect(files.write).toHaveBeenCalledWith('w', 'note.ts', 'unsaved\n', undefined)
    expect(documents.activeTab()).toMatchObject({ content: 'unsaved\n', dirty: true, externalState: 'deleted' })

    const child = open(documents, 'w', 'dir/a.ts')
    documents.editDocument('w', child.path, child.lifecycleId, 'dirty child')
    expect(documents.inspectDeleteMutation('w', 'dir', 'directory', 'dir-v1').blockers.map(value => value.code)).toContain('dirty')
  })

  it('submits non-empty directory deletion recursively and leases clean descendants until commit', async () => {
    const documents = new DocumentSessionStore()
    const child = open(documents, 'w', 'dir/a.ts')
    let admittedRecursive: boolean | undefined
    const api = apiWith(async (input) => {
      if (input.mutation.kind === 'delete') admittedRecursive = input.mutation.recursive
      documents.editDocument('w', child.path, child.lifecycleId, 'late dirty edit')
      return {
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        state: 'committed',
        result: { kind: 'directory', path: 'dir', recursive: true, refreshDirectories: [''] },
      }
    })
    const retired = vi.fn()
    const editorSessions = { rebaseDocument: vi.fn(() => true), deleteDocument: retired }
    const mutationStore = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(mutationStore, api, {
      documents: documentPort(documents), editorSessions, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', documents.getSnapshot().activeWorkspaceEpoch)
    controller.beginDelete({ path: 'dir', type: 'directory', version: 'dir-v1' })
    expect(await controller.submit()).toBe('committed')
    expect(admittedRecursive).toBe(true)
    expect(documents.session('w').tabs).toHaveLength(0)
    expect(retired).toHaveBeenCalledWith({ workspaceId: 'w', path: 'dir/a.ts', lifecycleId: child.lifecycleId })
  })

  it('mirrors the Host portable-name policy including UTF-8 byte limits', () => {
    const store = new WorkspaceMutationStore()
    const api = apiWith(async () => ({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'notCommitted',
      error: { code: 'unused', message: 'unused' },
    }))
    const controller = new WorkspaceMutationController(store, api)
    controller.selectWorkspace('w', 1)
    for (const name of [
      'CON', 'nul.txt', 'COM1.log', 'name:stream', 'bad?', 'tail.', 'tail ', 'bad\0name',
      '.__dsh_code_ide_quarantine_owned', '界'.repeat(86),
    ]) {
      expect(controller.beginCreate('', 'file', name), name).toBe(true)
      controller.requestConfirmation()
      const state = store.getSnapshot()
      expect(state.phase, name).toBe('confirming')
      if (state.phase === 'confirming') expect(state.impact.blockers.map(value => value.code), name).toContain('INVALID_NAME')
      controller.cancel()
    }
    expect(controller.beginCreate('', 'file', '界'.repeat(85))).toBe(true)
    controller.requestConfirmation()
    const valid = store.getSnapshot()
    expect(valid.phase).toBe('confirming')
    if (valid.phase === 'confirming') expect(valid.impact.blockers).toEqual([])
  })

  it('keeps a proven commit when presentation throws, opens created files independently, and retains recovery', async () => {
    let createAttempts = 0
    const explorer: MutationExplorerPort = {
      commitCreateMutation: vi.fn(async () => {
        createAttempts += 1
        if (createAttempts === 1) throw new Error('list failed')
        return true
      }),
      commitRenameMutation: vi.fn(async () => true),
      commitDeleteMutation: vi.fn(async () => true),
    }
    const navigation = { openCreatedFile: vi.fn(async () => true) }
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const api = apiWith(async () => ({
      providerEpoch: PROVIDER_EPOCH,
      operationId: OPERATION_ID,
      state: 'committed',
      result: { kind: 'file', path: 'new.ts', version: 'v1', refreshDirectories: [''] },
    }))
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, {
      explorer, navigation, recovery, operationId: () => OPERATION_ID,
    })
    controller.selectWorkspace('w', 1)
    controller.beginCreate('', 'file', 'new.ts')
    controller.requestConfirmation()
    expect(await controller.submit()).toBe('committed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'applying', error: { code: 'COMMITTED_PRESENTATION_FAILED' } })
    expect(recovery.committed).toHaveBeenCalledOnce()
    expect(recovery.applied).not.toHaveBeenCalled()
    expect(navigation.openCreatedFile).toHaveBeenCalledWith(OPERATION_ID, 'w', 1, 'new.ts')
    expect(await controller.retryCommitted()).toBe('committed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle' })
    expect(recovery.applied).toHaveBeenCalledOnce()
  })

  it('resumes a persisted committed receipt without mutate/status and clears it after idempotent application', async () => {
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const explorer: MutationExplorerPort = {
      commitCreateMutation: vi.fn(async () => true),
      commitRenameMutation: vi.fn(async () => true),
      commitDeleteMutation: vi.fn(async () => true),
    }
    const api = apiWith(async () => { throw new Error('must not mutate') })
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(store, api, { recovery, explorer })
    controller.selectWorkspace('w', 4)
    const record = {
      providerEpoch: PROVIDER_EPOCH,
      workspaceId: 'w',
      workspaceEpoch: 4,
      operationId: OPERATION_ID,
      draft: { kind: 'create' as const, parentPath: '', name: 'restored', resourceKind: 'directory' as const },
    }
    const result = { kind: 'directory' as const, path: 'restored', version: 'v1', refreshDirectories: [''] }
    expect(await controller.resumeCommitted(record, result)).toBe('committed')
    expect(api.mutate).not.toHaveBeenCalled()
    expect(api.status).not.toHaveBeenCalled()
    expect(recovery.applied).toHaveBeenCalledWith(record)
  })

  it('fails committed rename recovery before changing documents when destination mapping would collide', async () => {
    const documents = new DocumentSessionStore()
    const source = open(documents, 'w', 'src/a.ts', 'source bytes', 'v1')
    const destination = open(documents, 'w', 'src/b.ts', 'destination bytes', 'v9')
    documents.editDocument('w', destination.path, destination.lifecycleId, 'destination dirty bytes')
    const before = documents.session('w')
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const read = vi.fn<DocumentFilePort['read']>(async (_workspaceId, path) => ({
      path, content: 'authoritative destination', version: 'v10',
    }))
    const controller = new WorkspaceMutationController(
      new WorkspaceMutationStore(),
      apiWith(async () => { throw new Error('must not mutate') }),
      {
        documents: documentPort(documents, read),
        recovery,
      },
    )
    const epoch = documents.getSnapshot().activeWorkspaceEpoch
    controller.selectWorkspace('w', epoch)
    const record = {
      providerEpoch: PROVIDER_EPOCH,
      workspaceId: 'w',
      workspaceEpoch: epoch,
      operationId: OPERATION_ID,
      draft: {
        kind: 'rename' as const,
        source: { path: source.path, type: 'file' as const, version: source.version },
        name: 'b.ts',
      },
    }
    const result = {
      kind: 'file' as const,
      path: source.path,
      destinationPath: destination.path,
      version: 'v2',
      refreshDirectories: ['src'],
    }

    expect(await controller.resumeCommitted(record, result)).toBe('committed')
    expect(controller.store.getSnapshot()).toMatchObject({
      phase: 'applying', error: { code: 'COMMITTED_PRESENTATION_FAILED' },
    })
    expect(documents.session('w')).toEqual(before)
    expect(read).not.toHaveBeenCalled()
    expect(recovery.applied).not.toHaveBeenCalled()
  })

  it('recovers authoritative destination bytes before applying persisted committed and unknown renames', async () => {
    for (const phase of ['committed', 'unknown'] as const) {
      const documents = new DocumentSessionStore()
      documents.restoreWorkspace('w', [{
        path: 'src/a.ts',
        name: 'a.ts',
        content: '',
        version: 'unobserved',
        dirty: false,
        externalState: 'deleted',
        loadError: 'old source is missing',
      }], 'src/a.ts')
      documents.selectWorkspace('w')
      const files: DocumentFilePort = {
        read: vi.fn(async (_workspaceId, path) => ({ path, content: 'authoritative B\n', version: 'v3' })),
        write: vi.fn(),
      }
      const documentController = new DocumentController(documents, files)
      const recovery: MutationRecoveryPort = {
        prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
        notCommitted: vi.fn(), acknowledged: vi.fn(),
      }
      const result = {
        kind: 'file' as const,
        path: 'src/a.ts',
        destinationPath: 'src/b.ts',
        version: 'v2',
        refreshDirectories: ['src'],
      }
      const status = vi.fn(async () => ({
        providerEpoch: PROVIDER_EPOCH,
        operationId: OPERATION_ID,
        state: 'committed' as const,
        result,
      }))
      const api = apiWith(async () => { throw new Error('must not mutate') }, status)
      const store = new WorkspaceMutationStore()
      const controller = new WorkspaceMutationController(store, api, { documents: documentController, recovery })
      const epoch = documents.getSnapshot().activeWorkspaceEpoch
      controller.selectWorkspace('w', epoch)
      const record = {
        providerEpoch: PROVIDER_EPOCH,
        workspaceId: 'w',
        workspaceEpoch: epoch,
        operationId: OPERATION_ID,
        draft: {
          kind: 'rename' as const,
          source: { path: 'src/a.ts', type: 'file' as const, version: 'v1' },
          name: 'b.ts',
        },
      }

      if (phase === 'committed') {
        expect(await controller.resumeCommitted(record, result)).toBe('committed')
      } else {
        expect(controller.resumeUnknown(record)).toBe(true)
        expect(await controller.reconcileUnknown()).toBe('committed')
        expect(status).toHaveBeenCalledOnce()
      }

      expect(files.read).toHaveBeenCalledWith('w', 'src/b.ts')
      expect(documents.activeTab()).toMatchObject({
        path: 'src/b.ts',
        content: 'authoritative B\n',
        baselineContent: 'authoritative B\n',
        version: 'v3',
        dirty: false,
      })
      expect(documents.activeTab()).not.toHaveProperty('externalState')
      expect(documents.activeTab()).not.toHaveProperty('loadError')
      expect(documents.isPathMutationLeased('w', 'src/b.ts')).toBe(false)
      expect(recovery.applied).toHaveBeenCalledWith(record)
    }
  })

  it('recovers every open descendant of a committed directory rename while preserving dirty bytes and identities', async () => {
    const documents = new DocumentSessionStore()
    documents.restoreWorkspace('w', [
      {
        path: 'src/a.ts', name: 'a.ts', content: '', version: 'unobserved', dirty: false,
        externalState: 'deleted', loadError: 'old source missing',
      },
      {
        path: 'src/n/b.ts', name: 'b.ts', content: 'LOCAL DIRTY', baselineContent: 'old baseline',
        version: 'old-v', dirty: true,
      },
      { path: 'other.ts', name: 'other.ts', content: 'unrelated', version: 'u1', dirty: false },
    ], 'src/n/b.ts')
    documents.selectWorkspace('w')
    const before = documents.session('w').tabs.map(tab => ({ path: tab.path, lifecycleId: tab.lifecycleId }))
    const files: DocumentFilePort = {
      read: vi.fn(async (_workspaceId, path) => path === 'lib/a.ts'
        ? { path, content: 'disk A', version: 'a10' }
        : { path, content: 'disk B', version: 'b11' }),
      write: vi.fn(),
    }
    const recovery: MutationRecoveryPort = {
      prepared: vi.fn(), unknown: vi.fn(), committed: vi.fn(), applied: vi.fn(),
      notCommitted: vi.fn(), acknowledged: vi.fn(),
    }
    const store = new WorkspaceMutationStore()
    const controller = new WorkspaceMutationController(
      store,
      apiWith(async () => { throw new Error('must not mutate') }),
      { documents: new DocumentController(documents, files), recovery },
    )
    const epoch = documents.getSnapshot().activeWorkspaceEpoch
    controller.selectWorkspace('w', epoch)
    const record = {
      providerEpoch: PROVIDER_EPOCH,
      workspaceId: 'w',
      workspaceEpoch: epoch,
      operationId: OPERATION_ID,
      draft: {
        kind: 'rename' as const,
        source: { path: 'src', type: 'directory' as const, version: 'dir-v1' },
        name: 'lib',
      },
    }
    const result = {
      kind: 'directory' as const,
      path: 'src',
      destinationPath: 'lib',
      version: 'dir-v2',
      refreshDirectories: [''],
    }

    expect(await controller.resumeCommitted(record, result)).toBe('committed')
    expect(store.getSnapshot()).toMatchObject({ phase: 'idle' })
    const session = documents.session('w')
    expect(session.activePath).toBe('lib/n/b.ts')
    expect(session.tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'lib/a.ts', content: 'disk A', baselineContent: 'disk A', version: 'a10', dirty: false }),
      expect.objectContaining({
        path: 'lib/n/b.ts', content: 'LOCAL DIRTY', baselineContent: 'disk B', version: 'b11',
        dirty: true, externalState: 'modified',
      }),
      expect.objectContaining({ path: 'other.ts', content: 'unrelated', version: 'u1' }),
    ]))
    expect(session.tabs.map(tab => tab.lifecycleId)).toEqual(before.map(tab => tab.lifecycleId))
    expect(files.read).toHaveBeenCalledTimes(2)
  })
})
