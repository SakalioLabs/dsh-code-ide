import { describe, expect, it, vi } from 'vitest'
import { DocumentConflictController, DocumentConflictStore } from '../../src/client/documents/conflict.ts'
import { DocumentController } from '../../src/client/documents/controller.ts'
import { DocumentSessionStore, type EditorTab } from '../../src/client/documents/session.ts'
import {
  materializeEditableText,
  normalizeEditableText,
} from '../../src/client/documents/text-content.ts'
import { EditorNavigationController } from '../../src/client/navigation/editor-navigation.ts'
import { WorkspaceReplaceController, WorkspaceReplaceStore } from '../../src/client/search/workspace-replace.ts'
import { WorkspaceSearchStore } from '../../src/client/search/workspace-search.ts'

function completedDiskSearch(): WorkspaceSearchStore {
  const search = new WorkspaceSearchStore()
  search.selectWorkspace('workspace')
  const intent = search.begin({
    pattern: 'target', mode: 'literal', caseSensitive: true, wholeWord: false,
  })!
  search.complete(intent, {
    items: [{
      path: 'closed.ts', lineNumber: 2, preview: 'target', previewStart: 0,
      ranges: [{ start: 0, end: 6 }], source: 'disk',
    }],
    matchCount: 1,
    fileCount: 1,
    truncated: false,
    dirtyBuffersOmitted: false,
    limit: 500,
  })
  return search
}

