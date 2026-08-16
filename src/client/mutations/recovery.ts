import { decodeMutationResult } from '../api.ts'
import { decodeWorkspacePath } from '../workspace-path.ts'
import type {
  MutationRecoveryPort,
  MutationRecoveryRecord,
  ProtocolMutationResult,
} from './controller.ts'
import type { MutationDraft, MutationPageError, MutationSource } from './store.ts'

export const WORKSPACE_MUTATION_RECOVERY_KEY = 'dsh-code-ide.workspace-mutation.v1'
export const WORKSPACE_MUTATION_RECOVERY_SCHEMA = 1
export const MAX_MUTATION_RECOVERY_CODE_UNITS = 32 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const RECORD_KEYS = new Set(['providerEpoch', 'workspaceId', 'workspaceEpoch', 'operationId', 'draft'])
const SOURCE_KEYS = new Set(['path', 'type', 'version'])
const CREATE_KEYS = new Set(['kind', 'parentPath', 'name', 'resourceKind'])
const RENAME_KEYS = new Set(['kind', 'source', 'name'])
const MOVE_RENAME_KEYS = new Set([...RENAME_KEYS, 'destinationParentPath'])
const DELETE_KEYS = new Set(['kind', 'source'])
const ERROR_KEYS = new Set(['code', 'message'])
const BASE_KEYS = new Set(['schema', 'phase', 'savedAt', 'record'])
const ERROR_ENVELOPE_KEYS = new Set([...BASE_KEYS, 'error'])
const COMMITTED_ENVELOPE_KEYS = new Set([...BASE_KEYS, 'result'])

export interface MutationRecoveryStoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type PersistedMutationRecovery =
  | {
    readonly schema: 1
    readonly phase: 'prepared'
    readonly savedAt: number
    readonly record: MutationRecoveryRecord
  }
  | {
    readonly schema: 1
    readonly phase: 'unknown'
    readonly savedAt: number
    readonly record: MutationRecoveryRecord
    readonly error: MutationPageError
  }
  | {
    readonly schema: 1
    readonly phase: 'committed'
    readonly savedAt: number
    readonly record: MutationRecoveryRecord
    readonly result: ProtocolMutationResult
  }

export type MutationRecoveryLoadResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly value: PersistedMutationRecovery }
  | { readonly kind: 'invalid'; readonly message: string; readonly resettable: boolean }
  | { readonly kind: 'future'; readonly message: string; readonly resettable: true }

export type MutationRecoveryInvalidResetResult =
  | { readonly status: 'reset' }
  | { readonly status: 'already-empty' }
  | { readonly status: 'refused'; readonly message: string }

export interface MutationRecoveryPersistenceOptions {
  readonly storage?: MutationRecoveryStoragePort
  readonly now?: () => number
}

/**
 * Couples mutation checkpoints to the existing durable workbench snapshot.
 * The workbench is flushed before Host admission and again before a proven
 * commit checkpoint is removed, so a crash never leaves both authorities old.
 */
export function createDurableMutationRecoveryPort(
  recovery: MutationRecoveryPort,
  flushWorkbench: () => boolean,
): MutationRecoveryPort {
  const requireFlush = (stage: string): void => {
    if (!flushWorkbench()) throw new Error(`The ${stage} workbench session could not be flushed.`)
  }
  return {
    prepared: record => {
      requireFlush('pre-mutation')
      recovery.prepared(record)
    },
    unknown: (record, error) => { recovery.unknown(record, error) },
    committed: (record, result) => { recovery.committed(record, result) },
    applied: record => {
      requireFlush('committed')
      recovery.applied(record)
    },
    notCommitted: record => { recovery.notCommitted(record) },
    acknowledged: record => { recovery.acknowledged(record) },
  }
}

function defaultStorage(): MutationRecoveryStoragePort {
  return {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value) },
    removeItem: key => { window.localStorage.removeItem(key) },
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every(key => expected.has(key))
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}

function decodeSource(value: unknown): MutationSource | undefined {
  const source = recordOf(value)
  if (source === undefined || !exactKeys(source, SOURCE_KEYS)
    || (source.type !== 'file' && source.type !== 'directory')
    || !bounded(source.version, 256)) return undefined
  const path = decodeWorkspacePath(source.path, { allowRoot: false })
  return path === undefined ? undefined : { path, type: source.type, version: source.version }
}

