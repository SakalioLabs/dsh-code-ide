import type { RevertResult, SaveResult } from '../documents/controller.ts'
import type { CommandRegistry } from './registry.ts'
import type { KeybindingContextSchema } from './keybindings.ts'
import type { CommandEnablement, CommandRegistration, WorkbenchCommand } from './types.ts'

export type QuickInputMode = 'none' | 'files' | 'commands' | 'line' | 'eol' | 'language' | 'indentation'

export interface WorkbenchCommandContext {
  readonly workspaceSelected: boolean
  readonly activeEditor: boolean
  readonly multipleEditors: boolean
  readonly activeEditorDirty: boolean
  readonly activeEditorSaving: boolean
  readonly activeEditorDeleted: boolean
  readonly activeEditorReadOnly: boolean
  /** A CodeEditor surface is mounted; false for Markdown and media presentations. */
  readonly activeTextEditorVisible?: boolean
  /** Exact editor-surface write admission; pending saves do not make the buffer non-editable. */
  readonly activeEditorEditable: boolean
  readonly activeEditorUndoAvailable: boolean
  readonly activeEditorRedoAvailable: boolean
  /** Exact per-workspace editor navigation history availability. */
  readonly navigateBackAvailable: boolean
  readonly navigateForwardAvailable: boolean
  /** Current workspace has at least one authoritatively completed editor close. */
  readonly reopenableEditor: boolean
  /** Current workspace has a completed, non-empty search result projection. */
  readonly searchResultsAvailable: boolean
  readonly activeEditorSaveOutcome?: 'unknown'
  /** Current workspace has at least one dirty editor that can be saved immediately. */
  readonly saveableDirtyEditors: boolean
  /** Effective admission for at least one Host-supported workspace mutation. */
  readonly workspaceMutationsAvailable: boolean
  /** Raw Host capabilities; command admission still requires workspaceMutationsAvailable. */
  readonly workspaceCreateFileAvailable: boolean
  readonly workspaceCreateDirectoryAvailable: boolean
  readonly workspaceRenameAvailable: boolean
  readonly workspaceDeleteAvailable: boolean
  /** Current focused/selected visible Explorer row has an authoritative mutable identity. */
  readonly explorerMutableEntryAvailable: boolean
  readonly workspaceMutationIdle: boolean
  readonly quickInputMode: QuickInputMode
  readonly railView: 'explorer' | 'search'
  readonly compact: boolean
  readonly compactTerminalVisible: boolean
  /** Live page-global TerminalSessionStore capacity for the selected workspace. */
  readonly terminalCanCreate: boolean
  /** The selected workspace has at least two live terminal sessions. */
  readonly terminalCanNavigate: boolean
  /** The selected workspace has an exact active terminal runtime to clear. */
  readonly terminalCanClear?: boolean
  readonly compactPanel: 'none' | 'rail' | 'harness'
}

/** Narrow UI/application ports. No handler receives arbitrary paths, shell text or Host command ids. */
export interface WorkbenchCommandActions {
  showCommands(): void
  /** Optional only during the App migration; the built-in fails explicitly until attached. */
  showKeyboardShortcuts?(): void
  showQuickOpen(): void
  showExplorer(): void
  showSearch(): void
  toggleTerminal(): void
  createTerminal(): void
  focusNextTerminal(): void
  focusPreviousTerminal(): void
  clearTerminal(): void
  focusHarness(): void
  nextEditor(): void
  previousEditor(): void
  navigateBack(): Promise<void>
  navigateForward(): Promise<void>
  showGoToLine(): void
  toggleWordWrap(): void
  undoActiveEditor(): void
  redoActiveEditor(): void
  toggleLineComment(): void
  trimTrailingWhitespace(): void
  convertIndentationToSpaces(): void
  convertIndentationToTabs(): void
  showChangeIndentationSize(): void
  showChangeEndOfLine(): void
  showChangeLanguageMode(): void
  closeActiveEditor(): void
  closeAllEditors(): void
  reopenClosedEditor(): Promise<void>
  nextSearchResult(): Promise<void>
  previousSearchResult(): Promise<void>
  focusActiveEditor(): void
  refreshExplorer(): Promise<void>
  revealActiveFile(): Promise<void>
  copyRelativePathOfActiveFile(): Promise<void>
  createFile(): void
  createFolder(): void
  renameExplorerEntry(): void
  deleteExplorerEntry(): void
  saveActive(): Promise<SaveResult>
  saveAll(): Promise<void>
  revertActive(): Promise<RevertResult>
  recreateDeleted(): Promise<SaveResult>
  checkSaveOutcome(): Promise<void>
}

