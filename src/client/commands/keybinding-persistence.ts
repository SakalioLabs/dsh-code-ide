import {
  MAX_KEYBINDING_WHEN_CLAUSES,
  MAX_USER_KEYBINDINGS,
  type KeyStroke,
  type KeybindingEditOutcome,
  type KeybindingContextSchema,
  type KeybindingPersistenceStatus,
  type KeybindingPlatform,
  type KeybindingSequence,
  type KeybindingSettingsMutationPort,
  type KeybindingSettingsValue,
  type KeybindingWhenClause,
  type UnboundDefaultKeybinding,
  type UserKeybinding,
  type UserKeybindingInput,
} from './keybindings.ts'

export const KEYBINDING_SETTINGS_STORAGE_KEY = 'dsh-code-ide.keybindings.v1'
export const KEYBINDING_SETTINGS_LOCK_NAME = 'dsh-code-ide.keybindings.v1.writer'
export const KEYBINDING_SETTINGS_SCHEMA = 1
export const MAX_KEYBINDING_SETTINGS_RAW_CODE_UNITS = 256 * 1024
export const MAX_PERSISTED_USER_KEYBINDINGS = MAX_USER_KEYBINDINGS
export const MAX_PERSISTED_UNBOUND_DEFAULTS = 512
export const MAX_PERSISTED_KEYBINDING_ENTRIES = 512

const MAX_ID_CODE_UNITS = 128
const MAX_CONTEXT_VALUE_CODE_UNITS = 256
const READY_STATUS: KeybindingPersistenceStatus = Object.freeze({ kind: 'ready' })
const SAVING_STATUS: KeybindingPersistenceStatus = Object.freeze({ kind: 'saving' })
const EMPTY_ARRAY = Object.freeze([]) as readonly never[]
const EMPTY_VALUE: KeybindingSettingsValue = Object.freeze({
  userBindings: EMPTY_ARRAY,
  unboundDefaults: EMPTY_ARRAY,
})

export type PersistedUserKeybindingV1 = UserKeybinding
export type PersistedUnboundDefaultKeybindingV1 = UnboundDefaultKeybinding

export interface PersistedKeybindingSettingsV1 {
  readonly schema: 1
  readonly revision: number
  readonly writerId: string
  readonly updatedAt: number
  readonly userBindings: readonly PersistedUserKeybindingV1[]
  readonly unboundDefaults: readonly PersistedUnboundDefaultKeybindingV1[]
}

export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The callback is the complete lock lifetime; callers must not retain a release handle. */
export interface LockPort {
  runExclusive<T>(name: string, callback: () => T | Promise<T>, signal?: AbortSignal): Promise<T>
}

export interface StorageEventPort {
  subscribe(key: string, listener: () => void): () => void
}

export interface KeybindingPersistenceOptions {
  readonly storage: StoragePort
  readonly lock?: LockPort
  readonly storageEvents?: StorageEventPort
  readonly now?: () => number
  readonly createId?: () => string
  readonly contextSchema?: KeybindingContextSchema
}

type Listener = () => void

type ReadResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly value: PersistedKeybindingSettingsV1 }
  | { readonly kind: 'future' | 'corrupt' | 'error'; readonly message: string }

type Mutation = (
  current: KeybindingSettingsValue,
) => { readonly kind: 'unchanged' } | { readonly kind: 'changed'; readonly value: KeybindingSettingsValue }

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const admitted = new Set([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!admitted.has(key)) throw new Error(`${label} contains an unsupported ${key} field.`)
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label} is missing ${key}.`)
  }
}

function safeText(value: unknown, label: string, maximum = MAX_ID_CODE_UNITS): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be non-empty text with at most ${String(maximum)} characters.`)
  }
  return value
}

function safeKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /^(?:Alt|AltGraph|Control|Dead|Meta|Process|Shift|Unidentified)$/iu.test(value)) {
    throw new Error('Key stroke key must be printable text with at most 32 characters.')
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const id = safeText(value, label)
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(id)) {
    throw new Error(`${label} must be a stable identifier with at most ${String(MAX_ID_CODE_UNITS)} characters.`)
  }
  return id
}

function commandId(value: unknown): string {
  return identifier(value, 'Command id')
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value
}

