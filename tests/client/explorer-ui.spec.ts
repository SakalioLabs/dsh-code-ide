import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, WorkspaceSummary } from '../../src/client/contracts.ts'
import {
  applyExplorerKeyboardAction,
  applyExplorerRowClick,
  explorerKeyboardAction,
  explorerOwnsDeferredFocus,
  explorerOwnsRemovedFocusRecovery,
  explorerRelativePathClipboardAction,
  explorerRovingPath,
  FileExplorer,
  type ExplorerKeyboardController,
  type ExplorerRowController,
} from '../../src/client/FileExplorer.tsx'
import { ExplorerController } from '../../src/client/explorer/controller.ts'
import { deriveVisibleExplorerRows } from '../../src/client/explorer/model.ts'
import { ExplorerStore } from '../../src/client/explorer/store.ts'

const workspace: WorkspaceSummary = {
  workspaceId: 'workspace-1',
  title: 'Demo workspace',
  path: 'C:/demo',
}
const source: FileEntry = { name: 'src', path: 'src', type: 'directory' }
const readme: FileEntry = { name: 'README.md', path: 'README.md', type: 'file' }
const app: FileEntry = { name: 'app.ts', path: 'src/app.ts', type: 'file' }

function populatedStore(): ExplorerStore {
  const store = new ExplorerStore()
  store.selectWorkspace(workspace.workspaceId)
  store.setDirectoryEntries(workspace.workspaceId, '', [source, readme])
  store.setExpanded(workspace.workspaceId, source.path, true)
  store.setDirectoryEntries(workspace.workspaceId, source.path, [app])
  store.setFocus(workspace.workspaceId, app.path)
  store.setSelected(workspace.workspaceId, app.path)
  return store
}

function controllerFor(store: ExplorerStore): ExplorerController {
  return new ExplorerController(store, {
    list: vi.fn(async () => ({ entries: [] })),
  })
}

describe('FileExplorer accessibility adapter', () => {
  it('keeps a programmatic Explorer focus target when no workspace is selected', () => {
    const store = new ExplorerStore()
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace: undefined,
      store,
      controller: controllerFor(store),
      onOpen: vi.fn(),
      focusRequest: 1,
    }))
    expect(html).toContain('data-workbench-focus="explorer"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('No workspace selected')
  })

  it('renders a named, flat APG tree with one selected row and one roving tab stop', () => {
    const store = populatedStore()
    store.setDirectoryLoading(workspace.workspaceId, source.path)
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store,
      controller: controllerFor(store),
      onOpen: vi.fn(),
    }))

    expect(html).toContain('role="tree"')
    expect(html).toContain('aria-label="Files in Demo workspace"')
    expect(html).toContain('aria-multiselectable="false"')
    expect(html.match(/role="treeitem"/g)).toHaveLength(3)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    const sourceTag = html.match(/<div role="treeitem"[^>]*title="src">/)?.[0]
    const appTag = html.match(/<div role="treeitem"[^>]*title="src\/app.ts">/)?.[0]
    expect(sourceTag).toContain('aria-selected="false"')
    expect(sourceTag).toContain('aria-expanded="true"')
    expect(sourceTag).toContain('aria-level="1"')
    expect(sourceTag).toContain('aria-posinset="1"')
    expect(sourceTag).toContain('aria-setsize="2"')
    expect(appTag).toContain('aria-selected="true"')
    expect(appTag).toContain('aria-level="2"')
    expect(appTag).toContain('aria-posinset="1"')
    expect(appTag).toContain('aria-setsize="1"')
    expect(appTag).toContain('tabindex="0"')
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading src…')
  })

  it('enables Collapse Folders only while a non-root directory is expanded', () => {
    const store = populatedStore()
    const render = (): string => renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store,
      controller: controllerFor(store),
      onOpen: vi.fn(),
    }))
    const collapseButton = (html: string): string | undefined =>
      html.match(/<button[^>]*aria-label="Collapse Folders in Explorer"[^>]*>/u)?.[0]

    const expanded = collapseButton(render())
    expect(expanded).toBeDefined()
    expect(expanded).not.toContain('disabled')

    expect(store.collapseAll(workspace.workspaceId)).toBe(true)
    expect(collapseButton(render())).toContain('disabled=""')
  })

  it('keeps loading, empty and failure announcements out of the treeitem projection', () => {
    const loadingStore = new ExplorerStore()
    loadingStore.selectWorkspace(workspace.workspaceId)
    loadingStore.setDirectoryLoading(workspace.workspaceId, '')
    const loading = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: loadingStore,
      controller: controllerFor(loadingStore),
      onOpen: vi.fn(),
    }))
    expect(loading).toContain('Loading files…')
    expect(loading).not.toContain('role="treeitem"')
    expect(loading).toContain('role="tree"')
    expect(loading).toContain('tabindex="0"')

    const failedStore = new ExplorerStore()
    failedStore.selectWorkspace(workspace.workspaceId)
    failedStore.setDirectoryError(workspace.workspaceId, '', new Error('offline'))
    const failed = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: failedStore,
      controller: controllerFor(failedStore),
      onOpen: vi.fn(),
    }))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Could not load Demo workspace: offline')
    expect(failed).not.toContain('role="treeitem"')
  })

  it('renders the workspace-empty state without inventing a selectable row', () => {
    const store = new ExplorerStore()
    store.selectWorkspace(workspace.workspaceId)
    store.setDirectoryEntries(workspace.workspaceId, '', [])
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store,
      controller: controllerFor(store),
      onOpen: vi.fn(),
    }))

    expect(html).toContain('Workspace is empty')
    expect(html).not.toContain('role="treeitem"')
  })
})

