import { describe, expect, it, vi } from 'vitest'
import {
  DocumentConflictController,
  DocumentConflictStore,
  classifyDocumentConflict,
  type DocumentConflictReadPort,
} from '../../src/client/documents/conflict.ts'
import {
  DOCUMENT_CONFLICT_VARIANT_UTF8_LIMIT,
  DocumentSessionStore,
  type DocumentIdentity,
  type EditorTab,
} from '../../src/client/documents/session.ts'

function conflictDocument(options: { base?: string; local?: string; version?: string } = {}) {
  const documents = new DocumentSessionStore()
  documents.selectWorkspace('workspace')
  const base = options.base ?? 'base\n'
  const open = documents.beginOpen('workspace', 'src/index.ts', 'index.ts')!
  expect(documents.completeOpen(open, {
    path: open.path,
    content: base,
    version: options.version ?? 'v1',
  })).toBe(true)
  const opened = documents.activeTab()!
  documents.editDocument('workspace', opened.path, opened.lifecycleId, options.local ?? 'local\n')
  documents.updateWorkspaceTabs('workspace', tabs => tabs.map(tab => tab.lifecycleId === opened.lifecycleId
    ? { ...tab, externalState: 'modified' as const }
    : tab))
  const tab = documents.activeTab()!
  const identity: DocumentIdentity = {
    workspaceId: 'workspace',
    workspaceEpoch: documents.getSnapshot().activeWorkspaceEpoch,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
  }
  return { documents, tab, identity }
}

function runtime(
  values: readonly ({ content: string; version: string } | Error)[],
  current = conflictDocument(),
) {
  let cursor = 0
  const files: DocumentConflictReadPort = {
    read: vi.fn(async (_workspaceId, path) => {
      const value = values[Math.min(cursor, values.length - 1)]
      cursor += 1
      if (value instanceof Error) throw value
      if (value === undefined) throw new Error('missing fixture read')
      return { path, ...value }
    }),
  }
  const store = new DocumentConflictStore()
  const controller = new DocumentConflictController(store, current.documents, files)
  expect(controller.selectWorkspace('workspace', current.identity.workspaceEpoch)).toBe(true)
  return { ...current, files, store, controller }
}

function exactTab(documents: DocumentSessionStore, identity: DocumentIdentity): EditorTab {
  const tab = documents.inspect(identity)
  expect(tab).toBeDefined()
  return tab!
}

