import { describe, expect, it, vi } from 'vitest'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import {
  WorkspaceReplaceController,
  WorkspaceReplaceStore,
} from '../../src/client/search/workspace-replace.ts'
import { WorkspaceSearchStore } from '../../src/client/search/workspace-search.ts'
import type { WorkspaceTextSearchQuery } from '../../src/shared/workspace-search.ts'

const query: WorkspaceTextSearchQuery = {
  pattern: 'foo', mode: 'literal', caseSensitive: true, wholeWord: false,
}

function completedSearch(source: 'buffer' | 'disk'): WorkspaceSearchStore {
  const search = new WorkspaceSearchStore()
  search.selectWorkspace('workspace')
  const intent = search.begin(query)!
  search.complete(intent, {
    items: [{
      path: 'a.ts', lineNumber: 1, preview: 'foo', previewStart: 0,
      ranges: [{ start: 0, end: 3 }], source,
    }],
    matchCount: 1,
    fileCount: 1,
    truncated: false,
    dirtyBuffersOmitted: false,
    limit: 500,
  })
  return search
}

function replacement(
  documents: DocumentSessionStore,
  search: WorkspaceSearchStore,
  read: (workspaceId: string, path: string) => Promise<{ path: string; content: string; version: string }>,
) {
  const store = new WorkspaceReplaceStore()
  store.selectWorkspace('workspace')
  return { store, controller: new WorkspaceReplaceController(store, search, documents, { read }) }
}

describe('Workspace replacement domain', () => {
  it('previews and atomically edits an exact dirty buffer without Host I/O', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('workspace')
    const open = documents.beginOpen('workspace', 'a.ts', 'a.ts')!
    documents.completeOpen(open, { path: 'a.ts', content: 'base\n', version: 'v1' })
    const tab = documents.activeTab()!
    documents.editDocument('workspace', tab.path, tab.lifecycleId, 'foo foo\n')
    const read = vi.fn(async () => ({ path: 'a.ts', content: 'disk\n', version: 'v1' }))
    const { store, controller } = replacement(documents, completedSearch('buffer'), read)

    await expect(controller.preview('bar')).resolves.toBe('ready')
    expect(store.getSnapshot().preview).toMatchObject({ replacementCount: 2, fileCount: 1 })
    const token = store.getSnapshot().preview!.token
    await expect(controller.apply(token)).resolves.toBe('applied')

    expect(read).not.toHaveBeenCalled()
    expect(documents.activeTab()).toMatchObject({
      lifecycleId: tab.lifecycleId, content: 'bar bar\n', version: 'v1', dirty: true,
    })
  })

  it('revalidates a closed file and opens the replacement as a dirty CAS-backed tab', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('workspace')
    const read = vi.fn(async (_workspaceId: string, path: string) => ({ path, content: 'foo\n', version: 'v7' }))
    const { store, controller } = replacement(documents, completedSearch('disk'), read)

    await expect(controller.preview('bar')).resolves.toBe('ready')
    await expect(controller.apply(store.getSnapshot().preview!.token)).resolves.toBe('applied')

    expect(read).toHaveBeenCalledTimes(2)
    expect(documents.activeTab()).toMatchObject({
      path: 'a.ts', content: 'bar\n', baselineContent: 'foo\n', version: 'v7', dirty: true,
    })
  })

  it('rejects the whole preview when an exact buffer revision changes before apply', async () => {
    const documents = new DocumentSessionStore()
    documents.selectWorkspace('workspace')
    const open = documents.beginOpen('workspace', 'a.ts', 'a.ts')!
    documents.completeOpen(open, { path: 'a.ts', content: 'foo\n', version: 'v1' })
    const original = documents.activeTab()!
    const { store, controller } = replacement(
      documents,
      completedSearch('buffer'),
      async () => ({ path: 'a.ts', content: 'foo\n', version: 'v1' }),
    )

    await controller.preview('bar')
    const token = store.getSnapshot().preview!.token
    documents.editDocument('workspace', original.path, original.lifecycleId, 'user edit\n')
    await expect(controller.apply(token)).resolves.toBe('stale')
    expect(documents.activeTab()?.content).toBe('user edit\n')
  })
})