function decodeName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).length > 255 || value.includes('\0')
    || value.includes('/') || value.includes('\\')) return undefined
  return value
}

function decodeDraft(value: unknown): MutationDraft | undefined {
  const draft = recordOf(value)
  if (draft === undefined) return undefined
  if (draft.kind === 'create') {
    const parentPath = decodeWorkspacePath(draft.parentPath, { allowRoot: true })
    const name = decodeName(draft.name)
    if (!exactKeys(draft, CREATE_KEYS) || parentPath === undefined || name === undefined
      || (draft.resourceKind !== 'file' && draft.resourceKind !== 'directory')) return undefined
    return { kind: 'create', parentPath, name, resourceKind: draft.resourceKind }
  }
  if (draft.kind === 'rename') {
    const source = decodeSource(draft.source)
    const name = decodeName(draft.name)
    const hasDestinationParent = Object.hasOwn(draft, 'destinationParentPath')
    const destinationParentPath = hasDestinationParent
      ? decodeWorkspacePath(draft.destinationParentPath, { allowRoot: true })
      : undefined
    if (!(exactKeys(draft, RENAME_KEYS) || exactKeys(draft, MOVE_RENAME_KEYS))
      || source === undefined || name === undefined
      || (hasDestinationParent && destinationParentPath === undefined)
      || (source.type === 'directory' && destinationParentPath !== undefined
        && (destinationParentPath === source.path || destinationParentPath.startsWith(`${source.path}/`)))) return undefined
    return {
      kind: 'rename',
      source,
      name,
      ...(destinationParentPath === undefined ? {} : { destinationParentPath }),
    }
  }
  if (draft.kind === 'delete') {
    const source = decodeSource(draft.source)
    if (!exactKeys(draft, DELETE_KEYS) || source === undefined) return undefined
    return { kind: 'delete', source }
  }
  return undefined
}

function decodeRecord(value: unknown): MutationRecoveryRecord | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, RECORD_KEYS)
    || !UUID.test(String(record.providerEpoch)) || !UUID.test(String(record.operationId))
    || !bounded(record.workspaceId, 256)
    || !Number.isSafeInteger(record.workspaceEpoch) || (record.workspaceEpoch as number) < 0) return undefined
  const draft = decodeDraft(record.draft)
  if (draft === undefined) return undefined
  return {
    providerEpoch: record.providerEpoch as string,
    workspaceId: record.workspaceId,
    workspaceEpoch: record.workspaceEpoch as number,
    operationId: record.operationId as string,
    draft,
  }
}

function decodeError(value: unknown): MutationPageError | undefined {
  const error = recordOf(value)
  if (error === undefined || !exactKeys(error, ERROR_KEYS)
    || !bounded(error.code, 256) || !bounded(error.message, 2_000)) return undefined
  return { code: error.code, message: error.message }
}

function decodeEnvelope(value: unknown): PersistedMutationRecovery {
  const envelope = recordOf(value)
  if (envelope === undefined || envelope.schema !== WORKSPACE_MUTATION_RECOVERY_SCHEMA
    || typeof envelope.savedAt !== 'number' || !Number.isFinite(envelope.savedAt) || envelope.savedAt < 0) {
    throw new Error('Mutation recovery envelope is malformed.')
  }
  const record = decodeRecord(envelope.record)
  if (record === undefined) throw new Error('Mutation recovery identity is malformed.')
  if (envelope.phase === 'prepared') {
    if (!exactKeys(envelope, BASE_KEYS)) throw new Error('Prepared mutation recovery is malformed.')
    return { schema: 1, phase: 'prepared', savedAt: envelope.savedAt, record }
  }
  if (envelope.phase === 'unknown') {
    const error = decodeError(envelope.error)
    if (!exactKeys(envelope, ERROR_ENVELOPE_KEYS) || error === undefined) {
      throw new Error('Unknown mutation recovery is malformed.')
    }
    return { schema: 1, phase: 'unknown', savedAt: envelope.savedAt, record, error }
  }
  if (envelope.phase === 'committed') {
    const result = decodeMutationResult(envelope.result)
    if (!exactKeys(envelope, COMMITTED_ENVELOPE_KEYS) || result === undefined) {
      throw new Error('Committed mutation recovery is malformed.')
    }
    return { schema: 1, phase: 'committed', savedAt: envelope.savedAt, record, result }
  }
  throw new Error('Mutation recovery phase is unsupported.')
}

