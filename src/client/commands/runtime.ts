import { CommandPaletteController } from './palette.ts'
import { CommandRegistry } from './registry.ts'
import { createBrowserKeybindingPersistence } from './keybinding-persistence.ts'
import { detectKeybindingPlatform, type KeybindingSettingsMutationPort } from './keybindings.ts'
import type { ShortcutPlatform } from './shortcuts.ts'
import {
  registerWorkbenchCommands,
  WORKBENCH_KEYBINDING_CONTEXT_SCHEMA,
  type WorkbenchCommandActions,
  type WorkbenchCommandContext,
} from './workbench.ts'

const emptyContext: WorkbenchCommandContext = {
  workspaceSelected: false,
  activeEditor: false,
  multipleEditors: false,
  activeEditorDirty: false,
  activeEditorSaving: false,
  activeEditorDeleted: false,
  activeEditorReadOnly: false,
  activeTextEditorVisible: false,
  activeEditorEditable: false,
  activeEditorUndoAvailable: false,
  activeEditorRedoAvailable: false,
  navigateBackAvailable: false,
  navigateForwardAvailable: false,
  reopenableEditor: false,
  searchResultsAvailable: false,
  saveableDirtyEditors: false,
  workspaceMutationsAvailable: false,
  workspaceCreateFileAvailable: false,
  workspaceCreateDirectoryAvailable: false,
  workspaceRenameAvailable: false,
  workspaceDeleteAvailable: false,
  explorerMutableEntryAvailable: false,
  workspaceMutationIdle: true,
  quickInputMode: 'none',
  railView: 'explorer',
  compact: false,
  compactTerminalVisible: false,
  terminalCanCreate: false,
  terminalCanNavigate: false,
  compactPanel: 'none',
}

function equalScalarContext(left: WorkbenchCommandContext, right: WorkbenchCommandContext): boolean {
  if (left === right) return true
  const leftKeys = Object.keys(left) as (keyof WorkbenchCommandContext)[]
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
}

export interface WorkbenchCommandRuntimeOptions {
  readonly platform?: ShortcutPlatform
  /** Injected tests own construction; the runtime/registry own exact-once disposal. */
  readonly keybindingSettings?: KeybindingSettingsMutationPort
}

/** Page-local owner for command effects; React only supplies live coeffects/actions. */
export class WorkbenchCommandRuntime {
  private context: WorkbenchCommandContext = emptyContext
  private actions: WorkbenchCommandActions | undefined
  readonly registry: CommandRegistry<WorkbenchCommandContext>
  readonly shortcuts
  readonly palette: CommandPaletteController<WorkbenchCommandContext>
  private readonly builtins
  private disposal?: Promise<void>

  constructor(platformOrOptions: ShortcutPlatform | WorkbenchCommandRuntimeOptions = 'other') {
    const options = typeof platformOrOptions === 'string'
      ? { platform: platformOrOptions }
      : platformOrOptions
    const requestedPlatform = options.platform ?? 'other'
    const platform = requestedPlatform === 'other' ? detectKeybindingPlatform() : requestedPlatform
    const settings = options.keybindingSettings
      ?? (typeof window === 'undefined'
        ? undefined
        : createBrowserKeybindingPersistence(WORKBENCH_KEYBINDING_CONTEXT_SCHEMA))
    this.registry = new CommandRegistry(() => this.context, platform, {
      contextSchema: WORKBENCH_KEYBINDING_CONTEXT_SCHEMA,
      ...(settings === undefined ? {} : { settings }),
    })
    this.shortcuts = this.registry.keybindings
    this.palette = new CommandPaletteController(this.registry)
    this.builtins = registerWorkbenchCommands(this.registry, () => {
      if (this.actions === undefined) throw new Error('Workbench command actions are not attached.')
      return this.actions
    })
  }

  setContext(context: WorkbenchCommandContext): void {
    if (equalScalarContext(this.context, context)) return
    this.context = context
    this.registry.contextChanged()
  }

  setActions(actions: WorkbenchCommandActions): void {
    this.actions = actions
  }

  /** Call from a committed effect; render-time construction stays side-effect free. */
  startPersistenceSync(): void { this.shortcuts.startPersistenceSync() }

  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.palette.dispose()
      await this.builtins.dispose()
      await this.registry.dispose()
      this.actions = undefined
    })()
    return this.disposal
  }
}
