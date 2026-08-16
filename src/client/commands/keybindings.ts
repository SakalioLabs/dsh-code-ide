import type { CommandKeybinding } from './types.ts'
import { formatKeybinding, keybindingSignature, validateKeybinding } from './shortcuts.ts'

export const KEYBINDING_CHORD_TIMEOUT_MS = 1_000
export const MAX_USER_KEYBINDINGS = 512
export const MAX_KEYBINDING_WHEN_CLAUSES = 8

export type KeybindingPlatform = 'mac' | 'windows' | 'linux'
export type KeybindingContextValue = boolean | string
export type KeyStroke = CommandKeybinding
export type KeybindingSequence = readonly [Readonly<KeyStroke>] | readonly [Readonly<KeyStroke>, Readonly<KeyStroke>]

export function detectKeybindingPlatform(
  browserNavigator: Pick<Navigator, 'platform' | 'userAgent'> | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): KeybindingPlatform {
  if (browserNavigator === undefined) return 'windows'
  const modern = (browserNavigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  const value = `${modern ?? ''} ${browserNavigator.platform} ${browserNavigator.userAgent}`.toLocaleLowerCase('en-US')
  if (/mac|iphone|ipad|ipod/u.test(value)) return 'mac'
  if (/linux|cros|x11/u.test(value)) return 'linux'
  return 'windows'
}

/** A bounded conjunction over keys explicitly admitted by the controller. */
export interface KeybindingWhenClause {
  readonly key: string
  readonly equals: KeybindingContextValue
}

export interface DefaultKeybinding {
  /** Stable within one command; persisted unbinds target this id. */
  readonly id: string
  readonly sequence: KeybindingSequence
  /** Omitted means every supported browser platform. */
  readonly platforms?: readonly KeybindingPlatform[]
  readonly when?: readonly KeybindingWhenClause[]
}

export interface UserKeybinding {
  readonly id: string
  readonly commandId: string
  readonly sequence: KeybindingSequence
  readonly platforms?: readonly KeybindingPlatform[]
  readonly when?: readonly KeybindingWhenClause[]
}

export interface UnboundDefaultKeybinding {
  readonly commandId: string
  readonly bindingId: string
}

export type KeybindingPolicy = 'allow' | 'modified-only' | 'none'

export type EffectiveKeybindingState = 'active' | 'inactive' | 'shadowed' | 'conflict'

export interface EffectiveKeybindingView {
  readonly id: string
  readonly bindingId: string
  readonly commandId: string
  readonly source: 'default' | 'user'
  readonly sequence: KeybindingSequence
  readonly label: string
  readonly state: EffectiveKeybindingState
}

export interface KeybindingConflictView {
  readonly kind: 'exact' | 'prefix'
  readonly signature: string
  /** Stable ids are sorted for diagnostics only; order never elects a winner. */
  readonly candidateIds: readonly string[]
  readonly commandIds: readonly string[]
}

export interface CommandKeybindingView {
  readonly commandId: string
  readonly state: 'default' | 'customized' | 'unbound' | 'conflict'
  readonly defaultBindings: readonly DefaultKeybinding[]
  readonly userBindings: readonly UserKeybinding[]
  readonly effectiveBindings: readonly EffectiveKeybindingView[]
  readonly conflicts: readonly KeybindingConflictView[]
}

export type KeybindingPersistenceStatus =
  | { readonly kind: 'memory' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'readOnly'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

export interface PendingKeybindingChord {
  readonly firstStroke: Readonly<KeyStroke>
  readonly label: string
  readonly expiresAt: number
}

export interface KeybindingSnapshot {
  readonly revision: number
  readonly platform: KeybindingPlatform
  readonly commands: readonly CommandKeybindingView[]
  readonly conflicts: readonly KeybindingConflictView[]
  readonly pending?: PendingKeybindingChord
  readonly persistence: KeybindingPersistenceStatus
  /** Corrupt, future, or unreadable settings block every shortcut, including defaults. */
  readonly dispatchBlocked: boolean
  /** Only an explicit, confirmed recovery action may overwrite invalid stored data. */
  readonly canResetInvalid: boolean
}

export type KeybindingEditOutcome =
  | { readonly status: 'saved' | 'unchanged'; readonly message?: undefined }
  | { readonly status: 'read-only' | 'failed'; readonly message: string }

export interface UserKeybindingInput {
  readonly commandId: string
  readonly sequence: KeybindingSequence
  readonly platforms?: readonly KeybindingPlatform[]
  readonly when?: readonly KeybindingWhenClause[]
}

export interface KeybindingPreview {
  readonly sequence: KeybindingSequence
  readonly label: string
  /** Canonical current-platform signature; `primary` is already expanded. */
  readonly signature: string
  readonly firstStrokeSignature: string
  readonly exactMatches: readonly EffectiveKeybindingView[]
  readonly prefixMatches: readonly EffectiveKeybindingView[]
}

export interface ShortcutDecisionNone { readonly kind: 'none'; readonly consume: false }
export interface ShortcutDecisionPending {
  readonly kind: 'pending'
  readonly consume: true
  readonly pending: PendingKeybindingChord
}
export interface ShortcutDecisionExecute {
  readonly kind: 'execute'
  readonly consume: true
  readonly commandId: string
  readonly bindingId: string
  readonly source: 'default' | 'user'
}
export interface ShortcutDecisionConflict {
  readonly kind: 'conflict'
  readonly consume: true
  readonly conflict: KeybindingConflictView
}
export type ShortcutDecision = ShortcutDecisionNone | ShortcutDecisionPending | ShortcutDecisionExecute | ShortcutDecisionConflict

export interface ShortcutKeyboardEventLike {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

export type KeybindingContextSchema = Readonly<Record<string, readonly KeybindingContextValue[] | 'boolean'>>

export interface KeybindingSettingsValue {
  readonly userBindings: readonly UserKeybinding[]
  readonly unboundDefaults: readonly UnboundDefaultKeybinding[]
}

export interface KeybindingSettingsMutationPort {
  readonly getValue: () => KeybindingSettingsValue
  readonly getStatus: () => KeybindingPersistenceStatus
  readonly canDispatch?: () => boolean
  readonly canResetInvalid?: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly startSync?: () => void
  readonly add: (input: UserKeybindingInput) => Promise<KeybindingEditOutcome>
  readonly replace: (bindingId: string, input: UserKeybindingInput) => Promise<KeybindingEditOutcome>
  readonly replaceDefault: (
    commandId: string,
    bindingId: string,
    input: UserKeybindingInput,
  ) => Promise<KeybindingEditOutcome>
  readonly remove: (bindingId: string) => Promise<KeybindingEditOutcome>
  readonly unbindDefault: (commandId: string, bindingId: string) => Promise<KeybindingEditOutcome>
  readonly resetCommand: (commandId: string) => Promise<KeybindingEditOutcome>
  readonly resetAll: () => Promise<KeybindingEditOutcome>
  readonly resetInvalidSettings?: () => Promise<KeybindingEditOutcome>
  readonly dispose: () => void
}

type Listener = () => void

interface CommandContribution {
  readonly token: object
  readonly commandId: string
  readonly defaultBindings: readonly DefaultKeybinding[]
  readonly policy: KeybindingPolicy
}

interface Candidate {
  readonly id: string
  readonly bindingId: string
  readonly commandId: string
  readonly source: 'default' | 'user'
  readonly sequence: KeybindingSequence
  readonly platforms?: readonly KeybindingPlatform[]
  readonly when?: readonly KeybindingWhenClause[]
  readonly platformSpecific: boolean
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\ufffd').slice(0, 1_000)
  return safe.length === 0 ? 'The keybinding operation failed.' : safe
}

function validateIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} must be a stable identifier with at most 128 characters.`)
  }
}

function normalizedPlatform(platform: KeybindingPlatform): KeybindingPlatform {
  if (platform === 'mac' || platform === 'windows' || platform === 'linux') return platform
  throw new Error('Unsupported keybinding platform.')
}

function cloneStroke(stroke: Readonly<KeyStroke>): Readonly<KeyStroke> {
  validateKeybinding(stroke)
  if (/^(?:Alt|AltGraph|Control|Dead|Meta|Process|Shift|Unidentified)$/iu.test(stroke.key)) {
    throw new Error('A modifier-only, dead, composing, or unidentified key cannot be a keybinding stroke.')
  }
  return Object.freeze({
    key: stroke.key,
    ...(stroke.primary === true ? { primary: true } : {}),
    ...(stroke.shift === true ? { shift: true } : {}),
    ...(stroke.alt === true ? { alt: true } : {}),
    ...(stroke.ctrl === true ? { ctrl: true } : {}),
    ...(stroke.meta === true ? { meta: true } : {}),
  })
}

function hasModifier(stroke: Readonly<KeyStroke>): boolean {
  return stroke.primary === true || stroke.ctrl === true || stroke.meta === true || stroke.alt === true
}

function hasStrongModifier(stroke: Readonly<KeyStroke>): boolean {
  return stroke.primary === true || stroke.ctrl === true || stroke.meta === true
}

function printableKey(key: string): boolean {
  return [...key].length === 1
}

function modifierOnlyKey(key: string): boolean {
  return /^(?:Alt|AltGraph|Control|Meta|Shift)$/iu.test(key)
}

function cloneSequence(sequence: KeybindingSequence, policy: KeybindingPolicy): KeybindingSequence {
  if (!Array.isArray(sequence) || (sequence.length !== 1 && sequence.length !== 2)) {
    throw new Error('A keybinding sequence must contain one or two strokes.')
  }
  const first = cloneStroke(sequence[0])
  if (printableKey(first.key) && !hasModifier(first)) {
    throw new Error('A printable first stroke requires a modifier.')
  }
  if (policy === 'modified-only' && !hasStrongModifier(first)) {
    throw new Error('This command requires Ctrl, Command, Meta, or primary on its first stroke.')
  }
  if (sequence.length === 1) return Object.freeze([first])
  return Object.freeze([first, cloneStroke(sequence[1])])
}

function clonePlatforms(platforms: readonly KeybindingPlatform[] | undefined): readonly KeybindingPlatform[] | undefined {
  if (platforms === undefined) return undefined
  if (platforms.length === 0 || platforms.length > 3) throw new Error('A platform list must contain one to three entries.')
  const values = platforms.map(normalizedPlatform)
  if (new Set(values).size !== values.length) throw new Error('A platform list cannot contain duplicates.')
  return Object.freeze([...values].sort())
}

function allowedContextValue(
  schema: KeybindingContextSchema,
  key: string,
  value: KeybindingContextValue,
): boolean {
  const domain = schema[key]
  if (domain === 'boolean') return typeof value === 'boolean'
  return domain !== undefined && domain.some(candidate => candidate === value)
}

function cloneWhen(
  clauses: readonly KeybindingWhenClause[] | undefined,
  schema: KeybindingContextSchema,
): readonly KeybindingWhenClause[] | undefined {
  if (clauses === undefined) return undefined
  if (clauses.length === 0 || clauses.length > MAX_KEYBINDING_WHEN_CLAUSES) {
    throw new Error(`A keybinding context must contain one to ${String(MAX_KEYBINDING_WHEN_CLAUSES)} clauses.`)
  }
  const seen = new Set<string>()
  const cloned = clauses.map((clause) => {
    if (typeof clause !== 'object' || clause === null || typeof clause.key !== 'string'
      || clause.key.length === 0 || clause.key.length > 64 || seen.has(clause.key)
      || !allowedContextValue(schema, clause.key, clause.equals)) {
      throw new Error('A keybinding context contains an unknown, duplicate, or invalid clause.')
    }
    seen.add(clause.key)
    return Object.freeze({ key: clause.key, equals: clause.equals })
  })
  return Object.freeze(cloned.sort((left, right) => left.key.localeCompare(right.key, 'en-US')))
}

function cloneDefaultBinding(
  binding: DefaultKeybinding,
  schema: KeybindingContextSchema,
  policy: KeybindingPolicy,
): DefaultKeybinding {
  validateIdentifier(binding.id, 'Default keybinding id')
  if (policy === 'none') throw new Error('Commands with keybindingPolicy none cannot contribute defaults.')
  const platforms = clonePlatforms(binding.platforms)
  const when = cloneWhen(binding.when, schema)
  return Object.freeze({
    id: binding.id,
    sequence: cloneSequence(binding.sequence, policy),
    ...(platforms === undefined ? {} : { platforms }),
    ...(when === undefined ? {} : { when }),
  })
}

function cloneUserInput(
  input: UserKeybindingInput,
  schema: KeybindingContextSchema,
  policy: KeybindingPolicy,
): UserKeybindingInput {
  validateIdentifier(input.commandId, 'Command id')
  if (policy === 'none') throw new Error('This command does not allow user keybindings.')
  const platforms = clonePlatforms(input.platforms)
  const when = cloneWhen(input.when, schema)
  return Object.freeze({
    commandId: input.commandId,
    sequence: cloneSequence(input.sequence, policy),
    ...(platforms === undefined ? {} : { platforms }),
    ...(when === undefined ? {} : { when }),
  })
}

function cloneUserBinding(
  binding: UserKeybinding,
  schema: KeybindingContextSchema,
  policy: KeybindingPolicy,
): UserKeybinding {
  validateIdentifier(binding.id, 'User keybinding id')
  const input = cloneUserInput(binding, schema, policy)
  return Object.freeze({ id: binding.id, ...input })
}

function strokeSignature(stroke: Readonly<KeyStroke>, platform: KeybindingPlatform): string {
  return keybindingSignature(stroke, platform)
}

function keyboardEventSignature(event: ShortcutKeyboardEventLike, platform: KeybindingPlatform): string {
  return keybindingSignature({
    key: event.key,
    ...(event.ctrlKey ? { ctrl: true } : {}),
    ...(event.metaKey ? { meta: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
  }, platform)
}

export function keybindingSequenceSignature(
  sequence: KeybindingSequence,
  platform: KeybindingPlatform,
): string {
  return sequence.map(stroke => strokeSignature(stroke, platform)).join(' ')
}

export function formatKeybindingSequence(sequence: KeybindingSequence, platform: KeybindingPlatform): string {
  return sequence.map(stroke => formatKeybinding(stroke, platform)).join(' ')
}

function matchesPlatform(candidate: Candidate, platform: KeybindingPlatform): boolean {
  return candidate.platforms === undefined || candidate.platforms.includes(platform)
}

function matchesWhen<C>(candidate: Candidate, context: Readonly<C>): boolean {
  if (candidate.when === undefined) return true
  const record = context as Readonly<Record<string, unknown>>
  try { return candidate.when.every(clause => record[clause.key] === clause.equals) } catch { return false }
}

function whenStrictlyContains(left: Candidate, right: Candidate): boolean {
  const leftClauses = left.when ?? []
  const rightClauses = right.when ?? []
  if (leftClauses.length <= rightClauses.length) return false
  return rightClauses.every(rightClause => leftClauses.some(
    leftClause => leftClause.key === rightClause.key && leftClause.equals === rightClause.equals,
  ))
}

function preferredCandidates(candidates: readonly Candidate[]): { preferred: Candidate[]; shadowed: Candidate[] } {
  if (candidates.length <= 1) return { preferred: [...candidates], shadowed: [] }
  const userLayer = candidates.some(candidate => candidate.source === 'user')
  const layer = candidates.filter(candidate => !userLayer || candidate.source === 'user')
  const specificPlatform = layer.some(candidate => candidate.platformSpecific)
  const platform = layer.filter(candidate => !specificPlatform || candidate.platformSpecific)
  const preferred = platform.filter(candidate => !platform.some(other => whenStrictlyContains(other, candidate)))
  const preferredIds = new Set(preferred.map(candidate => candidate.id))
  return {
    preferred,
    shadowed: candidates.filter(candidate => !preferredIds.has(candidate.id)),
  }
}

function frozenStatus(status: KeybindingPersistenceStatus): KeybindingPersistenceStatus {
  return Object.freeze({ ...status })
}

class MemoryKeybindingSettings implements KeybindingSettingsMutationPort {
  private value: KeybindingSettingsValue = Object.freeze({
    userBindings: Object.freeze([]),
    unboundDefaults: Object.freeze([]),
  })
  private readonly listeners = new Set<Listener>()
  private disposed = false

  constructor(private readonly createId: () => string) {}

  readonly getValue = (): KeybindingSettingsValue => this.value
  readonly getStatus = (): KeybindingPersistenceStatus => Object.freeze({ kind: 'memory' })
  readonly canDispatch = (): boolean => true
  readonly canResetInvalid = (): boolean => false
  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly startSync = (): void => {}

  readonly add = async (input: UserKeybindingInput): Promise<KeybindingEditOutcome> => {
    const id = this.uniqueId()
    return this.update([...this.value.userBindings, Object.freeze({ id, ...input })], this.value.unboundDefaults)
  }

  readonly replace = async (bindingId: string, input: UserKeybindingInput): Promise<KeybindingEditOutcome> => {
    const index = this.value.userBindings.findIndex(binding => binding.id === bindingId)
    if (index < 0) return { status: 'unchanged' }
    const next = [...this.value.userBindings]
    next[index] = Object.freeze({ id: bindingId, ...input })
    return this.update(next, this.value.unboundDefaults)
  }

  readonly replaceDefault = async (
    commandId: string,
    bindingId: string,
    input: UserKeybindingInput,
  ): Promise<KeybindingEditOutcome> => {
    if (input.commandId !== commandId) {
      return { status: 'failed', message: 'Replacement command id does not match its default binding.' }
    }
    const id = this.uniqueId()
    const userBindings = [...this.value.userBindings, Object.freeze({ id, ...input })]
    const unboundDefaults = this.value.unboundDefaults.some(
      value => value.commandId === commandId && value.bindingId === bindingId,
    ) ? this.value.unboundDefaults : [
      ...this.value.unboundDefaults,
      Object.freeze({ commandId, bindingId }),
    ]
    return this.update(userBindings, unboundDefaults)
  }

  readonly remove = async (bindingId: string): Promise<KeybindingEditOutcome> => {
    const next = this.value.userBindings.filter(binding => binding.id !== bindingId)
    return next.length === this.value.userBindings.length
      ? { status: 'unchanged' }
      : this.update(next, this.value.unboundDefaults)
  }

  readonly unbindDefault = async (commandId: string, bindingId: string): Promise<KeybindingEditOutcome> => {
    if (this.value.unboundDefaults.some(value => value.commandId === commandId && value.bindingId === bindingId)) {
      return { status: 'unchanged' }
    }
    return this.update(this.value.userBindings, [
      ...this.value.unboundDefaults,
      Object.freeze({ commandId, bindingId }),
    ])
  }

  readonly resetCommand = async (commandId: string): Promise<KeybindingEditOutcome> => {
    const userBindings = this.value.userBindings.filter(binding => binding.commandId !== commandId)
    const unboundDefaults = this.value.unboundDefaults.filter(binding => binding.commandId !== commandId)
    if (userBindings.length === this.value.userBindings.length
      && unboundDefaults.length === this.value.unboundDefaults.length) return { status: 'unchanged' }
    return this.update(userBindings, unboundDefaults)
  }

  readonly resetAll = async (): Promise<KeybindingEditOutcome> => {
    if (this.value.userBindings.length === 0 && this.value.unboundDefaults.length === 0) return { status: 'unchanged' }
    return this.update([], [])
  }

  readonly resetInvalidSettings = async (): Promise<KeybindingEditOutcome> => ({ status: 'unchanged' })

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.createId()
      validateIdentifier(id, 'User keybinding id')
      if (!this.value.userBindings.some(binding => binding.id === id)) return id
    }
    throw new Error('Could not allocate a unique user keybinding id.')
  }

  private update(
    userBindings: readonly UserKeybinding[],
    unboundDefaults: readonly UnboundDefaultKeybinding[],
  ): KeybindingEditOutcome {
    if (this.disposed) return { status: 'read-only', message: 'Keybinding settings are disposed.' }
    this.value = Object.freeze({
      userBindings: Object.freeze([...userBindings]),
      unboundDefaults: Object.freeze([...unboundDefaults]),
    })
    for (const listener of this.listeners) {
      try { listener() } catch { /* subscriber owns its error boundary */ }
    }
    return { status: 'saved' }
  }
}

const EMPTY_SNAPSHOT: KeybindingSnapshot = Object.freeze({
  revision: 0,
  platform: 'windows',
  commands: Object.freeze([]),
  conflicts: Object.freeze([]),
  persistence: Object.freeze({ kind: 'memory' }),
  dispatchBlocked: false,
  canResetInvalid: false,
})

/** Referentially stable external store; controller publishes deeply frozen snapshots. */
export class KeybindingStore {
  private current: KeybindingSnapshot
  private readonly listeners = new Set<Listener>()
  private disposed = false

  constructor(initial: KeybindingSnapshot = EMPTY_SNAPSHOT) {
    this.current = initial
  }

  readonly getSnapshot = (): KeybindingSnapshot => this.current

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @internal */
  publish(snapshot: KeybindingSnapshot): void {
    if (this.disposed || snapshot === this.current) return
    this.current = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* subscriber owns its error boundary */ }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }
}

export interface KeybindingControllerOptions<C> {
  readonly platform: KeybindingPlatform
  readonly getContext: () => Readonly<C>
  readonly contextSchema?: KeybindingContextSchema
  readonly isCommandActive: (commandId: string) => boolean
  readonly settings?: KeybindingSettingsMutationPort
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly createId?: () => string
}

/**
 * Browser-only shortcut resolver/controller. Command execution deliberately
 * remains in CommandRegistry; this class can return command ids but never runs
 * handlers or carries command arguments.
 */
export class KeybindingController<C> {
  readonly store: KeybindingStore
  private readonly commands = new Map<string, CommandContribution>()
  private readonly settings: KeybindingSettingsMutationPort
  private readonly unsubscribeSettings: () => void
  private readonly contextSchema: KeybindingContextSchema
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, milliseconds: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private revision = 0
  private disposed = false
  private persistenceSyncStarted = false
  private pendingFirstSignature: string | undefined
  private pendingTimer: unknown
  private candidates: readonly Candidate[] = Object.freeze([])
  private candidateStates = new Map<string, EffectiveKeybindingState>()
  private exactConflicts = new Map<string, KeybindingConflictView>()
  private prefixConflicts = new Map<string, KeybindingConflictView>()

  constructor(readonly options: KeybindingControllerOptions<C>) {
    this.contextSchema = options.contextSchema ?? Object.freeze({})
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds))
    this.clearTimer = options.clearTimer ?? (handle => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) })
    const createId = options.createId
      ?? (() => `kb-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`)
    this.settings = options.settings ?? new MemoryKeybindingSettings(createId)
    this.store = new KeybindingStore(Object.freeze({
      ...EMPTY_SNAPSHOT,
      platform: options.platform,
      persistence: frozenStatus(this.settings.getStatus()),
    }))
    this.unsubscribeSettings = this.settings.subscribe(() => { this.recompute() })
    this.recompute()
  }

  async addUserBinding(input: UserKeybindingInput): Promise<KeybindingEditOutcome> {
    return await this.edit(input.commandId, input, normalized => this.settings.add(normalized))
  }

  async replaceUserBinding(bindingId: string, input: UserKeybindingInput): Promise<KeybindingEditOutcome> {
    try { validateIdentifier(bindingId, 'User keybinding id') } catch (error) {
      return { status: 'failed', message: safeMessage(error) }
    }
    return await this.edit(input.commandId, input, normalized => this.settings.replace(bindingId, normalized))
  }

  async replaceDefaultBinding(
    commandId: string,
    bindingId: string,
    input: UserKeybindingInput,
  ): Promise<KeybindingEditOutcome> {
    try {
      validateIdentifier(bindingId, 'Default keybinding id')
      if (input.commandId !== commandId) throw new Error('Replacement command id does not match its default binding.')
      const contribution = this.commands.get(commandId)
      if (contribution === undefined) throw new Error(`Command ${commandId} is not currently registered.`)
      if (!contribution.defaultBindings.some(binding => binding.id === bindingId)) {
        throw new Error(`Default keybinding ${bindingId} is not registered for ${commandId}.`)
      }
      const normalized = cloneUserInput(input, this.contextSchema, contribution.policy)
      return await this.settings.replaceDefault(commandId, bindingId, normalized)
    } catch (error) { return { status: 'failed', message: safeMessage(error) } }
  }

  async removeUserBinding(bindingId: string): Promise<KeybindingEditOutcome> {
    try {
      validateIdentifier(bindingId, 'User keybinding id')
      return await this.settings.remove(bindingId)
    } catch (error) { return { status: 'failed', message: safeMessage(error) } }
  }

  async unbindDefault(commandId: string, bindingId: string): Promise<KeybindingEditOutcome> {
    try {
      validateIdentifier(commandId, 'Command id')
      validateIdentifier(bindingId, 'Default keybinding id')
      return await this.settings.unbindDefault(commandId, bindingId)
    } catch (error) { return { status: 'failed', message: safeMessage(error) } }
  }

  async resetCommand(commandId: string): Promise<KeybindingEditOutcome> {
    try {
      validateIdentifier(commandId, 'Command id')
      return await this.settings.resetCommand(commandId)
    } catch (error) { return { status: 'failed', message: safeMessage(error) } }
  }

  async resetAll(): Promise<KeybindingEditOutcome> {
    try { return await this.settings.resetAll() } catch (error) {
      return { status: 'failed', message: safeMessage(error) }
    }
  }

  async resetInvalidSettings(): Promise<KeybindingEditOutcome> {
    const reset = this.settings.resetInvalidSettings
    if (reset === undefined) {
      return { status: 'read-only', message: 'Invalid keybinding settings cannot be reset in this environment.' }
    }
    try { return await reset() } catch (error) {
      return { status: 'failed', message: safeMessage(error) }
    }
  }

  /** Effect-phase only: construction never attaches browser event listeners. */
  startPersistenceSync(): void {
    if (this.disposed || this.persistenceSyncStarted) return
    this.persistenceSyncStarted = true
    this.settings.startSync?.()
  }

  bindingsForCommand(commandId: string): CommandKeybindingView | undefined {
    return this.store.getSnapshot().commands.find(command => command.commandId === commandId)
  }

  findSame(sequence: KeybindingSequence): readonly EffectiveKeybindingView[] {
    let signature: string
    try { signature = keybindingSequenceSignature(cloneSequence(sequence, 'allow'), this.options.platform) } catch { return Object.freeze([]) }
    return Object.freeze(this.store.getSnapshot().commands.flatMap(command => command.effectiveBindings)
      .filter(binding => keybindingSequenceSignature(binding.sequence, this.options.platform) === signature))
  }

  previewUserBinding(input: UserKeybindingInput): KeybindingPreview {
    const contribution = this.commands.get(input.commandId)
    if (contribution === undefined) throw new Error(`Command ${input.commandId} is not currently registered.`)
    const normalized = cloneUserInput(input, this.contextSchema, contribution.policy)
    const signature = keybindingSequenceSignature(normalized.sequence, this.options.platform)
    const firstStrokeSignature = strokeSignature(normalized.sequence[0], this.options.platform)
    const all = this.store.getSnapshot().commands.flatMap(command => command.effectiveBindings)
    const exactMatches = Object.freeze(all.filter(
      binding => keybindingSequenceSignature(binding.sequence, this.options.platform) === signature,
    ))
    const prefixMatches = Object.freeze(all.filter((binding) => {
      const bindingFirst = strokeSignature(binding.sequence[0], this.options.platform)
      return bindingFirst === firstStrokeSignature
        && keybindingSequenceSignature(binding.sequence, this.options.platform) !== signature
        && (binding.sequence.length === 1 || normalized.sequence.length === 1)
    }))
    return Object.freeze({
      sequence: normalized.sequence,
      label: formatKeybindingSequence(normalized.sequence, this.options.platform),
      signature,
      firstStrokeSignature,
      exactMatches,
      prefixMatches,
    })
  }

  /** @internal Registry contribution seam. */
  registerCommand(commandId: string, bindings: readonly DefaultKeybinding[], policy: KeybindingPolicy): () => void {
    if (this.disposed) throw new Error('The keybinding controller is disposed.')
    validateIdentifier(commandId, 'Command id')
    if (this.commands.has(commandId)) throw new Error(`Keybindings for ${commandId} are already registered.`)
    const seen = new Set<string>()
    const defaults = bindings.map((binding) => {
      const cloned = cloneDefaultBinding(binding, this.contextSchema, policy)
      if (seen.has(cloned.id)) throw new Error(`Default keybinding ${cloned.id} is duplicated for ${commandId}.`)
      seen.add(cloned.id)
      return cloned
    })
    const token = Object.freeze({})
    const contribution = Object.freeze({
      token,
      commandId,
      defaultBindings: Object.freeze(defaults),
      policy,
    })
    this.commands.set(commandId, contribution)
    let projectionOnly: boolean
    try {
      projectionOnly = defaults.length === 0 && !this.hasStoredPreference(commandId)
      if (!projectionOnly) this.recompute()
    } catch (error) {
      this.commands.delete(commandId)
      try { this.recompute() } catch { /* preserve the original admission error */ }
      throw error
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.commands.get(commandId)?.token !== token) return
      this.commands.delete(commandId)
      if (!projectionOnly || this.hasStoredPreference(commandId)) this.recompute()
    }
  }

  /** @internal Registry context/disposal fence. */
  contextChanged(): void { this.recompute(true) }

  cancelPendingChord(): void { this.clearPending(true) }

  acceptKeyboardEvent(event: ShortcutKeyboardEventLike): ShortcutDecision {
    if (this.disposed) return { kind: 'none', consume: false }
    // A released primary modifier is normally pressed again before the second
    // stroke (for example Ctrl+K, then Ctrl+S). Its standalone keydown is not
    // a chord stroke and must not clear the pending prefix.
    if (modifierOnlyKey(event.key)) return { kind: 'none', consume: false }
    const eventSignature = keyboardEventSignature(event, this.options.platform)
    if (this.pendingFirstSignature !== undefined) {
      const pending = this.store.getSnapshot().pending
      if (pending === undefined || this.now() >= pending.expiresAt) {
        this.clearPending(true)
        return { kind: 'none', consume: false }
      }
      const firstSignature = this.pendingFirstSignature
      this.clearPending(true)
      const matched = this.candidates.filter(candidate => candidate.sequence.length === 2
        && strokeSignature(candidate.sequence[0], this.options.platform) === firstSignature
        && strokeSignature(candidate.sequence[1], this.options.platform) === eventSignature
        && (this.candidateStates.get(candidate.id) === 'active' || this.candidateStates.get(candidate.id) === 'conflict'))
      if (matched.length === 0) return { kind: 'none', consume: false }
      const matchedSequence = matched[0]?.sequence
      if (matchedSequence === undefined) return { kind: 'none', consume: false }
      const fullSignature = keybindingSequenceSignature(matchedSequence, this.options.platform)
      const conflict = this.exactConflicts.get(fullSignature)
      if (conflict !== undefined) return { kind: 'conflict', consume: true, conflict }
      const candidate = matched.find(value => this.candidateStates.get(value.id) === 'active')
      return candidate === undefined
        ? { kind: 'none', consume: false }
        : {
            kind: 'execute', consume: true, commandId: candidate.commandId,
            bindingId: candidate.bindingId, source: candidate.source,
          }
    }

    const candidates = this.candidates.filter(candidate => strokeSignature(candidate.sequence[0], this.options.platform) === eventSignature
      && (this.candidateStates.get(candidate.id) === 'active' || this.candidateStates.get(candidate.id) === 'conflict'))
    if (candidates.length === 0) return { kind: 'none', consume: false }
    const prefixConflict = this.prefixConflicts.get(eventSignature)
    if (prefixConflict !== undefined) return { kind: 'conflict', consume: true, conflict: prefixConflict }
    const singles = candidates.filter(candidate => candidate.sequence.length === 1)
    if (singles.length > 0) {
      const conflict = this.exactConflicts.get(eventSignature)
      if (conflict !== undefined) return { kind: 'conflict', consume: true, conflict }
      const candidate = singles.find(value => this.candidateStates.get(value.id) === 'active')
      if (candidate !== undefined) {
        return {
          kind: 'execute', consume: true, commandId: candidate.commandId,
          bindingId: candidate.bindingId, source: candidate.source,
        }
      }
    }
    const chords = candidates.filter(candidate => candidate.sequence.length === 2)
    if (chords.length === 0) return { kind: 'none', consume: false }
    const firstStroke = cloneStroke(chords[0]?.sequence[0] ?? event)
    const expiresAt = this.now() + KEYBINDING_CHORD_TIMEOUT_MS
    const pending = Object.freeze({
      firstStroke,
      label: formatKeybinding(firstStroke, this.options.platform),
      expiresAt,
    })
    this.pendingFirstSignature = eventSignature
    this.pendingTimer = this.setTimer(() => { this.clearPending(true) }, KEYBINDING_CHORD_TIMEOUT_MS)
    this.publishPending(pending)
    return { kind: 'pending', consume: true, pending }
  }

  commandForKeyboardEvent(event: ShortcutKeyboardEventLike): string | undefined {
    if (this.pendingFirstSignature !== undefined) return undefined
    const signature = keyboardEventSignature(event, this.options.platform)
    if (this.prefixConflicts.has(signature) || this.exactConflicts.has(signature)) return undefined
    return this.candidates.find(candidate => candidate.sequence.length === 1
      && strokeSignature(candidate.sequence[0], this.options.platform) === signature
      && this.candidateStates.get(candidate.id) === 'active')?.commandId
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearPending(false)
    this.unsubscribeSettings()
    this.settings.dispose()
    this.commands.clear()
    this.store.dispose()
  }

  private async edit(
    commandId: string,
    input: UserKeybindingInput,
    mutate: (normalized: UserKeybindingInput) => Promise<KeybindingEditOutcome>,
  ): Promise<KeybindingEditOutcome> {
    try {
      const contribution = this.commands.get(commandId)
      if (contribution === undefined) throw new Error(`Command ${commandId} is not currently registered.`)
      const normalized = cloneUserInput(input, this.contextSchema, contribution.policy)
      return await mutate(normalized)
    } catch (error) { return { status: 'failed', message: safeMessage(error) } }
  }

  private hasStoredPreference(commandId: string): boolean {
    try {
      const value = this.settings.getValue()
      return value.userBindings.some(binding => binding.commandId === commandId)
        || value.unboundDefaults.some(binding => binding.commandId === commandId)
    } catch { return true }
  }

  private readSettings(): {
    value: KeybindingSettingsValue
    status: KeybindingPersistenceStatus
    dispatchAllowed: boolean
  } {
    try {
      const status = frozenStatus(this.settings.getStatus())
      const dispatchAllowed = this.settings.canDispatch?.() ?? true
      const raw = this.settings.getValue()
      if (raw.userBindings.length + raw.unboundDefaults.length > MAX_USER_KEYBINDINGS) {
        throw new Error(`User keybindings exceed the limit of ${String(MAX_USER_KEYBINDINGS)} entries.`)
      }
      const ids = new Set<string>()
      const userBindings = raw.userBindings.map((binding) => {
        // Preferences outlive dynamic contributions. Structural decoding must
        // not discard unrelated entries when a command disappears or tightens
        // its policy; policy is applied later as an execution-time fence.
        const cloned = cloneUserBinding(binding, this.contextSchema, 'allow')
        if (ids.has(cloned.id)) throw new Error(`User keybinding ${cloned.id} is duplicated.`)
        ids.add(cloned.id)
        return cloned
      })
      const tombstones = new Set<string>()
      const unboundDefaults = raw.unboundDefaults.map((binding) => {
        validateIdentifier(binding.commandId, 'Command id')
        validateIdentifier(binding.bindingId, 'Default keybinding id')
        const key = `${binding.commandId}\u0000${binding.bindingId}`
        if (tombstones.has(key)) throw new Error('A default keybinding tombstone is duplicated.')
        tombstones.add(key)
        return Object.freeze({ commandId: binding.commandId, bindingId: binding.bindingId })
      })
      return {
        value: Object.freeze({
          userBindings: Object.freeze(userBindings),
          unboundDefaults: Object.freeze(unboundDefaults),
        }),
        status,
        dispatchAllowed,
      }
    } catch (error) {
      return {
        value: Object.freeze({ userBindings: Object.freeze([]), unboundDefaults: Object.freeze([]) }),
        status: Object.freeze({ kind: 'error', message: safeMessage(error) }),
        dispatchAllowed: false,
      }
    }
  }

  private recompute(preservePending = false): void {
    if (this.disposed) return
    const pending = preservePending ? this.store.getSnapshot().pending : undefined
    const pendingFirstSignature = preservePending ? this.pendingFirstSignature : undefined
    if (!preservePending) this.clearPending(false)
    const settings = this.readSettings()
    const tombstones = new Set(settings.value.unboundDefaults.map(value => `${value.commandId}\u0000${value.bindingId}`))
    const candidates: Candidate[] = []
    for (const contribution of this.commands.values()) {
      for (const binding of contribution.defaultBindings) {
        if (tombstones.has(`${contribution.commandId}\u0000${binding.id}`)) continue
        candidates.push(Object.freeze({
          id: `default:${contribution.commandId}:${binding.id}`,
          bindingId: binding.id,
          commandId: contribution.commandId,
          source: 'default',
          sequence: binding.sequence,
          ...(binding.platforms === undefined ? {} : { platforms: binding.platforms }),
          ...(binding.when === undefined ? {} : { when: binding.when }),
          platformSpecific: binding.platforms !== undefined,
        }))
      }
    }
    for (const binding of settings.value.userBindings) {
      candidates.push(Object.freeze({
        id: `user:${binding.commandId}:${binding.id}`,
        bindingId: binding.id,
        commandId: binding.commandId,
        source: 'user',
        sequence: binding.sequence,
        ...(binding.platforms === undefined ? {} : { platforms: binding.platforms }),
        ...(binding.when === undefined ? {} : { when: binding.when }),
        platformSpecific: binding.platforms !== undefined,
      }))
    }
    this.candidates = Object.freeze(candidates)
    const context = this.options.getContext()
    const states = new Map<string, EffectiveKeybindingState>()
    for (const candidate of candidates) {
      let commandActive = false
      try { commandActive = this.options.isCommandActive(candidate.commandId) } catch { commandActive = false }
      const policy = this.commands.get(candidate.commandId)?.policy
      const policyAllows = candidate.source === 'default' || (policy !== undefined && policy !== 'none'
        && (policy !== 'modified-only' || hasStrongModifier(candidate.sequence[0])))
      states.set(candidate.id, settings.dispatchAllowed && matchesPlatform(candidate, this.options.platform)
        && matchesWhen(candidate, context) && commandActive && policyAllows ? 'active' : 'inactive')
    }

    const exactConflicts = new Map<string, KeybindingConflictView>()
    const activeBySequence = new Map<string, Candidate[]>()
    for (const candidate of candidates) {
      if (states.get(candidate.id) !== 'active') continue
      const signature = keybindingSequenceSignature(candidate.sequence, this.options.platform)
      const group = activeBySequence.get(signature) ?? []
      group.push(candidate)
      activeBySequence.set(signature, group)
    }
    for (const [signature, group] of activeBySequence) {
      const { preferred, shadowed } = preferredCandidates(group)
      shadowed.forEach(candidate => states.set(candidate.id, 'shadowed'))
      const commandIds = [...new Set(preferred.map(candidate => candidate.commandId))].sort()
      if (commandIds.length > 1) {
        preferred.forEach(candidate => states.set(candidate.id, 'conflict'))
        exactConflicts.set(signature, Object.freeze({
          kind: 'exact', signature,
          candidateIds: Object.freeze(preferred.map(candidate => candidate.id).sort()),
          commandIds: Object.freeze(commandIds),
        }))
      } else if (preferred.length > 1) {
        const [winner, ...duplicates] = [...preferred].sort((left, right) => left.id.localeCompare(right.id, 'en-US'))
        if (winner !== undefined) states.set(winner.id, 'active')
        duplicates.forEach(candidate => states.set(candidate.id, 'shadowed'))
      }
    }

    const prefixConflicts = new Map<string, KeybindingConflictView>()
    const activeByFirst = new Map<string, Candidate[]>()
    for (const candidate of candidates) {
      if (states.get(candidate.id) !== 'active' && states.get(candidate.id) !== 'conflict') continue
      const signature = strokeSignature(candidate.sequence[0], this.options.platform)
      const group = activeByFirst.get(signature) ?? []
      group.push(candidate)
      activeByFirst.set(signature, group)
    }
    for (const [signature, group] of activeByFirst) {
      const singles = group.filter(candidate => candidate.sequence.length === 1)
      const chords = group.filter(candidate => candidate.sequence.length === 2)
      if (singles.length === 0 || chords.length === 0) continue
      const combined = preferredCandidates(group)
      const preferredHasSingle = combined.preferred.some(candidate => candidate.sequence.length === 1)
      const preferredHasChord = combined.preferred.some(candidate => candidate.sequence.length === 2)
      if (!preferredHasSingle || !preferredHasChord) {
        const preferredIds = new Set(combined.preferred.map(candidate => candidate.id))
        group.filter(candidate => !preferredIds.has(candidate.id)).forEach(candidate => states.set(candidate.id, 'shadowed'))
        continue
      }
      combined.shadowed.forEach(candidate => states.set(candidate.id, 'shadowed'))
      combined.preferred.forEach(candidate => states.set(candidate.id, 'conflict'))
      prefixConflicts.set(signature, Object.freeze({
        kind: 'prefix', signature,
        candidateIds: Object.freeze(combined.preferred.map(candidate => candidate.id).sort()),
        commandIds: Object.freeze([...new Set(combined.preferred.map(candidate => candidate.commandId))].sort()),
      }))
    }

    // Prefix precedence runs after exact resolution and can shadow every
    // candidate that originally formed an exact conflict. Rebuild the exact
    // projection from the final states so diagnostics and dispatch share one
    // winner set instead of retaining stale conflict metadata.
    const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate] as const))
    const prefixConflictCandidateIds = new Set(
      [...prefixConflicts.values()].flatMap(conflict => conflict.candidateIds),
    )
    const resolvedExactConflicts = new Map<string, KeybindingConflictView>()
    for (const [signature, conflict] of exactConflicts) {
      const surviving = conflict.candidateIds
        .map(candidateId => candidateById.get(candidateId))
        .filter((candidate): candidate is Candidate => (
          candidate !== undefined && states.get(candidate.id) === 'conflict'
        ))
      const survivingCommandIds = [...new Set(surviving.map(candidate => candidate.commandId))].sort()
      if (survivingCommandIds.length > 1) {
        resolvedExactConflicts.set(signature, Object.freeze({
          kind: 'exact', signature,
          candidateIds: Object.freeze(surviving.map(candidate => candidate.id).sort()),
          commandIds: Object.freeze(survivingCommandIds),
        }))
      } else if (surviving.length > 0
        && surviving.every(candidate => !prefixConflictCandidateIds.has(candidate.id))) {
        const [winner, ...duplicates] = [...surviving].sort((left, right) => left.id.localeCompare(right.id, 'en-US'))
        if (winner !== undefined) states.set(winner.id, 'active')
        duplicates.forEach(candidate => states.set(candidate.id, 'shadowed'))
      }
    }

    this.candidateStates = states
    this.exactConflicts = resolvedExactConflicts
    this.prefixConflicts = prefixConflicts
    const pendingStillValid = pending !== undefined && pendingFirstSignature !== undefined
      && this.now() < pending.expiresAt && !prefixConflicts.has(pendingFirstSignature)
      && candidates.some(candidate => candidate.sequence.length === 2
        && strokeSignature(candidate.sequence[0], this.options.platform) === pendingFirstSignature
        && (states.get(candidate.id) === 'active' || states.get(candidate.id) === 'conflict'))
    if (!pendingStillValid) this.clearPending(false)
    const conflicts = Object.freeze([...resolvedExactConflicts.values(), ...prefixConflicts.values()]
      .sort((left, right) => left.signature.localeCompare(right.signature, 'en-US') || left.kind.localeCompare(right.kind)))
    const commandIds = new Set<string>([
      ...[...this.commands.values()]
        .filter(contribution => contribution.defaultBindings.length > 0)
        .map(contribution => contribution.commandId),
      ...settings.value.userBindings.map(binding => binding.commandId),
      ...settings.value.unboundDefaults.map(binding => binding.commandId),
    ])
    const commandViews = [...commandIds].sort().map((commandId): CommandKeybindingView => {
      const contribution = this.commands.get(commandId)
      const defaults = contribution?.defaultBindings ?? Object.freeze([])
      const userBindings = Object.freeze(settings.value.userBindings.filter(binding => binding.commandId === commandId))
      const effectiveBindings = Object.freeze(candidates.filter(candidate => candidate.commandId === commandId).map((candidate) => Object.freeze({
        id: candidate.id,
        bindingId: candidate.bindingId,
        commandId,
        source: candidate.source,
        sequence: candidate.sequence,
        label: formatKeybindingSequence(candidate.sequence, this.options.platform),
        state: states.get(candidate.id) ?? 'inactive',
      } satisfies EffectiveKeybindingView)))
      const commandConflicts = Object.freeze(conflicts.filter(conflict => conflict.commandIds.includes(commandId)))
      const hasTombstone = settings.value.unboundDefaults.some(value => value.commandId === commandId)
      const state: CommandKeybindingView['state'] = commandConflicts.length > 0
        ? 'conflict'
        : effectiveBindings.length === 0
          ? 'unbound'
          : userBindings.length > 0 || hasTombstone
            ? 'customized'
            : 'default'
      return Object.freeze({
        commandId,
        state,
        defaultBindings: defaults,
        userBindings,
        effectiveBindings,
        conflicts: commandConflicts,
      })
    })
    this.revision += 1
    this.store.publish(Object.freeze({
      revision: this.revision,
      platform: this.options.platform,
      commands: Object.freeze(commandViews),
      conflicts,
      persistence: settings.status,
      dispatchBlocked: !settings.dispatchAllowed,
      canResetInvalid: this.settings.canResetInvalid?.() ?? false,
      ...(pendingStillValid ? { pending } : {}),
    }))
  }

  private publishPending(pending: PendingKeybindingChord): void {
    const current = this.store.getSnapshot()
    this.revision += 1
    this.store.publish(Object.freeze({ ...current, revision: this.revision, pending }))
  }

  private clearPending(publish: boolean): void {
    if (this.pendingTimer !== undefined) this.clearTimer(this.pendingTimer)
    this.pendingTimer = undefined
    const hadPending = this.pendingFirstSignature !== undefined || this.store.getSnapshot().pending !== undefined
    this.pendingFirstSignature = undefined
    if (!publish || !hadPending || this.disposed) return
    const current = this.store.getSnapshot()
    this.revision += 1
    const { pending: _pending, ...withoutPending } = current
    this.store.publish(Object.freeze({ ...withoutPending, revision: this.revision }))
  }
}