describe('editable document EOL boundary', () => {
  it('changes only the exact active editable EOL and keeps content/history untouched', () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
    store.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
    const initial = store.activeTab()!
    const identity = {
      workspaceId: 'workspace', workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: initial.path, lifecycleId: initial.lifecycleId,
    }

    expect(store.changeLineEnding(identity, '\r\n')).toBe('applied')
    expect(store.activeTab()).toMatchObject({
      content: 'base\n', baselineContent: 'base\n',
      lineEnding: '\r\n', baselineLineEnding: '\n', dirty: true,
      localRevision: initial.localRevision + 1, historyEpoch: initial.historyEpoch,
    })
    expect(store.changeLineEnding(identity, '\r\n')).toBe('not-needed')

    const changed = store.activeTab()!
    store.editDocument('workspace', changed.path, changed.lifecycleId, 'local\n')
    expect(store.changeLineEnding(identity, '\n')).toBe('applied')
    expect(store.activeTab()).toMatchObject({ lineEnding: '\n', baselineLineEnding: '\n', dirty: true })
    store.editDocument('workspace', changed.path, changed.lifecycleId, 'base\n')
    expect(store.activeTab()).toMatchObject({ lineEnding: '\n', baselineLineEnding: '\n', dirty: false })

    expect(store.changeLineEnding({ ...identity, lifecycleId: identity.lifecycleId + 1 }, '\r\n')).toBe('stale')
    const secondOpen = store.beginOpen('workspace', 'b.ts', 'b.ts')!
    store.completeOpen(secondOpen, { path: 'b.ts', content: 'second\n', version: 'v1' })
    expect(store.changeLineEnding(identity, '\r\n')).toBe('stale')
  })

  it('rejects EOL changes while document ownership is read-only or blocked', () => {
    const blocked: Array<(tab: EditorTab) => EditorTab> = [
      tab => ({ ...tab, pendingSaveId: 1 }),
      tab => ({ ...tab, pendingReloadId: 1 }),
      tab => ({ ...tab, pendingConflictId: 1 }),
      tab => ({ ...tab, saveOutcome: 'unknown' }),
      tab => ({ ...tab, externalState: 'deleted' }),
    ]
    for (const applyBlocker of blocked) {
      const store = new DocumentSessionStore()
      store.selectWorkspace('workspace')
      const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
      store.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
      const tab = store.activeTab()!
      store.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate === tab
        ? applyBlocker(candidate)
        : candidate))
      expect(store.changeLineEnding({
        workspaceId: 'workspace', workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
        path: tab.path, lifecycleId: tab.lifecycleId,
      }, '\r\n')).toBe('blocked')
    }

    const leased = new DocumentSessionStore()
    leased.selectWorkspace('workspace')
    const leasedOpen = leased.beginOpen('workspace', 'a.ts', 'a.ts')!
    leased.completeOpen(leasedOpen, { path: 'a.ts', content: 'base\n', version: 'v1' })
    const leasedTab = leased.activeTab()!
    expect(leased.restoreMutationLease('operation', 'workspace', [leasedTab.path])).toBe(true)
    expect(leased.changeLineEnding({
      workspaceId: 'workspace', workspaceEpoch: leased.getSnapshot().activeWorkspaceEpoch,
      path: leasedTab.path, lifecycleId: leasedTab.lifecycleId,
    }, '\r\n')).toBe('blocked')

    const readOnly = new DocumentSessionStore()
    readOnly.selectWorkspace('workspace')
    const readOnlyOpen = readOnly.beginOpen('workspace', 'large.txt', 'large.txt')!
    readOnly.completeOpen(readOnlyOpen, {
      path: 'large.txt', content: 'raw\r\npreview', version: 'large',
      readOnlyPresentation: {
        reason: 'too-large', sizeBytes: 5_000_000, limitBytes: 4_194_304,
        previewBytes: 12, truncated: true,
      },
    })
    const readOnlyTab = readOnly.activeTab()!
    expect(readOnly.changeLineEnding({
      workspaceId: 'workspace', workspaceEpoch: readOnly.getSnapshot().activeWorkspaceEpoch,
      path: readOnlyTab.path, lifecycleId: readOnlyTab.lifecycleId,
    }, '\r\n')).toBe('read-only')
  })

  it('keeps canonical LF coordinates while materializing captured CRLF on save', async () => {
    expect(normalizeEditableText('one\r\ntwo\r\n')).toEqual({
      content: 'one\ntwo\n', lineEnding: '\r\n',
    })
    expect(materializeEditableText('one\ntwo\n', '\r\n')).toBe('one\r\ntwo\r\n')

    const writes = vi.fn(async (_workspace: string, path: string, _content: string) => ({ path, version: 'v2' }))
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const documents = new DocumentController(store, {
      read: async (_workspace, path) => ({ path, content: 'one\r\ntarget here\r\n', version: 'v1' }),
      write: writes,
    })
    const navigation = new EditorNavigationController(documents)

    await expect(navigation.openPath('workspace', 'a.ts')).resolves.toBe(true)
    const opened = store.activeTab()!
    expect(opened).toMatchObject({ content: 'one\ntarget here\n', lineEnding: '\r\n', dirty: false })
    expect(navigation.revealActiveLocation({ lineNumber: 2, columnNumber: 7 })).toBe('revealed')
    expect(navigation.revealFor({
      workspaceId: 'workspace', path: opened.path, lifecycleId: opened.lifecycleId,
      historyEpoch: opened.historyEpoch, localRevision: opened.localRevision,
    })).toMatchObject({ from: 10, to: 10 })

    store.editDocument('workspace', opened.path, opened.lifecycleId, 'one\ntarget changed\n')
    await expect(documents.save('workspace', opened.path)).resolves.toBe('saved')
    expect(writes).toHaveBeenCalledWith('workspace', 'a.ts', 'one\r\ntarget changed\r\n', 'v1')
    expect(store.activeTab()).toMatchObject({
      content: 'one\ntarget changed\n', baselineContent: 'one\ntarget changed\n',
      lineEnding: '\r\n', baselineLineEnding: '\r\n', dirty: false,
    })
  })

  it('keeps baseline EOL evidence through unknown and immediate lost-response reconciliation', async () => {
    let readFails = true
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
    store.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
    const tab = store.activeTab()!
    const identity = {
      workspaceId: 'workspace', workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
      path: tab.path, lifecycleId: tab.lifecycleId,
    }
    expect(store.changeLineEnding(identity, '\r\n')).toBe('applied')
    const controller = new DocumentController(store, {
      write: async () => { throw new TypeError('response lost') },
      read: async (_workspace, path) => {
        if (readFails) throw new TypeError('offline')
        return { path, content: 'base\n', version: 'v1' }
      },
    })

    await expect(controller.save('workspace', tab.path)).resolves.toBe('unknown')
    expect(store.activeTab()?.unknownSave).toMatchObject({
      content: 'base\n', lineEnding: '\r\n',
      baselineContent: 'base\n', baselineLineEnding: '\n',
    })
    readFails = false
    await controller.reconcileUnknownSave('workspace', tab.path, tab.lifecycleId)
    expect(store.activeTab()).toMatchObject({
      lineEnding: '\r\n', baselineLineEnding: '\n', dirty: true,
    })
    expect(store.activeTab()?.saveOutcome).toBeUndefined()

    await expect(controller.save('workspace', tab.path)).resolves.toBe('failed')
    expect(store.activeTab()?.saveOutcome).toBeUndefined()
    expect(store.activeTab()).toMatchObject({ lineEnding: '\r\n', baselineLineEnding: '\n', dirty: true })
  })

  it('requires exact raw Host bytes before accepting a lost CRLF save or recreate', async () => {
    let disk = 'base\r\n'
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
    store.completeOpen(open, { path: 'a.ts', content: disk, version: 'v1' })
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'submitted\n')
    const controller = new DocumentController(store, {
      write: async () => { throw new TypeError('response lost') },
      read: async (_workspace, path) => ({ path, content: disk, version: 'v2' }),
    })

    disk = 'submitted\n'
    await expect(controller.save('workspace', tab.path)).resolves.toBe('unknown')
    expect(store.activeTab()?.unknownSave).toMatchObject({ content: 'submitted\n', lineEnding: '\r\n' })

    disk = 'submitted\r\n'
    await controller.reconcileUnknownSave('workspace', tab.path, tab.lifecycleId)
    expect(store.activeTab()).toMatchObject({
      baselineContent: 'submitted\n', baselineLineEnding: '\r\n',
      lineEnding: '\r\n', dirty: false, version: 'v2',
    })
    expect(store.activeTab()?.saveOutcome).toBeUndefined()
  })

  it('keeps read-only projections raw and preserves local EOL against the remote conflict baseline', async () => {
    const readOnlyStore = new DocumentSessionStore()
    readOnlyStore.selectWorkspace('workspace')
    const readOnly = new DocumentController(readOnlyStore, {
      read: async (_workspace, path) => ({
        path, content: 'raw\r\npreview', version: 'large',
        readOnlyPresentation: {
          reason: 'too-large' as const, sizeBytes: 5_000_000, limitBytes: 4_194_304,
          previewBytes: 12, truncated: true as const,
        },
      }),
      write: async (_workspace, path) => ({ path, version: 'unused' }),
    })
    await readOnly.open('workspace', 'large.txt', 'large.txt')
    expect(readOnlyStore.activeTab()).toMatchObject({ content: 'raw\r\npreview' })
    expect(readOnlyStore.activeTab()?.lineEnding).toBeUndefined()

    const documents = new DocumentSessionStore()
    documents.selectWorkspace('workspace')
    const open = documents.beginOpen('workspace', 'a.ts', 'a.ts')!
    documents.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
    const local = documents.activeTab()!
    documents.editDocument('workspace', local.path, local.lifecycleId, 'local\n')
    documents.updateWorkspaceTabs('workspace', tabs => tabs.map(candidate => candidate.path === local.path
      ? { ...candidate, externalState: 'modified' as const }
      : candidate))
    const identity = {
      workspaceId: 'workspace', workspaceEpoch: documents.getSnapshot().activeWorkspaceEpoch,
      path: local.path, lifecycleId: local.lifecycleId,
    }
    const conflictStore = new DocumentConflictStore()
    const conflict = new DocumentConflictController(conflictStore, documents, {
      read: async (_workspace, path) => ({ path, content: 'remote\r\n', version: 'v2' }),
    })
    conflict.selectWorkspace('workspace', identity.workspaceEpoch)

    await expect(conflict.compare(identity)).resolves.toBe('ready')
    expect(conflictStore.getSnapshot()).toMatchObject({
      phase: 'ready', remote: { content: 'remote\n', lineEnding: '\r\n', version: 'v2' },
    })
    await expect(conflict.keepLocal()).resolves.toBe('applied')
    expect(documents.activeTab()).toMatchObject({
      content: 'local\n', baselineContent: 'remote\n',
      lineEnding: '\n', baselineLineEnding: '\r\n', dirty: true,
    })
  })

  it('carries a closed file EOL through replacement into the ordinary CAS save path', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('workspace')
    const read = vi.fn(async (_workspace: string, path: string) => ({
      path, content: 'head\r\ntarget\r\n', version: 'v7',
    }))
    const replaceStore = new WorkspaceReplaceStore()
    replaceStore.selectWorkspace('workspace')
    const replace = new WorkspaceReplaceController(
      replaceStore, completedDiskSearch(), documents, { read },
    )

    await expect(replace.preview('changed')).resolves.toBe('ready')
    await expect(replace.apply(replaceStore.getSnapshot().preview!.token)).resolves.toBe('applied')
    expect(documents.activeTab()).toMatchObject({
      content: 'head\nchanged\n', baselineContent: 'head\ntarget\n',
      lineEnding: '\r\n', baselineLineEnding: '\r\n', dirty: true, version: 'v7',
    })

    const write = vi.fn(async (_workspace: string, path: string) => ({ path, version: 'v8' }))
    const controller = new DocumentController(documents, { read, write })
    await expect(controller.save('workspace', 'closed.ts')).resolves.toBe('saved')
    expect(write).toHaveBeenCalledWith('workspace', 'closed.ts', 'head\r\nchanged\r\n', 'v7')
  })
})
