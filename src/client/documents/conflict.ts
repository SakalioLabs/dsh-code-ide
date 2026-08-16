import type { ReadFileResponse } from '../contracts.ts'
import { normalizeEditableText } from './text-content.ts'
import {
  validateDocumentConflictVariant,
  type DocumentConflictIntent,
  type DocumentConflictRemote,
  type DocumentConflictResolution,
  type DocumentIdentity,
} from './session.ts'

export type DocumentConflictRelation =
  | 'remote-equals-base'
  | 'local-equals-base'
  | 'local-equals-remote'
  | 'diverged'
  | 'base-unavailable'

export interface DocumentConflictProjection {
  readonly intent: DocumentConflictIntent
  readonly base?: string
  readonly local: string
  readonly remote: DocumentConflictRemote
  readonly relation: DocumentConflictRelation
}

export interface DocumentConflictError {
  readonly code: string
  readonly message: string
}

export interface DocumentConflictPresentationRequest {
  readonly requestId: number
  readonly target: 'summary'
}

export type DocumentConflictSnapshot =
  | {
    readonly phase: 'idle'
    readonly workspaceId?: string
    readonly workspaceEpoch: number
  }
  | {
    readonly phase: 'comparing'
    readonly intent: DocumentConflictIntent
    readonly base?: string
    readonly local: string
    readonly presentationRequest?: DocumentConflictPresentationRequest
  }
  | ({
    readonly phase: 'ready'
    readonly presentationRequest?: DocumentConflictPresentationRequest
  } & DocumentConflictProjection)
  | ({
    readonly phase: 'applying'
    readonly resolution: DocumentConflictResolution
    readonly presentationRequest?: DocumentConflictPresentationRequest
  } & DocumentConflictProjection)
  | {
    readonly phase: 'error'
    readonly operation: 'compare' | 'verify'
    readonly intent: DocumentConflictIntent
    readonly base?: string
    readonly local: string
    readonly remote?: DocumentConflictRemote
    readonly relation?: DocumentConflictRelation
    readonly error: DocumentConflictError
    readonly presentationRequest?: DocumentConflictPresentationRequest
  }

export interface DocumentConflictDocumentPort {
  beginConflictCompare(identity: DocumentIdentity): DocumentConflictIntent | undefined
  isConflictCurrent(intent: DocumentConflictIntent): boolean
  cancelConflict(intent: DocumentConflictIntent): boolean
  applyConflictResolution(
    intent: DocumentConflictIntent,
    remote: DocumentConflictRemote,
    resolution: DocumentConflictResolution,
  ): boolean
}

export interface DocumentConflictReadPort {
  read(workspaceId: string, path: string): Promise<ReadFileResponse>
}

export type DocumentConflictCompareResult = 'ready' | 'blocked' | 'failed' | 'stale' | 'unavailable'
export type DocumentConflictResolveResult =
  | 'applied'
  | 'remote-changed'
  | 'invalid'
  | 'failed'
  | 'stale'
  | 'unavailable'

type Listener = () => void

function idle(workspaceId: string | undefined, workspaceEpoch: number): DocumentConflictSnapshot {
  return Object.freeze({
    phase: 'idle' as const,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    workspaceEpoch,
  })
}

function ownIntent(intent: DocumentConflictIntent): DocumentConflictIntent {
  return Object.freeze({ ...intent })
}

function ownRemote(remote: DocumentConflictRemote): DocumentConflictRemote {
  return Object.freeze({ ...remote })
}

function sameIntent(left: DocumentConflictIntent, right: DocumentConflictIntent): boolean {
  return left.workspaceId === right.workspaceId
    && left.workspaceEpoch === right.workspaceEpoch
    && left.path === right.path
    && left.lifecycleId === right.lifecycleId
    && left.requestId === right.requestId
    && left.resourceGeneration === right.resourceGeneration
    && left.localRevision === right.localRevision
    && left.baseVersion === right.baseVersion
    && left.lineEnding === right.lineEnding
    && left.local === right.local
    && left.base === right.base
}

export function classifyDocumentConflict(
  base: string | undefined,
  local: string,
  remote: string,
): DocumentConflictRelation {
  if (base === undefined) return 'base-unavailable'
  if (remote === base) return 'remote-equals-base'
  if (local === base) return 'local-equals-base'
  if (local === remote) return 'local-equals-remote'
  return 'diverged'
}

