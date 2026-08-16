import type {
  DefaultKeybinding,
  EffectiveKeybindingView,
  KeybindingConflictView,
  KeybindingPolicy,
} from './keybindings.ts'

export type WorkbenchCommandId = string

export interface CommandKeybinding {
  readonly key: string
  /** Ctrl on Windows/Linux and Command on macOS. */
  readonly primary?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
}

export interface CommandDisabled {
  readonly enabled: false
  readonly reason: string
}

export interface CommandEnabled {
  readonly enabled: true
}

export type CommandEnablement = CommandEnabled | CommandDisabled

export interface WorkbenchCommand<C> {
  readonly id: WorkbenchCommandId
  readonly title: string
  readonly category?: string
  readonly description?: string
  readonly keybindings?: readonly CommandKeybinding[]
  /** Stable browser-only defaults. Legacy `keybindings` are adapted while callers migrate. */
  readonly defaultKeybindings?: readonly DefaultKeybinding[]
  /** `none` forbids user bindings; `modified-only` protects dangerous commands. */
  readonly keybindingPolicy?: KeybindingPolicy
  /** Hidden commands are neither listed nor matched by the shortcut router. */
  readonly when?: (context: C) => boolean
  /** Presentation hint only. Execution always re-evaluates this predicate. */
  readonly enablement?: (context: C) => CommandEnablement
  readonly run: (context: C, signal: AbortSignal) => void | Promise<void>
}

export interface WorkbenchCommandView {
  readonly id: WorkbenchCommandId
  readonly title: string
  readonly category?: string
  readonly description?: string
  readonly keybindings: readonly CommandKeybinding[]
  readonly effectiveKeybindings?: readonly EffectiveKeybindingView[]
  readonly keybindingConflicts?: readonly KeybindingConflictView[]
  readonly shortcut?: CommandShortcutPresentation
  readonly enabled: boolean
  readonly disabledReason?: string
  readonly running: boolean
}

/** Full accepting command catalog; it never exposes handlers or context objects. */
export interface WorkbenchCommandCatalogEntry {
  readonly id: WorkbenchCommandId
  readonly title: string
  readonly category?: string
  readonly description?: string
  readonly defaultKeybindings: readonly DefaultKeybinding[]
  readonly keybindingPolicy: KeybindingPolicy
}

export interface CommandShortcutPresentation {
  readonly labels: readonly string[]
  readonly customized: boolean
  readonly state: 'default' | 'customized' | 'unbound' | 'conflict'
  readonly conflictIds: readonly string[]
}

export type CommandExecutionStatus =
  | 'completed'
  | 'cancelled'
  | 'disabled'
  | 'failed'
  | 'unavailable'
  | 'busy'

export interface CommandExecutionOutcome {
  readonly commandId: WorkbenchCommandId
  readonly status: CommandExecutionStatus
  readonly message?: string
}

export interface CommandExecutionOptions {
  /** Runs after the live preflight succeeds and immediately before the handler. */
  readonly onAdmitted?: () => void
}

export interface CommandRegistration {
  /** Idempotent. New execution is fenced before active work is aborted and joined. */
  dispose(): Promise<void>
}