describe('FileExplorer pure interaction handlers', () => {
  it('copies only the exact visible entry path through the injected write-only port', async () => {
    const writeClipboard = vi.fn(async (_value: string) => undefined)
    const file = explorerRelativePathClipboardAction(
      { name: '文 件.ts', path: 'src/文 件.ts', type: 'file' },
      writeClipboard,
    )
    const directory = explorerRelativePathClipboardAction(source, writeClipboard)
    expect(file).toBeDefined()
    expect(directory).toBeDefined()
    expect(explorerRelativePathClipboardAction(undefined, writeClipboard)).toBeUndefined()
    expect(explorerRelativePathClipboardAction(app, undefined)).toBeUndefined()

    await file?.()
    expect(writeClipboard).toHaveBeenCalledOnce()
    expect(writeClipboard).toHaveBeenLastCalledWith('src/文 件.ts')
    await directory?.()
    expect(writeClipboard).toHaveBeenCalledTimes(2)
    expect(writeClipboard).toHaveBeenLastCalledWith('src')

    const rejected = explorerRelativePathClipboardAction(app, async () => {
      throw new DOMException('permission denied', 'NotAllowedError')
    })
    await expect(rejected?.()).rejects.toThrow('permission denied')
  })

  it('normalizes only unmodified APG keys and printable typeahead characters', () => {
    expect(explorerKeyboardAction({ key: 'ArrowDown', altKey: false, ctrlKey: false, metaKey: false }))
      .toEqual({ kind: 'tree', key: 'ArrowDown' })
    expect(explorerKeyboardAction({ key: '*', altKey: false, ctrlKey: false, metaKey: false }))
      .toEqual({ kind: 'tree', key: '*' })
    expect(explorerKeyboardAction({ key: 'λ', altKey: false, ctrlKey: false, metaKey: false }))
      .toEqual({ kind: 'typeahead', character: 'λ' })
    expect(explorerKeyboardAction({ key: 'f', altKey: false, ctrlKey: true, metaKey: false })).toBeUndefined()
    expect(explorerKeyboardAction({
      key: 'Process', altKey: false, ctrlKey: false, metaKey: false, isComposing: true,
    })).toBeUndefined()
  })

  it('delegates tree keys and opens only the controller activation target', async () => {
    const store = populatedStore()
    const rows = deriveVisibleExplorerRows(store.session(workspace.workspaceId))
    const open = vi.fn()
    const controller: ExplorerKeyboardController = {
      handleTreeKey: vi.fn(async () => ({ focusPath: app.path, activatePath: app.path })),
      typeahead: vi.fn(() => readme.path),
    }

    await expect(applyExplorerKeyboardAction(
      controller, { kind: 'tree', key: 'Enter' }, rows, open,
    )).resolves.toBe(app.path)
    expect(controller.handleTreeKey).toHaveBeenCalledWith('Enter')
    expect(open).toHaveBeenCalledWith(app)

    await expect(applyExplorerKeyboardAction(
      controller, { kind: 'typeahead', character: 'r' }, rows, open,
    )).resolves.toBe(readme.path)
    expect(controller.typeahead).toHaveBeenCalledWith('r')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('makes click selection explicit, toggling directories and opening files', async () => {
    const controller: ExplorerRowController = {
      setFocus: vi.fn(),
      setSelected: vi.fn(),
      toggle: vi.fn(async () => {}),
    }
    const open = vi.fn()

    await applyExplorerRowClick(controller, source, open)
    expect(controller.setFocus).toHaveBeenLastCalledWith(source.path)
    expect(controller.setSelected).toHaveBeenLastCalledWith(source.path)
    expect(controller.toggle).toHaveBeenCalledWith(source.path)
    expect(open).not.toHaveBeenCalled()

    await applyExplorerRowClick(controller, app, open)
    expect(controller.setFocus).toHaveBeenLastCalledWith(app.path)
    expect(controller.setSelected).toHaveBeenLastCalledWith(app.path)
    expect(open).toHaveBeenCalledWith(app)
    expect(controller.toggle).toHaveBeenCalledTimes(1)
  })

  it('chooses a visible logical focus, then selection, then the first row', () => {
    const store = populatedStore()
    const rows = deriveVisibleExplorerRows(store.session(workspace.workspaceId))

    expect(explorerRovingPath(rows, app.path, readme.path)).toBe(app.path)
    expect(explorerRovingPath(rows, 'hidden/path', readme.path)).toBe(readme.path)
    expect(explorerRovingPath(rows, 'hidden/path', 'also/hidden')).toBe(source.path)
    expect(explorerRovingPath([], app.path, app.path)).toBeUndefined()
  })

  it('does not commit delayed keyboard focus after focus leaves the tree or a newer action wins', () => {
    expect(explorerOwnsDeferredFocus(4, 4, true)).toBe(true)
    expect(explorerOwnsDeferredFocus(4, 5, true)).toBe(false)
    expect(explorerOwnsDeferredFocus(4, 4, false)).toBe(false)
  })

  it('recovers a removed focused row only when the same focused document still owns body focus', () => {
    const eligible = {
      expectedGeneration: 3,
      currentGeneration: 3,
      documentHasFocus: true,
      activeElementIsBody: true,
      removedRowStillVisible: false,
      fallbackExists: true,
    }
    expect(explorerOwnsRemovedFocusRecovery(eligible)).toBe(true)
    expect(explorerOwnsRemovedFocusRecovery({ ...eligible, currentGeneration: 4 })).toBe(false)
    expect(explorerOwnsRemovedFocusRecovery({ ...eligible, documentHasFocus: false })).toBe(false)
    expect(explorerOwnsRemovedFocusRecovery({ ...eligible, activeElementIsBody: false })).toBe(false)
    expect(explorerOwnsRemovedFocusRecovery({ ...eligible, removedRowStillVisible: true })).toBe(false)
  })
})
