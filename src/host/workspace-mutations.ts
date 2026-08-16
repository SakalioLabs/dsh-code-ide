import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, link, lstat, mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MUTATION_BUDGETS,
  type CommittedMutationReceipt,
  type DeleteMutation,
  type ExpectedResource,
  type MutationProviderResponse,
  type MutationReceipt,
  type MutableResourceKind,
  type MutateWorkspaceRequest,
  type WorkspaceMutation,
  type WorkspaceMutationRequest,
  type WorkspaceMutationResult,
} from '../shared/workspace-mutations.js'
import type { HostLogger, HostWorkspace } from './contracts.js'
import { hostError, IdeHostError } from './errors.js'
import { sameFileIdentity, sameFileSnapshot, syncDirectory, versionOf } from './filesystem.js'
import { FfiNativeRenameAdapter, type NativeRenameAdapter } from './native-rename.js'
import {
  createUnavailableMutationBackend,
  type MutationBackend,
  type MutationBackendCapabilities,
  type MutationBackendOperation,
  type MutationBackendWorkspace,
} from './mutation-backend.js'
import {
  assertNoNestedMount,
  parseWorkspacePath,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  type ResolvedWorkspaceRoot,
} from './path-policy.js'
import { WorkspaceResources } from './workspace-resources.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^[A-Za-z0-9_-]+$/u
const QUARANTINE_PREFIX = '.__dsh_code_ide_quarantine_'
const STAGING_PREFIX = '.__dsh_code_ide_staging_'
const READ_DIRECTORY_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

export interface WorkspaceMutationServiceOptions {
  receiptTtlMs?: number
  maxReceipts?: number
  maxOperationIds?: number
  maxPurgeJobs?: number
  maxPurgeEntries?: number
}

export interface WorkspaceMutationServiceInternals {
  nativeRename?: NativeRenameAdapter
  /**
   * Capabilities proven by a containment-safe native backend. Omission is
   * deliberately all-false: Node path APIs cannot bind every ancestor against
   * a same-identity rename/symlink race or safely purge by directory handle.
   */
  backendCapabilities?: Readonly<MutationBackendCapabilities>
  now?: () => number
  afterCreateCommit?: (kind: 'file' | 'directory', destination: string) => void | Promise<void>
  afterNativeCommit?: (kind: 'rename' | 'delete', destination: string) => void | Promise<void>
}

interface ExecutionSuccess {
  readonly result: WorkspaceMutationResult
  readonly warning?: { code: string; message: string }
  readonly purge?: PurgeJob
}

interface InternalReceipt {
  readonly fingerprint: string
  readonly operationId: string
  readonly controller: AbortController
  readonly completion: Promise<MutationReceipt>
  resolve: (receipt: MutationReceipt) => void
  snapshot: MutationReceipt
  expiresAt: number
  httpStatus: number
  purgePending: boolean
}

interface PurgeJob {
  readonly path: string
  readonly identity: BigIntStats
  readonly workspaceRoot: ResolvedWorkspaceRoot
  notBefore: number
  attempts?: number
  readonly onSuccess: () => void
  readonly onFailure: (willRetry: boolean) => void
}

class RecoveryRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super('The mutation outcome requires recovery.', options)
    this.name = 'RecoveryRequiredError'
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdeHostError('INVALID_REQUEST', `${label} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const allowedSet = new Set(allowed)
  if (Object.keys(record).some(key => !allowedSet.has(key))) {
    throw new IdeHostError('INVALID_REQUEST', `${label} contains an unknown field.`)
  }
  return record
}

function requireExactKeys(record: Record<string, unknown>, required: readonly string[], label: string): void {
  if (required.some(key => !Object.hasOwn(record, key))) {
    throw new IdeHostError('INVALID_REQUEST', `${label} is missing a required field.`)
  }
}

function boundedString(value: unknown, maxBytes: number, code: string, label: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new IdeHostError(code, `${label} must be a non-empty bounded string.`)
  }
  return value
}

function validBackendVersion(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MUTATION_BUDGETS.maxVersionBytes
    && VERSION.test(value)
}

function uuid(value: unknown, label: string): string {
  const parsed = boundedString(value, MUTATION_BUDGETS.maxOperationIdBytes, 'INVALID_OPERATION_ID', label)
  if (!UUID.test(parsed)) throw new IdeHostError('INVALID_OPERATION_ID', `${label} must be a canonical UUID.`)
  return parsed
}

function epoch(value: unknown): string {
  const parsed = boundedString(value, MUTATION_BUDGETS.maxProviderEpochBytes, 'INVALID_PROVIDER_EPOCH', 'providerEpoch')
  if (!UUID.test(parsed)) throw new IdeHostError('INVALID_PROVIDER_EPOCH', 'providerEpoch must be a canonical UUID.')
  return parsed
}

function expectedResource(value: unknown): ExpectedResource {
  const record = exactRecord(value, ['kind', 'version'], 'expected')
  requireExactKeys(record, ['kind', 'version'], 'expected')
  if (record.kind !== 'file' && record.kind !== 'directory') {
    throw new IdeHostError('INVALID_RESOURCE_KIND', 'expected.kind must be file or directory.')
  }
  const version = boundedString(record.version, MUTATION_BUDGETS.maxVersionBytes, 'INVALID_VERSION', 'expected.version')
  if (!VERSION.test(version)) throw new IdeHostError('INVALID_VERSION', 'expected.version is not a valid opaque token.')
  return { kind: record.kind, version }
}

function mutationOf(value: unknown): WorkspaceMutation {
  const base = exactRecord(value, ['kind', 'path', 'destinationPath', 'expected', 'recursive'], 'mutation')
  if (!Object.hasOwn(base, 'kind')) throw new IdeHostError('INVALID_REQUEST', 'mutation.kind is required.')
  switch (base.kind) {
    case 'createFile': {
      const record = exactRecord(value, ['kind', 'path'], 'createFile mutation')
      requireExactKeys(record, ['kind', 'path'], 'createFile mutation')
      return { kind: 'createFile', path: parseWorkspacePath(record.path, { allowRoot: false }) }
    }
    case 'createDirectory': {
      const record = exactRecord(value, ['kind', 'path'], 'createDirectory mutation')
      requireExactKeys(record, ['kind', 'path'], 'createDirectory mutation')
      return { kind: 'createDirectory', path: parseWorkspacePath(record.path, { allowRoot: false }) }
    }
    case 'rename': {
      const record = exactRecord(value, ['kind', 'path', 'destinationPath', 'expected'], 'rename mutation')
      requireExactKeys(record, ['kind', 'path', 'destinationPath', 'expected'], 'rename mutation')
      const path = parseWorkspacePath(record.path, { allowRoot: false })
      const destinationPath = parseWorkspacePath(record.destinationPath, { allowRoot: false })
      if (path === destinationPath) throw new IdeHostError('INVALID_DESTINATION', 'The destination must differ from the source.')
      return { kind: 'rename', path, destinationPath, expected: expectedResource(record.expected) }
    }
    case 'delete': {
      const record = exactRecord(value, ['kind', 'path', 'expected', 'recursive'], 'delete mutation')
      requireExactKeys(record, ['kind', 'path', 'expected', 'recursive'], 'delete mutation')
      if (typeof record.recursive !== 'boolean') {
        throw new IdeHostError('INVALID_RECURSIVE_FLAG', 'delete.recursive must be boolean.')
      }
      return {
        kind: 'delete',
        path: parseWorkspacePath(record.path, { allowRoot: false }),
        expected: expectedResource(record.expected),
        recursive: record.recursive,
      }
    }
    default:
      throw new IdeHostError('UNKNOWN_MUTATION', 'Unknown workspace mutation kind.')
  }
}

export function parseWorkspaceMutationRequest(value: unknown): WorkspaceMutationRequest {
  const base = exactRecord(value, ['op', 'providerEpoch', 'operationId', 'workspaceId', 'mutation'], 'request')
  if (!Object.hasOwn(base, 'op')) throw new IdeHostError('INVALID_REQUEST', 'op is required.')
  if (base.op === 'provider') {
    const record = exactRecord(value, ['op'], 'provider request')
    requireExactKeys(record, ['op'], 'provider request')
    return { op: 'provider' }
  }
  if (base.op === 'status') {
    const record = exactRecord(value, ['op', 'providerEpoch', 'operationId'], 'status request')
    requireExactKeys(record, ['op', 'providerEpoch', 'operationId'], 'status request')
    return { op: 'status', providerEpoch: epoch(record.providerEpoch), operationId: uuid(record.operationId, 'operationId') }
  }
  if (base.op === 'mutate') {
    const record = exactRecord(value, ['op', 'providerEpoch', 'operationId', 'workspaceId', 'mutation'], 'mutate request')
    requireExactKeys(record, ['op', 'providerEpoch', 'operationId', 'workspaceId', 'mutation'], 'mutate request')
    return {
      op: 'mutate',
      providerEpoch: epoch(record.providerEpoch),
      operationId: uuid(record.operationId, 'operationId'),
      workspaceId: boundedString(
        record.workspaceId,
        MUTATION_BUDGETS.maxWorkspaceIdBytes,
        'INVALID_WORKSPACE_ID',
        'workspaceId',
      ),
      mutation: mutationOf(record.mutation),
    }
  }
  throw new IdeHostError('UNKNOWN_OPERATION', 'Unknown workspace mutation operation.')
}

function wireParent(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function refreshDirectories(...paths: string[]): string[] {
  return [...new Set(paths.map(wireParent))]
}

function kindOf(info: BigIntStats): MutableResourceKind | undefined {
  if (info.isSymbolicLink()) return undefined
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return undefined
}

function assertExpected(info: BigIntStats, expected: ExpectedResource): void {
  const kind = kindOf(info)
  if (kind === undefined) throw new IdeHostError('RESOURCE_TYPE_UNSUPPORTED', 'Only regular files and directories can be mutated.', 409)
  if (kind !== expected.kind) throw new IdeHostError('RESOURCE_KIND_CONFLICT', 'The resource kind changed.', 409)
  if (versionOf(info) !== expected.version) throw new IdeHostError('VERSION_CONFLICT', 'The resource changed before the mutation.', 409)
}

function assertSameIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (!sameFileIdentity(expected, actual) || kindOf(expected) !== kindOf(actual)) {
    throw new RecoveryRequiredError()
  }
}

function assertMovedSnapshot(expected: BigIntStats, actual: BigIntStats): void {
  assertSameIdentity(expected, actual)
  // A rename may change ctime, but it must not change content-bearing or mode
  // metadata. These checks catch an external writer between commit and verify.
  if (expected.size !== actual.size || expected.mtimeNs !== actual.mtimeNs || expected.mode !== actual.mode) {
    throw new RecoveryRequiredError()
  }
}

function assertUnchangedSnapshot(expected: BigIntStats, actual: BigIntStats): void {
  if (!sameFileSnapshot(expected, actual) || kindOf(expected) !== kindOf(actual)) {
    throw new RecoveryRequiredError()
  }
}

interface DirectoryFence {
  readonly wirePath: string
  readonly identity: BigIntStats
}

async function captureDirectoryFence(root: ResolvedWorkspaceRoot, wirePath: string): Promise<DirectoryFence> {
  const resolved = await resolveWorkspacePath(root, wirePath, { allowMissingFinal: false })
  const info = await lstat(resolved.absolutePath, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== root.identity.dev) {
    throw new IdeHostError('PARENT_IDENTITY_CHANGED', 'A workspace parent directory is unavailable.', 409)
  }
  await assertNoNestedMount(root, resolved.absolutePath, { includeDescendants: false })
  return { wirePath, identity: info }
}

async function assertDirectoryFence(
  root: ResolvedWorkspaceRoot,
  fence: DirectoryFence,
  options: { outcomeUncertain: boolean },
): Promise<void> {
  const resolved = await resolveWorkspacePath(root, fence.wirePath, { allowMissingFinal: false })
  await assertNoNestedMount(root, resolved.absolutePath, { includeDescendants: false })
  const info = await lstat(resolved.absolutePath, { bigint: true })
  if (info.isDirectory() && !info.isSymbolicLink() && info.dev === root.identity.dev
    && sameFileIdentity(fence.identity, info)) {
    return
  }
  if (options.outcomeUncertain) throw new RecoveryRequiredError()
  throw new IdeHostError('PARENT_IDENTITY_CHANGED', 'A workspace parent directory changed before commit.', 409)
}

function assertOwnedQuarantine(
  root: ResolvedWorkspaceRoot,
  expected: BigIntStats,
  actual: BigIntStats,
): void {
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== root.identity.dev) {
    throw new RecoveryRequiredError()
  }
  assertSameIdentity(expected, actual)
}

function fingerprint(request: MutateWorkspaceRequest): string {
  return createHash('sha256')
    .update('dsh-code-ide:workspace-mutation:v1\0')
    .update(JSON.stringify({ workspaceId: request.workspaceId, mutation: request.mutation }))
    .digest('base64url')
}

function copyReceipt(receipt: MutationReceipt): MutationReceipt {
  return JSON.parse(JSON.stringify(receipt)) as MutationReceipt
}

async function purgeTree(
  path: string,
  expected: BigIntStats,
  workspaceRoot: ResolvedWorkspaceRoot,
  maxEntries: number,
): Promise<void> {
  const currentWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot.registeredPath, workspaceRoot.identity)
  const root = await lstat(path, { bigint: true })
  if (!sameFileIdentity(root, expected) || root.dev !== expected.dev
    || root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error('quarantine identity changed')
  }
  await assertNoNestedMount(currentWorkspaceRoot, path, { includeDescendants: true })
  let entries = 0
  const remove = async (target: string): Promise<void> => {
    entries += 1
    if (entries > maxEntries) throw new Error('quarantine purge budget exceeded')
    const info = await lstat(target, { bigint: true })
    if (!info.isSymbolicLink() && info.dev !== expected.dev) {
      throw new Error('quarantine purge crossed a filesystem boundary')
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await unlink(target)
      return
    }
    const directory = await opendir(target)
    try {
      const rebound = await lstat(target, { bigint: true })
      if (rebound.isSymbolicLink() || !rebound.isDirectory() || !sameFileIdentity(info, rebound)) {
        throw new Error('quarantine directory identity changed before enumeration')
      }
      for await (const child of directory) await remove(join(target, child.name))
    } finally {
      await directory.close().catch(() => {})
    }
    const final = await lstat(target, { bigint: true })
    if (final.isSymbolicLink() || !final.isDirectory() || !sameFileIdentity(info, final)) {
      throw new Error('quarantine directory identity changed before removal')
    }
    await rmdir(target)
  }
  await remove(path)
}

class TombstonePurger {
  private readonly jobs: PurgeJob[] = []
  private reservations = 0
  private running: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private timerDue: number | undefined
  private disposed = false

  constructor(
    private readonly maxJobs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
    private readonly logger: HostLogger,
  ) {}

  reserve(): void {
    if (this.disposed || this.jobs.length + this.reservations >= this.maxJobs) {
      throw new IdeHostError('PURGE_QUEUE_FULL', 'Deferred deletion capacity is exhausted.', 429)
    }
    this.reservations += 1
  }

  release(): void {
    if (this.reservations > 0) this.reservations -= 1
  }

  enqueueReserved(job: PurgeJob): void {
    if (this.reservations <= 0) throw new Error('missing purge reservation')
    this.reservations -= 1
    this.jobs.push(job)
    this.schedule()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.timerDue = undefined
    await this.running
    while (this.jobs.length > 0) await this.runOne(true)
  }

  private schedule(): void {
    if (this.disposed || this.running !== undefined || this.jobs.length === 0) return
    this.jobs.sort((left, right) => left.notBefore - right.notBefore)
    const first = this.jobs[0]
    if (first === undefined) return
    if (this.timer !== undefined && this.timerDue !== undefined) {
      if (this.timerDue <= first.notBefore) return
      clearTimeout(this.timer)
    }
    const delay = Math.max(0, first.notBefore - this.now())
    this.timerDue = first.notBefore
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.timerDue = undefined
      void this.runOne(false)
    }, delay)
    this.timer.unref?.()
  }

  private async runOne(force: boolean): Promise<void> {
    if (this.disposed && !force) return
    if (this.running !== undefined) return await this.running
    const first = this.jobs[0]
    if (first === undefined) return
    if (!force && first.notBefore > this.now()) {
      this.schedule()
      return
    }
    const job = first
    this.running = (async () => {
      try {
        await purgeTree(job.path, job.identity, job.workspaceRoot, this.maxEntries)
        this.jobs.shift()
        job.onSuccess()
      } catch (error) {
        if (force) {
          this.jobs.shift()
          job.onFailure(false)
        } else {
          job.attempts = (job.attempts ?? 0) + 1
          const delay = Math.min(60_000, 250 * (2 ** Math.min(job.attempts, 8)))
          job.notBefore = this.now() + delay
          job.onFailure(true)
        }
        this.logger.warn('dsh-code-ide: deferred workspace deletion failed (%s)', nodeErrorCode(error) ?? 'UNKNOWN')
      }
    })().finally(() => { this.running = undefined })
    await this.running
    if (!this.disposed) this.schedule()
  }
}

function positiveBound(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`dsh-code-ide: ${name} must be between 1 and ${String(maximum)}`)
  }
  return resolved
}

/** Receipt-backed, fail-closed workspace mutation capability. */
export class WorkspaceMutationService {
  readonly providerEpoch = randomUUID()
  private readonly nativeRename: NativeRenameAdapter
  private readonly backend: MutationBackend
  private readonly ownsBackend: boolean
  private readonly backendWorkspaces = new Map<string, Promise<MutationBackendWorkspace>>()
  private readonly backendLifetime = new AbortController()
  private readonly now: () => number
  private readonly receiptTtlMs: number
  private readonly maxReceipts: number
  private readonly maxOperationIds: number
  private readonly receipts = new Map<string, InternalReceipt>()
  // Exact epoch-lifetime tombstones are intentionally never evicted. A
  // probabilistic filter may answer "already executed" for a fresh UUID,
  // which is not a valid idempotency result. Capacity exhaustion is explicit
  // and requires a provider restart/new epoch.
  private readonly seen = new Set<string>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly purger: TombstonePurger
  private accepting = true

  constructor(
    private readonly resources: WorkspaceResources,
    private readonly logger: HostLogger,
    options: WorkspaceMutationServiceOptions = {},
    private readonly internals: WorkspaceMutationServiceInternals = {},
    backend?: MutationBackend,
  ) {
    this.backend = backend ?? createUnavailableMutationBackend()
    this.ownsBackend = backend === undefined
    this.nativeRename = internals.nativeRename ?? new FfiNativeRenameAdapter()
    this.now = internals.now ?? Date.now
    this.receiptTtlMs = positiveBound(options.receiptTtlMs, 5 * 60_000, 24 * 60 * 60_000, 'mutationReceiptTtlMs')
    this.maxReceipts = positiveBound(options.maxReceipts, 1_024, 65_536, 'maxMutationReceipts')
    this.maxOperationIds = positiveBound(options.maxOperationIds, 65_536, 262_144, 'maxMutationOperationIds')
    this.purger = new TombstonePurger(
      positiveBound(options.maxPurgeJobs, 1_024, 65_536, 'maxMutationPurgeJobs'),
      positiveBound(options.maxPurgeEntries, 100_000, 1_000_000, 'maxMutationPurgeEntries'),
      this.now,
      logger,
    )
  }

  async request(value: unknown, signal?: AbortSignal): Promise<MutationProviderResponse | MutationReceipt> {
    const request = parseWorkspaceMutationRequest(value)
    if (request.op === 'provider') return await this.provider()
    this.assertEpoch(request.providerEpoch)
    if (request.op === 'status') return this.status(request.operationId)
    return await this.mutate(request, signal)
  }

  async provider(): Promise<MutationProviderResponse> {
    const capabilities = await this.capabilities()
    return {
      providerEpoch: this.providerEpoch,
      capabilities,
    }
  }

  status(operationId: string): MutationReceipt {
    this.sweep()
    const receipt = this.receipts.get(operationId)
    if (receipt !== undefined) return copyReceipt(receipt.snapshot)
    return { providerEpoch: this.providerEpoch, operationId, state: 'expired' }
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.backendLifetime.abort()
    for (const receipt of this.receipts.values()) {
      if (receipt.snapshot.state === 'queued' || receipt.snapshot.state === 'running') receipt.controller.abort()
    }
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    await this.purger.dispose()
    await this.nativeRename.dispose()
    const backendWorkspaces = [...this.backendWorkspaces.values()]
    this.backendWorkspaces.clear()
    const opened = await Promise.allSettled(backendWorkspaces)
    await Promise.allSettled(opened.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    if (this.ownsBackend) await this.backend.dispose()
    this.receipts.clear()
    this.seen.clear()
  }

  private async mutate(request: MutateWorkspaceRequest, signal?: AbortSignal): Promise<MutationReceipt> {
    // Unsupported structural mutations are rejected before workspace lookup,
    // receipt allocation, queue admission, native probing, or purge capacity.
    // This keeps an all-false production provider a side-effect-free handshake.
    const capabilityCheck = this.assertCapability(request.mutation.kind)
    if (capabilityCheck !== undefined) await capabilityCheck
    this.sweep()
    const requestFingerprint = fingerprint(request)
    const existing = this.receipts.get(request.operationId)
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new IdeHostError('OPERATION_ID_CONFLICT', 'operationId was already used for another mutation.', 409)
      }
      return await this.replay(existing)
    }
    if (this.seen.has(request.operationId)) {
      throw new IdeHostError('OPERATION_EXPIRED', 'The mutation receipt has expired.', 409)
    }
    if (!this.accepting) throw new IdeHostError('MUTATION_SERVICE_STOPPING', 'Workspace mutations are stopping.', 503)
    if (this.seen.size >= this.maxOperationIds) {
      throw new IdeHostError(
        'MUTATION_IDEMPOTENCY_CAPACITY',
        'Mutation idempotency capacity is exhausted; reconnect after the provider restarts.',
        429,
      )
    }
    if (this.receipts.size >= this.maxReceipts) {
      throw new IdeHostError('MUTATION_RECEIPT_CAPACITY', 'Mutation receipt capacity is exhausted.', 429)
    }
    const workspace = this.resources.requireWorkspace(request.workspaceId)
    const controller = new AbortController()
    let resolveCompletion!: (receipt: MutationReceipt) => void
    const completion = new Promise<MutationReceipt>(resolve => { resolveCompletion = resolve })
    const receipt: InternalReceipt = {
      fingerprint: requestFingerprint,
      operationId: request.operationId,
      controller,
      completion,
      resolve: resolveCompletion,
      snapshot: { providerEpoch: this.providerEpoch, operationId: request.operationId, state: 'queued' },
      expiresAt: Number.POSITIVE_INFINITY,
      httpStatus: 409,
      purgePending: false,
    }
    this.seen.add(request.operationId)
    this.receipts.set(request.operationId, receipt)
    const transportAbort = (): void => { controller.abort() }
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', transportAbort, { once: true })

    const execution = this.executeReceipt(receipt, workspace, request.mutation)
      .finally(() => { signal?.removeEventListener('abort', transportAbort) })
    this.inflight.add(execution)
    void execution.finally(() => { this.inflight.delete(execution) })
    return await this.replay(receipt)
  }

  private async replay(receipt: InternalReceipt): Promise<MutationReceipt> {
    const snapshot = receipt.snapshot.state === 'queued' || receipt.snapshot.state === 'running'
      ? await receipt.completion
      : receipt.snapshot
    if (snapshot.state === 'notCommitted') {
      throw new IdeHostError(snapshot.error.code, snapshot.error.message, receipt.httpStatus)
    }
    return copyReceipt(snapshot)
  }

  private async executeReceipt(
    receipt: InternalReceipt,
    workspace: HostWorkspace,
    mutation: WorkspaceMutation,
  ): Promise<void> {
    try {
      const success = await this.resources.runMutation(workspace, async () => {
        receipt.snapshot = { providerEpoch: this.providerEpoch, operationId: receipt.operationId, state: 'running' }
        this.assertNotAborted(receipt.controller.signal)
        return await this.execute(workspace, mutation, receipt.controller.signal)
      }, receipt.controller.signal)
      receipt.snapshot = {
        providerEpoch: this.providerEpoch,
        operationId: receipt.operationId,
        state: 'committed',
        result: success.result,
        ...(success.warning === undefined ? {} : { warning: success.warning }),
      }
      receipt.expiresAt = this.now() + this.receiptTtlMs
      const committed = receipt.snapshot
      if (success.purge !== undefined) {
        const purge = success.purge
        receipt.purgePending = true
        try {
          this.purger.enqueueReserved({
            ...purge,
            notBefore: receipt.expiresAt,
            onSuccess: () => { receipt.purgePending = false },
            onFailure: (willRetry) => {
              receipt.purgePending = willRetry
              if (receipt.snapshot.state !== 'committed') return
              // Retain the warning long enough for a reconnecting client to
              // observe it even though the first cleanup attempt ran at the
              // original receipt expiry boundary.
              receipt.expiresAt = this.now() + this.receiptTtlMs
              receipt.snapshot = {
                ...receipt.snapshot,
                warning: {
                  code: 'PURGE_DEFERRED',
                  message: 'The resource is deleted, but deferred storage cleanup requires attention.',
                },
              }
            },
          })
        } catch {
          receipt.purgePending = false
          this.purger.release()
          receipt.snapshot = {
            ...committed,
            warning: {
              code: 'PURGE_DEFERRED',
              message: 'The resource is deleted, but deferred storage cleanup requires attention.',
            },
          }
        }
      }
      receipt.resolve(copyReceipt(receipt.snapshot))
    } catch (error) {
      const recovery = error instanceof RecoveryRequiredError
        || (error instanceof IdeHostError && error.code === 'ATOMIC_RENAME_OUTCOME_UNKNOWN')
      const projected = recovery
        ? new IdeHostError('MUTATION_RECOVERY_REQUIRED', 'The Host cannot prove the final mutation state.', 503)
        : hostError(error)
      receipt.httpStatus = projected.status
      receipt.snapshot = {
        providerEpoch: this.providerEpoch,
        operationId: receipt.operationId,
        state: recovery ? 'recoveryRequired' : 'notCommitted',
        error: { code: projected.code, message: projected.message },
      }
      receipt.expiresAt = this.now() + this.receiptTtlMs
      receipt.resolve(copyReceipt(receipt.snapshot))
    }
  }

  private async execute(
    workspace: HostWorkspace,
    mutation: WorkspaceMutation,
    signal: AbortSignal,
  ): Promise<ExecutionSuccess> {
    // `backendCapabilities` is retained only as a test seam for the historical
    // path-based implementation. Production always executes through the
    // injected handle-relative backend, including the all-false fallback.
    if (this.internals.backendCapabilities === undefined) {
      return await this.executeBackend(workspace, mutation, signal)
    }
    switch (mutation.kind) {
      case 'createFile': return await this.createFile(workspace, mutation.path, signal)
      case 'createDirectory': return await this.createDirectory(workspace, mutation.path, signal)
      case 'rename': return await this.rename(workspace, mutation, signal)
      case 'delete': return await this.delete(workspace, mutation, signal)
    }
  }

  private backendOperation(mutation: WorkspaceMutation): MutationBackendOperation {
    const path = { segments: Object.freeze(mutation.path.split('/')) }
    switch (mutation.kind) {
      case 'createFile': return { kind: mutation.kind, path }
      case 'createDirectory': return { kind: mutation.kind, path }
      case 'rename': return {
        kind: mutation.kind,
        path,
        destinationPath: { segments: Object.freeze(mutation.destinationPath.split('/')) },
        expected: mutation.expected,
      }
      case 'delete': return {
        kind: mutation.kind,
        path,
        expected: mutation.expected,
        recursive: mutation.recursive,
      }
    }
  }

  private async backendWorkspace(workspace: HostWorkspace): Promise<MutationBackendWorkspace> {
    const workspaceId = String(workspace.id)
    // Revalidate the registered path and pinned root identity on every
    // operation, including when the native workspace handle is cached. A
    // registry replacement under the same id must never keep dispatching to
    // the previously pinned directory.
    const root = await this.resources.resolveRoot(workspace)
    let pending = this.backendWorkspaces.get(workspaceId)
    if (pending === undefined) {
      pending = (async () => {
        return await this.backend.openWorkspace({
          workspaceId,
          registeredRoot: root.registeredPath,
          expectedRootIdentity: {
            dev: root.identity.dev,
            ino: root.identity.ino,
          },
          signal: this.backendLifetime.signal,
        })
      })()
      this.backendWorkspaces.set(workspaceId, pending)
      void pending.catch(() => {
        if (this.backendWorkspaces.get(workspaceId) === pending) this.backendWorkspaces.delete(workspaceId)
      })
    }
    return await pending
  }

  private async executeBackend(
    workspace: HostWorkspace,
    mutation: WorkspaceMutation,
    signal: AbortSignal,
  ): Promise<ExecutionSuccess> {
    const backendWorkspace = await this.backendWorkspace(workspace)
    let outcome
    try {
      outcome = await backendWorkspace.execute({
        executionId: randomUUID(),
        operation: this.backendOperation(mutation),
        signal,
      })
    } catch (error) {
      throw new RecoveryRequiredError({ cause: error })
    }
    if (outcome.state !== 'committed') {
      const issue = new IdeHostError(outcome.error.code, outcome.error.message, outcome.error.httpStatus)
      if (outcome.state === 'recoveryRequired') throw new RecoveryRequiredError({ cause: issue })
      throw issue
    }
    const evidence = outcome.evidence
    if (evidence.kind !== mutation.kind) throw new RecoveryRequiredError()
    const warning = outcome.warning === undefined ? undefined : {
      code: outcome.warning.code,
      message: outcome.warning.message,
    }
    switch (mutation.kind) {
      case 'createFile': {
        if (evidence.kind !== 'createFile' || evidence.resourceKind !== 'file'
          || !validBackendVersion(evidence.version)) throw new RecoveryRequiredError()
        return {
          result: {
            kind: 'file',
            path: mutation.path,
            version: evidence.version,
            refreshDirectories: refreshDirectories(mutation.path),
          },
          ...(warning === undefined ? {} : { warning }),
        }
      }
      case 'createDirectory': {
        if (evidence.kind !== 'createDirectory' || evidence.resourceKind !== 'directory'
          || !validBackendVersion(evidence.version)) throw new RecoveryRequiredError()
        return {
          result: {
            kind: 'directory',
            path: mutation.path,
            version: evidence.version,
            refreshDirectories: refreshDirectories(mutation.path),
          },
          ...(warning === undefined ? {} : { warning }),
        }
      }
      case 'rename': {
        if (evidence.kind !== 'rename' || evidence.resourceKind !== mutation.expected.kind
          || !validBackendVersion(evidence.version)) throw new RecoveryRequiredError()
        return {
          result: {
            kind: evidence.resourceKind,
            path: mutation.path,
            destinationPath: mutation.destinationPath,
            version: evidence.version,
            refreshDirectories: refreshDirectories(mutation.path, mutation.destinationPath),
          },
          ...(warning === undefined ? {} : { warning }),
        }
      }
      case 'delete': {
        if (evidence.kind !== 'delete' || evidence.resourceKind !== mutation.expected.kind
          || evidence.recursive !== mutation.recursive) throw new RecoveryRequiredError()
        return {
          result: {
            kind: evidence.resourceKind,
            path: mutation.path,
            recursive: mutation.recursive,
            refreshDirectories: refreshDirectories(mutation.path),
          },
          ...(warning === undefined ? {} : { warning }),
        }
      }
    }
  }

  private async createFile(workspace: HostWorkspace, path: string, signal: AbortSignal): Promise<ExecutionSuccess> {
    const root = await this.resources.resolveRoot(workspace)
    const target = await resolveWorkspacePath(root, path, { allowMissingFinal: true })
    if (target.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    await assertNoNestedMount(root, target.absolutePath, { includeDescendants: false })
    const parentFence = await captureDirectoryFence(root, wireParent(path))
    const parent = dirname(target.absolutePath)
    const staging = join(parent, `${STAGING_PREFIX}${randomUUID()}`)
    let stagingPresent = false
    let published = false
    let warning: ExecutionSuccess['warning']
    try {
      const handle = await open(staging, 'wx', 0o666)
      stagingPresent = true
      let staged: BigIntStats
      try {
        await handle.sync()
        staged = await handle.stat({ bigint: true })
      } finally {
        await handle.close()
      }
      const freshRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(freshRoot, parentFence, { outcomeUncertain: true })
      const freshTarget = await resolveWorkspacePath(freshRoot, path, { allowMissingFinal: true })
      if (freshTarget.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
      await assertNoNestedMount(freshRoot, freshTarget.absolutePath, { includeDescendants: false })
      this.assertNotAborted(signal)
      try {
        await link(staging, freshTarget.absolutePath)
        published = true
      } catch (error) {
        if (nodeErrorCode(error) === 'EEXIST') {
          throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409, { cause: error })
        }
        throw error
      }
      try {
        await unlink(staging)
        stagingPresent = false
      } catch {
        warning = { code: 'CLEANUP_DEFERRED', message: 'The file was created, but staging cleanup was deferred.' }
      }
      const publishedSnapshot = await lstat(freshTarget.absolutePath, { bigint: true })
      assertMovedSnapshot(staged, publishedSnapshot)
      if (!publishedSnapshot.isFile() || publishedSnapshot.isSymbolicLink() || publishedSnapshot.size !== 0n) {
        throw new RecoveryRequiredError()
      }
      await this.internals.afterCreateCommit?.('file', freshTarget.absolutePath)
      await syncDirectory(parent)
      const finalRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(finalRoot, parentFence, { outcomeUncertain: true })
      const finalTarget = await resolveWorkspacePath(finalRoot, path, { allowMissingFinal: false })
      await assertNoNestedMount(finalRoot, finalTarget.absolutePath, { includeDescendants: false })
      const created = await lstat(finalTarget.absolutePath, { bigint: true })
      assertUnchangedSnapshot(publishedSnapshot, created)
      if (!created.isFile() || created.isSymbolicLink()) throw new RecoveryRequiredError()
      return {
        result: { kind: 'file', path, version: versionOf(created), refreshDirectories: refreshDirectories(path) },
        ...(warning === undefined ? {} : { warning }),
      }
    } catch (error) {
      if (published && !(error instanceof RecoveryRequiredError)) throw new RecoveryRequiredError({ cause: error })
      throw error
    } finally {
      // Once published, a failed staging unlink is retained under the reserved
      // namespace so the returned version cannot be invalidated by a late
      // cleanup attempt changing the shared inode ctime.
      if (stagingPresent && !published) await unlink(staging).catch(() => {})
    }
  }

  private async createDirectory(workspace: HostWorkspace, path: string, signal: AbortSignal): Promise<ExecutionSuccess> {
    let root = await this.resources.resolveRoot(workspace)
    let target = await resolveWorkspacePath(root, path, { allowMissingFinal: true })
    if (target.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    await assertNoNestedMount(root, target.absolutePath, { includeDescendants: false })
    const parentFence = await captureDirectoryFence(root, wireParent(path))
    root = await this.resources.resolveRoot(workspace)
    await assertDirectoryFence(root, parentFence, { outcomeUncertain: false })
    target = await resolveWorkspacePath(root, path, { allowMissingFinal: true })
    if (target.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    await assertNoNestedMount(root, target.absolutePath, { includeDescendants: false })
    this.assertNotAborted(signal)
    let created = false
    try {
      await mkdir(target.absolutePath, { recursive: false })
      created = true
      const createdSnapshot = await lstat(target.absolutePath, { bigint: true })
      if (!createdSnapshot.isDirectory() || createdSnapshot.isSymbolicLink()
        || createdSnapshot.dev !== root.identity.dev) {
        throw new RecoveryRequiredError()
      }
      await this.internals.afterCreateCommit?.('directory', target.absolutePath)
      await syncDirectory(dirname(target.absolutePath))
      const finalRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(finalRoot, parentFence, { outcomeUncertain: true })
      const finalTarget = await resolveWorkspacePath(finalRoot, path, { allowMissingFinal: false })
      await assertNoNestedMount(finalRoot, finalTarget.absolutePath, { includeDescendants: true })
      const info = await lstat(finalTarget.absolutePath, { bigint: true })
      assertUnchangedSnapshot(createdSnapshot, info)
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== finalRoot.identity.dev) {
        throw new RecoveryRequiredError()
      }
      return {
        result: { kind: 'directory', path, version: versionOf(info), refreshDirectories: refreshDirectories(path) },
      }
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST' && !created) {
        throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409, { cause: error })
      }
      if (created && !(error instanceof RecoveryRequiredError)) throw new RecoveryRequiredError({ cause: error })
      throw error
    }
  }

  private async rename(
    workspace: HostWorkspace,
    mutation: Extract<WorkspaceMutation, { kind: 'rename' }>,
    signal: AbortSignal,
  ): Promise<ExecutionSuccess> {
    if (!await this.nativeRename.supported()) {
      throw new IdeHostError('ATOMIC_RENAME_UNSUPPORTED', 'Atomic no-replace rename is unavailable on this Host.', 501)
    }
    const sourceKey = process.platform === 'win32' ? mutation.path.toLowerCase() : mutation.path
    const destinationKey = process.platform === 'win32' ? mutation.destinationPath.toLowerCase() : mutation.destinationPath
    if (mutation.expected.kind === 'directory'
      && destinationKey.startsWith(`${sourceKey}/`)) {
      throw new IdeHostError('INVALID_DESTINATION', 'A directory cannot be renamed into its own subtree.')
    }
    let root = await this.resources.resolveRoot(workspace)
    let source = await resolveWorkspacePath(root, mutation.path, { allowMissingFinal: false })
    let destination = await resolveWorkspacePath(root, mutation.destinationPath, { allowMissingFinal: true })
    if (destination.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    let sourceInfo = await lstat(source.absolutePath, { bigint: true })
    assertExpected(sourceInfo, mutation.expected)
    await assertNoNestedMount(root, source.absolutePath, {
      includeDescendants: mutation.expected.kind === 'directory',
    })
    await assertNoNestedMount(root, destination.absolutePath, { includeDescendants: false })
    const sourceParentFence = await captureDirectoryFence(root, wireParent(mutation.path))
    const destinationParentFence = await captureDirectoryFence(root, wireParent(mutation.destinationPath))

    root = await this.resources.resolveRoot(workspace)
    await assertDirectoryFence(root, sourceParentFence, { outcomeUncertain: false })
    await assertDirectoryFence(root, destinationParentFence, { outcomeUncertain: false })
    source = await resolveWorkspacePath(root, mutation.path, { allowMissingFinal: false })
    destination = await resolveWorkspacePath(root, mutation.destinationPath, { allowMissingFinal: true })
    if (destination.exists) throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    sourceInfo = await lstat(source.absolutePath, { bigint: true })
    assertExpected(sourceInfo, mutation.expected)
    await assertNoNestedMount(root, source.absolutePath, {
      includeDescendants: mutation.expected.kind === 'directory',
    })
    await assertNoNestedMount(root, destination.absolutePath, { includeDescendants: false })
    this.assertNotAborted(signal)
    let moved = false
    try {
      await this.nativeRename.moveNoReplace(source.absolutePath, destination.absolutePath)
      moved = true
      let freshRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(freshRoot, sourceParentFence, { outcomeUncertain: true })
      await assertDirectoryFence(freshRoot, destinationParentFence, { outcomeUncertain: true })
      let finalDestination = await resolveWorkspacePath(freshRoot, mutation.destinationPath, { allowMissingFinal: false })
      await assertNoNestedMount(freshRoot, finalDestination.absolutePath, {
        includeDescendants: mutation.expected.kind === 'directory',
      })
      const committedInfo = await lstat(finalDestination.absolutePath, { bigint: true })
      assertMovedSnapshot(sourceInfo, committedInfo)
      await this.internals.afterNativeCommit?.('rename', finalDestination.absolutePath)
      freshRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(freshRoot, sourceParentFence, { outcomeUncertain: true })
      await assertDirectoryFence(freshRoot, destinationParentFence, { outcomeUncertain: true })
      finalDestination = await resolveWorkspacePath(freshRoot, mutation.destinationPath, { allowMissingFinal: false })
      await assertNoNestedMount(freshRoot, finalDestination.absolutePath, {
        includeDescendants: mutation.expected.kind === 'directory',
      })
      await syncDirectory(dirname(source.absolutePath))
      if (dirname(source.absolutePath) !== dirname(destination.absolutePath)) {
        await syncDirectory(dirname(destination.absolutePath))
      }
      const finalInfo = await lstat(finalDestination.absolutePath, { bigint: true })
      assertUnchangedSnapshot(committedInfo, finalInfo)
      return {
        result: {
          kind: mutation.expected.kind,
          path: mutation.path,
          destinationPath: mutation.destinationPath,
          version: versionOf(finalInfo),
          refreshDirectories: refreshDirectories(mutation.path, mutation.destinationPath),
        },
      }
    } catch (error) {
      if (moved || (error instanceof IdeHostError && error.code === 'ATOMIC_RENAME_OUTCOME_UNKNOWN')) {
        throw new RecoveryRequiredError({ cause: error })
      }
      throw error
    }
  }

  private async delete(
    workspace: HostWorkspace,
    mutation: DeleteMutation,
    signal: AbortSignal,
  ): Promise<ExecutionSuccess> {
    if (!await this.nativeRename.supported()) {
      throw new IdeHostError('ATOMIC_RENAME_UNSUPPORTED', 'Atomic no-replace rename is unavailable on this Host.', 501)
    }
    let root = await this.resources.resolveRoot(workspace)
    let source = await resolveWorkspacePath(root, mutation.path, { allowMissingFinal: false })
    let sourceInfo = await lstat(source.absolutePath, { bigint: true })
    assertExpected(sourceInfo, mutation.expected)
    await assertNoNestedMount(root, source.absolutePath, {
      includeDescendants: mutation.expected.kind === 'directory',
    })
    const parentFence = await captureDirectoryFence(root, wireParent(mutation.path))
    if (!mutation.recursive && mutation.expected.kind === 'directory'
      && await this.directoryHasEntries(source.absolutePath)) {
      throw new IdeHostError('DIRECTORY_NOT_EMPTY', 'Recursive confirmation is required for a non-empty directory.', 409)
    }

    this.purger.reserve()
    let reservation = true
    const parent = dirname(source.absolutePath)
    const quarantine = join(parent, `${QUARANTINE_PREFIX}${randomUUID()}`)
    const payload = join(quarantine, 'payload')
    let quarantinePresent = false
    let moved = false
    let outcomeUnknown = false
    try {
      await mkdir(quarantine, { recursive: false, mode: 0o700 })
      quarantinePresent = true
      await chmod(quarantine, 0o700)
      const quarantineInfo = await lstat(quarantine, { bigint: true })
      if (!quarantineInfo.isDirectory() || quarantineInfo.isSymbolicLink()
        || quarantineInfo.dev !== root.identity.dev) {
        throw new IdeHostError('QUARANTINE_UNAVAILABLE', 'A safe deletion quarantine could not be created.', 409)
      }

      root = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(root, parentFence, { outcomeUncertain: true })
      source = await resolveWorkspacePath(root, mutation.path, { allowMissingFinal: false })
      sourceInfo = await lstat(source.absolutePath, { bigint: true })
      assertExpected(sourceInfo, mutation.expected)
      await assertNoNestedMount(root, source.absolutePath, {
        includeDescendants: mutation.expected.kind === 'directory',
      })
      const preCommitQuarantine = await lstat(quarantine, { bigint: true })
      assertOwnedQuarantine(root, quarantineInfo, preCommitQuarantine)
      this.assertNotAborted(signal)
      try {
        await this.nativeRename.moveNoReplace(source.absolutePath, payload)
        moved = true
      } catch (error) {
        outcomeUnknown = error instanceof IdeHostError && error.code === 'ATOMIC_RENAME_OUTCOME_UNKNOWN'
        throw error
      }
      const committedInfo = await lstat(payload, { bigint: true })
      assertMovedSnapshot(sourceInfo, committedInfo)
      await this.internals.afterNativeCommit?.('delete', payload)
      let freshRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(freshRoot, parentFence, { outcomeUncertain: true })
      await assertNoNestedMount(freshRoot, quarantine, { includeDescendants: true })
      let currentQuarantine = await lstat(quarantine, { bigint: true })
      assertOwnedQuarantine(freshRoot, quarantineInfo, currentQuarantine)
      let movedInfo = await lstat(payload, { bigint: true })
      assertUnchangedSnapshot(committedInfo, movedInfo)

      if (!mutation.recursive && mutation.expected.kind === 'directory'
        && await this.directoryHasEntries(payload)) {
        try {
          await this.nativeRename.moveNoReplace(payload, source.absolutePath)
          moved = false
          freshRoot = await this.resources.resolveRoot(workspace)
          await assertDirectoryFence(freshRoot, parentFence, { outcomeUncertain: true })
          const restored = await lstat(source.absolutePath, { bigint: true })
          assertMovedSnapshot(sourceInfo, restored)
        } catch (error) {
          throw new RecoveryRequiredError({ cause: error })
        }
        await rmdir(quarantine)
        quarantinePresent = false
        throw new IdeHostError('DIRECTORY_NOT_EMPTY', 'Recursive confirmation is required for a non-empty directory.', 409)
      }

      await syncDirectory(parent)
      freshRoot = await this.resources.resolveRoot(workspace)
      await assertDirectoryFence(freshRoot, parentFence, { outcomeUncertain: true })
      await assertNoNestedMount(freshRoot, quarantine, { includeDescendants: true })
      currentQuarantine = await lstat(quarantine, { bigint: true })
      assertOwnedQuarantine(freshRoot, quarantineInfo, currentQuarantine)
      movedInfo = await lstat(payload, { bigint: true })
      assertUnchangedSnapshot(committedInfo, movedInfo)
      const purge: PurgeJob = {
        path: quarantine,
        identity: quarantineInfo,
        workspaceRoot: freshRoot,
        notBefore: this.now() + this.receiptTtlMs,
        onSuccess: () => {},
        onFailure: () => {},
      }
      reservation = false
      return {
        result: {
          kind: mutation.expected.kind,
          path: mutation.path,
          recursive: mutation.recursive,
          refreshDirectories: refreshDirectories(mutation.path),
        },
        purge,
      }
    } catch (error) {
      if (moved || outcomeUnknown || error instanceof RecoveryRequiredError) {
        throw new RecoveryRequiredError({ cause: error })
      }
      throw error
    } finally {
      if (reservation) this.purger.release()
      if (quarantinePresent && !moved && !outcomeUnknown) {
        try {
          await rmdir(quarantine)
        } catch (error) {
          // An owned empty quarantine must be removable. Unexpected contents
          // or an identity race require reconciliation rather than claiming a
          // clean precommit failure while leaving hidden state behind.
          throw new RecoveryRequiredError({ cause: error })
        }
      }
    }
  }

  private async directoryHasEntries(path: string): Promise<boolean> {
    const handle = await open(path, READ_DIRECTORY_FLAGS)
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isDirectory()) throw new IdeHostError('RESOURCE_KIND_CONFLICT', 'The directory kind changed.', 409)
    } finally {
      await handle.close()
    }
    const directory = await opendir(path)
    try {
      return await directory.read() !== null
    } finally {
      await directory.close().catch(() => {})
    }
  }

  private assertEpoch(value: string): void {
    if (value !== this.providerEpoch) {
      throw new IdeHostError('PROVIDER_EPOCH_MISMATCH', 'The workspace mutation provider was restarted.', 409)
    }
  }

  private async capabilities(): Promise<MutationProviderResponse['capabilities']> {
    const backend = this.internals.backendCapabilities ?? this.backend.descriptor.capabilities
    if (this.internals.backendCapabilities === undefined) return { ...backend }
    const needsNative = backend.rename || backend.delete
    const native = needsNative && await this.nativeRename.supported()
    return {
      createFile: backend.createFile,
      createDirectory: backend.createDirectory,
      rename: backend.rename && native,
      delete: backend.delete && native,
    }
  }

  private assertCapability(kind: WorkspaceMutation['kind']): Promise<void> | undefined {
    const backend = this.internals.backendCapabilities ?? this.backend.descriptor.capabilities
    if (kind === 'createFile' || kind === 'createDirectory') {
      if (backend[kind]) return undefined
      throw new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'A containment-safe workspace mutation backend is unavailable on this Host.',
        501,
      )
    }
    if (!backend[kind]) {
      throw new IdeHostError(
        'ATOMIC_RENAME_UNSUPPORTED',
        'A containment-safe atomic mutation backend is unavailable on this Host.',
        501,
      )
    }
    return this.internals.backendCapabilities === undefined ? undefined : this.assertNativeCapability()
  }

  private async assertNativeCapability(): Promise<void> {
    if (!await this.nativeRename.supported()) {
      throw new IdeHostError(
        'ATOMIC_RENAME_UNSUPPORTED',
        'A containment-safe atomic mutation backend is unavailable on this Host.',
        501,
      )
    }
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted || !this.accepting) {
      throw new IdeHostError('MUTATION_CANCELLED', 'The mutation was cancelled before commit.', 409)
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= now && !receipt.purgePending) this.receipts.delete(id)
    }
  }
}
