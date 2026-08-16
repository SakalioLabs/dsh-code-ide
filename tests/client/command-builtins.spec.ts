import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../src/client/commands/registry.ts'
import { WorkbenchCommandRuntime } from '../../src/client/commands/runtime.ts'
import type { KeybindingSettingsMutationPort } from '../../src/client/commands/keybindings.ts'
import {
  registerWorkbenchCommands,
  type WorkbenchCommandActions,
  type WorkbenchCommandContext,
} from '../../src/client/commands/workbench.ts'

function initialContext(): WorkbenchCommandContext {
  return {
    workspaceSelected: true,
    activeEditor: true,
    multipleEditors: true,
    activeEditorDirty: true,
    activeEditorSaving: false,
    activeEditorDeleted: false,
    activeEditorReadOnly: false,
    activeEditorEditable: true,
    activeEditorUndoAvailable: true,
    activeEditorRedoAvailable: true,
    navigateBackAvailable: true,
    navigateForwardAvailable: true,
    reopenableEditor: true,
    searchResultsAvailable: true,
    saveableDirtyEditors: true,
    workspaceMutationsAvailable: true,
    workspaceCreateFileAvailable: true,
    workspaceCreateDirectoryAvailable: true,
    workspaceRenameAvailable: true,
    workspaceDeleteAvailable: true,
    explorerMutableEntryAvailable: true,
    workspaceMutationIdle: true,
    terminalCanCreate: true,
    terminalCanNavigate: true,
    terminalCanClear: true,
    quickInputMode: 'none',
    railView: 'explorer',
    compact: false,
    compactTerminalVisible: false,
    compactPanel: 'none',
  }
}

function actions(): WorkbenchCommandActions {
  return {
    showCommands: vi.fn(), showKeyboardShortcuts: vi.fn(), showQuickOpen: vi.fn(), showExplorer: vi.fn(), showSearch: vi.fn(),
    toggleTerminal: vi.fn(), createTerminal: vi.fn(), focusNextTerminal: vi.fn(), focusPreviousTerminal: vi.fn(),
    clearTerminal: vi.fn(),
    focusHarness: vi.fn(), refreshExplorer: vi.fn(async () => undefined),
    nextEditor: vi.fn(), previousEditor: vi.fn(), showGoToLine: vi.fn(), toggleWordWrap: vi.fn(),
    navigateBack: vi.fn(async () => undefined), navigateForward: vi.fn(async () => undefined),
    undoActiveEditor: vi.fn(), redoActiveEditor: vi.fn(), toggleLineComment: vi.fn(), trimTrailingWhitespace: vi.fn(),
    convertIndentationToSpaces: vi.fn(), convertIndentationToTabs: vi.fn(),
    showChangeEndOfLine: vi.fn(), showChangeIndentationSize: vi.fn(), showChangeLanguageMode: vi.fn(),
    closeActiveEditor: vi.fn(), closeAllEditors: vi.fn(), reopenClosedEditor: vi.fn(async () => undefined),
    nextSearchResult: vi.fn(async () => undefined), previousSearchResult: vi.fn(async () => undefined),
    focusActiveEditor: vi.fn(),
    revealActiveFile: vi.fn(async () => undefined),
    copyRelativePathOfActiveFile: vi.fn(async () => undefined),
    createFile: vi.fn(), createFolder: vi.fn(),
    renameExplorerEntry: vi.fn(), deleteExplorerEntry: vi.fn(),
    saveActive: vi.fn(async () => 'saved'), saveAll: vi.fn(async () => undefined),
    revertActive: vi.fn(async () => 'reverted'),
    recreateDeleted: vi.fn(async () => 'saved'),
    checkSaveOutcome: vi.fn(async () => undefined),
  }
}