function cloneStroke(value: unknown): Readonly<KeyStroke> {
  const record = ownRecord(value, 'Key stroke')
  exactKeys(record, ['key'], ['primary', 'shift', 'alt', 'ctrl', 'meta'], 'Key stroke')
  const key = safeKey(record.key)
  const result: {
    key: string
    primary?: boolean
    shift?: boolean
    alt?: boolean
    ctrl?: boolean
    meta?: boolean
  } = { key }
  for (const modifier of ['primary', 'shift', 'alt', 'ctrl', 'meta'] as const) {
    const setting = record[modifier]
    if (setting !== undefined && typeof setting !== 'boolean') {
      throw new Error(`Key stroke ${modifier} must be boolean.`)
    }
    if (setting === true) result[modifier] = true
  }
  if (result.primary === true && (result.ctrl === true || result.meta === true)) {
    throw new Error('A key stroke cannot combine primary with explicit Ctrl or Meta.')
  }
  return Object.freeze(result)
}

function cloneSequence(value: unknown): KeybindingSequence {
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) {
    throw new Error('A keybinding sequence must contain one or two strokes.')
  }
  const first = cloneStroke(value[0])
  if ([...first.key].length === 1 && first.primary !== true && first.ctrl !== true
    && first.meta !== true && first.alt !== true) {
    throw new Error('A printable first stroke requires a modifier.')
  }
  const second = value[1] === undefined ? undefined : cloneStroke(value[1])
  return second === undefined ? Object.freeze([first]) : Object.freeze([first, second])
}

const PLATFORM_ORDER: readonly KeybindingPlatform[] = ['mac', 'windows', 'linux']

function clonePlatforms(value: unknown): readonly KeybindingPlatform[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > PLATFORM_ORDER.length) {
    throw new Error('Keybinding platforms must be a non-empty bounded array.')
  }
  const platforms = new Set<KeybindingPlatform>()
  for (const candidate of value) {
    if (candidate !== 'mac' && candidate !== 'windows' && candidate !== 'linux') {
      throw new Error('Keybinding platform is unsupported.')
    }
    if (platforms.has(candidate)) throw new Error('Keybinding platforms must be unique.')
    platforms.add(candidate)
  }
  return Object.freeze(PLATFORM_ORDER.filter(platform => platforms.has(platform)).sort())
}

function cloneWhen(value: unknown): readonly KeybindingWhenClause[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KEYBINDING_WHEN_CLAUSES) {
    throw new Error(`Keybinding when clauses require one to ${String(MAX_KEYBINDING_WHEN_CLAUSES)} entries.`)
  }
  const keys = new Set<string>()
  const clauses = value.map((candidate): KeybindingWhenClause => {
    const record = ownRecord(candidate, 'Keybinding when clause')
    exactKeys(record, ['key', 'equals'], [], 'Keybinding when clause')
    const key = safeText(record.key, 'Keybinding context key', 64)
    if (keys.has(key)) throw new Error('Keybinding context keys must be unique.')
    keys.add(key)
    const equals = record.equals
    if (typeof equals !== 'boolean' && (typeof equals !== 'string'
      || equals.length > MAX_CONTEXT_VALUE_CODE_UNITS || /[\u0000-\u001f\u007f]/u.test(equals))) {
      throw new Error('Keybinding context value must be a boolean or bounded text.')
    }
    return Object.freeze({ key, equals })
  })
  return Object.freeze(clauses.sort((left, right) => left.key.localeCompare(right.key, 'en-US')))
}

function validateWhenSchema(
  when: readonly KeybindingWhenClause[] | undefined,
  schema: KeybindingContextSchema | undefined,
): void {
  if (when === undefined || schema === undefined) return
  for (const clause of when) {
    const domain = schema[clause.key]
    const valid = domain === 'boolean'
      ? typeof clause.equals === 'boolean'
      : domain !== undefined && domain.some(value => value === clause.equals)
    if (!valid) throw new Error(`Keybinding context key ${clause.key} is not admitted by this workbench.`)
  }
}

function cloneUserBinding(value: unknown, label = 'User keybinding'): UserKeybinding {
  const record = ownRecord(value, label)
  exactKeys(record, ['id', 'commandId', 'sequence'], ['platforms', 'when'], label)
  const platforms = clonePlatforms(record.platforms)
  const when = cloneWhen(record.when)
  return Object.freeze({
    id: identifier(record.id, `${label} id`),
    commandId: commandId(record.commandId),
    sequence: cloneSequence(record.sequence),
    ...(platforms === undefined ? {} : { platforms }),
    ...(when === undefined ? {} : { when }),
  })
}