export const WORKBENCH_KEYBINDING_CONTEXT_SCHEMA: KeybindingContextSchema = Object.freeze({
  workspaceSelected: 'boolean',
  activeEditor: 'boolean',
  multipleEditors: 'boolean',
  activeEditorDirty: 'boolean',
  activeEditorSaving: 'boolean',
  activeEditorDeleted: 'boolean',
  activeEditorReadOnly: 'boolean',
  activeTextEditorVisible: 'boolean',
  activeEditorEditable: 'boolean',
  activeEditorUndoAvailable: 'boolean',
  activeEditorRedoAvailable: 'boolean',
  navigateBackAvailable: 'boolean',
  navigateForwardAvailable: 'boolean',
  reopenableEditor: 'boolean',
  searchResultsAvailable: 'boolean',
  activeEditorSaveOutcome: Object.freeze(['unknown']),
  saveableDirtyEditors: 'boolean',
  workspaceMutationsAvailable: 'boolean',
  workspaceCreateFileAvailable: 'boolean',
  workspaceCreateDirectoryAvailable: 'boolean',
  workspaceRenameAvailable: 'boolean',
  workspaceDeleteAvailable: 'boolean',
  explorerMutableEntryAvailable: 'boolean',
  workspaceMutationIdle: 'boolean',
  quickInputMode: Object.freeze(['none', 'files', 'commands', 'line', 'eol', 'language']),
  railView: Object.freeze(['explorer', 'search']),
  compact: 'boolean',
  compactTerminalVisible: 'boolean',
  terminalCanCreate: 'boolean',
  terminalCanNavigate: 'boolean',
  terminalCanClear: 'boolean',
  compactPanel: Object.freeze(['none', 'rail', 'harness']),
})

function available(enabled: boolean, reason: string): CommandEnablement {
  return enabled ? { enabled: true } : { enabled: false, reason }
}

function lineEndingAvailability(context: WorkbenchCommandContext): CommandEnablement {
  if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
  if (!context.activeEditorEditable) return { enabled: false, reason: 'The active editor is read-only.' }
  if (context.activeEditorSaving) {
    return { enabled: false, reason: 'Another document operation is in progress.' }
  }
  if (context.activeEditorSaveOutcome === 'unknown') {
    return { enabled: false, reason: 'Check the uncertain save outcome first.' }
  }
  return available(!context.activeEditorDeleted, 'The active file was deleted outside the IDE.')
}

function saveAvailability(context: WorkbenchCommandContext): CommandEnablement {
  if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
  if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
  if (context.activeEditorSaving) return { enabled: false, reason: 'The active file operation is still running.' }
  if (context.activeEditorSaveOutcome === 'unknown') {
    return { enabled: false, reason: 'Check the uncertain save outcome before saving again.' }
  }
  if (context.activeEditorDeleted) {
    return { enabled: false, reason: 'Recreate the deleted file before saving it.' }
  }
  return available(context.activeEditorDirty, 'The active file has no unsaved changes.')
}

function mutationAvailability(
  context: WorkbenchCommandContext,
  operationSupported: boolean,
  unsupportedReason: string,
): CommandEnablement {
  if (!context.workspaceSelected) return { enabled: false, reason: 'Select a workspace first.' }
  if (!operationSupported) return { enabled: false, reason: unsupportedReason }
  if (!context.workspaceMutationsAvailable) {
    return { enabled: false, reason: 'This page does not currently own safe file-operation recovery.' }
  }
  return available(context.workspaceMutationIdle, 'Finish or reconcile the active file operation first.')
}

function explorerMutationAvailability(
  context: WorkbenchCommandContext,
  operationSupported: boolean,
  unsupportedReason: string,
): CommandEnablement {
  const mutation = mutationAvailability(context, operationSupported, unsupportedReason)
  if (!mutation.enabled) return mutation
  return available(
    context.explorerMutableEntryAvailable,
    'Select a current file or folder in Explorer first.',
  )
}

function recreateAvailability(context: WorkbenchCommandContext): CommandEnablement {
  if (!context.activeEditor || !context.activeEditorDeleted) {
    return { enabled: false, reason: 'The active editor is not a deleted file.' }
  }
  if (context.activeEditorSaving) return { enabled: false, reason: 'The active file operation is still running.' }
  if (context.activeEditorSaveOutcome === 'unknown') {
    return { enabled: false, reason: 'Check the uncertain recreate outcome before trying again.' }
  }
  return available(context.activeEditorDirty, 'The deleted editor has no local content to recreate.')
}