describe('document conflict domain', () => {
  it('classifies the complete three-way relation vocabulary deterministically', () => {
    expect(classifyDocumentConflict('base', 'local', 'base')).toBe('remote-equals-base')
    expect(classifyDocumentConflict('base', 'base', 'remote')).toBe('local-equals-base')
    expect(classifyDocumentConflict('base', 'same', 'same')).toBe('local-equals-remote')
    expect(classifyDocumentConflict('base', 'local', 'remote')).toBe('diverged')
    expect(classifyDocumentConflict(undefined, 'same', 'same')).toBe('base-unavailable')
  })

  it('does no authoritative read until explicit compare and projects captured Base, Local, and Remote', async () => {
    const current = runtime([{ content: 'remote\n', version: 'v2' }])
    expect(current.files.read).not.toHaveBeenCalled()

    await expect(current.controller.compare(current.identity)).resolves.toBe('ready')

    expect(current.files.read).toHaveBeenCalledOnce()
    expect(current.files.read).toHaveBeenCalledWith('workspace', 'src/index.ts')
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'ready',
      base: 'base\n',
      local: 'local\n',
      remote: { content: 'remote\n', version: 'v2' },
      relation: 'diverged',
      intent: {
        workspaceId: 'workspace',
        workspaceEpoch: current.identity.workspaceEpoch,
        path: current.identity.path,
        lifecycleId: current.identity.lifecycleId,
        requestId: expect.any(Number),
        resourceGeneration: expect.any(Number),
        localRevision: 1,
        baseVersion: 'v1',
        local: 'local\n',
        base: 'base\n',
      },
      presentationRequest: { target: 'summary' },
    })
    const request = current.store.getSnapshot().presentationRequest!
    expect(current.controller.acknowledgePresentation(request.requestId)).toBe(true)
    expect(current.store.getSnapshot()).not.toHaveProperty('presentationRequest')
    expect(exactTab(current.documents, current.identity).pendingConflictId).toBeDefined()
  })

  it('preserves an unacknowledged summary focus request and creates a fresh one for a later error', async () => {
    const current = runtime([
      { content: 'remote\n', version: 'v2' },
      new Error('verification offline'),
    ])
    await current.controller.compare(current.identity)
    const initial = current.store.getSnapshot().presentationRequest!
    expect(initial).toMatchObject({ target: 'summary' })
    expect(current.controller.acknowledgePresentation(initial.requestId)).toBe(true)

    await expect(current.controller.keepLocal()).resolves.toBe('failed')
    const error = current.store.getSnapshot()
    expect(error).toMatchObject({
      phase: 'error', operation: 'verify', presentationRequest: { target: 'summary' },
    })
    expect(error.presentationRequest?.requestId).not.toBe(initial.requestId)
  })

  it('fails closed before read for unknown, pending, leased, deleted, and non-modified documents', async () => {
    const cases: ((documents: DocumentSessionStore, tab: EditorTab) => void)[] = [
      (documents, tab) => {
        const save = documents.beginSave('workspace', tab.path)!
        documents.failSave(save, 'lost', 'unknown')
      },
      (documents, tab) => { documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
        ? { ...candidate, pendingReloadId: 77 }
        : candidate)) },
      (documents, tab) => { expect(documents.restoreMutationLease('operation', 'workspace', [tab.path])).toBe(true) },
      (documents, tab) => { documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
        ? { ...candidate, externalState: 'deleted' as const }
        : candidate)) },
      (documents, tab) => { documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
        ? { ...candidate, externalState: undefined }
        : candidate)) },
    ]
    for (const arrange of cases) {
      const current = conflictDocument()
      arrange(current.documents, current.documents.activeTab()!)
      const instance = runtime([{ content: 'must not read', version: 'v2' }], current)
      await expect(instance.controller.compare(instance.identity)).resolves.toBe('blocked')
      expect(instance.files.read).not.toHaveBeenCalled()
    }
  })

  it('accepts Remote without writing and advances content, baseline, version, revision, and history', async () => {
    const current = runtime([
      { content: 'remote\n', version: 'v2' },
      { content: 'remote\n', version: 'v2' },
    ])
    await expect(current.controller.compare(current.identity)).resolves.toBe('ready')
    await expect(current.controller.acceptRemote()).resolves.toBe('applied')

    expect(current.files.read).toHaveBeenCalledTimes(2)
    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'remote\n',
      baselineContent: 'remote\n',
      version: 'v2',
      dirty: false,
      localRevision: 2,
      historyEpoch: 1,
    })
    expect(exactTab(current.documents, current.identity)).not.toHaveProperty('pendingConflictId')
    expect(exactTab(current.documents, current.identity)).not.toHaveProperty('externalState')
  })

  it('keeps Local without resetting history and leaves the next ordinary Save on confirmed Remote CAS', async () => {
    const current = runtime([
      { content: 'remote\n', version: 'v2' },
      { content: 'remote\n', version: 'v2' },
    ])
    await current.controller.compare(current.identity)
    await expect(current.controller.keepLocal()).resolves.toBe('applied')

    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'local\n',
      baselineContent: 'remote\n',
      version: 'v2',
      dirty: true,
      localRevision: 1,
      historyEpoch: 0,
    })
    expect(current.documents.beginSave('workspace', current.identity.path)).toMatchObject({
      content: 'local\n', expectedVersion: 'v2', baselineContent: 'remote\n',
    })
  })

  it('applies Merged locally, resets history only when text changes, and never owns a Host write port', async () => {
    const current = runtime([
      { content: 'remote\n', version: 'v2' },
      { content: 'remote\n', version: 'v2' },
    ])
    await current.controller.compare(current.identity)
    await expect(current.controller.applyMerged('merged\n')).resolves.toBe('applied')

    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'merged\n', baselineContent: 'remote\n', version: 'v2', dirty: true,
      localRevision: 2, historyEpoch: 1,
    })
    expect(current.documents.beginSave('workspace', current.identity.path)).toMatchObject({
      content: 'merged\n', expectedVersion: 'v2',
    })
  })

  it('re-reads before apply and requires review again when either Remote bytes or version changed', async () => {
    const current = runtime([
      { content: 'remote A\n', version: 'v2' },
      { content: 'remote B\n', version: 'v3' },
      { content: 'remote B\n', version: 'v3' },
    ])
    await current.controller.compare(current.identity)
    await expect(current.controller.keepLocal()).resolves.toBe('remote-changed')
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'ready', remote: { content: 'remote B\n', version: 'v3' }, relation: 'diverged',
    })
    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'local\n', baselineContent: 'base\n', version: 'v1', pendingConflictId: expect.any(Number),
    })

    await expect(current.controller.keepLocal()).resolves.toBe('applied')
    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'local\n', baselineContent: 'remote B\n', version: 'v3', historyEpoch: 0,
    })
  })

  it('preserves Local across read errors and allows an explicit retry or cancellation', async () => {
    const current = runtime([
      new Error('offline'),
      { content: 'remote\n', version: 'v2' },
    ])
    await expect(current.controller.compare(current.identity)).resolves.toBe('failed')
    expect(current.store.getSnapshot()).toMatchObject({
      phase: 'error', operation: 'compare', error: { code: 'REMOTE_READ_FAILED' }, local: 'local\n',
    })
    expect(exactTab(current.documents, current.identity)).toMatchObject({
      content: 'local\n', dirty: true, pendingConflictId: expect.any(Number),
    })

    await expect(current.controller.retry()).resolves.toBe('ready')
    expect(current.controller.cancel()).toBe(true)
    expect(exactTab(current.documents, current.identity)).toMatchObject({ content: 'local\n', dirty: true })
    expect(exactTab(current.documents, current.identity)).not.toHaveProperty('pendingConflictId')
  })

  it('fences asynchronous completion across local revision, lifecycle, and workspace ABA changes', async () => {
    let release!: (value: { path: string; content: string; version: string }) => void
    const gate = new Promise<{ path: string; content: string; version: string }>(resolve => { release = resolve })
    const current = conflictDocument()
    const files: DocumentConflictReadPort = { read: vi.fn(() => gate) }
    const store = new DocumentConflictStore()
    const controller = new DocumentConflictController(store, current.documents, files)
    controller.selectWorkspace('workspace', current.identity.workspaceEpoch)
    const comparing = controller.compare(current.identity)
    current.documents.editDocument('workspace', current.identity.path, current.identity.lifecycleId, 'continued\n')
    release({ path: current.identity.path, content: 'late\n', version: 'v9' })
    await expect(comparing).resolves.toBe('stale')
    expect(exactTab(current.documents, current.identity)).toMatchObject({ content: 'continued\n', dirty: true })

    const replacement = conflictDocument()
    const second = runtime([{ content: 'late\n', version: 'v9' }], replacement)
    const pending = second.controller.compare(second.identity)
    replacement.documents.restoreWorkspace('workspace', [{
      path: second.identity.path,
      name: 'index.ts',
      content: 'replacement\n',
      baselineContent: 'replacement\n',
      version: 'v10',
      dirty: false,
    }], second.identity.path)
    await expect(pending).resolves.toBe('stale')
    expect(replacement.documents.activeTab()).toMatchObject({ content: 'replacement\n', version: 'v10' })

    const aba = runtime([{ content: 'late\n', version: 'v9' }])
    const oldEpoch = aba.identity.workspaceEpoch
    aba.documents.selectWorkspace('other')
    aba.documents.selectWorkspace('workspace')
    expect(aba.documents.getSnapshot().activeWorkspaceEpoch).not.toBe(oldEpoch)
    await expect(aba.controller.compare(aba.identity)).resolves.toBe('blocked')
    expect(aba.files.read).not.toHaveBeenCalled()
  })

  it('enforces a strict per-variant 1 MiB UTF-8 budget and rejects NUL before unsafe work', async () => {
    const tooLarge = '🙂'.repeat(DOCUMENT_CONFLICT_VARIANT_UTF8_LIMIT / 4 + 1)
    const invalidRemote = runtime([{ content: 'remote\0bytes', version: 'v2' }])
    await expect(invalidRemote.controller.compare(invalidRemote.identity)).resolves.toBe('failed')
    expect(invalidRemote.store.getSnapshot()).toMatchObject({
      phase: 'error', error: { code: 'REMOTE_NUL' }, local: 'local\n',
    })

    const invalidMerged = runtime([{ content: 'remote\n', version: 'v2' }])
    await invalidMerged.controller.compare(invalidMerged.identity)
    await expect(invalidMerged.controller.applyMerged(tooLarge)).resolves.toBe('invalid')
    await expect(invalidMerged.controller.applyMerged('bad\0merge')).resolves.toBe('invalid')
    expect(invalidMerged.files.read).toHaveBeenCalledOnce()
    expect(invalidMerged.store.getSnapshot()).toMatchObject({ phase: 'ready', local: 'local\n' })
  })
})