function projection(intent: DocumentConflictIntent, remote: DocumentConflictRemote): DocumentConflictProjection {
  const owned = ownIntent(intent)
  return Object.freeze({
    intent: owned,
    ...(owned.base === undefined ? {} : { base: owned.base }),
    local: owned.local,
    remote: ownRemote(remote),
    relation: classifyDocumentConflict(owned.base, owned.local, remote.content),
  })
}

/** Page-owned runtime projection; transport and document authority remain ports. */
export class DocumentConflictStore {
  private snapshot: DocumentConflictSnapshot = idle(undefined, 0)
  private readonly listeners = new Set<Listener>()
  private presentationSequence = 0
  private disposed = false

  readonly getSnapshot = (): DocumentConflictSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed || !Number.isSafeInteger(workspaceEpoch) || workspaceEpoch < 0) return false
    const currentId = this.snapshot.phase === 'idle'
      ? this.snapshot.workspaceId
      : this.snapshot.intent.workspaceId
    const currentEpoch = this.snapshot.phase === 'idle'
      ? this.snapshot.workspaceEpoch
      : this.snapshot.intent.workspaceEpoch
    if (currentId === workspaceId && currentEpoch === workspaceEpoch) return true
    this.publish(idle(workspaceId, workspaceEpoch))
    return true
  }

  begin(intent: DocumentConflictIntent): boolean {
    if (this.disposed || this.snapshot.phase !== 'idle'
      || this.snapshot.workspaceId !== intent.workspaceId
      || this.snapshot.workspaceEpoch !== intent.workspaceEpoch) return false
    const owned = ownIntent(intent)
    this.publish(Object.freeze({
      phase: 'comparing' as const,
      intent: owned,
      ...(owned.base === undefined ? {} : { base: owned.base }),
      local: owned.local,
      presentationRequest: Object.freeze({
        requestId: ++this.presentationSequence,
        target: 'summary' as const,
      }),
    }))
    return true
  }

  review(intent: DocumentConflictIntent, remote: DocumentConflictRemote): boolean {
    if (this.disposed || (this.snapshot.phase !== 'comparing' && this.snapshot.phase !== 'applying')
      || !sameIntent(this.snapshot.intent, intent)) return false
    const request = this.snapshot.presentationRequest
    this.publish(Object.freeze({
      phase: 'ready' as const,
      ...projection(intent, remote),
      ...(request === undefined ? {} : { presentationRequest: request }),
    }))
    return true
  }

  beginApplying(resolution: DocumentConflictResolution): DocumentConflictProjection | undefined {
    if (this.disposed || this.snapshot.phase !== 'ready') return undefined
    const current: DocumentConflictProjection = projection(this.snapshot.intent, this.snapshot.remote)
    const ownedResolution = Object.freeze({ ...resolution }) as DocumentConflictResolution
    this.publish(Object.freeze({
      phase: 'applying' as const,
      ...current,
      resolution: ownedResolution,
      ...(this.snapshot.presentationRequest === undefined
        ? {}
        : { presentationRequest: this.snapshot.presentationRequest }),
    }))
    return current
  }

  reportError(
    intent: DocumentConflictIntent,
    operation: 'compare' | 'verify',
    error: DocumentConflictError,
  ): boolean {
    if (this.disposed || (this.snapshot.phase !== 'comparing' && this.snapshot.phase !== 'applying')
      || !sameIntent(this.snapshot.intent, intent)) return false
    const current = this.snapshot
    const owned = ownIntent(intent)
    this.publish(Object.freeze({
      phase: 'error' as const,
      operation,
      intent: owned,
      ...(owned.base === undefined ? {} : { base: owned.base }),
      local: owned.local,
      ...(current.phase === 'applying'
        ? {
          remote: ownRemote(current.remote),
          relation: current.relation,
        }
        : {}),
      error: Object.freeze({ ...error }),
      presentationRequest: current.presentationRequest ?? Object.freeze({
        requestId: ++this.presentationSequence,
        target: 'summary' as const,
      }),
    }))
    return true
  }

  retry(): DocumentConflictIntent | undefined {
    if (this.disposed || this.snapshot.phase !== 'error') return undefined
    const intent = ownIntent(this.snapshot.intent)
    this.publish(Object.freeze({
      phase: 'comparing' as const,
      intent,
      ...(intent.base === undefined ? {} : { base: intent.base }),
      local: intent.local,
      ...(this.snapshot.presentationRequest === undefined
        ? {}
        : { presentationRequest: this.snapshot.presentationRequest }),
    }))
    return intent
  }

  finish(intent: DocumentConflictIntent): boolean {
    if (this.disposed) return false
    if (this.snapshot.phase === 'idle') {
      return this.snapshot.workspaceId === intent.workspaceId
        && this.snapshot.workspaceEpoch === intent.workspaceEpoch
    }
    if (!sameIntent(this.snapshot.intent, intent)) return false
    this.publish(idle(intent.workspaceId, intent.workspaceEpoch))
    return true
  }

  activeIntent(): DocumentConflictIntent | undefined {
    return this.snapshot.phase === 'idle' ? undefined : this.snapshot.intent
  }

  acknowledgePresentation(requestId: number): boolean {
    if (this.disposed || this.snapshot.phase === 'idle'
      || this.snapshot.presentationRequest?.requestId !== requestId) return false
    const { presentationRequest: _presentationRequest, ...snapshot } = this.snapshot
    this.publish(Object.freeze(snapshot) as DocumentConflictSnapshot)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private publish(snapshot: DocumentConflictSnapshot): void {
    if (this.disposed || snapshot === this.snapshot) return
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* presentation observers cannot roll back a domain transition */ }
    }
  }
}

