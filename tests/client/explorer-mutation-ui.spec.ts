import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, WorkspaceSummary } from '../../src/client/contracts.ts'
import {
  clampExplorerMenuPosition,
  explorerContextDismissRestoresFocus,
  explorerDeleteImpactMessages,
  explorerFocusTrapIndex,
  explorerMutationShortcut,
  explorerMutationNameInputLabel,
  explorerMutationNameKeyboardHint,
  explorerRenameSelectionRanges,
  InvalidMutationRecoveryDialogBody,
  nextExplorerMenuIndex,
  validateExplorerMutationName,
  type ExplorerMutationController,
} from '../../src/client/ExplorerMutationUi.tsx'
import {
  beginExplorerDeleteMutation,
  explorerCreateParentPath,
  explorerDragIdentityIsCurrent,
  explorerMoveDestinationParent,
  explorerKeyboardAction,
  explorerMutationSource,
  FileExplorer,
} from '../../src/client/FileExplorer.tsx'
import { explorerFileIconKind } from '../../src/client/icons.tsx'
import { ExplorerController } from '../../src/client/explorer/controller.ts'
import { deriveVisibleExplorerRows } from '../../src/client/explorer/model.ts'
import { ExplorerStore } from '../../src/client/explorer/store.ts'
import { WorkspaceMutationStore, type MutationSource } from '../../src/client/mutations/store.ts'

const workspace: WorkspaceSummary = {
  workspaceId: 'workspace-mutation-ui',
  title: 'Mutation UI',
  path: 'C:/mutation-ui',
}
const source: FileEntry = { name: 'src', path: 'src', type: 'directory', version: 'dir-v1' }
const app: FileEntry = { name: 'app.test.ts', path: 'src/app.test.ts', type: 'file', version: 'file-v1' }
const readme: FileEntry = { name: 'README.md', path: 'README.md', type: 'file', version: 'readme-v1' }

function populatedExplorerStore(): ExplorerStore {
  const store = new ExplorerStore()
  store.selectWorkspace(workspace.workspaceId)
  store.setDirectoryEntries(workspace.workspaceId, '', [source, readme])
  store.setExpanded(workspace.workspaceId, source.path, true)
  store.setDirectoryEntries(workspace.workspaceId, source.path, [app])
  store.setFocus(workspace.workspaceId, app.path)
  store.setSelected(workspace.workspaceId, app.path)
  return store
}

function explorerController(store: ExplorerStore): ExplorerController {
  return new ExplorerController(store, { list: vi.fn(async () => ({ entries: [] })) })
}

function mutationController(): ExplorerMutationController {
  return {
    beginCreate: vi.fn(),
    beginRename: vi.fn(),
    beginDelete: vi.fn(),
    updateName: vi.fn(),
    requestConfirmation: vi.fn(),
    submit: vi.fn(async () => 'committed' as const),
    reconcileUnknown: vi.fn(async () => 'committed' as const),
    retryCommitted: vi.fn(async () => 'committed' as const),
    acknowledgeUnresolvedOutcome: vi.fn(async () => 'acknowledged' as const),
    cancel: vi.fn(),
  }
}