function sameOperation(left: MutationRecoveryRecord, right: MutationRecoveryRecord): boolean {
  return left.providerEpoch === right.providerEpoch && left.operationId === right.operationId
    && left.workspaceId === right.workspaceId
}

/**
 * Synchronous mutation checkpoint owned by the workbench's existing Web Lock.
 * It never stores source bytes and never interprets a transport abort as a rollback.
 */
export class MutationRecoveryPersistence implements MutationRecoveryPort {
  private readonly storage: MutationRecoveryStoragePort
  private readonly now: () => number
  private writerOwned = false
  private writable = false
  private formatWritable = true
  private invalidStoredValue = false

  constructor(options: MutationRecoveryPersistenceOptions = {}) {
    this.storage = options.storage ?? defaultStorage()
    this.now = options.now ?? Date.now
  }

  setWritable(value: boolean): void {
    this.writerOwned = value
    this.writable = value && this.formatWritable
  }

  load(): MutationRecoveryLoadResult {
    const loaded = this.readStored()
    if (loaded.kind === 'invalid' || loaded.kind === 'future') {
      this.formatWritable = false
      this.writable = false
      this.invalidStoredValue = loaded.resettable
    }
    return loaded
  }

  canResetInvalid(): boolean {
    return this.writerOwned && this.invalidStoredValue
  }

  /**
   * Explicitly abandons only a checkpoint that is still unreadable at the
   * instant of confirmation. It never clears a valid operation record and it
   * never infers, retries, or rolls back the corresponding disk operation.
   */
  resetInvalid(): MutationRecoveryInvalidResetResult {
    if (!this.writerOwned) throw new Error('This page does not own the mutation recovery lock.')
    const current = this.readStored()
    if (current.kind === 'ready') {
      // Preserve the now-valid checkpoint while allowing the current
      // Web-Lock owner to resume that exact record without a page reload.
      this.formatWritable = true
      this.writable = this.writerOwned
      this.invalidStoredValue = false
      return {
        status: 'refused',
        message: 'The checkpoint became a valid pending, committed, or manual recovery record and was preserved.',
      }
    }
    if (current.kind === 'empty') {
      this.formatWritable = true
      this.writable = true
      this.invalidStoredValue = false
      return { status: 'already-empty' }
    }
    if (!current.resettable) {
      this.formatWritable = false
      this.writable = false
      this.invalidStoredValue = false
      return { status: 'refused', message: current.message }
    }
    try {
      this.storage.removeItem(WORKSPACE_MUTATION_RECOVERY_KEY)
    } catch (error) {
      this.formatWritable = false
      this.writable = false
      this.invalidStoredValue = true
      throw new Error(`Invalid mutation recovery could not be cleared: ${error instanceof Error ? error.message : String(error)}`)
    }
    const after = this.readStored()
    if (after.kind !== 'empty') {
      const becameReady = after.kind === 'ready'
      this.formatWritable = becameReady
      this.writable = becameReady && this.writerOwned
      this.invalidStoredValue = becameReady ? false : after.resettable
      return {
        status: 'refused',
        message: becameReady
          ? 'A valid pending, committed, or manual recovery record appeared and was preserved.'
          : 'The invalid mutation recovery checkpoint could not be removed.',
      }
    }
    this.formatWritable = true
    this.writable = true
    this.invalidStoredValue = false
    return { status: 'reset' }
  }

