import { decodeWorkspacePath } from '../workspace-path.ts'
import {
  WorkspaceMutationStore,
  type AcceptedMutationCommit,
  type MutationBlocker,
  type MutationDraft,
  type MutationImpact,
  type MutationPageError,
  type MutationResourceKind,
  type MutationSource,
} from './store.ts'

export type ProtocolWorkspaceMutation =
  | { readonly kind: 'createFile'; readonly path: string }
  | { readonly kind: 'createDirectory'; readonly path: string }
  | {
    readonly kind: 'rename'
    readonly path: string
    readonly destinationPath: string
    readonly expected: { readonly kind: MutationResourceKind; readonly version: string }
  }
  | {
    readonly kind: 'delete'
    readonly path: string
    readonly expected: { readonly kind: MutationResourceKind; readonly version: string }
    readonly recursive: boolean
  }

export type ProtocolMutationResult =
  | {
    readonly kind: MutationResourceKind
    readonly path: string
    readonly version: string
    readonly refreshDirectories: readonly string[]
  }
  | {
    readonly kind: MutationResourceKind
    readonly path: string
    readonly destinationPath: string
    readonly version: string
    readonly refreshDirectories: readonly string[]
  }
  | {
    readonly kind: MutationResourceKind
    readonly path: string
    readonly recursive: boolean
    readonly refreshDirectories: readonly string[]
  }

export type ProtocolMutationReceipt =
  | { readonly providerEpoch: string; readonly operationId: string; readonly state: 'queued' | 'running' }
  | {
    readonly providerEpoch: string
    readonly operationId: string
    readonly state: 'committed'
    readonly result: ProtocolMutationResult
    readonly warning?: { readonly code: string; readonly message: string }
  }
  | {
    readonly providerEpoch: string
    readonly operationId: string
    readonly state: 'notCommitted' | 'recoveryRequired'
    readonly error: { readonly code: string; readonly message: string }
  }
  | { readonly providerEpoch: string; readonly operationId: string; readonly state: 'expired' }

export interface MutationApiPort {
  provider(signal?: AbortSignal): Promise<{
    readonly providerEpoch: string
    readonly capabilities: {
      readonly createFile: boolean
      readonly createDirectory: boolean
      readonly rename: boolean
      readonly delete: boolean
    }
  }>
  mutate(input: {
    readonly providerEpoch: string
    readonly operationId: string
    readonly workspaceId: string
    readonly mutation: ProtocolWorkspaceMutation
  }, signal?: AbortSignal): Promise<ProtocolMutationReceipt>
  status(providerEpoch: string, operationId: string, signal?: AbortSignal): Promise<ProtocolMutationReceipt>
}

interface DomainMutationImpact {
  readonly affectedDocuments: number
  readonly preservesDirtyFile: boolean
  readonly blockers: readonly { readonly code: string; readonly path: string }[]
}

export interface MutationDocumentPort {
  commitCreateMutation(workspaceId: string, workspaceEpoch: number, targetPath: string): boolean
  recoverCommittedRename(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
  ): Promise<boolean>
  inspectRenameMutation(
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: MutationResourceKind,
    sourceVersion: string,
  ): DomainMutationImpact
  inspectDeleteMutation(
    workspaceId: string,
    sourcePath: string,
    resourceKind: MutationResourceKind,
    sourceVersion: string,
  ): DomainMutationImpact
  commitRenameMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    resourceKind: MutationResourceKind,
    expectedVersion: string,
    freshVersion: string,
    preserveRecoveredVersions?: boolean,
  ): {
    readonly applied: boolean
    readonly rekeyed: readonly {
      readonly fromPath: string
      readonly toPath: string
      readonly lifecycleId: number
    }[]
  }
  commitDeleteMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    resourceKind: MutationResourceKind,
    expectedVersion: string,
  ): {
    readonly applied: boolean
    readonly retired: readonly { readonly path: string; readonly lifecycleId: number }[]
  }
  acquireRenameMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: MutationResourceKind,
    sourceVersion: string,
  ): boolean
  acquireCreateMutationLease(operationId: string, workspaceId: string, targetPath: string): boolean
  acquireDeleteMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    resourceKind: MutationResourceKind,
    sourceVersion: string,
  ): boolean
  releaseMutationLease(operationId: string): boolean
  restoreMutationLease(operationId: string, workspaceId: string, prefixes: readonly string[]): boolean
}

export interface MutationEditorSessionPort {
  rebaseDocument(
    identity: { readonly workspaceId: string; readonly path: string; readonly lifecycleId: number },
    destinationPath: string,
  ): boolean
  deleteDocument(identity: { readonly workspaceId: string; readonly path: string; readonly lifecycleId: number }): void
}