describe('Explorer mutation pure interaction policy', () => {
  it('matches Host portable-name rules, including its private namespace and DOS superscripts', () => {
    expect(validateExplorerMutationName('计划.md')).toEqual({ valid: true })
    for (const name of [
      '', '.', '..', 'a/b', 'a\\b', 'bad?', 'tail.', 'tail ', 'CON', 'nul.txt',
      'COM¹.log', 'lpt³', '.__dsh_code_ide_quarantine_x', '.__DSH_CODE_IDE_STAGING_X',
      '界'.repeat(86),
    ]) {
      expect(validateExplorerMutationName(name), name).toMatchObject({ valid: false })
    }
    expect(validateExplorerMutationName('', 'zh')).toEqual({ valid: false, message: '请输入名称。' })
    expect(validateExplorerMutationName('CON', 'zh')).toEqual({ valid: false, message: '该名称是 Windows 保留名称。' })
    expect(explorerMutationNameInputLabel('create', 'file', 'zh')).toBe('新建文件名称')
    expect(explorerMutationNameInputLabel('rename', 'directory', 'zh')).toBe('重命名文件夹名称')
    expect(explorerMutationNameKeyboardHint('zh')).toContain('按 Enter 应用')
  })

  it('cycles rename selection stem, full name, then suffix; dotfiles and folders select all', () => {
    expect(explorerRenameSelectionRanges('app.test.ts', 'file')).toEqual([
      { start: 0, end: 8, part: 'stem' },
      { start: 0, end: 11, part: 'all' },
      { start: 9, end: 11, part: 'extension' },
    ])
    expect(explorerRenameSelectionRanges('.env', 'file')).toEqual([
      { start: 0, end: 4, part: 'all' },
    ])
    expect(explorerRenameSelectionRanges('folder.name', 'directory')).toEqual([
      { start: 0, end: 11, part: 'all' },
    ])
  })

  it('never routes editable-descendant or composing keys to mutation or APG tree handlers', () => {
    const editable = {
      key: 'ArrowRight', altKey: false, ctrlKey: false, metaKey: false, editableTarget: true,
    }
    expect(explorerKeyboardAction(editable)).toBeUndefined()
    expect(explorerKeyboardAction({ ...editable, key: ' ' })).toBeUndefined()
    expect(explorerMutationShortcut({ ...editable, shiftKey: false })).toBeUndefined()
    expect(explorerMutationShortcut({ ...editable, key: 'F2', editableTarget: false, shiftKey: false }))
      .toBe('rename')
    expect(explorerMutationShortcut({
      ...editable, key: 'Delete', editableTarget: false, shiftKey: false, isComposing: true,
    })).toBeUndefined()
    expect(explorerMutationShortcut({
      ...editable, key: 'F10', editableTarget: false, shiftKey: true,
    })).toBe('context-menu')
  })

  it('implements disabled-aware menu roving, bounded placement, and cyclic focus trapping', () => {
    const enabled = [true, false, true]
    expect(nextExplorerMenuIndex(-1, 'Home', enabled)).toBe(0)
    expect(nextExplorerMenuIndex(0, 'ArrowDown', enabled)).toBe(2)
    expect(nextExplorerMenuIndex(2, 'ArrowDown', enabled)).toBe(0)
    expect(nextExplorerMenuIndex(0, 'ArrowUp', enabled)).toBe(2)
    expect(nextExplorerMenuIndex(-1, 'End', enabled)).toBe(2)
    expect(nextExplorerMenuIndex(-1, 'Home', [false, false])).toBe(-1)

    expect(clampExplorerMenuPosition(990, 790, 1_000, 800)).toEqual({ left: 770, top: 626 })
    expect(clampExplorerMenuPosition(-10, -20, 1_000, 800)).toEqual({ left: 6, top: 6 })
    expect(explorerFocusTrapIndex(0, 3, true)).toBe(2)
    expect(explorerFocusTrapIndex(2, 3, false)).toBe(0)
  })

  it('restores the row for Escape but lets an outside pointer or activated item own focus', () => {
    expect(explorerContextDismissRestoresFocus('escape')).toBe(true)
    expect(explorerContextDismissRestoresFocus('outside-pointer')).toBe(false)
    expect(explorerContextDismissRestoresFocus('item-activation')).toBe(false)
  })

  it('chooses create parents without manufacturing entries and requires mutable versions', () => {
    const store = populatedExplorerStore()
    const rows = deriveVisibleExplorerRows(store.session(workspace.workspaceId))
    expect(explorerCreateParentPath(rows, source.path)).toBe(source.path)
    expect(explorerCreateParentPath(rows, app.path)).toBe(source.path)
    expect(explorerCreateParentPath(rows, undefined)).toBe('')
    expect(explorerMutationSource(app)).toEqual({ path: app.path, type: 'file', version: 'file-v1' })
    expect(explorerMutationSource({ ...app, version: undefined })).toBeUndefined()
    expect(explorerMutationSource({ ...app, type: 'other' })).toBeUndefined()
  })

  it('classifies mainstream suffixes and admits only a current internal move to a safe folder', () => {
    expect([
      'a.py', 'a.js', 'a.ts', 'a.json', 'a.html', 'a.css', 'a.md', 'a.c', 'a.cpp',
      'a.java', 'a.go', 'a.rs', 'a.sh', 'a.ps1', 'a.yaml', 'a.xml', 'a.sql',
    ].map(name => explorerFileIconKind(name, 'file'))).toEqual([
      'python', 'javascript', 'typescript', 'json', 'html', 'css', 'markdown', 'c', 'cpp',
      'java', 'go', 'rust', 'shell', 'powershell', 'yaml', 'xml', 'sql',
    ])
    expect(explorerFileIconKind('folder', 'directory')).toBe('folder')
    expect(explorerFileIconKind('LICENSE', 'file')).toBe('file')

    const store = populatedExplorerStore()
    const rows = deriveVisibleExplorerRows(store.session(workspace.workspaceId))
    const epoch = store.getSnapshot().activeWorkspaceEpoch
    const appSource = explorerMutationSource(app)!
    const destination: FileEntry = {
      name: 'lib', path: 'lib', type: 'directory', version: 'lib-v1',
    }
    const child: FileEntry = {
      name: 'child', path: 'src/child', type: 'directory', version: 'child-v1',
    }

    expect(explorerMoveDestinationParent(appSource, destination)).toBe('lib')
    expect(explorerMoveDestinationParent(appSource, source)).toBeUndefined()
    expect(explorerMoveDestinationParent(explorerMutationSource(source)!, source)).toBeUndefined()
    expect(explorerMoveDestinationParent(explorerMutationSource(source)!, child)).toBeUndefined()
    expect(explorerMoveDestinationParent(appSource, { ...destination, type: 'file' })).toBeUndefined()

    const identity = { workspaceId: workspace.workspaceId, workspaceEpoch: epoch, source: appSource }
    expect(explorerDragIdentityIsCurrent(identity, workspace.workspaceId, epoch, rows)).toBe(true)
    expect(explorerDragIdentityIsCurrent(identity, 'another-workspace', epoch, rows)).toBe(false)
    expect(explorerDragIdentityIsCurrent(identity, workspace.workspaceId, epoch + 1, rows)).toBe(false)
    expect(explorerDragIdentityIsCurrent({
      ...identity,
      source: { ...identity.source, version: 'stale-version' },
    }, workspace.workspaceId, epoch, rows)).toBe(false)
  })

  it('delegates delete once because the controller owns confirmation admission', () => {
    const requestConfirmation = vi.fn()
    const deleteSource: MutationSource = { path: 'src', type: 'directory', version: 'dir-v1' }
    const beginDelete = vi.fn((value: MutationSource) => {
      requestConfirmation(value)
      return true
    })

    expect(beginExplorerDeleteMutation({ beginDelete }, deleteSource)).toBe(true)
    expect(beginDelete).toHaveBeenCalledOnce()
    expect(requestConfirmation).toHaveBeenCalledOnce()
  })

  it('describes recursive, open-document, and dirty-buffer delete impact', () => {
    expect(explorerDeleteImpactMessages(
      { path: 'src', type: 'directory', version: 'dir-v1' },
      { affectedDocuments: 2, preservesDirtyFile: true, blockers: [] },
    )).toEqual([
      'src will be permanently deleted. This cannot be undone.',
      'The folder and all of its contents will be deleted recursively.',
      '2 open documents are affected.',
      'The dirty editor buffer remains open in memory, but its file on disk will be removed.',
    ])
    expect(explorerDeleteImpactMessages(
      { path: 'src', type: 'directory', version: 'dir-v1' },
      { affectedDocuments: 2, preservesDirtyFile: true, blockers: [] },
      'zh',
    )).toEqual([
      'src 将被永久删除。此操作无法撤销。', '此文件夹及其所有内容将被递归删除。',
      '将影响 2 个打开的文档。', '未保存的编辑器缓冲区仍会保留在内存中，但磁盘上的文件将被删除。',
    ])
  })
})