  private readStored(): MutationRecoveryLoadResult {
    let raw: string | null
    try { raw = this.storage.getItem(WORKSPACE_MUTATION_RECOVERY_KEY) } catch (error) {
      return {
        kind: 'invalid',
        message: `Mutation recovery is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        resettable: false,
      }
    }
    if (raw === null) return { kind: 'empty' }
    if (raw.length > MAX_MUTATION_RECOVERY_CODE_UNITS) {
      return { kind: 'invalid', message: 'Stored mutation recovery exceeds its safety limit.', resettable: true }
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      return { kind: 'invalid', message: 'Stored mutation recovery is not valid JSON.', resettable: true }
    }
    const schema = recordOf(parsed)?.schema
    if (typeof schema === 'number' && schema > WORKSPACE_MUTATION_RECOVERY_SCHEMA) {
      return {
        kind: 'future',
        message: 'A newer mutation recovery format is present; this version will not overwrite it.',
        resettable: true,
      }
    }
    try { return { kind: 'ready', value: decodeEnvelope(parsed) } } catch (error) {
      return {
        kind: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        resettable: true,
      }
    }
  }

  prepared(record: MutationRecoveryRecord): void {
    if (!this.writable) throw new Error('This page does not own the mutation recovery lock.')
    const existing = this.load()
    if (existing.kind !== 'empty') throw new Error('Another mutation recovery checkpoint is active.')
    this.persist({ schema: 1, phase: 'prepared', savedAt: this.now(), record })
  }

  unknown(record: MutationRecoveryRecord, error: MutationPageError): void {
    this.assertCurrent(record, ['prepared', 'unknown'])
    this.persist({ schema: 1, phase: 'unknown', savedAt: this.now(), record, error })
  }

  committed(record: MutationRecoveryRecord, result: ProtocolMutationResult): void {
    this.assertCurrent(record, ['prepared', 'unknown'])
    this.persist({ schema: 1, phase: 'committed', savedAt: this.now(), record, result })
  }

  applied(record: MutationRecoveryRecord): void {
    this.removeCurrent(record, 'committed')
  }

  notCommitted(record: MutationRecoveryRecord): void {
    this.removeCurrent(record, ['prepared', 'unknown'])
  }

  acknowledged(record: MutationRecoveryRecord): void {
    this.removeCurrent(record, ['prepared', 'unknown'])
  }

  private persist(value: PersistedMutationRecovery): void {
    if (!this.writable) throw new Error('This page does not own the mutation recovery lock.')
    const raw = JSON.stringify(value)
    if (raw.length > MAX_MUTATION_RECOVERY_CODE_UNITS) throw new Error('Mutation recovery exceeds its storage budget.')
    this.storage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, raw)
  }

  private current(): PersistedMutationRecovery {
    const loaded = this.load()
    if (loaded.kind !== 'ready') throw new Error('The mutation recovery checkpoint is unavailable.')
    return loaded.value
  }

  private assertCurrent(
    record: MutationRecoveryRecord,
    allowedPhases?: readonly PersistedMutationRecovery['phase'][],
  ): PersistedMutationRecovery {
    if (!this.writable) throw new Error('This page does not own the mutation recovery lock.')
    const current = this.current()
    if (!sameOperation(current.record, record)) throw new Error('A different mutation recovery checkpoint is active.')
    if (allowedPhases !== undefined && !allowedPhases.includes(current.phase)) {
      throw new Error(`Mutation recovery is ${current.phase}, not an allowed predecessor.`)
    }
    return current
  }

  private removeCurrent(
    record: MutationRecoveryRecord,
    requiredPhase?: PersistedMutationRecovery['phase'] | readonly PersistedMutationRecovery['phase'][],
  ): void {
    const phases = requiredPhase === undefined
      ? undefined
      : typeof requiredPhase === 'string' ? [requiredPhase] : requiredPhase
    this.assertCurrent(record, phases)
    this.storage.removeItem(WORKSPACE_MUTATION_RECOVERY_KEY)
  }
}

/** Page epochs are runtime-only; a persisted operation is rebound only after selecting its exact workspace. */
export function rebindMutationRecoveryRecord(
  record: MutationRecoveryRecord,
  workspaceEpoch: number,
): MutationRecoveryRecord {
  if (!Number.isSafeInteger(workspaceEpoch) || workspaceEpoch < 0) throw new Error('Workspace epoch is invalid.')
  return { ...record, workspaceEpoch }
}