export interface MutationExplorerPort {
  commitCreateMutation(
    workspaceId: string,
    workspaceEpoch: number,
    path: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean>
  commitRenameMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    freshVersion: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean>
  commitDeleteMutation(
    workspaceId: string,
    workspaceEpoch: number,
    path: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean>
  refreshExpanded?(): Promise<unknown>
}

export interface MutationRecoveryRecord {
  readonly providerEpoch: string
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly operationId: string
  readonly draft: MutationDraft
}

/** The adapter must persist a prepared record before admission and clear it only after checkpointing committed domains. */
export interface MutationRecoveryPort {
  prepared(record: MutationRecoveryRecord): void
  unknown(record: MutationRecoveryRecord, error: MutationPageError): void
  committed(record: MutationRecoveryRecord, result: ProtocolMutationResult): void
  applied(record: MutationRecoveryRecord): void
  notCommitted(record: MutationRecoveryRecord): void
  acknowledged(record: MutationRecoveryRecord): void
}

export interface WorkspaceMutationControllerOptions {
  readonly documents?: MutationDocumentPort
  readonly editorSessions?: MutationEditorSessionPort
  readonly explorer?: MutationExplorerPort
  readonly navigation?: MutationNavigationPort
  readonly recovery?: MutationRecoveryPort
  readonly operationId?: () => string
}

export interface MutationNavigationPort {
  openCreatedFile(operationId: string, workspaceId: string, workspaceEpoch: number, path: string): Promise<boolean>
}

interface PendingCommittedApplication {
  readonly commit: AcceptedMutationCommit
  readonly record: MutationRecoveryRecord
  readonly result: ProtocolMutationResult
  readonly recoverDocuments: boolean
  checkpointed: boolean
  documentsRecovered: boolean
  domainApplied: boolean
  presentationApplied: boolean
}

export type MutationControllerResult = 'committed' | 'blocked' | 'unknown' | 'failed' | 'stale' | 'acknowledged'

export const MUTATION_MANUAL_RECONCILIATION_REQUIRED = 'MUTATION_MANUAL_RECONCILIATION_REQUIRED'

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

function basename(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? path : path.slice(separator + 1)
}

function targetPath(draft: Exclude<MutationDraft, { kind: 'delete' }>): string {
  const parent = draft.kind === 'create'
    ? draft.parentPath
    : draft.destinationParentPath ?? parentPath(draft.source.path)
  return parent === '' ? draft.name : `${parent}/${draft.name}`
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, '\ufffd').slice(0, 1_000)
}

function protocolErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

const DEFINITELY_NOT_ADMITTED = new Set([
  'ATOMIC_RENAME_UNSUPPORTED',
  'INVALID_MUTATION_REQUEST',
  'MUTATION_IDEMPOTENCY_CAPACITY',
  'MUTATION_RECEIPT_CAPACITY',
  'MUTATION_SERVICE_STOPPING',
  'PROVIDER_EPOCH_MISMATCH',
  'WORKSPACE_MUTATION_UNAVAILABLE',
  'WORKSPACE_NOT_FOUND',
])

function pageError(code: string, value: string): MutationPageError {
  const boundedCode = code.replace(/[\u0000-\u001f\u007f]/gu, '\ufffd').slice(0, 256) || 'MUTATION_ERROR'
  const boundedMessage = value.replace(/[\u0000-\u001f\u007f]/gu, '\ufffd').slice(0, 2_000)
    || 'The file operation failed without a usable message.'
  return { code: boundedCode, message: boundedMessage }
}

function manualReconciliationError(reason: string): MutationPageError {
  return pageError(
    MUTATION_MANUAL_RECONCILIATION_REQUIRED,
    `${reason} The IDE cannot determine whether the file operation committed. Review the workspace before releasing its safety fence.`,
  )
}

function blockerMessage(code: string): string {
  switch (code) {
    case 'dirty': return 'Save or discard affected unsaved changes before continuing.'
    case 'pending-save': return 'Wait for the affected save to finish before continuing.'
    case 'pending-reload': return 'Wait for the affected reload to finish before continuing.'
    case 'pending-conflict': return 'Finish reviewing the affected external file change before continuing.'
    case 'unknown-save': return 'Reconcile the affected save outcome before continuing.'
    case 'destination-open': return 'Close the document already open at the destination before continuing.'
    case 'external-state': return 'Reconcile the affected external file change before continuing.'
    default: return 'This open document currently blocks the mutation.'
  }
}

function defaultOperationId(): string {
  if (globalThis.crypto?.randomUUID === undefined) throw new Error('This browser cannot create mutation operation IDs.')
  return globalThis.crypto.randomUUID()
}

function sourceValid(source: MutationSource): boolean {
  return decodeWorkspacePath(source.path, { allowRoot: false }) === source.path
    && source.version.length > 0 && source.version.length <= 256
}

const WINDOWS_FORBIDDEN_NAME = /[<>:"|?*\u0000-\u001f\u007f]/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu

function portableName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\')
    && new TextEncoder().encode(name).length <= 255
    && !WINDOWS_FORBIDDEN_NAME.test(name)
    && !name.endsWith('.') && !name.endsWith(' ')
    && !WINDOWS_RESERVED_NAME.test(name)
    && !name.toLowerCase().startsWith('.__dsh_code_ide_')
}

/** Owns provider admission/status effects; committed presentation remains delegated to domain ports. */
export class WorkspaceMutationController {
  private readonly documents: MutationDocumentPort | undefined
  private readonly editorSessions: MutationEditorSessionPort | undefined
  private readonly explorer: MutationExplorerPort | undefined
  private readonly navigation: MutationNavigationPort | undefined
  private readonly recovery: MutationRecoveryPort | undefined
  private readonly operationId: () => string
  private providerValue: Awaited<ReturnType<MutationApiPort['provider']>> | undefined
  private providerPromise: Promise<Awaited<ReturnType<MutationApiPort['provider']>>> | undefined
  private statusController: AbortController | undefined
  private pendingCommitted: PendingCommittedApplication | undefined
  private applicationPromise: Promise<MutationControllerResult> | undefined
  private disposed = false

