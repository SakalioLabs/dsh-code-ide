import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  editorTabAccessibleLabel,
  editorTabAuxiliaryAction,
  editorTabDomId,
  editorTabFocusTargetIndex,
  editorTabIdentity,
  editorTabKeyboardAction,
  EditorTabs,
  type EditorTabsProps,
} from '../../src/client/EditorTabs.tsx'
import type { EditorTab } from '../../src/client/documents/session.ts'

function tab(path: string, lifecycleId: number, overrides: Partial<EditorTab> = {}): EditorTab {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    name,
    content: '',
    version: `v-${lifecycleId}`,
    baselineContent: '',
    dirty: false,
    lifecycleId,
    localRevision: 0,
    historyEpoch: 0,
    ...overrides,
  }
}

function props(overrides: Partial<EditorTabsProps> = {}): EditorTabsProps {
  return {
    tabs: [tab('src/first.ts', 7), tab('src/nested/second.ts', 8, { dirty: true })],
    workspaceId: 'workspace-a',
    workspaceEpoch: 4,
    activePath: 'src/nested/second.ts',
    panelId: 'editor-panel',
    onActivate: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  }
}

describe('editor tab keyboard decisions', () => {
  it('wraps directional navigation and supports Home, End, and Delete', () => {
    expect(editorTabKeyboardAction({ key: 'ArrowLeft' }, 0, 3)).toEqual({ kind: 'activate', index: 2 })
    expect(editorTabKeyboardAction({ key: 'ArrowRight' }, 2, 3)).toEqual({ kind: 'activate', index: 0 })
    expect(editorTabKeyboardAction({ key: 'Home' }, 2, 3)).toEqual({ kind: 'activate', index: 0 })
    expect(editorTabKeyboardAction({ key: 'End' }, 0, 3)).toEqual({ kind: 'activate', index: 2 })
    expect(editorTabKeyboardAction({ key: 'Delete' }, 1, 3)).toEqual({ kind: 'close', index: 1 })
  })

  it('does not consume unrelated, modified, or out-of-range input', () => {
    expect(editorTabKeyboardAction({ key: 'Enter' }, 0, 2)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardAction({ key: 'ArrowRight', ctrlKey: true }, 0, 2)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardAction({ key: 'Delete', altKey: true }, 0, 2)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardAction({ key: 'End' }, -1, 2)).toEqual({ kind: 'none' })
    expect(editorTabKeyboardAction({ key: 'End' }, 0, 0)).toEqual({ kind: 'none' })
  })
})

describe('editor tab auxiliary-pointer decisions', () => {
  it('owns only the middle mouse button for close', () => {
    expect(editorTabAuxiliaryAction({ button: 1 })).toBe('close')
    expect(editorTabAuxiliaryAction({ button: 0 })).toBe('none')
    expect(editorTabAuxiliaryAction({ button: 2 })).toBe('none')
    expect(editorTabAuxiliaryAction({ button: 3 })).toBe('none')
  })
})

describe('editor tab presentation helpers', () => {
  it('builds an exact lifecycle identity and deterministic tabpanel relationship id', () => {
    const source = tab('src/file.ts', 42)
    expect(editorTabIdentity(source, 'workspace-a', 9)).toEqual({
      workspaceId: 'workspace-a',
      workspaceEpoch: 9,
      path: 'src/file.ts',
      lifecycleId: 42,
    })
    expect(editorTabDomId('editor-panel', 3)).toBe('editor-panel-tab-3')
  })

  it('announces the full path and every safety-relevant state', () => {
    const label = editorTabAccessibleLabel(tab('src/nested/file.ts', 2, {
      dirty: true,
      externalState: 'deleted',
      pendingSaveId: 3,
      pendingReloadId: 4,
      saveOutcome: 'unknown',
      saveError: 'write failed',
      loadError: 'read failed',
    }))
    expect(label).toBe(
      'src/nested/file.ts, unsaved changes, deleted outside the IDE, saving, reloading, save outcome unknown, save failed, load failed',
    )
    expect(editorTabAccessibleLabel(tab('src/plain.ts', 1))).toBe('src/plain.ts')
  })

  it('resolves explicit or active focus and refuses a stale requested path', () => {
    const tabs = [tab('a.ts', 1), tab('b.ts', 2)]
    expect(editorTabFocusTargetIndex(tabs, 'b.ts', { requestId: 1 })).toBe(1)
    expect(editorTabFocusTargetIndex(tabs, 'a.ts', { requestId: 2, path: 'b.ts' })).toBe(1)
    expect(editorTabFocusTargetIndex(tabs, 'a.ts', { requestId: 3, path: 'retired.ts' })).toBe(-1)
  })
})

describe('EditorTabs SSR contract', () => {
  it('renders a named tablist, exact active roving tab, controls, and mouse close controls', () => {
    const html = renderToStaticMarkup(createElement(EditorTabs, props()))
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Open editors"')
    expect(html).toContain('aria-orientation="horizontal"')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
    expect(html.match(/role="presentation"/g)).toHaveLength(2)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    // The two close buttons are deliberately removed from sequential focus.
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html.match(/aria-selected="false"/g)).toHaveLength(1)
    expect(html.match(/aria-controls="editor-panel"/g)).toHaveLength(2)
    expect(html).toContain('id="editor-panel-tab-1"')
    expect(html).toContain('aria-label="src/nested/second.ts, unsaved changes"')
    expect(html).toContain('aria-label="Close src/first.ts"')
    expect(html).toContain('aria-label="Close src/nested/second.ts"')
  })

  it('keeps one keyboard entry point without fabricating selection during a transient empty active path', () => {
    const html = renderToStaticMarkup(createElement(EditorTabs, props({ activePath: undefined })))
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/aria-selected="true"/g)).toBeNull()
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2)
  })

  it('renders an empty named tablist without a phantom tab stop', () => {
    const html = renderToStaticMarkup(createElement(EditorTabs, props({ tabs: [], activePath: undefined })))
    expect(html).toContain('role="tablist"')
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('tabindex="0"')
  })
})