describe('built-in workbench commands', () => {
  it('publishes context changes only when a scalar value changes', async () => {
    const runtime = new WorkbenchCommandRuntime('windows')
    const contextChanged = vi.spyOn(runtime.registry, 'contextChanged')
    const explicitUndefinedTerminal = initialContext()
    Object.defineProperty(explicitUndefinedTerminal, 'terminalCanClear', { value: undefined, enumerable: true })
    const { terminalCanClear: omitted, ...withoutTerminalCanClear } = explicitUndefinedTerminal
    void omitted
    const explicitUndefinedSaveOutcome = { ...withoutTerminalCanClear }
    Object.defineProperty(explicitUndefinedSaveOutcome, 'activeEditorSaveOutcome', {
      value: undefined, enumerable: true,
    })

    runtime.setContext(explicitUndefinedTerminal)
    runtime.setContext({ ...explicitUndefinedTerminal })
    runtime.setContext(explicitUndefinedSaveOutcome)
    runtime.setContext({ ...explicitUndefinedSaveOutcome })
    runtime.setContext({ ...explicitUndefinedSaveOutcome, compact: true })

    expect(contextChanged).toHaveBeenCalledTimes(3)
    await runtime.dispose()
  })

  it('constructs without a DOM using memory keybinding settings', async () => {
    const runtime = new WorkbenchCommandRuntime('windows')
    expect(runtime.shortcuts.store.getSnapshot().persistence).toEqual({ kind: 'memory' })
    expect(runtime.registry.catalog().map(command => command.id)).toContain('workbench.action.openGlobalKeybindings')
    await runtime.dispose()
  })

  it('starts injected persistence only from an effect seam and disposes it exactly once', async () => {
    const startSync = vi.fn()
    const dispose = vi.fn()
    const unsubscribe = vi.fn()
    const unchanged = async () => ({ status: 'unchanged' as const })
    const settings: KeybindingSettingsMutationPort = {
      getValue: () => ({ userBindings: [], unboundDefaults: [] }),
      getStatus: () => ({ kind: 'ready' }),
      canDispatch: () => true,
      canResetInvalid: () => false,
      subscribe: () => unsubscribe,
      startSync,
      add: unchanged,
      replace: unchanged,
      replaceDefault: unchanged,
      remove: unchanged,
      unbindDefault: unchanged,
      resetCommand: unchanged,
      resetAll: unchanged,
      resetInvalidSettings: unchanged,
      dispose,
    }
    const runtime = new WorkbenchCommandRuntime({ platform: 'windows', keybindingSettings: settings })
    expect(startSync).not.toHaveBeenCalled()
    runtime.startPersistenceSync()
    runtime.startPersistenceSync()
    expect(startSync).toHaveBeenCalledOnce()
    await Promise.all([runtime.dispose(), runtime.dispose()])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    runtime.startPersistenceSync()
    expect(startSync).toHaveBeenCalledOnce()
  })

  it('delegates through narrow live action ports and preserves the official shortcut split', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    const registration = registerWorkbenchCommands(registry, () => currentActions)

    expect(registry.catalog()).toHaveLength(44)
    expect(registry.list()).toHaveLength(43)

    expect(registry.commandForKeyboardEvent({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }))
      .toBe('workbench.action.quickOpen')
    expect(registry.commandForKeyboardEvent({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }))
      .toBe('workbench.action.showCommands')
    expect(registry.commandForKeyboardEvent({ key: 'F1', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }))
      .toBe('workbench.action.showCommands')
    expect(registry.commandForKeyboardEvent({ key: 'g', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }))
      .toBe('workbench.action.gotoLine')
    expect(registry.commandForKeyboardEvent({ key: 'z', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }))
      .toBe('editor.action.toggleWordWrap')
    expect(registry.commandForKeyboardEvent({ key: '`', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }))
      .toBe('workbench.action.terminal.toggle')
    expect(registry.catalog().find(command => command.id === 'workbench.action.gotoLine')).toMatchObject({
      title: 'Go to Line/Column...',
      category: 'Go',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'g' }] }],
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.toggleWordWrap')).toMatchObject({
      title: 'Toggle Word Wrap',
      category: 'View',
      defaultKeybindings: [{ id: 'altZ', sequence: [{ alt: true, key: 'z' }] }],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.navigateBack')).toMatchObject({
      title: 'Go Back', category: 'Go', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.navigateForward')).toMatchObject({
      title: 'Go Forward', category: 'Go', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'undo')).toMatchObject({
      title: 'Undo', category: 'Edit', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'redo')).toMatchObject({
      title: 'Redo', category: 'Edit', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.commentLine')).toMatchObject({
      title: 'Toggle Line Comment', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'none',
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.trimTrailingWhitespace')).toMatchObject({
      title: 'Trim Trailing Whitespace', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.indentationToSpaces')).toMatchObject({
      title: 'Convert Indentation to Spaces', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.indentationToTabs')).toMatchObject({
      title: 'Convert Indentation to Tabs', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'editor.action.changeIndentationSize')).toMatchObject({
      title: 'Change Indentation Size...', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.editor.changeEOL')).toMatchObject({
      title: 'Change End of Line Sequence...', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.editor.changeLanguageMode')).toMatchObject({
      title: 'Change Language Mode...', category: 'Edit', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.files.revert')).toMatchObject({
      title: 'Revert File', category: 'File', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'copyRelativeFilePath')).toMatchObject({
      title: 'Copy Relative Path of Active File', category: 'File', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.terminal.new')).toMatchObject({
      title: 'New Terminal', category: 'Terminal', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.terminal.focusNext')).toMatchObject({
      title: 'Focus Next Terminal', category: 'Terminal', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.terminal.focusPrevious')).toMatchObject({
      title: 'Focus Previous Terminal', category: 'Terminal', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.terminal.clear')).toMatchObject({
      title: 'Clear', category: 'Terminal', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'renameFile')).toMatchObject({
      title: 'Rename File', category: 'File', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'deleteFile')).toMatchObject({
      title: 'Delete File', category: 'File', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.reopenClosedEditor')).toMatchObject({
      title: 'Reopen Closed Editor',
      category: 'View',
      defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'workbench.action.closeAllEditors')).toMatchObject({
      title: 'Close All Editors', category: 'View', defaultKeybindings: [], keybindingPolicy: 'allow',
    })
    expect(registry.catalog().find(command => command.id === 'search.action.focusNextSearchResult')).toMatchObject({
      title: 'Focus Next Search Result', category: 'Search', defaultKeybindings: [],
    })
    expect(registry.catalog().find(command => command.id === 'search.action.focusPreviousSearchResult')).toMatchObject({
      title: 'Focus Previous Search Result', category: 'Search', defaultKeybindings: [],
    })

    expect(registry.keybindings.acceptKeyboardEvent({
      key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    })).toMatchObject({ kind: 'pending' })
    const openShortcuts = registry.keybindings.acceptKeyboardEvent({
      key: 's', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    })
    expect(openShortcuts).toMatchObject({ kind: 'execute', commandId: 'workbench.action.openGlobalKeybindings' })
    if (openShortcuts.kind === 'execute') await registry.execute(openShortcuts.commandId)
    expect(currentActions.showKeyboardShortcuts).toHaveBeenCalledOnce()

    await registry.execute('workbench.view.search')
    expect(currentActions.showSearch).toHaveBeenCalledOnce()
    await registry.execute('workbench.files.action.showActiveFileInExplorer')
    expect(currentActions.revealActiveFile).toHaveBeenCalledOnce()
    await registry.execute('copyRelativeFilePath')
    expect(currentActions.copyRelativePathOfActiveFile).toHaveBeenCalledOnce()
    await registry.execute('explorer.newFile')
    await registry.execute('explorer.newFolder')
    await registry.execute('renameFile')
    await registry.execute('deleteFile')
    expect(currentActions.createFile).toHaveBeenCalledOnce()
    expect(currentActions.createFolder).toHaveBeenCalledOnce()
    expect(currentActions.renameExplorerEntry).toHaveBeenCalledOnce()
    expect(currentActions.deleteExplorerEntry).toHaveBeenCalledOnce()
    await registry.execute('workbench.action.nextEditorInGroup')
    await registry.execute('workbench.action.previousEditorInGroup')
    await registry.execute('workbench.action.navigateBack')
    await registry.execute('workbench.action.navigateForward')
    await registry.execute('workbench.action.gotoLine')
    await registry.execute('editor.action.toggleWordWrap')
    await registry.execute('undo')
    await registry.execute('redo')
    await registry.execute('editor.action.commentLine')
    await registry.execute('editor.action.trimTrailingWhitespace')
    await registry.execute('editor.action.indentationToSpaces')
    await registry.execute('editor.action.indentationToTabs')
    await registry.execute('editor.action.changeIndentationSize')
    await registry.execute('workbench.action.editor.changeEOL')
    await registry.execute('workbench.action.editor.changeLanguageMode')
    await registry.execute('workbench.action.files.revert')
    await registry.execute('workbench.action.terminal.new')
    await registry.execute('workbench.action.terminal.focusNext')
    await registry.execute('workbench.action.terminal.focusPrevious')
    await registry.execute('workbench.action.terminal.clear')
    await registry.execute('workbench.action.terminal.toggle')
    await registry.execute('workbench.action.closeActiveEditor')
    await registry.execute('workbench.action.closeAllEditors')
    await registry.execute('workbench.action.reopenClosedEditor')
    await registry.execute('search.action.focusNextSearchResult')
    await registry.execute('search.action.focusPreviousSearchResult')
    await registry.execute('workbench.action.focusActiveEditorGroup')
    expect(currentActions.nextEditor).toHaveBeenCalledOnce()
    expect(currentActions.previousEditor).toHaveBeenCalledOnce()
    expect(currentActions.navigateBack).toHaveBeenCalledOnce()
    expect(currentActions.navigateForward).toHaveBeenCalledOnce()
    expect(currentActions.showGoToLine).toHaveBeenCalledOnce()
    expect(currentActions.toggleWordWrap).toHaveBeenCalledOnce()
    expect(currentActions.undoActiveEditor).toHaveBeenCalledOnce()
    expect(currentActions.redoActiveEditor).toHaveBeenCalledOnce()
    expect(currentActions.toggleLineComment).toHaveBeenCalledOnce()
    expect(currentActions.trimTrailingWhitespace).toHaveBeenCalledOnce()
    expect(currentActions.convertIndentationToSpaces).toHaveBeenCalledOnce()
    expect(currentActions.convertIndentationToTabs).toHaveBeenCalledOnce()
    expect(currentActions.showChangeIndentationSize).toHaveBeenCalledOnce()
    expect(currentActions.showChangeEndOfLine).toHaveBeenCalledOnce()
    expect(currentActions.showChangeLanguageMode).toHaveBeenCalledOnce()
    expect(currentActions.revertActive).toHaveBeenCalledOnce()
    expect(currentActions.createTerminal).toHaveBeenCalledOnce()
    expect(currentActions.focusNextTerminal).toHaveBeenCalledOnce()
    expect(currentActions.focusPreviousTerminal).toHaveBeenCalledOnce()
    expect(currentActions.clearTerminal).toHaveBeenCalledOnce()
    expect(currentActions.toggleTerminal).toHaveBeenCalledOnce()
    expect(currentActions.closeActiveEditor).toHaveBeenCalledOnce()
    expect(currentActions.closeAllEditors).toHaveBeenCalledOnce()
    expect(currentActions.reopenClosedEditor).toHaveBeenCalledOnce()
    expect(currentActions.nextSearchResult).toHaveBeenCalledOnce()
    expect(currentActions.previousSearchResult).toHaveBeenCalledOnce()
    expect(currentActions.focusActiveEditor).toHaveBeenCalledOnce()
    context.activeEditor = false
    expect(await registry.execute('workbench.action.closeAllEditors')).toMatchObject({
      status: 'disabled', message: 'No editors are open.',
    })
    expect(currentActions.closeAllEditors).toHaveBeenCalledOnce()
    expect(await registry.execute('workbench.action.gotoLine')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(currentActions.showGoToLine).toHaveBeenCalledOnce()
    expect(await registry.execute('editor.action.toggleWordWrap')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(currentActions.toggleWordWrap).toHaveBeenCalledOnce()
    context.activeEditor = true
    context.activeEditorReadOnly = true
    expect(await registry.execute('workbench.action.gotoLine')).toMatchObject({
      status: 'disabled', message: 'The active file is a read-only preview.',
    })
    expect(currentActions.showGoToLine).toHaveBeenCalledOnce()
    expect(await registry.execute('editor.action.toggleWordWrap')).toMatchObject({
      status: 'disabled', message: 'The active file is a read-only preview.',
    })
    expect(currentActions.toggleWordWrap).toHaveBeenCalledOnce()
    await registration.dispose()
  })

  it('exposes File: Save All only for a workspace and enables it only for saveable dirty editors', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    const catalog = registry.catalog().find(command => command.id === 'workbench.action.files.saveAll')
    expect(catalog).toMatchObject({ title: 'Save All', category: 'File', defaultKeybindings: [] })

    context.workspaceSelected = false
    expect(registry.list().map(command => command.id)).not.toContain('workbench.action.files.saveAll')
    expect(await registry.execute('workbench.action.files.saveAll')).toMatchObject({ status: 'unavailable' })

    context.workspaceSelected = true
    context.saveableDirtyEditors = false
    expect(registry.list().find(command => command.id === 'workbench.action.files.saveAll'))
      .toMatchObject({ enabled: false, disabledReason: 'No saveable editors have unsaved changes.' })
    expect(await registry.execute('workbench.action.files.saveAll')).toMatchObject({ status: 'disabled' })
    expect(currentActions.saveAll).not.toHaveBeenCalled()

    context.saveableDirtyEditors = true
    expect(await registry.execute('workbench.action.files.saveAll')).toMatchObject({ status: 'completed' })
    expect(currentActions.saveAll).toHaveBeenCalledOnce()
  })

  it('reopens only when the selected workspace has a closed editor', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.reopenableEditor = false
    expect(registry.list().find(item => item.id === 'workbench.action.reopenClosedEditor')).toMatchObject({
      enabled: false,
      disabledReason: 'No closed editor is available in the selected workspace.',
    })
    expect(await registry.execute('workbench.action.reopenClosedEditor')).toMatchObject({ status: 'disabled' })
    expect(currentActions.reopenClosedEditor).not.toHaveBeenCalled()

    context.reopenableEditor = true
    expect(await registry.execute('workbench.action.reopenClosedEditor')).toMatchObject({ status: 'completed' })
    expect(currentActions.reopenClosedEditor).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('workbench.action.reopenClosedEditor')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
    expect(currentActions.reopenClosedEditor).toHaveBeenCalledOnce()
  })

  it('navigates search results only for a completed non-empty current projection', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.searchResultsAvailable = false
    expect(registry.list().find(item => item.id === 'search.action.focusNextSearchResult')).toMatchObject({
      enabled: false, disabledReason: 'No completed search results are available.',
    })
    expect(await registry.execute('search.action.focusNextSearchResult')).toMatchObject({ status: 'disabled' })
    expect(currentActions.nextSearchResult).not.toHaveBeenCalled()

    context.searchResultsAvailable = true
    expect(await registry.execute('search.action.focusNextSearchResult')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('search.action.focusPreviousSearchResult')).toMatchObject({ status: 'completed' })
    expect(currentActions.nextSearchResult).toHaveBeenCalledOnce()
    expect(currentActions.previousSearchResult).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('search.action.focusNextSearchResult')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
    expect(currentActions.nextSearchResult).toHaveBeenCalledOnce()
  })

  it('offers editor history commands only for an editable active editor with exact history', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditorUndoAvailable = false
    expect(await registry.execute('undo')).toMatchObject({
      status: 'disabled', message: 'The active editor has no changes to undo.',
    })
    expect(currentActions.undoActiveEditor).not.toHaveBeenCalled()

    context.activeEditorUndoAvailable = true
    context.activeEditorEditable = false
    expect(await registry.execute('undo')).toMatchObject({ status: 'disabled', message: 'The active editor is read-only.' })
    expect(await registry.execute('redo')).toMatchObject({ status: 'disabled', message: 'The active editor is read-only.' })

    context.activeEditorEditable = true
    expect(await registry.execute('undo')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('redo')).toMatchObject({ status: 'completed' })
    expect(currentActions.undoActiveEditor).toHaveBeenCalledOnce()
    expect(currentActions.redoActiveEditor).toHaveBeenCalledOnce()
  })

  it('offers editor text commands only for an editable active editor', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditor = false
    expect(await registry.execute('editor.action.commentLine')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(await registry.execute('editor.action.trimTrailingWhitespace')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(await registry.execute('editor.action.indentationToSpaces')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(await registry.execute('editor.action.indentationToTabs')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    context.activeEditor = true
    context.activeEditorEditable = false
    expect(await registry.execute('editor.action.commentLine')).toMatchObject({
      status: 'disabled', message: 'The active editor is read-only.',
    })
    expect(await registry.execute('editor.action.trimTrailingWhitespace')).toMatchObject({
      status: 'disabled', message: 'The active editor is read-only.',
    })
    expect(await registry.execute('editor.action.indentationToSpaces')).toMatchObject({
      status: 'disabled', message: 'The active editor is read-only.',
    })
    expect(await registry.execute('editor.action.indentationToTabs')).toMatchObject({
      status: 'disabled', message: 'The active editor is read-only.',
    })
    expect(currentActions.toggleLineComment).not.toHaveBeenCalled()
    expect(currentActions.trimTrailingWhitespace).not.toHaveBeenCalled()
    expect(currentActions.convertIndentationToSpaces).not.toHaveBeenCalled()
    expect(currentActions.convertIndentationToTabs).not.toHaveBeenCalled()

    context.activeEditorEditable = true
    expect(await registry.execute('editor.action.commentLine')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('editor.action.trimTrailingWhitespace')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('editor.action.indentationToSpaces')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('editor.action.indentationToTabs')).toMatchObject({ status: 'completed' })
    expect(currentActions.toggleLineComment).toHaveBeenCalledOnce()
    expect(currentActions.trimTrailingWhitespace).toHaveBeenCalledOnce()
    expect(currentActions.convertIndentationToSpaces).toHaveBeenCalledOnce()
    expect(currentActions.convertIndentationToTabs).toHaveBeenCalledOnce()
  })

  it('offers end of line choices only for an exact unblocked editable editor', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditor = false
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    context.activeEditor = true
    context.activeEditorEditable = false
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({
      status: 'disabled', message: 'The active editor is read-only.',
    })
    context.activeEditorEditable = true
    context.activeEditorSaving = true
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({
      status: 'disabled', message: 'Another document operation is in progress.',
    })
    context.activeEditorSaving = false
    context.activeEditorSaveOutcome = 'unknown'
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({
      status: 'disabled', message: 'Check the uncertain save outcome first.',
    })
    delete context.activeEditorSaveOutcome
    context.activeEditorDeleted = true
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({
      status: 'disabled', message: 'The active file was deleted outside the IDE.',
    })
    expect(currentActions.showChangeEndOfLine).not.toHaveBeenCalled()

    context.activeEditorDeleted = false
    expect(await registry.execute('workbench.action.editor.changeEOL')).toMatchObject({ status: 'completed' })
    expect(currentActions.showChangeEndOfLine).toHaveBeenCalledOnce()
  })

  it('offers language and indentation presentation choices even while document mutation is blocked', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditor = false
    expect(await registry.execute('workbench.action.editor.changeLanguageMode')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(await registry.execute('editor.action.changeIndentationSize')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    context.activeEditor = true
    context.activeEditorReadOnly = true
    expect(await registry.execute('workbench.action.editor.changeLanguageMode')).toMatchObject({
      status: 'disabled', message: 'The active file is a read-only preview.',
    })
    expect(await registry.execute('editor.action.changeIndentationSize')).toMatchObject({
      status: 'disabled', message: 'The active file is a read-only preview.',
    })
    context.activeEditorReadOnly = false
    context.activeEditorEditable = false
    context.activeEditorSaving = true
    context.activeEditorDeleted = true
    expect(await registry.execute('workbench.action.editor.changeLanguageMode')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('editor.action.changeIndentationSize')).toMatchObject({ status: 'completed' })
    expect(currentActions.showChangeLanguageMode).toHaveBeenCalledOnce()
    expect(currentActions.showChangeIndentationSize).toHaveBeenCalledOnce()
  })

  it('offers Revert File only for an unblocked dirty editable disk file', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditorDirty = false
    expect(await registry.execute('workbench.action.files.revert')).toMatchObject({
      status: 'disabled', message: 'The active file has no unsaved changes.',
    })
    context.activeEditorDirty = true
    context.activeEditorReadOnly = true
    expect(await registry.execute('workbench.action.files.revert')).toMatchObject({
      status: 'disabled', message: 'The active file is a read-only preview.',
    })
    context.activeEditorReadOnly = false
    context.activeEditorSaving = true
    expect(await registry.execute('workbench.action.files.revert')).toMatchObject({
      status: 'disabled', message: 'The active file operation is still running.',
    })
    context.activeEditorSaving = false
    context.activeEditorSaveOutcome = 'unknown'
    expect(await registry.execute('workbench.action.files.revert')).toMatchObject({ status: 'disabled' })
    delete context.activeEditorSaveOutcome
    expect(await registry.execute('workbench.action.files.revert')).toMatchObject({ status: 'completed' })
    expect(currentActions.revertActive).toHaveBeenCalledOnce()
  })

  it('requires recovery ownership for create and uses recreate for deleted dirty buffers', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.workspaceMutationsAvailable = false
    expect(await registry.execute('explorer.newFile')).toMatchObject({ status: 'disabled' })
    context.workspaceMutationsAvailable = true
    context.activeEditorDeleted = true
    expect(await registry.execute('workbench.action.files.save')).toMatchObject({ status: 'disabled' })
    expect(await registry.execute('workbench.action.files.recreateDeleted')).toMatchObject({ status: 'completed' })
    expect(currentActions.recreateDeleted).toHaveBeenCalledOnce()
  })

  it('gates file and folder creation by their exact Host capabilities', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.workspaceCreateFileAvailable = true
    context.workspaceCreateDirectoryAvailable = false
    expect(await registry.execute('explorer.newFile')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('explorer.newFolder')).toMatchObject({
      status: 'disabled',
      message: expect.stringContaining('folder creation'),
    })
    expect(currentActions.createFile).toHaveBeenCalledOnce()
    expect(currentActions.createFolder).not.toHaveBeenCalled()
  })

  it('gates Explorer rename and delete by recovery ownership, granular capability, idle state, and an exact entry', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.explorerMutableEntryAvailable = false
    expect(await registry.execute('renameFile')).toMatchObject({
      status: 'disabled', message: 'Select a current file or folder in Explorer first.',
    })
    context.explorerMutableEntryAvailable = true
    context.workspaceRenameAvailable = false
    expect(await registry.execute('renameFile')).toMatchObject({
      status: 'disabled', message: expect.stringContaining('rename'),
    })
    context.workspaceRenameAvailable = true
    context.workspaceDeleteAvailable = false
    expect(await registry.execute('deleteFile')).toMatchObject({
      status: 'disabled', message: expect.stringContaining('deletion'),
    })
    context.workspaceDeleteAvailable = true
    context.workspaceMutationsAvailable = false
    expect(await registry.execute('renameFile')).toMatchObject({ status: 'disabled' })
    context.workspaceMutationsAvailable = true
    context.workspaceMutationIdle = false
    expect(await registry.execute('deleteFile')).toMatchObject({ status: 'disabled' })
    context.workspaceMutationIdle = true
    await expect(registry.execute('renameFile')).resolves.toMatchObject({ status: 'completed' })
    await expect(registry.execute('deleteFile')).resolves.toMatchObject({ status: 'completed' })
    expect(currentActions.renameExplorerEntry).toHaveBeenCalledOnce()
    expect(currentActions.deleteExplorerEntry).toHaveBeenCalledOnce()
  })

  it('rechecks save state and maps non-successful domain outcomes to command failure', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditorDirty = false
    expect(await registry.execute('workbench.action.files.save')).toMatchObject({ status: 'disabled' })
    expect(currentActions.saveActive).not.toHaveBeenCalled()

    context.activeEditorDirty = true
    currentActions.saveActive = vi.fn(async () => 'conflict')
    expect(await registry.execute('workbench.action.files.save')).toMatchObject({ status: 'failed', message: expect.stringContaining('changed on disk') })
  })

  it('only exposes check-save in its exact context and gates terminal focus on a workspace', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)
    expect(registry.list().map(item => item.id)).not.toContain('workbench.action.files.checkSaveOutcome')
    expect(registry.list().find(item => item.id === 'workbench.action.terminal.toggle'))
      .toMatchObject({ enabled: true })

    context.activeEditorSaveOutcome = 'unknown'
    expect(registry.list().map(item => item.id)).toContain('workbench.action.files.checkSaveOutcome')

    context.workspaceSelected = false
    expect(registry.list().find(item => item.id === 'workbench.action.terminal.toggle')).toMatchObject({
      enabled: false,
      disabledReason: 'Select a workspace first.',
    })
    expect(await registry.execute('workbench.action.terminal.toggle')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
    expect(currentActions.toggleTerminal).not.toHaveBeenCalled()
  })

  it('creates a terminal only while the selected workspace has global capacity', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.terminalCanCreate = false
    expect(registry.list().find(item => item.id === 'workbench.action.terminal.new')).toMatchObject({
      enabled: false,
      disabledReason: 'The terminal session limit has been reached.',
    })
    expect(await registry.execute('workbench.action.terminal.new')).toMatchObject({ status: 'disabled' })
    expect(currentActions.createTerminal).not.toHaveBeenCalled()

    context.terminalCanCreate = true
    expect(await registry.execute('workbench.action.terminal.new')).toMatchObject({ status: 'completed' })
    expect(currentActions.createTerminal).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('workbench.action.terminal.new')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
    expect(currentActions.createTerminal).toHaveBeenCalledOnce()
  })

  it('navigates terminals only while the selected workspace has multiple sessions', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.terminalCanNavigate = false
    expect(await registry.execute('workbench.action.terminal.focusNext')).toMatchObject({
      status: 'disabled', message: 'The selected workspace has only one terminal session.',
    })
    expect(await registry.execute('workbench.action.terminal.focusPrevious')).toMatchObject({ status: 'disabled' })
    expect(currentActions.focusNextTerminal).not.toHaveBeenCalled()
    expect(currentActions.focusPreviousTerminal).not.toHaveBeenCalled()

    context.terminalCanNavigate = true
    expect(await registry.execute('workbench.action.terminal.focusNext')).toMatchObject({ status: 'completed' })
    expect(await registry.execute('workbench.action.terminal.focusPrevious')).toMatchObject({ status: 'completed' })
    expect(currentActions.focusNextTerminal).toHaveBeenCalledOnce()
    expect(currentActions.focusPreviousTerminal).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('workbench.action.terminal.focusNext')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
  })

  it('clears only an exact active terminal in the selected workspace', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.terminalCanClear = false
    expect(await registry.execute('workbench.action.terminal.clear')).toMatchObject({
      status: 'disabled', message: 'No active terminal is available.',
    })
    expect(currentActions.clearTerminal).not.toHaveBeenCalled()

    context.terminalCanClear = true
    expect(await registry.execute('workbench.action.terminal.clear')).toMatchObject({ status: 'completed' })
    expect(currentActions.clearTerminal).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('workbench.action.terminal.clear')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
    expect(currentActions.clearTerminal).toHaveBeenCalledOnce()
  })

  it('copies an active relative path even for read-only or deleted presentations', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.activeEditorReadOnly = true
    context.activeEditorDeleted = true
    expect(await registry.execute('copyRelativeFilePath')).toMatchObject({ status: 'completed' })
    expect(currentActions.copyRelativePathOfActiveFile).toHaveBeenCalledOnce()

    context.activeEditor = false
    expect(await registry.execute('copyRelativeFilePath')).toMatchObject({
      status: 'disabled', message: 'No active editor.',
    })
    expect(currentActions.copyRelativePathOfActiveFile).toHaveBeenCalledOnce()
  })

  it('enables editor history commands from their exact live stack directions', async () => {
    const context = initialContext()
    const currentActions = actions()
    const registry = new CommandRegistry(() => context)
    registerWorkbenchCommands(registry, () => currentActions)

    context.navigateBackAvailable = false
    context.navigateForwardAvailable = false
    expect(await registry.execute('workbench.action.navigateBack')).toMatchObject({
      status: 'disabled', message: 'No previous editor location is available.',
    })
    expect(await registry.execute('workbench.action.navigateForward')).toMatchObject({
      status: 'disabled', message: 'No next editor location is available.',
    })

    context.navigateBackAvailable = true
    expect(await registry.execute('workbench.action.navigateBack')).toMatchObject({ status: 'completed' })
    expect(currentActions.navigateBack).toHaveBeenCalledOnce()
    context.navigateForwardAvailable = true
    expect(await registry.execute('workbench.action.navigateForward')).toMatchObject({ status: 'completed' })
    expect(currentActions.navigateForward).toHaveBeenCalledOnce()

    context.workspaceSelected = false
    expect(await registry.execute('workbench.action.navigateBack')).toMatchObject({
      status: 'disabled', message: 'Select a workspace first.',
    })
  })
})
