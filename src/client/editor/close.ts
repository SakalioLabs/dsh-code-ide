import type {
  DocumentIdentity,
  EditorTab,
} from '../documents/session.ts'

export type EditorCloseOrigin = 'tab' | 'editor'

export interface EditorCloseError {
  readonly code: string
  readonly message: string
}

export interface EditorClosePresentationRequest {
  readonly requestId: number
  readonly target: 'cancel' | 'dismiss'
}

export interface EditorCloseContext {
  readonly identity: DocumentIdentity
  readonly name: string
  readonly deleted: boolean
  readonly origin: EditorCloseOrigin
}

export type EditorCloseSnapshot =
  | {
    readonly phase: 'idle'
    readonly workspaceId?: string
    readonly workspaceEpoch: number
  }
  | (EditorCloseContext & {
    readonly phase: 'confirming'
    readonly presentationRequest?: EditorClosePresentationRequest
  })
  | (EditorCloseContext & {
    readonly phase: 'saving'
  })
  | (EditorCloseContext & {
    readonly phase: 'error'
    readonly error: EditorCloseError
    /** `decide` retains Save/Discard/Cancel; `dismiss` exposes no unsafe decision. */
    readonly actions: 'decide' | 'dismiss'
    readonly presentationRequest?: EditorClosePresentationRequest
  })

export type EditorCloseSaveResult =
  | 'saved'
  | 'not-needed'
  | 'conflict'
  | 'failed'
  | 'unknown'
  | 'stale'

export interface EditorCloseDocumentPort {
  inspect(identity: DocumentIdentity): EditorTab | undefined
  closeIfCurrent(identity: DocumentIdentity): EditorTab | undefined
  isPathMutationLeased(workspaceId: string, path: string): boolean
}

export interface EditorCloseSavePort {
  save(workspaceId: string, path: string): Promise<EditorCloseSaveResult>
  recreateDeleted(workspaceId: string, path: string): Promise<EditorCloseSaveResult>
}

/** Matches EditorSessionRegistry without coupling this transaction to CodeMirror. */
export interface EditorCloseRetirementPort {
  deleteDocument(identity: Pick<DocumentIdentity, 'workspaceId' | 'path' | 'lifecycleId'>): void
}

export type EditorCloseOutcome =
  | { readonly status: 'closed'; readonly disposition: 'clean' | 'saved' | 'discarded' }
  | { readonly status: 'confirming' }
  | { readonly status: 'blocked'; readonly error: EditorCloseError }
  | { readonly status: 'failed'; readonly error: EditorCloseError }
  | { readonly status: 'stale' }
  | { readonly status: 'unavailable' }

type Listener = () => void

function idle(workspaceId: string | undefined, workspaceEpoch: number): EditorCloseSnapshot {
  return Object.freeze({
    phase: 'idle' as const,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    workspaceEpoch,
  })
}

function ownIdentity(identity: DocumentIdentity): DocumentIdentity {
  return Object.freeze({ ...identity })
}

function ownContext(context: EditorCloseContext): EditorCloseContext {
  return Object.freeze({ ...context, identity: ownIdentity(context.identity) })
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return left.workspaceId === right.workspaceId
    && left.workspaceEpoch === right.workspaceEpoch
    && left.path === right.path
    && left.lifecycleId === right.lifecycleId
}

function contextFrom(snapshot: Exclude<EditorCloseSnapshot, { phase: 'idle' }>): EditorCloseContext {
  return ownContext({
    identity: snapshot.identity,
    name: snapshot.name,
    deleted: snapshot.deleted,
    origin: snapshot.origin,
  })
}

/** Framework-neutral, page-owned presentation state for one close transaction. */
export class EditorCloseStore {
  private snapshot: EditorCloseSnapshot = idle(undefined, 0)
  private readonly listeners = new Set<Listener>()
  private presentationSequence = 0
  private disposed = false