function cloneUserInput(value: unknown): UserKeybindingInput {
  const record = ownRecord(value, 'User keybinding input')
  exactKeys(record, ['commandId', 'sequence'], ['platforms', 'when'], 'User keybinding input')
  const platforms = clonePlatforms(record.platforms)
  const when = cloneWhen(record.when)
  return Object.freeze({
    commandId: commandId(record.commandId),
    sequence: cloneSequence(record.sequence),
    ...(platforms === undefined ? {} : { platforms }),
    ...(when === undefined ? {} : { when }),
  })
}

function cloneTombstone(value: unknown): UnboundDefaultKeybinding {
  const record = ownRecord(value, 'Unbound default keybinding')
  exactKeys(record, ['commandId', 'bindingId'], [], 'Unbound default keybinding')
  return Object.freeze({
    commandId: commandId(record.commandId),
    bindingId: identifier(record.bindingId, 'Default keybinding id'),
  })
}

function assertEntryBounds(
  userBindings: readonly UserKeybinding[],
  unboundDefaults: readonly UnboundDefaultKeybinding[],
): void {
  if (userBindings.length > MAX_PERSISTED_USER_KEYBINDINGS) {
    throw new Error(`Persisted user keybindings exceed the ${String(MAX_PERSISTED_USER_KEYBINDINGS)} entry limit.`)
  }
  if (unboundDefaults.length > MAX_PERSISTED_UNBOUND_DEFAULTS) {
    throw new Error(`Persisted default unbinds exceed the ${String(MAX_PERSISTED_UNBOUND_DEFAULTS)} entry limit.`)
  }
  if (userBindings.length + unboundDefaults.length > MAX_PERSISTED_KEYBINDING_ENTRIES) {
    throw new Error(`Persisted keybinding settings exceed the ${String(MAX_PERSISTED_KEYBINDING_ENTRIES)} total entry limit.`)
  }
}

function freezeValue(
  userBindings: readonly UserKeybinding[],
  unboundDefaults: readonly UnboundDefaultKeybinding[],
): KeybindingSettingsValue {
  assertEntryBounds(userBindings, unboundDefaults)
  if (userBindings.length === 0 && unboundDefaults.length === 0) return EMPTY_VALUE
  return Object.freeze({
    userBindings: Object.freeze([...userBindings]),
    unboundDefaults: Object.freeze([...unboundDefaults]),
  })
}

export function decodePersistedKeybindingSettingsV1(value: unknown): PersistedKeybindingSettingsV1 {
  const record = ownRecord(value, 'Persisted keybinding settings')
  exactKeys(
    record,
    ['schema', 'revision', 'writerId', 'updatedAt', 'userBindings', 'unboundDefaults'],
    [],
    'Persisted keybinding settings',
  )
  if (record.schema !== KEYBINDING_SETTINGS_SCHEMA) throw new Error('Unsupported keybinding settings schema.')
  if (!Array.isArray(record.userBindings) || !Array.isArray(record.unboundDefaults)) {
    throw new Error('Persisted keybinding entries must be arrays.')
  }
  const userBindings = Object.freeze(record.userBindings.map(binding => cloneUserBinding(binding)))
  const unboundDefaults = Object.freeze(record.unboundDefaults.map(binding => cloneTombstone(binding)))
  assertEntryBounds(userBindings, unboundDefaults)

  const userIds = new Set<string>()
  for (const binding of userBindings) {
    if (userIds.has(binding.id)) throw new Error(`Duplicate user keybinding id: ${binding.id}`)
    userIds.add(binding.id)
  }
  const tombstoneIds = new Set<string>()
  for (const binding of unboundDefaults) {
    const id = `${binding.commandId}\u0000${binding.bindingId}`
    if (tombstoneIds.has(id)) throw new Error(`Duplicate default keybinding unbind: ${binding.commandId}/${binding.bindingId}`)
    tombstoneIds.add(id)
  }

  return Object.freeze({
    schema: 1,
    revision: nonNegativeSafeInteger(record.revision, 'Keybinding settings revision'),
    writerId: safeText(record.writerId, 'Keybinding settings writer id'),
    updatedAt: nonNegativeSafeInteger(record.updatedAt, 'Keybinding settings updatedAt'),
    userBindings,
    unboundDefaults,
  })
}