describe('Explorer mutation SSR adapter', () => {
  it('projects invalid recovery as one two-step alertdialog with explicit disk-safety copy', () => {
    const initial = renderToStaticMarkup(createElement(InvalidMutationRecoveryDialogBody, {
      titleId: 'invalid-title',
      descriptionId: 'invalid-description',
      reviewed: false,
      busy: false,
      canReset: true,
      onDismiss: vi.fn(),
      onReview: vi.fn(),
      onKeep: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(initial).toContain('role="alertdialog"')
    expect(initial).toContain('Review Safety-Fence Release...')
    expect(initial).not.toContain('Stop Tracking Without Deciding')
    expect(initial).toContain('will not decide, retry, undo, or roll back any disk result')
    expect(initial).toContain('Inspect the workspace manually')

    const reviewed = renderToStaticMarkup(createElement(InvalidMutationRecoveryDialogBody, {
      titleId: 'invalid-title',
      descriptionId: 'invalid-description',
      reviewed: true,
      busy: false,
      canReset: true,
      onDismiss: vi.fn(),
      onReview: vi.fn(),
      onKeep: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(reviewed).toContain('Stop Tracking Without Deciding')
    expect(reviewed).not.toContain('Review Safety-Fence Release...')
    expect(reviewed.match(/role="alertdialog"/gu)).toHaveLength(1)
    expect(reviewed).toContain('valid pending, committed, or manual recovery will be preserved')
  })

  it('renders all toolbar actions even before the optional mutation workflow is wired', () => {
    const explorerStore = populatedExplorerStore()
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: explorerStore,
      controller: explorerController(explorerStore),
      onOpen: vi.fn(),
    }))

    expect(html).toContain('aria-label="New File"')
    expect(html).toContain('aria-label="New Folder"')
    expect(html).toContain('aria-label="Refresh Explorer"')
  })

  it('gates create toolbar actions by exact capability without hiding the mutation adapter', () => {
    const explorerStore = populatedExplorerStore()
    const mutations = new WorkspaceMutationStore()
    mutations.selectWorkspace(workspace.workspaceId, 1)
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: explorerStore,
      controller: explorerController(explorerStore),
      onOpen: vi.fn(),
      mutationStore: mutations,
      mutationController: mutationController(),
      mutationAdmissionEnabled: true,
      mutationCreateFileEnabled: true,
      mutationCreateDirectoryEnabled: false,
      mutationRenameEnabled: true,
      mutationDeleteEnabled: false,
    }))

    expect(html).toMatch(/<button[^>]*aria-label="New File"[^>]*>/u)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="New File"/u)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="New Folder"/u)
  })

  it('keeps an admitted recovery visible after admission and all capabilities are withdrawn', () => {
    const explorerStore = populatedExplorerStore()
    const mutations = new WorkspaceMutationStore()
    mutations.selectWorkspace(workspace.workspaceId, 1)
    mutations.beginEditing({
      kind: 'rename', source: { path: app.path, type: 'file', version: 'file-v1' }, name: 'renamed.ts',
    })
    mutations.beginConfirming({ affectedDocuments: 0, preservesDirtyFile: false, blockers: [] })
    mutations.beginSubmitting('operation', 'provider')
    mutations.markUnknown('operation', { code: 'MUTATION_PENDING', message: 'Still checking.' })
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: explorerStore,
      controller: explorerController(explorerStore),
      onOpen: vi.fn(),
      mutationStore: mutations,
      mutationController: mutationController(),
      mutationAdmissionEnabled: false,
      mutationCreateFileEnabled: false,
      mutationCreateDirectoryEnabled: false,
      mutationRenameEnabled: false,
      mutationDeleteEnabled: false,
    }))

    expect(html).toContain('aria-label="Rename file name"')
    expect(html).toContain('Still checking.')
    expect(html).toContain('Check Status')
  })

  it('renders a distinct synthetic create row with the draft input as the sole tree roving stop', () => {
    const explorerStore = populatedExplorerStore()
    const mutations = new WorkspaceMutationStore()
    mutations.selectWorkspace(workspace.workspaceId, 1)
    mutations.beginEditing({
      kind: 'create', parentPath: source.path, name: 'new-file.ts', resourceKind: 'file',
    })
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: explorerStore,
      controller: explorerController(explorerStore),
      onOpen: vi.fn(),
      mutationStore: mutations,
      mutationController: mutationController(),
    }))

    expect(html.match(/role="treeitem"/g)).toHaveLength(4)
    expect(html.match(/data-explorer-path=/g)).toHaveLength(3)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toContain('data-workbench-focus="explorer-edit"')
    expect(html).toContain('aria-label="New file name"')
    expect(html).toContain('value="new-file.ts"')
  })

  it('keeps the real rename row identity while replacing only its label with the editor', () => {
    const explorerStore = populatedExplorerStore()
    const mutations = new WorkspaceMutationStore()
    mutations.selectWorkspace(workspace.workspaceId, 1)
    mutations.beginEditing({
      kind: 'rename', source: { path: app.path, type: 'file', version: 'file-v1' }, name: app.name,
    })
    const html = renderToStaticMarkup(createElement(FileExplorer, {
      workspace,
      store: explorerStore,
      controller: explorerController(explorerStore),
      onOpen: vi.fn(),
      mutationStore: mutations,
      mutationController: mutationController(),
    }))

    expect(html.match(/role="treeitem"/g)).toHaveLength(3)
    expect(html).toContain(`data-explorer-path="${app.path}"`)
    expect(html).toContain('aria-label="Rename file name"')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  })
})
