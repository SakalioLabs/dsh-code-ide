import { keybindingSignature, type KeyboardEventLike } from './shortcuts.ts'
import {
  KeybindingController,
  type KeybindingContextSchema,
  type KeybindingPlatform,
  type KeybindingSettingsMutationPort,
} from './keybindings.ts'
import type {
  CommandEnablement,
  CommandExecutionOptions,
  CommandExecutionOutcome,
  CommandRegistration,
  WorkbenchCommand,
  WorkbenchCommandCatalogEntry,
  WorkbenchCommandView,
} from './types.ts'

type Listener = () => void

interface RegisteredCommand<C> {
  readonly command: WorkbenchCommand<C>
  readonly disposeKeybindings: () => void
  accepting: boolean
  disposal?: Promise<void>
}

interface ActiveInvocation {
  readonly controller: AbortController
  readonly settled: Promise<CommandExecutionOutcome>
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '�').slice(0, 1_000)
  return safe.length === 0 ? 'Command failed.' : safe
}

function validateText(value: string, name: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be non-empty text with at most ${String(maximum)} characters.`)
  }
}

function cloneCommand<C>(command: WorkbenchCommand<C>): WorkbenchCommand<C> {
  validateText(command.id, 'Command id', 128)
  if (!/^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u.test(command.id)) {
    throw new Error(`Invalid command id: ${command.id}`)
  }
  validateText(command.title, 'Command title', 160)
  if (command.category !== undefined) validateText(command.category, 'Command category', 80)
  if (command.description !== undefined) validateText(command.description, 'Command description', 500)
  if (command.keybindingPolicy !== undefined
    && command.keybindingPolicy !== 'allow'
    && command.keybindingPolicy !== 'modified-only'
    && command.keybindingPolicy !== 'none') {
    throw new Error('Command keybindingPolicy must be allow, modified-only, or none.')
  }
  if (command.keybindings !== undefined && command.defaultKeybindings !== undefined) {
    throw new Error('A command cannot combine legacy keybindings with stable defaultKeybindings.')
  }
  const keybindings = command.keybindings?.map(binding => Object.freeze({ ...binding })) ?? []
  keybindings.forEach(binding => { keybindingSignature(binding) })
  return Object.freeze({ ...command, keybindings: Object.freeze(keybindings) })
}

function enabledView(enablement: CommandEnablement | undefined): Pick<WorkbenchCommandView, 'enabled' | 'disabledReason'> {
  if (enablement === undefined || enablement.enabled) return { enabled: true }
  return { enabled: false, disabledReason: enablement.reason }
}

function commandDefaultKeybindings<C>(command: WorkbenchCommand<C>) {
  return command.defaultKeybindings ?? (command.keybindings ?? []).map((binding, index) => Object.freeze({
    id: `legacy.${String(index + 1)}`,
    sequence: Object.freeze([binding] as const),
  }))
}

/**
 * Framework-neutral command contribution seam. Stable ids are the reconciliation
 * key; unregister first fences new work, then aborts and joins the exact active
 * invocation before the contribution disappears.
 */
export class CommandRegistry<C> {
  private readonly commands = new Map<string, RegisteredCommand<C>>()
  private readonly shortcuts = new Map<string, string>()
  private readonly active = new Map<string, ActiveInvocation>()
  private readonly listeners = new Set<Listener>()
  private catalogSnapshot: readonly WorkbenchCommandCatalogEntry[] = Object.freeze([])
  private disposed = false
  readonly keybindings: KeybindingController<C>
  private readonly unsubscribeKeybindings: () => void
  private suppressKeybindingProjection = 0

  constructor(
    private readonly getContext: () => C,
    private readonly shortcutPlatform: 'mac' | 'other' | KeybindingPlatform = 'other',
    keybindingOptions: {
      readonly contextSchema?: KeybindingContextSchema
      readonly settings?: KeybindingSettingsMutationPort
      readonly now?: () => number
      readonly setTimer?: (callback: () => void, milliseconds: number) => unknown
      readonly clearTimer?: (handle: unknown) => void
      readonly createId?: () => string
    } = {},
  ) {
    const platform: KeybindingPlatform = shortcutPlatform === 'other' ? 'windows' : shortcutPlatform
    this.keybindings = new KeybindingController({
      platform,
      getContext: () => this.getContext(),
      isCommandActive: commandId => {
        const record = this.commands.get(commandId)
        return record !== undefined && record.accepting && this.isVisible(record.command, this.getContext())
      },
      ...keybindingOptions,
    })
    this.unsubscribeKeybindings = this.keybindings.store.subscribe(() => {
      if (!this.disposed && this.suppressKeybindingProjection === 0) this.emit()
    })
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  register(command: WorkbenchCommand<C>): CommandRegistration {
    if (this.disposed) throw new Error('The command registry is disposed.')
    if (this.commands.size >= 1_000) throw new Error('The command registry limit of 1000 commands was reached.')
    const owned = cloneCommand(command)
    if (this.commands.has(owned.id)) throw new Error(`Command ${owned.id} is already registered.`)

    const signatures = (owned.keybindings ?? []).map(binding => keybindingSignature(binding, this.shortcutPlatform))
    for (const signature of signatures) {
      const owner = this.shortcuts.get(signature)
      if (owner !== undefined) throw new Error(`Keybinding ${signature} is already owned by ${owner}.`)
    }

    this.suppressKeybindingProjection += 1
    let disposeOwnedKeybindings = (): void => {}
    const record: RegisteredCommand<C> = {
      command: owned,
      disposeKeybindings: () => { disposeOwnedKeybindings() },
      accepting: true,
    }
    this.commands.set(owned.id, record)
    try {
      disposeOwnedKeybindings = this.keybindings.registerCommand(
        owned.id,
        commandDefaultKeybindings(owned),
        owned.keybindingPolicy ?? 'allow',
      )
      signatures.forEach(signature => this.shortcuts.set(signature, owned.id))
      this.refreshCatalog()
      this.emit()
      return { dispose: () => this.disposeRegistration(record) }
    } catch (error) {
      disposeOwnedKeybindings()
      if (this.commands.get(owned.id) === record) this.commands.delete(owned.id)
      throw error
    } finally {
      this.suppressKeybindingProjection -= 1
    }
  }

  list(): readonly WorkbenchCommandView[] {
    const context = this.getContext()
    const views: WorkbenchCommandView[] = []
    for (const record of this.commands.values()) {
      if (!record.accepting || !this.isVisible(record.command, context)) continue
      let availability: CommandEnablement | undefined
      try {
        availability = record.command.enablement?.(context)
      } catch {
        availability = { enabled: false, reason: 'Command state is unavailable.' }
      }
      views.push({
        id: record.command.id,
        title: record.command.title,
        ...(record.command.category === undefined ? {} : { category: record.command.category }),
        ...(record.command.description === undefined ? {} : { description: record.command.description }),
        keybindings: record.command.keybindings ?? [],
        effectiveKeybindings: this.keybindings.bindingsForCommand(record.command.id)?.effectiveBindings ?? Object.freeze([]),
        keybindingConflicts: this.keybindings.bindingsForCommand(record.command.id)?.conflicts ?? Object.freeze([]),
        shortcut: this.shortcutPresentation(record.command.id),
        ...enabledView(availability),
        running: this.active.has(record.command.id),
      })
    }
    return Object.freeze(views.map(view => Object.freeze(view)))
  }

  /** Complete accepting metadata catalog, including commands hidden by live `when`. */
  catalog(): readonly WorkbenchCommandCatalogEntry[] {
    return this.catalogSnapshot
  }

  private refreshCatalog(): void {
    const entries: WorkbenchCommandCatalogEntry[] = []
    for (const record of this.commands.values()) {
      if (!record.accepting) continue
      const command = record.command
      entries.push(Object.freeze({
        id: command.id,
        title: command.title,
        ...(command.category === undefined ? {} : { category: command.category }),
        ...(command.description === undefined ? {} : { description: command.description }),
        defaultKeybindings: this.keybindings.bindingsForCommand(command.id)?.defaultBindings ?? Object.freeze([]),
        keybindingPolicy: command.keybindingPolicy ?? 'allow',
      }))
    }
    this.catalogSnapshot = Object.freeze(entries)
  }

  commandForKeyboardEvent(event: KeyboardEventLike): string | undefined {
    return this.keybindings.commandForKeyboardEvent(event)
  }

  async execute(id: string, options: CommandExecutionOptions = {}): Promise<CommandExecutionOutcome> {
    const record = this.commands.get(id)
    if (this.disposed || record === undefined || !record.accepting) return { commandId: id, status: 'unavailable' }
    if (this.active.has(id)) return { commandId: id, status: 'busy', message: 'Command is already running.' }

    const context = this.getContext()
    try {
      if (!this.isVisible(record.command, context)) return { commandId: id, status: 'unavailable' }
      const enablement = record.command.enablement?.(context)
      if (enablement !== undefined && !enablement.enabled) {
        return { commandId: id, status: 'disabled', message: enablement.reason }
      }
    } catch (error) {
      return { commandId: id, status: 'failed', message: errorMessage(error) }
    }

    const controller = new AbortController()
    let resolveOutcome!: (outcome: CommandExecutionOutcome) => void
    const settled = new Promise<CommandExecutionOutcome>(resolve => { resolveOutcome = resolve })
    this.active.set(id, { controller, settled })
    this.emit()

    try {
      options.onAdmitted?.()
    } catch (error) {
      this.active.delete(id)
      const outcome: CommandExecutionOutcome = { commandId: id, status: 'failed', message: errorMessage(error) }
      resolveOutcome(outcome)
      this.emit()
      return outcome
    }

    let outcome: CommandExecutionOutcome
    try {
      await record.command.run(context, controller.signal)
      outcome = controller.signal.aborted
        ? { commandId: id, status: 'cancelled' }
        : { commandId: id, status: 'completed' }
    } catch (error) {
      outcome = controller.signal.aborted
        ? { commandId: id, status: 'cancelled' }
        : { commandId: id, status: 'failed', message: errorMessage(error) }
    }
    if (this.active.get(id)?.controller === controller) this.active.delete(id)
    resolveOutcome(outcome)
    this.emit()
    return outcome
  }

  /** Notify projections that coeffect-backed context changed. */
  contextChanged(): void {
    if (!this.disposed) {
      this.keybindings.contextChanged()
      this.emit()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.commands.values()].map(record => this.disposeRegistration(record)))
    this.unsubscribeKeybindings()
    this.keybindings.dispose()
    this.listeners.clear()
  }

  private isVisible(command: WorkbenchCommand<C>, context: C): boolean {
    try {
      return command.when?.(context) ?? true
    } catch {
      return false
    }
  }

  private disposeRegistration(record: RegisteredCommand<C>): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    if (!record.accepting && this.commands.get(record.command.id) !== record) return Promise.resolve()

    this.suppressKeybindingProjection += 1
    record.accepting = false
    try { record.disposeKeybindings() } finally { this.suppressKeybindingProjection -= 1 }
    this.refreshCatalog()
    for (const binding of record.command.keybindings ?? []) {
      const signature = keybindingSignature(binding, this.shortcutPlatform)
      if (this.shortcuts.get(signature) === record.command.id) this.shortcuts.delete(signature)
    }
    const invocation = this.active.get(record.command.id)
    this.emit()

    if (invocation === undefined) {
      if (this.commands.get(record.command.id) === record) this.commands.delete(record.command.id)
      return Promise.resolve()
    }

    invocation.controller.abort()
    record.disposal = invocation.settled.then(() => {
      if (this.commands.get(record.command.id) === record) this.commands.delete(record.command.id)
      this.emit()
    })
    return record.disposal
  }

  private emit(): void {
    // A broken projection must not interrupt registration, admission or
    // teardown of unrelated command contributions.
    for (const listener of this.listeners) {
      try { listener() } catch { /* subscriber owns its reporting boundary */ }
    }
  }

  private shortcutPresentation(commandId: string): NonNullable<WorkbenchCommandView['shortcut']> {
    const view = this.keybindings.bindingsForCommand(commandId)
    if (view === undefined) {
      return Object.freeze({ labels: Object.freeze([]), customized: false, state: 'unbound', conflictIds: Object.freeze([]) })
    }
    return Object.freeze({
      labels: Object.freeze(view.effectiveBindings.filter(binding => binding.state === 'active').map(binding => binding.label)),
      customized: view.state === 'customized' || view.userBindings.length > 0
        || (view.state === 'unbound' && view.defaultBindings.length > 0),
      state: view.state,
      conflictIds: Object.freeze(view.conflicts.flatMap(conflict => conflict.candidateIds)),
    })
  }
}