  constructor(
    readonly store: WorkspaceMutationStore,
    private readonly api: MutationApiPort,
    options: WorkspaceMutationControllerOptions = {},
  ) {
    this.documents = options.documents
    this.editorSessions = options.editorSessions
    this.explorer = options.explorer
    this.navigation = options.navigation
    this.recovery = options.recovery
    this.operationId = options.operationId ?? defaultOperationId
  }

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed) return false
    if (!this.store.selectWorkspace(workspaceId, workspaceEpoch)) return false
    this.statusController?.abort()
    this.statusController = undefined
    return true
  }

  beginCreate(parent: string, resourceKind: MutationResourceKind, name = ''): boolean {
    if (this.disposed || decodeWorkspacePath(parent, { allowRoot: true }) !== parent) return false
    return this.store.beginEditing({ kind: 'create', parentPath: parent, name, resourceKind })
  }

  beginRename(source: MutationSource): boolean {
    if (this.disposed || !sourceValid(source)) return false
    return this.store.beginEditing({ kind: 'rename', source: { ...source }, name: basename(source.path) })
  }

  /** A move is the existing atomic rename transaction with a different canonical parent. */
  beginMove(source: MutationSource, destinationParentPath: string): boolean {
    if (this.disposed || !sourceValid(source)
      || decodeWorkspacePath(destinationParentPath, { allowRoot: true }) !== destinationParentPath
      || destinationParentPath === parentPath(source.path)
      || (source.type === 'directory' && (destinationParentPath === source.path
        || destinationParentPath.startsWith(`${source.path}/`)))) return false
    return this.store.beginEditing({
      kind: 'rename',
      source: { ...source },
      name: basename(source.path),
      destinationParentPath,
    })
  }

  beginDelete(source: MutationSource): boolean {
    if (this.disposed || !sourceValid(source)
      || !this.store.beginEditing({ kind: 'delete', source: { ...source } })) return false
    return this.requestConfirmation()
  }

  updateName(name: string): boolean {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'editing' || state.draft.kind === 'delete') return false
    return this.store.updateDraft({ ...state.draft, name })
  }

  requestConfirmation(): boolean {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'editing') return false
    return this.store.beginConfirming(this.inspect(state.workspaceId, state.draft))
  }

  cancel(): boolean {
    return !this.disposed && this.store.cancel()
  }

  async submit(): Promise<MutationControllerResult> {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'confirming') return 'stale'
    const impact = this.inspect(state.workspaceId, state.draft)
    this.store.refreshImpact(impact)
    if (impact.blockers.length > 0) {
      if (state.draft.kind !== 'delete') {
        const first = impact.blockers[0]
        this.store.backToEditing(pageError(first?.code ?? 'MUTATION_BLOCKED', first?.message ?? 'The mutation is blocked.'))
      }
      return 'blocked'
    }
    const confirmed = this.store.getSnapshot()
    if (confirmed.phase !== 'confirming') return 'stale'

    let provider: Awaited<ReturnType<MutationApiPort['provider']>>
    try {
      provider = await this.provider()
    } catch (error) {
      if (this.store.getSnapshot() !== confirmed) return 'stale'
      this.store.rejectConfirmation(pageError('PROVIDER_UNAVAILABLE', message(error)))
      return 'failed'
    }
    if (this.disposed || this.store.getSnapshot() !== confirmed) return 'stale'
    const unsupported = confirmed.draft.kind === 'create'
      ? confirmed.draft.resourceKind === 'file'
        ? !provider.capabilities.createFile
        : !provider.capabilities.createDirectory
      : confirmed.draft.kind === 'rename'
        ? !provider.capabilities.rename
        : !provider.capabilities.delete
    if (unsupported) {
      this.store.rejectConfirmation(pageError('UNSUPPORTED_MUTATION', 'The active Host does not support this mutation.'))
      return 'failed'
    }

    let operationId: string
    try {
      operationId = this.operationId()
    } catch (error) {
      this.store.rejectConfirmation(pageError('OPERATION_ID_UNAVAILABLE', message(error)))
      return 'failed'
    }
    if (!this.store.beginSubmitting(operationId, provider.providerEpoch)) return 'stale'
    const active = this.store.getSnapshot()
    if (active.phase !== 'submitting' || active.operationId !== operationId) return 'stale'
    const record: MutationRecoveryRecord = {
      providerEpoch: provider.providerEpoch,
      workspaceId: active.workspaceId,
      workspaceEpoch: active.workspaceEpoch,
      operationId,
      draft: active.draft,
    }
    if (!this.acquireDocumentLease(record)) {
      this.store.fail(operationId, pageError(
        'MUTATION_BLOCKED',
        'An affected document changed before admission. Review it before trying again.',
      ))
      return 'blocked'
    }
    try {
      this.recovery?.prepared(record)
    } catch (error) {
      this.documents?.releaseMutationLease(operationId)
      this.store.fail(operationId, pageError('RECOVERY_CHECKPOINT_FAILED', message(error)))
      return 'failed'
    }
    try {
      const receipt = await this.api.mutate({
        providerEpoch: provider.providerEpoch,
        operationId,
        workspaceId: active.workspaceId,
        mutation: this.protocolMutation(active.draft),
      })
      return await this.handleReceipt(receipt, provider.providerEpoch, record)
    } catch (error) {
      const code = protocolErrorCode(error)
      if (code !== undefined && DEFINITELY_NOT_ADMITTED.has(code)) {
        if (code === 'PROVIDER_EPOCH_MISMATCH') {
          this.providerValue = undefined
          this.providerPromise = undefined
        }
        const failure = pageError(code, message(error))
        try {
          this.recovery?.notCommitted(record)
        } catch (checkpointError) {
          const unknown = pageError(
            'RECOVERY_CHECKPOINT_FAILED',
            `The Host rejected the operation before admission, but its local recovery fence could not be cleared: ${message(checkpointError)}`,
          )
          if (!this.store.markUnknown(operationId, unknown)) return 'stale'
          this.checkpointUnknown(record, unknown)
          return 'unknown'
        }
        this.documents?.releaseMutationLease(operationId)
        if (!this.store.fail(operationId, failure)) return 'stale'
        return 'failed'
      }
      const failure = pageError('MUTATION_OUTCOME_UNKNOWN', message(error))
      if (!this.store.markUnknown(operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
  }

  async reconcileUnknown(): Promise<MutationControllerResult> {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'unknown') return 'stale'
    if (state.error.code === MUTATION_MANUAL_RECONCILIATION_REQUIRED) return 'unknown'
    if (!this.store.beginReconciling(state.operationId)) return 'stale'
    const record: MutationRecoveryRecord = {
      providerEpoch: state.providerEpoch,
      workspaceId: state.workspaceId,
      workspaceEpoch: state.workspaceEpoch,
      operationId: state.operationId,
      draft: state.draft,
    }
    const controller = new AbortController()
    this.statusController?.abort()
    this.statusController = controller
    try {
      const receipt = await this.api.status(state.providerEpoch, state.operationId, controller.signal)
      return await this.handleReceipt(receipt, state.providerEpoch, record)
    } catch (error) {
      const code = protocolErrorCode(error)
      if (code === 'PROVIDER_EPOCH_MISMATCH') {
        this.providerValue = undefined
        this.providerPromise = undefined
      }
      const failure = code === 'PROVIDER_EPOCH_MISMATCH'
        ? manualReconciliationError('The original Host provider restarted and no longer owns this receipt.')
        : pageError('MUTATION_OUTCOME_UNKNOWN', message(error))
      if (!this.store.reconciliationUnknown(state.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    } finally {
      if (this.statusController === controller) this.statusController = undefined
    }
  }

  async acknowledgeUnresolvedOutcome(): Promise<MutationControllerResult> {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'unknown'
      || state.error.code !== MUTATION_MANUAL_RECONCILIATION_REQUIRED) return 'stale'
    const record: MutationRecoveryRecord = {
      providerEpoch: state.providerEpoch,
      workspaceId: state.workspaceId,
      workspaceEpoch: state.workspaceEpoch,
      operationId: state.operationId,
      draft: state.draft,
    }
    try {
      this.recovery?.acknowledged(record)
    } catch (error) {
      this.store.updateUnknown(state.operationId, pageError(
        MUTATION_MANUAL_RECONCILIATION_REQUIRED,
        `The outcome remains unresolved and its safety checkpoint could not be cleared: ${message(error)}`,
      ))
      return 'unknown'
    }
    this.documents?.releaseMutationLease(state.operationId)
    if (!this.store.acknowledgeUnresolved(state.operationId, pageError(
      'MUTATION_TRACKING_RELEASED',
      'The IDE stopped tracking an unresolved file operation without deciding whether it committed. Review and refresh the workspace before editing.',
    ))) return 'stale'
    try { await this.explorer?.refreshExpanded?.() } catch (error) {
      this.store.reportIdleError(pageError(
        'MUTATION_TRACKING_RELEASED',
        `The unresolved operation was released, but Explorer refresh failed: ${message(error)}`,
      ))
    }
    return 'acknowledged'
  }

  resumeUnknown(
    record: MutationRecoveryRecord,
    error: MutationPageError = pageError(
      'MUTATION_OUTCOME_UNKNOWN',
      'This mutation was interrupted before its receipt was persisted. Check the original provider status; do not submit it again.',
    ),
  ): boolean {
    if (this.disposed) return false
    if (!this.restoreDocumentLease(record)) return false
    const restored = this.store.restoreUnknown(
      { workspaceId: record.workspaceId, workspaceEpoch: record.workspaceEpoch },
      record.draft,
      this.inspect(record.workspaceId, record.draft),
      record.operationId,
      record.providerEpoch,
      error,
    )
    if (!restored) this.documents?.releaseMutationLease(record.operationId)
    return restored
  }

  async resumeCommitted(
    record: MutationRecoveryRecord,
    result: ProtocolMutationResult,
  ): Promise<MutationControllerResult> {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'idle' || state.workspaceId !== record.workspaceId
      || state.workspaceEpoch !== record.workspaceEpoch) return 'stale'
    if (!this.resultMatches(record.draft, result)) {
      this.store.reportIdleError(pageError(
        'MUTATION_RESULT_MISMATCH',
        'The persisted committed result does not match its mutation record.',
      ))
      return 'failed'
    }
    if (!this.restoreDocumentLease(record)) {
      this.store.reportIdleError(pageError(
        'MUTATION_RECOVERY_BLOCKED',
        'The committed operation could not reacquire its local document safety fence.',
      ))
      return 'failed'
    }
    const commit = this.store.restoreApplying(
      { workspaceId: record.workspaceId, workspaceEpoch: record.workspaceEpoch },
      record.draft,
      this.inspect(record.workspaceId, record.draft),
      record.operationId,
      record.providerEpoch,
    )
    if (commit === undefined) {
      this.documents?.releaseMutationLease(record.operationId)
      return 'stale'
    }
    this.pendingCommitted = {
      commit,
      record,
      result,
      recoverDocuments: true,
      checkpointed: true,
      documentsRecovered: false,
      domainApplied: false,
      presentationApplied: false,
    }
    return this.applyPendingCommitted()
  }

  async retryCommitted(): Promise<MutationControllerResult> {
    const state = this.store.getSnapshot()
    if (this.disposed || state.phase !== 'applying'
      || this.pendingCommitted?.record.operationId !== state.operationId) return 'stale'
    if (!this.store.retryApplying(state.operationId)) return 'stale'
    return this.applyPendingCommitted()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.statusController?.abort()
    this.statusController = undefined
    this.pendingCommitted = undefined
    this.applicationPromise = undefined
    this.store.dispose()
  }

  private inspect(workspaceId: string, draft: MutationDraft): MutationImpact {
    const blockers: MutationBlocker[] = []
    if (draft.kind !== 'delete') {
      const path = targetPath(draft)
      const validName = portableName(draft.name)
      if (!validName || decodeWorkspacePath(path, { allowRoot: false }) !== path) {
        blockers.push({ code: 'INVALID_NAME', message: 'Enter one valid file or folder name.' })
      } else if (draft.kind === 'rename' && draft.source.type === 'directory'
        && (path === draft.source.path || path.startsWith(`${draft.source.path}/`))) {
        blockers.push({
          code: 'INVALID_DESTINATION',
          message: 'A folder cannot be moved into itself or one of its descendants.',
          path,
        })
      } else if (draft.kind === 'rename' && path === draft.source.path) {
        blockers.push({ code: 'UNCHANGED_NAME', message: 'Enter a different name.', path })
      }
    }
    const domain = draft.kind === 'rename'
      ? this.documents?.inspectRenameMutation(
        workspaceId, draft.source.path, targetPath(draft), draft.source.type, draft.source.version,
      )
      : draft.kind === 'delete'
        ? this.documents?.inspectDeleteMutation(
          workspaceId, draft.source.path, draft.source.type, draft.source.version,
        )
        : undefined
    if (domain !== undefined) {
      blockers.push(...domain.blockers.map(value => ({
        code: value.code,
        path: value.path,
        message: blockerMessage(value.code),
      })))
    }
    return {
      affectedDocuments: domain?.affectedDocuments ?? 0,
      preservesDirtyFile: domain?.preservesDirtyFile ?? false,
      blockers,
    }
  }

  private async provider(): Promise<Awaited<ReturnType<MutationApiPort['provider']>>> {
    if (this.providerValue !== undefined) return this.providerValue
    this.providerPromise ??= this.api.provider()
    try {
      const value = await this.providerPromise
      this.providerValue = value
      return value
    } finally {
      this.providerPromise = undefined
    }
  }

  private acquireDocumentLease(record: MutationRecoveryRecord): boolean {
    if (this.documents === undefined) return true
    if (record.draft.kind === 'create') return this.documents.acquireCreateMutationLease(
      record.operationId,
      record.workspaceId,
      targetPath(record.draft),
    )
    if (record.draft.kind === 'rename') return this.documents.acquireRenameMutationLease(
      record.operationId,
      record.workspaceId,
      record.draft.source.path,
      targetPath(record.draft),
      record.draft.source.type,
      record.draft.source.version,
    )
    return this.documents.acquireDeleteMutationLease(
      record.operationId,
      record.workspaceId,
      record.draft.source.path,
      record.draft.source.type,
      record.draft.source.version,
    )
  }

  private restoreDocumentLease(record: MutationRecoveryRecord): boolean {
    if (this.documents === undefined) return true
    const prefixes = record.draft.kind === 'create'
      ? [targetPath(record.draft)]
      : record.draft.kind === 'rename'
        ? [record.draft.source.path, targetPath(record.draft)]
        : [record.draft.source.path]
    return this.documents.restoreMutationLease(record.operationId, record.workspaceId, prefixes)
  }

  private protocolMutation(draft: MutationDraft): ProtocolWorkspaceMutation {
    if (draft.kind === 'create') {
      return draft.resourceKind === 'file'
        ? { kind: 'createFile', path: targetPath(draft) }
        : { kind: 'createDirectory', path: targetPath(draft) }
    }
    if (draft.kind === 'rename') return {
      kind: 'rename',
      path: draft.source.path,
      destinationPath: targetPath(draft),
      expected: { kind: draft.source.type, version: draft.source.version },
    }
    return {
      kind: 'delete',
      path: draft.source.path,
      expected: { kind: draft.source.type, version: draft.source.version },
      recursive: draft.source.type === 'directory',
    }
  }

  private resultMatches(draft: MutationDraft, result: ProtocolMutationResult): boolean {
    if (draft.kind === 'create') {
      return !('destinationPath' in result) && !('recursive' in result)
        && result.path === targetPath(draft) && result.kind === draft.resourceKind
    }
    if (draft.kind === 'rename') {
      return 'destinationPath' in result && result.path === draft.source.path
        && result.destinationPath === targetPath(draft) && result.kind === draft.source.type
    }
    return 'recursive' in result && result.path === draft.source.path
      && result.kind === draft.source.type && result.recursive === (draft.source.type === 'directory')
  }

  private async handleReceipt(
    receipt: ProtocolMutationReceipt,
    providerEpoch: string,
    record: MutationRecoveryRecord,
  ): Promise<MutationControllerResult> {
    if (receipt.providerEpoch !== providerEpoch || receipt.operationId !== record.operationId) {
      const failure = pageError('MUTATION_RECEIPT_MISMATCH', 'The Host returned a receipt for another operation.')
      if (!this.toUnknown(record.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
    if (receipt.state === 'queued' || receipt.state === 'running') {
      const failure = pageError('MUTATION_PENDING', 'The Host is still processing this operation. Check its status; do not submit it again.')
      if (!this.toUnknown(record.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
    if (receipt.state === 'recoveryRequired' || receipt.state === 'expired') {
      const failure = receipt.state === 'recoveryRequired'
        ? manualReconciliationError(`The Host requires manual recovery (${receipt.error.code}: ${receipt.error.message}).`)
        : manualReconciliationError('The Host no longer has this receipt.')
      if (!this.toUnknown(record.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
    if (receipt.state === 'notCommitted') {
      try { this.recovery?.notCommitted(record) } catch (error) {
        const failure = pageError(
          'RECOVERY_CHECKPOINT_FAILED',
          `The Host proved the operation was not committed, but its local recovery fence could not be cleared: ${message(error)}`,
        )
        if (!this.toUnknown(record.operationId, failure)) return 'stale'
        this.checkpointUnknown(record, failure)
        return 'unknown'
      }
      this.documents?.releaseMutationLease(record.operationId)
      if (!this.store.fail(record.operationId, receipt.error)) return 'stale'
      return 'failed'
    }
    if (receipt.state !== 'committed') {
      const failure = pageError('MUTATION_RECEIPT_INVALID', 'The Host returned an unsupported mutation receipt state.')
      if (!this.toUnknown(record.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
    if (!this.resultMatches(record.draft, receipt.result)) {
      const failure = pageError('MUTATION_RESULT_MISMATCH', 'The committed result does not match the submitted mutation.')
      if (!this.toUnknown(record.operationId, failure)) return 'stale'
      this.checkpointUnknown(record, failure)
      return 'unknown'
    }
    const wasReconciling = this.store.getSnapshot().phase === 'reconciling'
    const accepted = this.store.acceptCommitted(record.operationId)
    if (accepted === undefined) return 'stale'
    this.pendingCommitted = {
      commit: accepted,
      record,
      result: receipt.result,
      recoverDocuments: wasReconciling,
      checkpointed: false,
      documentsRecovered: !wasReconciling,
      domainApplied: false,
      presentationApplied: false,
    }
    return this.applyPendingCommitted()
  }

  private async applyPendingCommitted(): Promise<MutationControllerResult> {
    if (this.applicationPromise !== undefined) return this.applicationPromise
    let task!: Promise<MutationControllerResult>
    task = this.performPendingCommitted().finally(() => {
      if (this.applicationPromise === task) this.applicationPromise = undefined
    })
    this.applicationPromise = task
    return task
  }

  private async performPendingCommitted(): Promise<MutationControllerResult> {
    const pending = this.pendingCommitted
    const state = this.store.getSnapshot()
    if (this.disposed || pending === undefined || state.phase !== 'applying'
      || state.operationId !== pending.record.operationId) return 'stale'
    try {
      // Persist the proven receipt before any fallible domain/presentation work.
      // A reload can then resume idempotent application without resubmitting.
      if (!pending.checkpointed) {
        this.recovery?.committed(pending.record, pending.result)
        pending.checkpointed = true
      }
      if (!pending.documentsRecovered) {
        if (pending.recoverDocuments) await this.recoverCommittedDocuments(pending.commit, pending.result)
        pending.documentsRecovered = true
      }
      if (!pending.domainApplied) {
        this.applyAuthoritativeCommit(pending.commit, pending.result, pending.recoverDocuments)
        pending.domainApplied = true
      }
      if (!pending.presentationApplied) {
        await this.applyCommittedPresentation(pending.commit, pending.result)
        pending.presentationApplied = true
      }
      this.recovery?.applied(pending.record)
      // Release is idempotent cleanup after both durable checkpoints agree.
      // A false result means the exact lease was already absent, not that the
      // committed mutation should be replayed.
      this.documents?.releaseMutationLease(pending.record.operationId)
      if (!this.store.finishApplying(pending.record.operationId)) return 'stale'
      this.pendingCommitted = undefined
      return 'committed'
    } catch (error) {
      this.store.applyingFailed(pending.record.operationId, pageError(
        pending.checkpointed ? 'COMMITTED_PRESENTATION_FAILED' : 'RECOVERY_CHECKPOINT_FAILED',
        message(error),
      ))
      return 'committed'
    }
  }

  private toUnknown(operationId: string, error: MutationPageError): boolean {
    const phase = this.store.getSnapshot().phase
    return phase === 'submitting'
      ? this.store.markUnknown(operationId, error)
      : phase === 'reconciling' && this.store.reconciliationUnknown(operationId, error)
  }

  private checkpointUnknown(record: MutationRecoveryRecord, error: MutationPageError): void {
    try {
      this.recovery?.unknown(record, error)
    } catch (checkpointError) {
      const failure = error.code === MUTATION_MANUAL_RECONCILIATION_REQUIRED
        ? manualReconciliationError(
          `${error.message} The local recovery checkpoint could not be advanced: ${message(checkpointError)}`,
        )
        : pageError(
          'RECOVERY_CHECKPOINT_FAILED',
          `The outcome remains unknown and its local recovery checkpoint could not be advanced: ${message(checkpointError)}`,
        )
      this.store.updateUnknown(record.operationId, failure)
    }
  }

  private applyAuthoritativeCommit(
    commit: AcceptedMutationCommit,
    result: ProtocolMutationResult,
    preserveRecoveredVersions = false,
  ): void {
    const draft = commit.draft
    if (draft.kind === 'create' && !('destinationPath' in result) && !('recursive' in result)) {
      if (this.documents?.commitCreateMutation(commit.workspaceId, commit.workspaceEpoch, result.path) === false) {
        throw new Error('The created resource could not be fenced into the active document generation.')
      }
      return
    }
    if (draft.kind === 'rename' && 'destinationPath' in result) {
      const documents = this.documents?.commitRenameMutation(
        commit.workspaceId,
        commit.workspaceEpoch,
        draft.source.path,
        result.destinationPath,
        draft.source.type,
        draft.source.version,
        result.version,
        preserveRecoveredVersions,
      )
      if (documents?.applied === true) {
        for (const document of documents.rekeyed) {
          this.editorSessions?.rebaseDocument({
            workspaceId: commit.workspaceId,
            path: document.fromPath,
            lifecycleId: document.lifecycleId,
          }, document.toPath)
        }
      } else if (documents !== undefined) {
        throw new Error('The renamed documents no longer match the committed workspace identity.')
      }
      return
    }
    if (draft.kind === 'delete' && 'recursive' in result) {
      const documents = this.documents?.commitDeleteMutation(
        commit.workspaceId, commit.workspaceEpoch, draft.source.path, draft.source.type, draft.source.version,
      )
      if (documents?.applied === true) {
        for (const document of documents.retired) {
          this.editorSessions?.deleteDocument({
            workspaceId: commit.workspaceId,
            path: document.path,
            lifecycleId: document.lifecycleId,
          })
        }
      } else if (documents !== undefined) {
        throw new Error('The deleted documents no longer match the committed workspace identity.')
      }
    }
  }

  private async recoverCommittedDocuments(
    commit: AcceptedMutationCommit,
    result: ProtocolMutationResult,
  ): Promise<void> {
    if (commit.draft.kind !== 'rename' || !('destinationPath' in result) || this.documents === undefined) return
    const recovered = await this.documents.recoverCommittedRename(
      commit.workspaceId,
      commit.workspaceEpoch,
      commit.draft.source.path,
      result.destinationPath,
    )
    if (!recovered) throw new Error('The committed rename destination could not be reconciled with open documents.')
  }

  private async applyCommittedPresentation(
    commit: AcceptedMutationCommit,
    result: ProtocolMutationResult,
  ): Promise<void> {
    const draft = commit.draft
    if (draft.kind === 'create' && !('destinationPath' in result) && !('recursive' in result)) {
      const effects: Promise<boolean>[] = []
      if (this.explorer !== undefined) effects.push(this.explorer.commitCreateMutation(
        commit.workspaceId, commit.workspaceEpoch, result.path, result.refreshDirectories,
      ))
      if (draft.resourceKind === 'file') {
        if (this.navigation !== undefined) effects.push(this.navigation.openCreatedFile(
          commit.operationId, commit.workspaceId, commit.workspaceEpoch, result.path,
        ))
      }
      const outcomes = await Promise.allSettled(effects)
      const rejected = outcomes.find(outcome => outcome.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      if (outcomes.some(outcome => outcome.status === 'fulfilled' && outcome.value !== true)) {
        throw new Error('The created resource could not be presented in the active workbench.')
      }
      return
    }
    if (draft.kind === 'rename' && 'destinationPath' in result) {
      const applied = await this.explorer?.commitRenameMutation(
        commit.workspaceId,
        commit.workspaceEpoch,
        draft.source.path,
        result.destinationPath,
        result.version,
        result.refreshDirectories,
      )
      if (applied === false) throw new Error('The renamed resource could not be presented in the active Explorer.')
      return
    }
    if (draft.kind === 'delete' && 'recursive' in result) {
      const applied = await this.explorer?.commitDeleteMutation(
        commit.workspaceId, commit.workspaceEpoch, draft.source.path, result.refreshDirectories,
      )
      if (applied === false) throw new Error('The deleted resource could not be presented in the active Explorer.')
    }
  }
}