export function encodePersistedKeybindingSettingsV1(value: PersistedKeybindingSettingsV1): string {
  const owned = decodePersistedKeybindingSettingsV1(value)
  const raw = JSON.stringify(owned)
  if (raw.length > MAX_KEYBINDING_SETTINGS_RAW_CODE_UNITS) {
    throw new Error('Keybinding settings exceed the 256 KiB storage budget.')
  }
  return raw
}

function parseRaw(raw: string | null): ReadResult {
  if (raw === null) return { kind: 'empty' }
  if (raw.length > MAX_KEYBINDING_SETTINGS_RAW_CODE_UNITS) {
    return { kind: 'corrupt', message: 'Stored keybinding settings exceed the 256 KiB safety limit.' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return { kind: 'corrupt', message: 'Stored keybinding settings are not valid JSON.' }
  }
  const schema = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).schema
    : undefined
  if (typeof schema === 'number' && schema > KEYBINDING_SETTINGS_SCHEMA) {
    return {
      kind: 'future',
      message: 'A newer keybinding settings format is present; this version will not overwrite it.',
    }
  }
  try {
    return { kind: 'ready', value: decodePersistedKeybindingSettingsV1(parsed) }
  } catch (error) {
    return { kind: 'corrupt', message: error instanceof Error ? error.message : String(error) }
  }
}

function valueFromPersisted(value: PersistedKeybindingSettingsV1): KeybindingSettingsValue {
  return freezeValue(value.userBindings, value.unboundDefaults)
}

function valuesEqual(left: KeybindingSettingsValue, right: KeybindingSettingsValue): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

function statusesEqual(left: KeybindingPersistenceStatus, right: KeybindingPersistenceStatus): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'readOnly' && right.kind === 'readOnly') return left.message === right.message
  if (left.kind === 'error' && right.kind === 'error') return left.message === right.message
  return true
}

function frozenStatus(status: KeybindingPersistenceStatus): KeybindingPersistenceStatus {
  if (status.kind === 'ready') return READY_STATUS
  if (status.kind === 'saving') return SAVING_STATUS
  return Object.freeze({ ...status })
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '�').slice(0, 1_000)
  return safe.length === 0 ? 'Unknown persistence error.' : safe
}

function defaultCreateId(): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `kb-${value}`
}

/**
 * Browser-local keybinding settings. Every edit obtains one short exclusive
 * Web Lock, reloads the latest wire value inside that lock, and writes once.
 */