  readonly getSnapshot = (): EditorCloseSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed || !Number.isSafeInteger(workspaceEpoch) || workspaceEpoch < 0) return false
    const currentWorkspaceId = this.snapshot.phase === 'idle'
      ? this.snapshot.workspaceId
      : this.snapshot.identity.workspaceId
    const currentWorkspaceEpoch = this.snapshot.phase === 'idle'
      ? this.snapshot.workspaceEpoch
      : this.snapshot.identity.workspaceEpoch
    if (currentWorkspaceId === workspaceId && currentWorkspaceEpoch === workspaceEpoch) return true
    this.publish(idle(workspaceId, workspaceEpoch))
    return true
  }

  beginConfirming(context: EditorCloseContext): boolean {
    if (this.disposed || this.snapshot.phase !== 'idle'
      || this.snapshot.workspaceId !== context.identity.workspaceId
      || this.snapshot.workspaceEpoch !== context.identity.workspaceEpoch) return false
    const owned = ownContext(context)
    this.publish(Object.freeze({
      phase: 'confirming' as const,
      ...owned,
      presentationRequest: Object.freeze({
        requestId: ++this.presentationSequence,
        target: 'cancel' as const,
      }),
    }))
    return true
  }

  beginSaving(current?: EditorCloseContext): EditorCloseContext | undefined {
    if (this.disposed || (this.snapshot.phase !== 'confirming'
      && !(this.snapshot.phase === 'error' && this.snapshot.actions === 'decide'))) return undefined
    if (current !== undefined && !sameIdentity(this.snapshot.identity, current.identity)) return undefined
    const context = current === undefined ? contextFrom(this.snapshot) : ownContext(current)
    this.publish(Object.freeze({ phase: 'saving' as const, ...context }))
    return context
  }

  decisionContext(): EditorCloseContext | undefined {
    if (this.disposed || (this.snapshot.phase !== 'confirming'
      && !(this.snapshot.phase === 'error' && this.snapshot.actions === 'decide'))) return undefined
    return contextFrom(this.snapshot)
  }

  reportError(
    context: EditorCloseContext,
    error: EditorCloseError,
    actions: 'decide' | 'dismiss',
  ): boolean {
    if (this.disposed) return false
    if (this.snapshot.phase === 'idle') {
      if (this.snapshot.workspaceId !== context.identity.workspaceId
        || this.snapshot.workspaceEpoch !== context.identity.workspaceEpoch) return false
    } else if (!sameIdentity(this.snapshot.identity, context.identity)) return false
    const owned = ownContext(context)
    const ownedError = Object.freeze({ ...error })
    this.publish(Object.freeze({
      phase: 'error' as const,
      ...owned,
      error: ownedError,
      actions,
      presentationRequest: Object.freeze({
        requestId: ++this.presentationSequence,
        target: actions === 'decide' ? 'cancel' as const : 'dismiss' as const,
      }),
    }))
    return true
  }

  finish(identity: DocumentIdentity): boolean {
    if (this.disposed) return false
    if (this.snapshot.phase === 'idle') {
      return this.snapshot.workspaceId === identity.workspaceId
        && this.snapshot.workspaceEpoch === identity.workspaceEpoch
    }
    if (!sameIdentity(this.snapshot.identity, identity)) return false
    this.publish(idle(identity.workspaceId, identity.workspaceEpoch))
    return true
  }

  cancel(): boolean {
    if (this.disposed || (this.snapshot.phase !== 'confirming' && this.snapshot.phase !== 'error')) return false
    const { workspaceId, workspaceEpoch } = this.snapshot.identity
    this.publish(idle(workspaceId, workspaceEpoch))
    return true
  }

  acknowledgePresentation(requestId: number): boolean {
    if (this.disposed || (this.snapshot.phase !== 'confirming' && this.snapshot.phase !== 'error')
      || this.snapshot.presentationRequest?.requestId !== requestId) return false
    const { presentationRequest: _presentationRequest, ...snapshot } = this.snapshot
    this.publish(Object.freeze(snapshot))
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private publish(snapshot: EditorCloseSnapshot): void {
    if (this.disposed || snapshot === this.snapshot) return
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* presentation observers cannot roll back a domain transition */ }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function blocker(tab: EditorTab, documents: EditorCloseDocumentPort, identity: DocumentIdentity): EditorCloseError | undefined {
  if (tab.pendingSaveId !== undefined) {
    return { code: 'PENDING_SAVE', message: `Wait for the save of ${tab.name} to finish before closing it.` }
  }
  if (tab.pendingReloadId !== undefined) {
    return { code: 'PENDING_RELOAD', message: `Wait for the reload of ${tab.name} to finish before closing it.` }
  }
  if (tab.pendingConflictId !== undefined) {
    return { code: 'PENDING_CONFLICT', message: `Finish reviewing the external changes to ${tab.name} before closing it.` }
  }
  if (tab.saveOutcome === 'unknown') {
    return { code: 'UNKNOWN_SAVE', message: `Check the uncertain save outcome for ${tab.name} before closing it.` }
  }
  if (documents.isPathMutationLeased(identity.workspaceId, identity.path)) {
    return { code: 'MUTATION_LEASE', message: `Wait for the active file operation involving ${tab.name} before closing it.` }
  }
  return undefined
}

function refreshedContext(context: EditorCloseContext, tab: EditorTab): EditorCloseContext {
  return {
    ...context,
    name: tab.name,
    deleted: tab.externalState === 'deleted',
  }
}

/**
 * Orchestrates close decisions while DocumentSessionStore remains the sole
 * document authority and EditorSessionRegistry remains a retirement port.
 */
export class EditorCloseController {
  private disposed = false
  private fence = 0

  constructor(
    readonly store: EditorCloseStore,
    private readonly documents: EditorCloseDocumentPort,
    private readonly saves: EditorCloseSavePort,
    private readonly retirement: EditorCloseRetirementPort,
  ) {}

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed) return false
    const snapshot = this.store.getSnapshot()
    const currentWorkspaceId = snapshot.phase === 'idle' ? snapshot.workspaceId : snapshot.identity.workspaceId
    const currentWorkspaceEpoch = snapshot.phase === 'idle' ? snapshot.workspaceEpoch : snapshot.identity.workspaceEpoch
    const changed = currentWorkspaceId !== workspaceId || currentWorkspaceEpoch !== workspaceEpoch
    const selected = this.store.selectWorkspace(workspaceId, workspaceEpoch)
    if (selected && changed) this.fence += 1
    return selected
  }

  requestClose(identity: DocumentIdentity, origin: EditorCloseOrigin): EditorCloseOutcome {
    if (this.disposed) return { status: 'unavailable' }
    const snapshot = this.store.getSnapshot()
    if (snapshot.phase !== 'idle') return { status: 'unavailable' }
    if (snapshot.workspaceId !== identity.workspaceId
      || snapshot.workspaceEpoch !== identity.workspaceEpoch) return { status: 'stale' }
    const tab = this.documents.inspect(identity)
    if (tab === undefined) return { status: 'stale' }
    const context: EditorCloseContext = {
      identity,
      name: tab.name,
      deleted: tab.externalState === 'deleted',
      origin,
    }
    const blocked = blocker(tab, this.documents, identity)
    if (blocked !== undefined) return this.block(context, blocked)
    if (!tab.dirty) return this.close(context, 'clean')
    return this.store.beginConfirming(context) ? { status: 'confirming' } : { status: 'stale' }
  }

  async save(): Promise<EditorCloseOutcome> {
    if (this.disposed) return { status: 'unavailable' }
    const decision = this.store.decisionContext()
    if (decision === undefined) return { status: 'unavailable' }
    const admittedTab = this.documents.inspect(decision.identity)
    if (admittedTab === undefined) {
      this.store.finish(decision.identity)
      return { status: 'stale' }
    }
    const context = refreshedContext(decision, admittedTab)
    const blockedAtAdmission = blocker(admittedTab, this.documents, context.identity)
    if (blockedAtAdmission !== undefined) return this.block(context, blockedAtAdmission)
    if (!admittedTab.dirty) return this.close(context, 'saved')
    if (this.store.beginSaving(context) === undefined) return { status: 'stale' }
    const admittedFence = this.fence
    let result: EditorCloseSaveResult
    try {
      result = await (context.deleted
        ? this.saves.recreateDeleted(context.identity.workspaceId, context.identity.path)
        : this.saves.save(context.identity.workspaceId, context.identity.path))
    } catch (error) {
      if (!this.acceptsCompletion(context.identity, admittedFence)) return { status: 'stale' }
      return this.fail(context, {
        code: 'SAVE_UNKNOWN',
        message: `Saving ${context.name} ended without a classified outcome: ${errorMessage(error)}`,
      }, 'dismiss')
    }

    if (!this.acceptsCompletion(context.identity, admittedFence)) return { status: 'stale' }
    const tab = this.documents.inspect(context.identity)
    if (tab === undefined) {
      this.store.finish(context.identity)
      return { status: 'stale' }
    }
    const current = refreshedContext(context, tab)
    if (result === 'saved' || result === 'not-needed') {
      const blocked = blocker(tab, this.documents, context.identity)
      if (blocked !== undefined) return this.block(current, blocked)
      if (tab.dirty) {
        return this.fail(current, {
          code: 'DOCUMENT_STILL_DIRTY',
          message: `${tab.name} changed while it was being saved. Review the newer edits before closing it.`,
        }, 'decide')
      }
      return this.close(current, 'saved')
    }

    const errors: Record<Exclude<EditorCloseSaveResult, 'saved' | 'not-needed'>, EditorCloseError> = {
      conflict: {
        code: 'SAVE_CONFLICT',
        message: `${tab.name} changed on disk. Local edits remain open and were not discarded.`,
      },
      failed: {
        code: 'SAVE_FAILED',
        message: `${tab.name} could not be saved. Local edits remain open.`,
      },
      unknown: {
        code: 'SAVE_UNKNOWN',
        message: `The save outcome for ${tab.name} is unknown. Check it before closing the document.`,
      },
      stale: {
        code: 'SAVE_STALE',
        message: `${tab.name} changed identity while the save was completing. It was not closed.`,
      },
    }
    const nowBlocked = blocker(tab, this.documents, context.identity)
    const requiresReconciliation = result === 'unknown' || result === 'stale'
    return this.fail(
      current,
      errors[result],
      nowBlocked === undefined && !requiresReconciliation ? 'decide' : 'dismiss',
    )
  }

  discard(): EditorCloseOutcome {
    if (this.disposed) return { status: 'unavailable' }
    const context = this.store.decisionContext()
    if (context === undefined) return { status: 'unavailable' }
    const tab = this.documents.inspect(context.identity)
    if (tab === undefined) {
      this.store.finish(context.identity)
      return { status: 'stale' }
    }
    const current = refreshedContext(context, tab)
    const blocked = blocker(tab, this.documents, context.identity)
    if (blocked !== undefined) return this.block(current, blocked)
    return this.close(current, 'discarded')
  }

  cancel(): boolean {
    return !this.disposed && this.store.cancel()
  }

  acknowledgePresentation(requestId: number): boolean {
    return !this.disposed && this.store.acknowledgePresentation(requestId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fence += 1
    this.store.dispose()
  }

  private acceptsCompletion(identity: DocumentIdentity, admittedFence: number): boolean {
    if (this.disposed || admittedFence !== this.fence) return false
    const snapshot = this.store.getSnapshot()
    return snapshot.phase === 'saving' && sameIdentity(snapshot.identity, identity)
  }

  private block(context: EditorCloseContext, error: EditorCloseError): EditorCloseOutcome {
    this.store.reportError(context, error, 'dismiss')
    return { status: 'blocked', error }
  }

  private fail(
    context: EditorCloseContext,
    error: EditorCloseError,
    actions: 'decide' | 'dismiss',
  ): EditorCloseOutcome {
    this.store.reportError(context, error, actions)
    return { status: 'failed', error }
  }

  private close(
    context: EditorCloseContext,
    disposition: 'clean' | 'saved' | 'discarded',
  ): EditorCloseOutcome {
    const removed = this.documents.closeIfCurrent(context.identity)
    if (removed === undefined) {
      const current = this.documents.inspect(context.identity)
      if (current !== undefined) {
        const blocked = blocker(current, this.documents, context.identity)
        if (blocked !== undefined) return this.block(refreshedContext(context, current), blocked)
      }
      this.store.finish(context.identity)
      return { status: 'stale' }
    }

    const retirementIdentity = {
      workspaceId: context.identity.workspaceId,
      path: context.identity.path,
      lifecycleId: context.identity.lifecycleId,
    }
    try {
      // `closeIfCurrent` removed the exact identity synchronously. Every later
      // request is stale, so this retirement port is invoked exactly once
      // without retaining an unbounded set of historical document identities.
      this.retirement.deleteDocument(retirementIdentity)
    } catch (error) {
      return this.fail(context, {
        code: 'RETIREMENT_FAILED',
        message: `The document closed, but its editor session could not be retired: ${errorMessage(error)}`,
      }, 'dismiss')
    }
    this.store.finish(context.identity)
    return { status: 'closed', disposition }
  }
}