function boundedError(code: string, message: string): DocumentConflictError {
  const safeCode = code.replace(/[\u0000-\u001f\u007f]/gu, '\ufffd').slice(0, 128) || 'CONFLICT_ERROR'
  const safeMessage = message.replace(/[\u0000-\u001f\u007f]/gu, '\ufffd').slice(0, 2_000)
    || 'The conflict operation failed without a usable message.'
  return { code: safeCode, message: safeMessage }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function variantError(prefix: 'REMOTE' | 'MERGED', content: string): DocumentConflictError | undefined {
  const invalid = validateDocumentConflictVariant(content)
  if (invalid === undefined) return undefined
  const description = invalid === 'nul'
    ? 'contains a NUL character'
    : invalid === 'invalid-unicode'
      ? 'contains an invalid Unicode surrogate'
      : 'exceeds the 1 MiB UTF-8 limit'
  return boundedError(`${prefix}_${invalid.replace('-', '_').toUpperCase()}`, `${prefix === 'REMOTE' ? 'Remote' : 'Merged'} text ${description}.`)
}

/** Explicit compare + verify-before-apply controller. It never owns a write port. */
export class DocumentConflictController {
  private disposed = false
  private fence = 0

  constructor(
    readonly store: DocumentConflictStore,
    private readonly documents: DocumentConflictDocumentPort,
    private readonly files: DocumentConflictReadPort,
  ) {}

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed) return false
    const active = this.store.activeIntent()
    const snapshot = this.store.getSnapshot()
    const currentId = snapshot.phase === 'idle' ? snapshot.workspaceId : snapshot.intent.workspaceId
    const currentEpoch = snapshot.phase === 'idle' ? snapshot.workspaceEpoch : snapshot.intent.workspaceEpoch
    const changed = currentId !== workspaceId || currentEpoch !== workspaceEpoch
    if (changed && active !== undefined) this.documents.cancelConflict(active)
    const selected = this.store.selectWorkspace(workspaceId, workspaceEpoch)
    if (selected && changed) this.fence += 1
    return selected
  }

  async compare(identity: DocumentIdentity): Promise<DocumentConflictCompareResult> {
    if (this.disposed || this.store.getSnapshot().phase !== 'idle') return 'unavailable'
    const intent = this.documents.beginConflictCompare(identity)
    if (intent === undefined) return 'blocked'
    if (!this.store.begin(intent)) {
      this.documents.cancelConflict(intent)
      return 'stale'
    }
    return this.readComparison(intent)
  }

  async retry(): Promise<DocumentConflictCompareResult> {
    if (this.disposed) return 'unavailable'
    const intent = this.store.retry()
    if (intent === undefined) return 'unavailable'
    return this.readComparison(intent)
  }

  acceptRemote(): Promise<DocumentConflictResolveResult> {
    return this.resolve({ kind: 'accept-remote' })
  }

  keepLocal(): Promise<DocumentConflictResolveResult> {
    return this.resolve({ kind: 'keep-local' })
  }

  applyMerged(content: string): Promise<DocumentConflictResolveResult> {
    if (variantError('MERGED', content) !== undefined) return Promise.resolve('invalid')
    return this.resolve({ kind: 'apply-merged', content: normalizeEditableText(content).content })
  }

  cancel(): boolean {
    if (this.disposed) return false
    const intent = this.store.activeIntent()
    if (intent === undefined) return false
    this.fence += 1
    const released = this.documents.cancelConflict(intent)
    this.store.finish(intent)
    return released
  }

  acknowledgePresentation(requestId: number): boolean {
    return !this.disposed && this.store.acknowledgePresentation(requestId)
  }

  dispose(): void {
    if (this.disposed) return
    const intent = this.store.activeIntent()
    this.disposed = true
    this.fence += 1
    if (intent !== undefined) this.documents.cancelConflict(intent)
    this.store.dispose()
  }

  private async readComparison(intent: DocumentConflictIntent): Promise<DocumentConflictCompareResult> {
    const admittedFence = this.fence
    let result: ReadFileResponse
    try {
      result = await this.files.read(intent.workspaceId, intent.path)
    } catch (error) {
      if (!this.accepts(intent, admittedFence, 'comparing')) return this.stale(intent)
      this.store.reportError(intent, 'compare', boundedError('REMOTE_READ_FAILED', message(error)))
      return 'failed'
    }
    if (!this.accepts(intent, admittedFence, 'comparing')) return this.stale(intent)
    if (result.path !== intent.path) {
      this.store.reportError(intent, 'compare', boundedError(
        'REMOTE_PATH_MISMATCH',
        'The authoritative read returned another path.',
      ))
      return 'failed'
    }
    if (result.readOnlyPresentation !== undefined) {
      this.store.reportError(intent, 'compare', boundedError(
        'REMOTE_NOT_EDITABLE_TEXT',
        'The remote resource is binary or exceeds the editable text limit.',
      ))
      return 'failed'
    }
    const invalid = variantError('REMOTE', result.content)
    if (invalid !== undefined) {
      this.store.reportError(intent, 'compare', invalid)
      return 'failed'
    }
    const remote = normalizeEditableText(result.content)
    return this.store.review(intent, {
      content: remote.content,
      version: result.version,
      lineEnding: remote.lineEnding,
    }) ? 'ready' : 'stale'
  }

  private async resolve(resolution: DocumentConflictResolution): Promise<DocumentConflictResolveResult> {
    if (this.disposed) return 'unavailable'
    if (resolution.kind === 'apply-merged' && variantError('MERGED', resolution.content) !== undefined) return 'invalid'
    const reviewed = this.store.beginApplying(resolution)
    if (reviewed === undefined) return 'unavailable'
    const intent = reviewed.intent
    const admittedFence = this.fence
    let result: ReadFileResponse
    try {
      result = await this.files.read(intent.workspaceId, intent.path)
    } catch (error) {
      if (!this.accepts(intent, admittedFence, 'applying')) return this.stale(intent)
      this.store.reportError(intent, 'verify', boundedError('REMOTE_VERIFY_FAILED', message(error)))
      return 'failed'
    }
    if (!this.accepts(intent, admittedFence, 'applying')) return this.stale(intent)
    if (result.path !== intent.path) {
      this.store.reportError(intent, 'verify', boundedError(
        'REMOTE_PATH_MISMATCH',
        'The verification read returned another path.',
      ))
      return 'failed'
    }
    if (result.readOnlyPresentation !== undefined) {
      this.store.reportError(intent, 'verify', boundedError(
        'REMOTE_NOT_EDITABLE_TEXT',
        'The remote resource is binary or exceeds the editable text limit.',
      ))
      return 'failed'
    }
    const invalid = variantError('REMOTE', result.content)
    if (invalid !== undefined) {
      this.store.reportError(intent, 'verify', invalid)
      return 'failed'
    }
    const normalized = normalizeEditableText(result.content)
    const remote = {
      content: normalized.content,
      version: result.version,
      lineEnding: normalized.lineEnding,
    }
    if (remote.content !== reviewed.remote.content || remote.version !== reviewed.remote.version
      || remote.lineEnding !== reviewed.remote.lineEnding) {
      return this.store.review(intent, remote) ? 'remote-changed' : 'stale'
    }
    if (!this.documents.applyConflictResolution(intent, remote, resolution)) return this.stale(intent)
    this.store.finish(intent)
    return 'applied'
  }

  private accepts(
    intent: DocumentConflictIntent,
    admittedFence: number,
    phase: 'comparing' | 'applying',
  ): boolean {
    if (this.disposed || admittedFence !== this.fence || !this.documents.isConflictCurrent(intent)) return false
    const snapshot = this.store.getSnapshot()
    return snapshot.phase === phase && sameIntent(snapshot.intent, intent)
  }

  private stale(intent: DocumentConflictIntent): 'stale' {
    this.documents.cancelConflict(intent)
    this.store.finish(intent)
    return 'stale'
  }
}
