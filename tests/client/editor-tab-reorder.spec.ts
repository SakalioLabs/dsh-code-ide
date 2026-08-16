import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  beginEditorTabDrag,
  editorTabDropPlacement,
  editorTabKeyboardReorderAction,
  EditorTabs,
  resolveEditorTabDrag,
} from '../../src/client/EditorTabs.tsx'
import {
  DocumentSessionStore,
  type DocumentIdentity,
  type EditorTab,
} from '../../src/client/documents/session.ts'

function open(store: DocumentSessionStore, path: string): EditorTab {
  const workspaceId = 'workspace'
  if (store.getSnapshot().activeWorkspaceId !== workspaceId) store.selectWorkspace(workspaceId)
  const intent = store.beginOpen(workspaceId, path, path)!
  expect(store.completeOpen(intent, { path, content: `${path}\n`, version: `v-${path}` })).toBe(true)
  return store.session(workspaceId).tabs.find(tab => tab.path === path)!
}

function exact(store: DocumentSessionStore, tab: EditorTab): DocumentIdentity {
  return {
    workspaceId: 'workspace',
    workspaceEpoch: store.getSnapshot().activeWorkspaceEpoch,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
  }
}

describe('exact editor-tab reorder', () => {
  it('moves existing tab objects before/after without activating or changing buffer state', () => {
    const store = new DocumentSessionStore()
    const first = open(store, 'a.ts')
    const second = open(store, 'b.ts')
    const third = open(store, 'c.ts')
    store.editDocument('workspace', second.path, second.lifecycleId, 'dirty\n')
    const before = store.session('workspace')
    const dirtyBefore = before.tabs[1]!

    expect(store.reorderTab(exact(store, third), exact(store, first), 'before')).toBe('applied')
    let after = store.session('workspace')
    expect(after.tabs.map(tab => tab.path)).toEqual(['c.ts', 'a.ts', 'b.ts'])
    expect(after.activePath).toBe('c.ts')
    expect(after.tabs[0]).toBe(third)
    expect(after.tabs[1]).toBe(first)
    expect(after.tabs[2]).toBe(dirtyBefore)
    expect(after.tabs[2]).toMatchObject({ content: 'dirty\n', dirty: true })

    expect(store.reorderTab(exact(store, third), exact(store, second), 'after')).toBe('applied')
    after = store.session('workspace')
    expect(after.tabs.map(tab => tab.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(after.activePath).toBe('c.ts')
  })

  it('does not publish an already satisfied placement and rejects every stale identity form', () => {
    const store = new DocumentSessionStore()
    const first = open(store, 'a.ts')
    const second = open(store, 'b.ts')
    const firstIdentity = exact(store, first)
    const secondIdentity = exact(store, second)
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.reorderTab(secondIdentity, firstIdentity, 'after')).toBe('not-needed')
    expect(listener).not.toHaveBeenCalled()
    expect(store.reorderTab(firstIdentity, { ...secondIdentity, workspaceId: 'other' }, 'before')).toBe('stale')
    expect(store.reorderTab({ ...firstIdentity, workspaceEpoch: firstIdentity.workspaceEpoch + 1 }, secondIdentity, 'before')).toBe('stale')
    expect(store.reorderTab({ ...firstIdentity, lifecycleId: firstIdentity.lifecycleId + 1 }, secondIdentity, 'before')).toBe('stale')

    expect(store.closeIfCurrent(firstIdentity)).toBe(first)
    const replacement = open(store, 'a.ts')
    expect(replacement.lifecycleId).not.toBe(first.lifecycleId)
    expect(store.reorderTab(firstIdentity, exact(store, second), 'after')).toBe('stale')
  })
})

describe('editor-tab drag adapter', () => {
  it('keeps paths out of HTML drag data and resolves only the component-owned opaque token', () => {
    const identity: DocumentIdentity = {
      workspaceId: 'workspace', workspaceEpoch: 3, path: 'private/source.ts', lifecycleId: 9,
    }
    const drag = beginEditorTabDrag(identity)

    expect(drag.token).not.toContain(identity.path)
    expect(resolveEditorTabDrag(drag, identity.path)).toBeUndefined()
    expect(resolveEditorTabDrag(drag, `${drag.token}-forged`)).toBeUndefined()
    expect(resolveEditorTabDrag(drag, drag.token)).toEqual(identity)
    expect(Object.isFrozen(drag)).toBe(true)
    expect(Object.isFrozen(drag.source)).toBe(true)
  })

  it('uses the target midpoint for deterministic before/after placement', () => {
    expect(editorTabDropPlacement(109, 100, 20)).toBe('before')
    expect(editorTabDropPlacement(110, 100, 20)).toBe('after')
    expect(editorTabDropPlacement(100, 100, -20)).toBe('after')
  })

  it('makes only tab selectors draggable and exposes the before/after description', () => {
    const tabs = ['a.ts', 'b.ts'].map((path, index): EditorTab => ({
      path,
      name: path,
      content: '',
      baselineContent: '',
      version: `v${String(index)}`,
      dirty: false,
      lifecycleId: index + 1,
      localRevision: 0,
      historyEpoch: 0,
    }))
    const html = renderToStaticMarkup(createElement(EditorTabs, {
      tabs,
      workspaceId: 'workspace',
      workspaceEpoch: 2,
      activePath: 'a.ts',
      panelId: 'editor-panel',
      onActivate: vi.fn(),
      onRequestClose: vi.fn(),
      onReorder: vi.fn(),
    }))

    expect(html.match(/draggable="true"/g)).toHaveLength(2)
    expect(html.match(/aria-describedby="editor-panel-tab-drag-description"/g)).toHaveLength(2)
    expect(html).toContain('left half of another tab to place it before')
    expect(html.match(/aria-label="Close /g)).toHaveLength(2)
  })
})

describe('editor-tab keyboard reorder adapter', () => {
  it('moves only one adjacent position with Alt+Shift+Arrow and never wraps', () => {
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowLeft', altKey: true, shiftKey: true }, 1, 3,
    )).toEqual({ kind: 'reorder', targetIndex: 0, placement: 'before' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowRight', altKey: true, shiftKey: true }, 1, 3,
    )).toEqual({ kind: 'reorder', targetIndex: 2, placement: 'after' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowLeft', altKey: true, shiftKey: true }, 0, 3,
    )).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowRight', altKey: true, shiftKey: true }, 2, 3,
    )).toEqual({ kind: 'none' })
  })

  it('ignores incomplete or conflicting modifier chords and invalid positions', () => {
    expect(editorTabKeyboardReorderAction({ key: 'ArrowLeft', altKey: true }, 1, 3)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction({ key: 'ArrowRight', shiftKey: true }, 1, 3)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowRight', altKey: true, shiftKey: true, ctrlKey: true }, 1, 3,
    )).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowRight', altKey: true, shiftKey: true, metaKey: true }, 1, 3,
    )).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction(
      { key: 'Home', altKey: true, shiftKey: true }, 1, 3,
    )).toEqual({ kind: 'none' })
    expect(editorTabKeyboardReorderAction(
      { key: 'ArrowRight', altKey: true, shiftKey: true }, -1, 3,
    )).toEqual({ kind: 'none' })
  })
})