function revertAvailability(context: WorkbenchCommandContext): CommandEnablement {
  if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
  if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
  if (context.activeEditorSaving) return { enabled: false, reason: 'The active file operation is still running.' }
  if (context.activeEditorSaveOutcome === 'unknown') {
    return { enabled: false, reason: 'Check the uncertain save outcome before reverting.' }
  }
  if (context.activeEditorDeleted) {
    return { enabled: false, reason: 'The active file no longer exists on disk.' }
  }
  return available(context.activeEditorDirty, 'The active file has no unsaved changes.')
}

function saveFailure(result: SaveResult): string | undefined {
  switch (result) {
    case 'saved':
    case 'not-needed': return undefined
    case 'conflict': return 'The file changed on disk. Your local buffer was preserved.'
    case 'unknown': return 'The save response was lost. Check its disk outcome before retrying.'
    case 'stale': return 'The active document changed before the save completed.'
    case 'failed': return 'The file could not be saved. Your local buffer was preserved.'
  }
}

export function registerWorkbenchCommands(
  registry: CommandRegistry<WorkbenchCommandContext>,
  getActions: () => WorkbenchCommandActions,
): CommandRegistration {
  const commands: readonly WorkbenchCommand<WorkbenchCommandContext>[] = [
    {
      id: 'workbench.action.showCommands',
      title: 'Show All Commands',
      category: 'View',
      description: 'Open the IDE Command Palette.',
      defaultKeybindings: [
        { id: 'primary', sequence: [{ primary: true, shift: true, key: 'p' }] },
        { id: 'f1', sequence: [{ key: 'F1' }] },
      ],
      run: () => { getActions().showCommands() },
    },
    {
      id: 'workbench.action.openGlobalKeybindings',
      title: 'Open Keyboard Shortcuts',
      category: 'Preferences',
      description: 'Open browser-local keyboard shortcut settings.',
      defaultKeybindings: [{
        id: 'primaryChord',
        sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
      }],
      run: () => {
        const action = getActions().showKeyboardShortcuts
        if (action === undefined) throw new Error('Keyboard shortcut settings are not attached.')
        action()
      },
    },
    {
      id: 'workbench.action.quickOpen',
      title: 'Quick Open',
      category: 'File',
      description: 'Find a file in the selected workspace.',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'p' }] }],
      enablement: context => available(context.workspaceSelected, 'Select a workspace first.'),
      run: () => { getActions().showQuickOpen() },
    },
    {
      id: 'workbench.action.files.save',
      title: 'Save',
      category: 'File',
      description: 'Save the active editor using its observed disk version.',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 's' }] }],
      enablement: saveAvailability,
      run: async () => {
        const failure = saveFailure(await getActions().saveActive())
        if (failure !== undefined) throw new Error(failure)
      },
    },
    {
      id: 'workbench.action.files.saveAll',
      title: 'Save All',
      category: 'File',
      description: 'Save every currently saveable dirty editor in the selected workspace.',
      when: context => context.workspaceSelected,
      enablement: context => available(
        context.saveableDirtyEditors,
        'No saveable editors have unsaved changes.',
      ),
      run: async () => { await getActions().saveAll() },
    },
    {
      id: 'workbench.action.files.revert',
      title: 'Revert File',
      category: 'File',
      description: 'Discard unsaved changes by replacing the active buffer with the current disk contents.',
      enablement: revertAvailability,
      run: async () => {
        const result = await getActions().revertActive()
        if (result === 'reverted') return
        if (result === 'failed') throw new Error('The file could not be read. Local changes were preserved.')
        if (result === 'stale') throw new Error('The active editor changed before the revert completed. Local changes were preserved.')
        throw new Error('The active editor is no longer available to revert.')
      },
    },
    {
      id: 'workbench.action.files.checkSaveOutcome',
      title: 'Check Save Outcome',
      category: 'File',
      description: 'Read the disk state after an uncertain save response.',
      when: context => context.activeEditorSaveOutcome === 'unknown',
      run: async () => { await getActions().checkSaveOutcome() },
    },
    {
      id: 'workbench.action.files.recreateDeleted',
      title: 'Recreate Deleted File',
      category: 'File',
      description: 'Create the active deleted file only if its path is still absent.',
      enablement: recreateAvailability,
      run: async () => {
        const result = await getActions().recreateDeleted()
        const failure = result === 'not-needed'
          ? 'The deleted editor is no longer available to recreate.'
          : saveFailure(result)
        if (failure !== undefined) throw new Error(failure)
      },
    },
    {
      id: 'workbench.view.explorer',
      title: 'Show Explorer',
      category: 'View',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, shift: true, key: 'e' }] }],
      run: () => { getActions().showExplorer() },
    },
    {
      id: 'workbench.view.search',
      title: 'Show Search',
      category: 'View',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, shift: true, key: 'f' }] }],
      enablement: context => available(context.workspaceSelected, 'Select a workspace first.'),
      run: () => { getActions().showSearch() },
    },
    {
      id: 'search.action.focusNextSearchResult',
      title: 'Focus Next Search Result',
      category: 'Search',
      description: 'Open the next result from the current completed workspace search.',
      enablement: context => context.workspaceSelected
        ? available(context.searchResultsAvailable, 'No completed search results are available.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: async () => { await getActions().nextSearchResult() },
    },
    {
      id: 'search.action.focusPreviousSearchResult',
      title: 'Focus Previous Search Result',
      category: 'Search',
      description: 'Open the previous result from the current completed workspace search.',
      enablement: context => context.workspaceSelected
        ? available(context.searchResultsAvailable, 'No completed search results are available.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: async () => { await getActions().previousSearchResult() },
    },
    {
      id: 'workbench.action.explorer.refresh',
      title: 'Refresh Explorer',
      category: 'Explorer',
      description: 'Reload every expanded Explorer directory from the Host.',
      enablement: context => available(context.workspaceSelected, 'Select a workspace first.'),
      run: async () => { await getActions().refreshExplorer() },
    },
    {
      id: 'explorer.newFile',
      title: 'New File',
      category: 'Explorer',
      description: 'Create an empty file without replacing an existing resource.',
      enablement: context => mutationAvailability(
        context,
        context.workspaceCreateFileAvailable,
        'This Host does not support containment-safe file creation.',
      ),
      run: () => { getActions().createFile() },
    },
    {
      id: 'explorer.newFolder',
      title: 'New Folder',
      category: 'Explorer',
      description: 'Create one folder without recursively creating missing parents.',
      enablement: context => mutationAvailability(
        context,
        context.workspaceCreateDirectoryAvailable,
        'This Host does not support containment-safe folder creation.',
      ),
      run: () => { getActions().createFolder() },
    },
    {
      id: 'renameFile',
      title: 'Rename File',
      category: 'File',
      description: 'Rename the current Explorer file or folder through the recoverable file-operation workflow.',
      enablement: context => explorerMutationAvailability(
        context,
        context.workspaceRenameAvailable,
        'This Host does not support containment-safe rename.',
      ),
      run: () => { getActions().renameExplorerEntry() },
    },
    {
      id: 'deleteFile',
      title: 'Delete File',
      category: 'File',
      description: 'Confirm deletion of the current Explorer file or folder through the recoverable file-operation workflow.',
      enablement: context => explorerMutationAvailability(
        context,
        context.workspaceDeleteAvailable,
        'This Host does not support containment-safe deletion.',
      ),
      run: () => { getActions().deleteExplorerEntry() },
    },
    {
      id: 'workbench.files.action.showActiveFileInExplorer',
      title: 'Reveal Active File in Explorer View',
      category: 'File',
      description: 'Show and focus the active file in the workspace tree.',
      enablement: context => available(context.activeEditor, 'No active editor.'),
      run: async () => { await getActions().revealActiveFile() },
    },
    {
      id: 'copyRelativeFilePath',
      title: 'Copy Relative Path of Active File',
      category: 'File',
      description: 'Copy the active file path relative to its selected workspace.',
      enablement: context => available(context.activeEditor, 'No active editor.'),
      run: async () => { await getActions().copyRelativePathOfActiveFile() },
    },
    {
      id: 'workbench.action.nextEditorInGroup',
      title: 'Open Next Editor',
      category: 'View',
      description: 'Activate the next open editor in this editor group.',
      enablement: context => available(context.multipleEditors, 'Open at least two editors first.'),
      run: () => { getActions().nextEditor() },
    },
    {
      id: 'workbench.action.previousEditorInGroup',
      title: 'Open Previous Editor',
      category: 'View',
      description: 'Activate the previous open editor in this editor group.',
      enablement: context => available(context.multipleEditors, 'Open at least two editors first.'),
      run: () => { getActions().previousEditor() },
    },
    {
      id: 'workbench.action.navigateBack',
      title: 'Go Back',
      category: 'Go',
      description: 'Return to the previous editor location in this workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.navigateBackAvailable, 'No previous editor location is available.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: async () => { await getActions().navigateBack() },
    },
    {
      id: 'workbench.action.navigateForward',
      title: 'Go Forward',
      category: 'Go',
      description: 'Return to the next editor location in this workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.navigateForwardAvailable, 'No next editor location is available.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: async () => { await getActions().navigateForward() },
    },
    {
      id: 'workbench.action.gotoLine',
      title: 'Go to Line/Column...',
      category: 'Go',
      description: 'Move the active editor caret to a one-based line and optional column.',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'g' }] }],
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
        return available(context.activeTextEditorVisible === true, 'Switch to the source view to navigate by line.')
      },
      run: () => { getActions().showGoToLine() },
    },
    {
      id: 'undo',
      title: 'Undo',
      category: 'Edit',
      description: 'Undo the most recent change in the active editor.',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (!context.activeEditorEditable) return { enabled: false, reason: 'The active editor is read-only.' }
        return available(context.activeEditorUndoAvailable, 'The active editor has no changes to undo.')
      },
      run: () => { getActions().undoActiveEditor() },
    },
    {
      id: 'redo',
      title: 'Redo',
      category: 'Edit',
      description: 'Redo the most recently undone change in the active editor.',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (!context.activeEditorEditable) return { enabled: false, reason: 'The active editor is read-only.' }
        return available(context.activeEditorRedoAvailable, 'The active editor has no changes to redo.')
      },
      run: () => { getActions().redoActiveEditor() },
    },
    {
      id: 'editor.action.commentLine',
      title: 'Toggle Line Comment',
      category: 'Edit',
      description: 'Toggle the current selection using the active language comment syntax.',
      keybindingPolicy: 'none',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        return available(context.activeEditorEditable, 'The active editor is read-only.')
      },
      run: () => { getActions().toggleLineComment() },
    },
    {
      id: 'editor.action.trimTrailingWhitespace',
      title: 'Trim Trailing Whitespace',
      category: 'Edit',
      description: 'Remove whitespace immediately before line endings throughout the active editor.',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        return available(context.activeEditorEditable, 'The active editor is read-only.')
      },
      run: () => { getActions().trimTrailingWhitespace() },
    },
    {
      id: 'editor.action.indentationToSpaces',
      title: 'Convert Indentation to Spaces',
      category: 'Edit',
      description: 'Convert leading indentation to spaces while preserving visual columns.',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        return available(context.activeEditorEditable, 'The active editor is read-only.')
      },
      run: () => { getActions().convertIndentationToSpaces() },
    },
    {
      id: 'editor.action.indentationToTabs',
      title: 'Convert Indentation to Tabs',
      category: 'Edit',
      description: 'Convert leading indentation to tabs while preserving visual columns.',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        return available(context.activeEditorEditable, 'The active editor is read-only.')
      },
      run: () => { getActions().convertIndentationToTabs() },
    },
    {
      id: 'editor.action.changeIndentationSize',
      title: 'Change Indentation Size...',
      category: 'Edit',
      description: 'Choose an indentation width from 1 through 8 for the active editor.',
      defaultKeybindings: [],
      keybindingPolicy: 'allow',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
        return available(context.activeTextEditorVisible === true, 'Switch to the source view to change indentation.')
      },
      run: () => { getActions().showChangeIndentationSize() },
    },
    {
      id: 'workbench.action.editor.changeEOL',
      title: 'Change End of Line Sequence...',
      category: 'Edit',
      description: 'Choose LF or CRLF for the active editor when it is saved.',
      enablement: lineEndingAvailability,
      run: () => { getActions().showChangeEndOfLine() },
    },
    {
      id: 'workbench.action.editor.changeLanguageMode',
      title: 'Change Language Mode...',
      category: 'Edit',
      description: 'Choose syntax highlighting and editor language features for the active editor.',
      defaultKeybindings: [],
      keybindingPolicy: 'allow',
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
        return available(context.activeTextEditorVisible === true, 'Switch to the source view to change the language mode.')
      },
      run: () => { getActions().showChangeLanguageMode() },
    },
    {
      id: 'editor.action.toggleWordWrap',
      title: 'Toggle Word Wrap',
      category: 'View',
      description: 'Toggle wrapping of long lines in the active editor.',
      defaultKeybindings: [{ id: 'altZ', sequence: [{ alt: true, key: 'z' }] }],
      enablement: context => {
        if (!context.activeEditor) return { enabled: false, reason: 'No active editor.' }
        if (context.activeEditorReadOnly) return { enabled: false, reason: 'The active file is a read-only preview.' }
        return available(context.activeTextEditorVisible === true, 'Switch to the source view to change word wrapping.')
      },
      run: () => { getActions().toggleWordWrap() },
    },
    {
      id: 'workbench.action.closeActiveEditor',
      title: 'Close Editor',
      category: 'View',
      description: 'Close the active editor, prompting before unsaved changes are discarded.',
      enablement: context => available(context.activeEditor, 'No active editor.'),
      run: () => { getActions().closeActiveEditor() },
    },
    {
      id: 'workbench.action.closeAllEditors',
      title: 'Close All Editors',
      category: 'View',
      description: 'Close every editor captured in the selected workspace, prompting for unsaved changes.',
      defaultKeybindings: [],
      keybindingPolicy: 'allow',
      enablement: context => available(context.activeEditor, 'No editors are open.'),
      run: () => { getActions().closeAllEditors() },
    },
    {
      id: 'workbench.action.reopenClosedEditor',
      title: 'Reopen Closed Editor',
      category: 'View',
      description: 'Reopen the most recently closed editor in the selected workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.reopenableEditor, 'No closed editor is available in the selected workspace.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: async () => { await getActions().reopenClosedEditor() },
    },
    {
      id: 'workbench.action.focusActiveEditorGroup',
      title: 'Focus Active Editor Group',
      category: 'View',
      description: 'Move focus to the active editor without inspecting the Harness frame.',
      enablement: context => available(context.activeEditor, 'No active editor.'),
      run: () => { getActions().focusActiveEditor() },
    },
    {
      id: 'workbench.action.terminal.new',
      title: 'New Terminal',
      category: 'Terminal',
      description: 'Create and focus a new terminal in the selected workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.terminalCanCreate, 'The terminal session limit has been reached.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: () => { getActions().createTerminal() },
    },
    {
      id: 'workbench.action.terminal.focusNext',
      title: 'Focus Next Terminal',
      category: 'Terminal',
      description: 'Focus the next terminal session in the selected workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.terminalCanNavigate, 'The selected workspace has only one terminal session.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: () => { getActions().focusNextTerminal() },
    },
    {
      id: 'workbench.action.terminal.focusPrevious',
      title: 'Focus Previous Terminal',
      category: 'Terminal',
      description: 'Focus the previous terminal session in the selected workspace.',
      enablement: context => context.workspaceSelected
        ? available(context.terminalCanNavigate, 'The selected workspace has only one terminal session.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: () => { getActions().focusPreviousTerminal() },
    },
    {
      id: 'workbench.action.terminal.clear',
      title: 'Clear',
      category: 'Terminal',
      description: 'Clear the active terminal buffer without sending input to its process.',
      enablement: context => context.workspaceSelected
        ? available(context.terminalCanClear === true, 'No active terminal is available.')
        : { enabled: false, reason: 'Select a workspace first.' },
      run: () => { getActions().clearTerminal() },
    },
    {
      id: 'workbench.action.terminal.toggle',
      title: 'Toggle Terminal',
      category: 'View',
      description: 'Focus the terminal, or show or hide it in the compact workbench.',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: '`' }] }],
      enablement: context => available(context.workspaceSelected, 'Select a workspace first.'),
      run: () => { getActions().toggleTerminal() },
    },
    {
      id: 'workbench.action.harness.focus',
      title: 'Focus DeepSeek Harness',
      category: 'View',
      description: 'Focus the official DeepSeek Harness frame without inspecting its contents.',
      run: () => { getActions().focusHarness() },
    },
  ]

  const registrations: CommandRegistration[] = []
  try {
    for (const command of commands) registrations.push(registry.register(command))
  } catch (error) {
    for (const registration of registrations.reverse()) void registration.dispose()
    throw error
  }
  let disposal: Promise<void> | undefined
  return {
    dispose: () => {
      disposal ??= Promise.all([...registrations].reverse().map(registration => registration.dispose())).then(() => undefined)
      return disposal
    },
  }
}