export class KeybindingPersistenceController implements KeybindingSettingsMutationPort {
  private readonly storage: StoragePort
  private readonly lock: LockPort | undefined
  private readonly now: () => number
  private readonly createId: () => string
  private readonly writerId: string
  private readonly contextSchema: KeybindingContextSchema | undefined
  private readonly storageEvents: StorageEventPort | undefined
  private readonly listeners = new Set<Listener>()
  private readonly pendingSettlements = new Set<(outcome: KeybindingEditOutcome) => void>()
  private readonly lockAbort = new AbortController()
  private unsubscribeStorageEvents: (() => void) | undefined
  private currentValue: KeybindingSettingsValue = EMPTY_VALUE
  private currentStatus: KeybindingPersistenceStatus = READY_STATUS
  private formatWritable = true
  private readOnlyMessage: string | undefined
  private dispatchAllowed = true
  private invalidStoredValue = false
  private syncStarted = false
  private disposed = false
  private mutating = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: KeybindingPersistenceOptions) {
    this.storage = options.storage
    this.lock = options.lock
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? defaultCreateId
    this.contextSchema = options.contextSchema
    this.storageEvents = options.storageEvents
    this.writerId = safeText(this.createId(), 'Keybinding settings writer id')

    const initial = this.readLatest()
    this.applyReadResult(initial)
    if (initial.kind !== 'error' && this.lock === undefined && this.formatWritable) {
      this.readOnlyMessage = 'This browser cannot provide an exclusive Web Lock; keybinding settings are read-only.'
      this.publish(this.currentValue, Object.freeze({ kind: 'readOnly', message: this.readOnlyMessage }))
    }
  }

  readonly getValue = (): KeybindingSettingsValue => this.currentValue

  readonly getStatus = (): KeybindingPersistenceStatus => this.currentStatus
  readonly canDispatch = (): boolean => this.dispatchAllowed

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly startSync = (): void => {
    if (this.disposed || this.syncStarted) return
    this.syncStarted = true
    this.unsubscribeStorageEvents = this.storageEvents?.subscribe(KEYBINDING_SETTINGS_STORAGE_KEY, () => {
      this.reloadFromStorageEvent()
    })
    // Close the constructor-read -> effect-subscribe race. Subscribing first means
    // either this read or a concurrently delivered storage event observes latest.
    this.reloadFromStorageEvent()
  }

  readonly canResetInvalid = (): boolean => !this.disposed && this.invalidStoredValue && this.lock !== undefined

  readonly add = async (input: UserKeybindingInput): Promise<KeybindingEditOutcome> => {
    let owned: UserKeybindingInput
    try {
      owned = cloneUserInput(input)
      validateWhenSchema(owned.when, this.contextSchema)
    } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      let id: string | undefined
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = identifier(this.createId(), 'User keybinding id')
        if (!current.userBindings.some(binding => binding.id === candidate)) {
          id = candidate
          break
        }
      }
      if (id === undefined) throw new Error('Could not allocate a unique user keybinding id.')
      const binding = cloneUserBinding({ id, ...owned })
      return {
        kind: 'changed',
        value: freezeValue([...current.userBindings, binding], current.unboundDefaults),
      }
    })
  }

  readonly replace = async (
    bindingId: string,
    input: UserKeybindingInput,
  ): Promise<KeybindingEditOutcome> => {
    let id: string
    let owned: UserKeybindingInput
    try {
      id = identifier(bindingId, 'User keybinding id')
      owned = cloneUserInput(input)
      validateWhenSchema(owned.when, this.contextSchema)
    } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      const index = current.userBindings.findIndex(binding => binding.id === id)
      if (index < 0) return { kind: 'unchanged' }
      const replacement = cloneUserBinding({ id, ...owned })
      if (JSON.stringify(current.userBindings[index]) === JSON.stringify(replacement)) return { kind: 'unchanged' }
      const userBindings = [...current.userBindings]
      userBindings[index] = replacement
      return { kind: 'changed', value: freezeValue(userBindings, current.unboundDefaults) }
    })
  }

  readonly replaceDefault = async (
    command: string,
    bindingId: string,
    input: UserKeybindingInput,
  ): Promise<KeybindingEditOutcome> => {
    let tombstone: UnboundDefaultKeybinding
    let owned: UserKeybindingInput
    try {
      tombstone = cloneTombstone({ commandId: command, bindingId })
      owned = cloneUserInput(input)
      validateWhenSchema(owned.when, this.contextSchema)
      if (owned.commandId !== tombstone.commandId) {
        throw new Error('Replacement command id does not match its default binding.')
      }
    } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      let id: string | undefined
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = identifier(this.createId(), 'User keybinding id')
        if (!current.userBindings.some(binding => binding.id === candidate)) {
          id = candidate
          break
        }
      }
      if (id === undefined) throw new Error('Could not allocate a unique user keybinding id.')
      const userBinding = cloneUserBinding({ id, ...owned })
      const hasTombstone = current.unboundDefaults.some(value => value.commandId === tombstone.commandId
        && value.bindingId === tombstone.bindingId)
      return {
        kind: 'changed',
        value: freezeValue(
          [...current.userBindings, userBinding],
          hasTombstone ? current.unboundDefaults : [...current.unboundDefaults, tombstone],
        ),
      }
    })
  }

  readonly remove = async (bindingId: string): Promise<KeybindingEditOutcome> => {
    let id: string
    try { id = identifier(bindingId, 'User keybinding id') } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      const userBindings = current.userBindings.filter(binding => binding.id !== id)
      return userBindings.length === current.userBindings.length
        ? { kind: 'unchanged' }
        : { kind: 'changed', value: freezeValue(userBindings, current.unboundDefaults) }
    })
  }

  readonly unbindDefault = async (command: string, bindingId: string): Promise<KeybindingEditOutcome> => {
    let tombstone: UnboundDefaultKeybinding
    try { tombstone = cloneTombstone({ commandId: command, bindingId }) } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      if (current.unboundDefaults.some(binding => binding.commandId === tombstone.commandId
        && binding.bindingId === tombstone.bindingId)) return { kind: 'unchanged' }
      return {
        kind: 'changed',
        value: freezeValue(current.userBindings, [...current.unboundDefaults, tombstone]),
      }
    })
  }

  readonly resetCommand = async (command: string): Promise<KeybindingEditOutcome> => {
    let id: string
    try { id = commandId(command) } catch (error) { return this.inputFailure(error) }
    return await this.enqueueMutation(current => {
      const userBindings = current.userBindings.filter(binding => binding.commandId !== id)
      const unboundDefaults = current.unboundDefaults.filter(binding => binding.commandId !== id)
      return userBindings.length === current.userBindings.length
        && unboundDefaults.length === current.unboundDefaults.length
        ? { kind: 'unchanged' }
        : { kind: 'changed', value: freezeValue(userBindings, unboundDefaults) }
    })
  }

  readonly resetAll = async (): Promise<KeybindingEditOutcome> => await this.enqueueMutation(current => (
    current.userBindings.length === 0 && current.unboundDefaults.length === 0
      ? { kind: 'unchanged' }
      : { kind: 'changed', value: EMPTY_VALUE }
  ))

  readonly resetInvalidSettings = async (): Promise<KeybindingEditOutcome> => await this.enqueueInvalidReset()

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lockAbort.abort()
    this.unsubscribeStorageEvents?.()
    this.unsubscribeStorageEvents = undefined
    this.listeners.clear()
    const outcome = this.disposedOutcome()
    for (const settle of [...this.pendingSettlements]) settle(outcome)
    this.pendingSettlements.clear()
  }

  private enqueueInvalidReset(): Promise<KeybindingEditOutcome> {
    if (this.disposed) return Promise.resolve(this.disposedOutcome())
    let resolve!: (outcome: KeybindingEditOutcome) => void
    const outcome = new Promise<KeybindingEditOutcome>(accept => { resolve = accept })
    let settled = false
    const settle = (value: KeybindingEditOutcome): void => {
      if (settled) return
      settled = true
      this.pendingSettlements.delete(settle)
      resolve(value)
    }
    this.pendingSettlements.add(settle)
    const markLockAcquired = (): void => { this.pendingSettlements.delete(settle) }
    this.mutationTail = this.mutationTail.then(async () => {
      settle(await this.runInvalidReset(markLockAcquired))
    }, async () => {
      settle(await this.runInvalidReset(markLockAcquired))
    })
    return outcome
  }

  private async runInvalidReset(markLockAcquired: () => void): Promise<KeybindingEditOutcome> {
    if (this.disposed) return { status: 'read-only', message: 'Keybinding persistence is disposed.' }
    if (!this.invalidStoredValue) return { status: 'unchanged' }
    if (this.lock === undefined) {
      return { status: 'read-only', message: 'A Web Lock is required to reset invalid keybinding settings.' }
    }
    this.publish(this.currentValue, SAVING_STATUS)
    try {
      return await this.lock.runExclusive(KEYBINDING_SETTINGS_LOCK_NAME, async () => {
        // Once the critical section starts, disposal must not project a write
        // that has already committed as read-only. The synchronous callback
        // owns its exact result until the lock promise unwinds.
        markLockAcquired()
        if (this.disposed) return this.disposedOutcome()
        const latest = this.readLatest()
        if (latest.kind === 'ready' || latest.kind === 'empty') {
          this.formatWritable = true
          this.invalidStoredValue = false
          this.readOnlyMessage = undefined
          this.applyReadResult(latest)
          return { status: 'unchanged' }
        }
        if (latest.kind === 'error') {
          this.applyReadResult(latest)
          return { status: 'failed', message: latest.message }
        }
        const updatedAt = nonNegativeSafeInteger(this.now(), 'Keybinding settings updatedAt')
        const empty: PersistedKeybindingSettingsV1 = Object.freeze({
          schema: 1,
          revision: 1,
          writerId: this.writerId,
          updatedAt,
          userBindings: Object.freeze([]),
          unboundDefaults: Object.freeze([]),
        })
        this.storage.setItem(KEYBINDING_SETTINGS_STORAGE_KEY, encodePersistedKeybindingSettingsV1(empty))
        this.formatWritable = true
        this.invalidStoredValue = false
        this.readOnlyMessage = undefined
        this.dispatchAllowed = true
        this.publish(EMPTY_VALUE, READY_STATUS)
        return { status: 'saved' }
      }, this.lockAbort.signal)
    } catch (error) {
      if (this.disposed) return this.disposedOutcome()
      const message = `Invalid keybinding settings could not be reset: ${safeErrorMessage(error)}`
      this.dispatchAllowed = false
      this.publish(this.currentValue, Object.freeze({ kind: 'error', message }))
      return { status: 'failed', message }
    }
  }

  private enqueueMutation(mutation: Mutation): Promise<KeybindingEditOutcome> {
    if (this.disposed) return Promise.resolve(this.disposedOutcome())
    let resolve!: (outcome: KeybindingEditOutcome) => void
    const outcome = new Promise<KeybindingEditOutcome>(accept => { resolve = accept })
    let settled = false
    const settle = (value: KeybindingEditOutcome): void => {
      if (settled) return
      settled = true
      this.pendingSettlements.delete(settle)
      resolve(value)
    }
    this.pendingSettlements.add(settle)
    const markLockAcquired = (): void => { this.pendingSettlements.delete(settle) }
    this.mutationTail = this.mutationTail.then(async () => {
      settle(await this.runMutation(mutation, markLockAcquired))
    }, async () => {
      settle(await this.runMutation(mutation, markLockAcquired))
    })
    return outcome
  }

  private async runMutation(mutation: Mutation, markLockAcquired: () => void): Promise<KeybindingEditOutcome> {
    if (this.disposed) return { status: 'read-only', message: 'Keybinding persistence is disposed.' }
    if (!this.formatWritable || this.lock === undefined) {
      const message = this.readOnlyMessage ?? 'Keybinding settings are read-only.'
      this.publish(this.currentValue, Object.freeze({ kind: 'readOnly', message }))
      return { status: 'read-only', message }
    }
    this.mutating = true
    this.publish(this.currentValue, SAVING_STATUS)
    try {
      return await this.lock.runExclusive(KEYBINDING_SETTINGS_LOCK_NAME, async () => {
        markLockAcquired()
        if (this.disposed) return { status: 'read-only', message: 'Keybinding persistence is disposed.' }
        if (!this.formatWritable) {
          return { status: 'read-only', message: this.readOnlyMessage ?? 'Keybinding settings are read-only.' }
        }
        const latest = this.readLatest()
        if (latest.kind === 'future' || latest.kind === 'corrupt') {
          this.applyReadResult(latest)
          return { status: 'read-only', message: latest.message }
        }
        if (latest.kind === 'error') {
          this.applyReadResult(latest)
          return { status: 'failed', message: latest.message }
        }
        const persisted = latest.kind === 'ready' ? latest.value : undefined
        const current = persisted === undefined ? EMPTY_VALUE : valueFromPersisted(persisted)
        this.publish(current, SAVING_STATUS)
        const change = mutation(current)
        if (change.kind === 'unchanged') {
          this.publish(current, READY_STATUS)
          return { status: 'unchanged' }
        }
        const revision = persisted?.revision ?? 0
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Keybinding settings revision is exhausted.')
        const updatedAt = nonNegativeSafeInteger(this.now(), 'Keybinding settings updatedAt')
        const next: PersistedKeybindingSettingsV1 = Object.freeze({
          schema: 1,
          revision: revision + 1,
          writerId: this.writerId,
          updatedAt,
          userBindings: change.value.userBindings,
          unboundDefaults: change.value.unboundDefaults,
        })
        const raw = encodePersistedKeybindingSettingsV1(next)
        this.storage.setItem(KEYBINDING_SETTINGS_STORAGE_KEY, raw)
        this.publish(change.value, READY_STATUS)
        return { status: 'saved' }
      }, this.lockAbort.signal)
    } catch (error) {
      if (this.disposed) return this.disposedOutcome()
      const message = `Keybinding settings could not be saved: ${safeErrorMessage(error)}`
      this.publish(this.currentValue, Object.freeze({ kind: 'error', message }))
      return { status: 'failed', message }
    } finally {
      this.mutating = false
      if (this.currentStatus.kind === 'saving') this.publish(this.currentValue, READY_STATUS)
    }
  }

  private inputFailure(error: unknown): KeybindingEditOutcome {
    if (this.disposed) return { status: 'read-only', message: 'Keybinding persistence is disposed.' }
    if (!this.formatWritable || this.lock === undefined) {
      return { status: 'read-only', message: this.readOnlyMessage ?? 'Keybinding settings are read-only.' }
    }
    const message = `Invalid keybinding settings edit: ${safeErrorMessage(error)}`
    this.publish(this.currentValue, Object.freeze({ kind: 'error', message }))
    return { status: 'failed', message }
  }

  private disposedOutcome(): KeybindingEditOutcome {
    return { status: 'read-only', message: 'Keybinding persistence is disposed.' }
  }

  private readLatest(): ReadResult {
    try {
      const result = parseRaw(this.storage.getItem(KEYBINDING_SETTINGS_STORAGE_KEY))
      if (result.kind === 'ready') {
        try {
          result.value.userBindings.forEach(binding => { validateWhenSchema(binding.when, this.contextSchema) })
        } catch (error) {
          return { kind: 'corrupt', message: safeErrorMessage(error) }
        }
      }
      return result
    } catch (error) {
      return { kind: 'error', message: `Keybinding settings are unavailable: ${safeErrorMessage(error)}` }
    }
  }

  private applyReadResult(result: ReadResult): void {
    if (result.kind === 'empty') {
      this.dispatchAllowed = true
      this.invalidStoredValue = false
      const status = this.mutating ? SAVING_STATUS : this.baseAvailableStatus()
      this.publish(EMPTY_VALUE, status)
      return
    }
    if (result.kind === 'ready') {
      this.dispatchAllowed = true
      this.invalidStoredValue = false
      const status = this.mutating ? SAVING_STATUS : this.baseAvailableStatus()
      this.publish(valueFromPersisted(result.value), status)
      return
    }
    if (result.kind === 'future' || result.kind === 'corrupt') {
      this.makeReadOnly(result.message)
      return
    }
    this.dispatchAllowed = false
    this.publish(this.currentValue, Object.freeze({ kind: 'error', message: result.message }))
  }

  private baseAvailableStatus(): KeybindingPersistenceStatus {
    if (!this.formatWritable || this.lock === undefined) {
      return Object.freeze({
        kind: 'readOnly',
        message: this.readOnlyMessage
          ?? 'This browser cannot provide an exclusive Web Lock; keybinding settings are read-only.',
      })
    }
    return READY_STATUS
  }

  private makeReadOnly(message: string): void {
    this.formatWritable = false
    this.dispatchAllowed = false
    this.invalidStoredValue = true
    this.readOnlyMessage = message
    this.publish(EMPTY_VALUE, Object.freeze({ kind: 'readOnly', message }))
  }

  private reloadFromStorageEvent(): void {
    if (this.disposed) return
    if (!this.formatWritable) return
    const result = this.readLatest()
    this.applyReadResult(result)
  }

  private publish(value: KeybindingSettingsValue, status: KeybindingPersistenceStatus): void {
    if (this.disposed) return
    const nextValue = valuesEqual(this.currentValue, value) ? this.currentValue : value
    const ownedStatus = frozenStatus(status)
    const nextStatus = statusesEqual(this.currentStatus, ownedStatus) ? this.currentStatus : ownedStatus
    if (nextValue === this.currentValue && nextStatus === this.currentStatus) return
    this.currentValue = nextValue
    this.currentStatus = nextStatus
    for (const listener of this.listeners) {
      try { listener() } catch { /* subscriber owns its reporting boundary */ }
    }
  }
}

function browserStorage(): StoragePort {
  return {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value) },
  }
}

function browserLock(): LockPort | undefined {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return undefined
  return {
    runExclusive: async <T>(name: string, callback: () => T | Promise<T>, signal?: AbortSignal): Promise<T> => (
      await navigator.locks.request(
        name,
        { mode: 'exclusive', ...(signal === undefined ? {} : { signal }) },
        async () => await callback(),
      )
    ),
  }
}

function browserStorageEvents(): StorageEventPort {
  return {
    subscribe: (key, listener) => {
      if (typeof window === 'undefined') return () => {}
      const handle = (event: StorageEvent): void => {
        // localStorage.clear() is broadcast with a null key.
        if (event.key === key || event.key === null) listener()
      }
      window.addEventListener('storage', handle)
      return () => { window.removeEventListener('storage', handle) }
    },
  }
}

export function createBrowserKeybindingPersistence(
  contextSchema?: KeybindingContextSchema,
): KeybindingPersistenceController {
  const lock = browserLock()
  return new KeybindingPersistenceController({
    storage: browserStorage(),
    storageEvents: browserStorageEvents(),
    ...(lock === undefined ? {} : { lock }),
    ...(contextSchema === undefined ? {} : { contextSchema }),
  })
}
