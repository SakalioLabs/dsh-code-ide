export type MutationResourceKind = 'file' | 'directory'

export interface MutationSource {
  readonly path: string
  readonly type: MutationResourceKind
  readonly version: string
}

export type MutationDraft =
  | {
    readonly kind: 'create'
    readonly parentPath: string
    readonly name: string
    readonly resourceKind: MutationResourceKind
  }
  | {
    readonly kind: 'rename'
    readonly source: MutationSource
    readonly name: string
    /** Omitted for an in-place rename; present for an Explorer move. */
    readonly destinationParentPath?: string
  }
  | {
    readonly kind: 'delete'
    readonly source: MutationSource
  }

export interface MutationBlocker {
  readonly code: string
  readonly message: string
  readonly path?: string
}

export interface MutationImpact {
  readonly affectedDocuments: number
  readonly preservesDirtyFile: boolean
  readonly blockers: readonly MutationBlocker[]
}

export interface MutationPageError {
  readonly code: string
  readonly message: string
}

export interface MutationFocusRequest {
  readonly requestId: number
  readonly target: 'name' | 'confirm'
}

interface WorkspaceIdentity {
  readonly workspaceId: string
  readonly workspaceEpoch: number
}

interface DraftState extends WorkspaceIdentity {
  readonly draft: MutationDraft
  readonly focusRequest?: MutationFocusRequest
  readonly error?: MutationPageError
}

interface ActiveState extends WorkspaceIdentity {
  readonly draft: MutationDraft
  readonly impact: MutationImpact
  readonly operationId: string
  readonly providerEpoch: string
}

export type WorkspaceMutationSnapshot =
  | {
    readonly phase: 'idle'
    readonly workspaceId?: string
    readonly workspaceEpoch: number
    readonly error?: MutationPageError
  }
  | (DraftState & { readonly phase: 'editing' })
  | (DraftState & { readonly phase: 'confirming'; readonly impact: MutationImpact })
  | (ActiveState & { readonly phase: 'submitting' })
  | (ActiveState & { readonly phase: 'unknown'; readonly error: MutationPageError })
  | (ActiveState & { readonly phase: 'reconciling'; readonly error?: MutationPageError })
  | (ActiveState & { readonly phase: 'applying'; readonly error?: MutationPageError })

export interface AcceptedMutationCommit extends WorkspaceIdentity {
  readonly draft: MutationDraft
  readonly impact: MutationImpact
  readonly operationId: string
  readonly providerEpoch: string
}

type Listener = () => void

function idle(
  workspaceId: string | undefined,
  workspaceEpoch: number,
  error?: MutationPageError,
): WorkspaceMutationSnapshot {
  return {
    phase: 'idle',
    ...(workspaceId === undefined ? {} : { workspaceId }),
    workspaceEpoch,
    ...(error === undefined ? {} : { error }),
  }
}

/** Page-owned mutation workflow. Transport and domain commits remain ports. */
export class WorkspaceMutationStore {
  private snapshot: WorkspaceMutationSnapshot = idle(undefined, 0)
  private readonly listeners = new Set<Listener>()
  private focusSequence = 0
  private disposed = false

  readonly getSnapshot = (): WorkspaceMutationSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    if (this.disposed || !Number.isSafeInteger(workspaceEpoch) || workspaceEpoch < 0) return false
    if (this.snapshot.workspaceId === workspaceId && this.snapshot.workspaceEpoch === workspaceEpoch) return true
    if (this.snapshot.phase === 'submitting' || this.snapshot.phase === 'unknown'
      || this.snapshot.phase === 'reconciling' || this.snapshot.phase === 'applying') return false
    this.publish(idle(workspaceId, workspaceEpoch))
    return true
  }

  beginEditing(draft: MutationDraft): boolean {
    if (this.disposed || this.snapshot.phase !== 'idle' || this.snapshot.workspaceId === undefined) return false
    const focusRequest: MutationFocusRequest = {
      requestId: ++this.focusSequence,
      target: draft.kind === 'delete' ? 'confirm' : 'name',
    }
    this.publish({
      phase: 'editing',
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft,
      focusRequest,
    })
    return true
  }

  updateDraft(draft: MutationDraft): boolean {
    if (this.disposed || this.snapshot.phase !== 'editing') return false
    const { error: _error, ...snapshot } = this.snapshot
    this.publish({ ...snapshot, draft })
    return true
  }

  beginConfirming(impact: MutationImpact): boolean {
    if (this.disposed || this.snapshot.phase !== 'editing') return false
    this.publish({
      phase: 'confirming',
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft: this.snapshot.draft,
      impact,
      focusRequest: { requestId: ++this.focusSequence, target: 'confirm' },
    })
    return true
  }

  backToEditing(error?: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'confirming') return false
    this.publish({
      phase: 'editing',
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft: this.snapshot.draft,
      focusRequest: { requestId: ++this.focusSequence, target: this.snapshot.draft.kind === 'delete' ? 'confirm' : 'name' },
      ...(error === undefined ? {} : { error }),
    })
    return true
  }

  beginSubmitting(operationId: string, providerEpoch: string): boolean {
    if (this.disposed || this.snapshot.phase !== 'confirming'
      || this.snapshot.impact.blockers.length > 0 || operationId.length === 0 || providerEpoch.length === 0) return false
    this.publish({
      phase: 'submitting',
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft: this.snapshot.draft,
      impact: this.snapshot.impact,
      operationId,
      providerEpoch,
    })
    return true
  }

  refreshImpact(impact: MutationImpact): boolean {
    if (this.disposed || this.snapshot.phase !== 'confirming') return false
    this.publish({ ...this.snapshot, impact })
    return true
  }

  rejectConfirmation(error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'confirming') return false
    if (this.snapshot.draft.kind !== 'delete') return this.backToEditing(error)
    this.publish({
      ...this.snapshot,
      error,
      focusRequest: { requestId: ++this.focusSequence, target: 'confirm' },
    })
    return true
  }

  markUnknown(operationId: string, error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'submitting' || this.snapshot.operationId !== operationId) return false
    this.publish({ ...this.snapshot, phase: 'unknown', error })
    return true
  }

  beginReconciling(operationId: string): boolean {
    if (this.disposed || this.snapshot.phase !== 'unknown' || this.snapshot.operationId !== operationId) return false
    this.publish({
      phase: 'reconciling',
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft: this.snapshot.draft,
      impact: this.snapshot.impact,
      operationId,
      providerEpoch: this.snapshot.providerEpoch,
      error: this.snapshot.error,
    })
    return true
  }

  reconciliationUnknown(operationId: string, error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'reconciling' || this.snapshot.operationId !== operationId) return false
    this.publish({ ...this.snapshot, phase: 'unknown', error })
    return true
  }

  updateUnknown(operationId: string, error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'unknown' || this.snapshot.operationId !== operationId) return false
    this.publish({ ...this.snapshot, error })
    return true
  }

  acknowledgeUnresolved(operationId: string, warning: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'unknown' || this.snapshot.operationId !== operationId) return false
    this.publish(idle(this.snapshot.workspaceId, this.snapshot.workspaceEpoch, warning))
    return true
  }

  acceptCommitted(operationId: string): AcceptedMutationCommit | undefined {
    if (this.disposed || (this.snapshot.phase !== 'submitting' && this.snapshot.phase !== 'reconciling')
      || this.snapshot.operationId !== operationId) return undefined
    const accepted: AcceptedMutationCommit = {
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      draft: this.snapshot.draft,
      impact: this.snapshot.impact,
      operationId,
      providerEpoch: this.snapshot.providerEpoch,
    }
    this.publish({ ...this.snapshot, phase: 'applying' })
    return accepted
  }

  restoreApplying(
    identity: WorkspaceIdentity,
    draft: MutationDraft,
    impact: MutationImpact,
    operationId: string,
    providerEpoch: string,
  ): AcceptedMutationCommit | undefined {
    if (this.disposed || this.snapshot.phase !== 'idle'
      || this.snapshot.workspaceId !== identity.workspaceId
      || this.snapshot.workspaceEpoch !== identity.workspaceEpoch
      || operationId.length === 0 || providerEpoch.length === 0) return undefined
    const accepted: AcceptedMutationCommit = {
      workspaceId: identity.workspaceId,
      workspaceEpoch: identity.workspaceEpoch,
      draft,
      impact,
      operationId,
      providerEpoch,
    }
    this.publish({ ...accepted, phase: 'applying' })
    return accepted
  }

  applyingFailed(operationId: string, error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'applying' || this.snapshot.operationId !== operationId) return false
    this.publish({ ...this.snapshot, error })
    return true
  }

  retryApplying(operationId: string): boolean {
    if (this.disposed || this.snapshot.phase !== 'applying' || this.snapshot.operationId !== operationId) return false
    const { error: _error, ...snapshot } = this.snapshot
    this.publish(snapshot)
    return true
  }

  finishApplying(operationId: string, error?: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'applying' || this.snapshot.operationId !== operationId) return false
    this.publish(idle(this.snapshot.workspaceId, this.snapshot.workspaceEpoch, error))
    return true
  }

  restoreUnknown(
    identity: WorkspaceIdentity,
    draft: MutationDraft,
    impact: MutationImpact,
    operationId: string,
    providerEpoch: string,
    error: MutationPageError,
  ): boolean {
    if (this.disposed || this.snapshot.phase !== 'idle'
      || this.snapshot.workspaceId !== identity.workspaceId
      || this.snapshot.workspaceEpoch !== identity.workspaceEpoch
      || operationId.length === 0 || providerEpoch.length === 0) return false
    this.publish({
      phase: 'unknown',
      workspaceId: identity.workspaceId,
      workspaceEpoch: identity.workspaceEpoch,
      draft,
      impact,
      operationId,
      providerEpoch,
      error,
    })
    return true
  }

  reportIdleError(error: MutationPageError): boolean {
    if (this.disposed || this.snapshot.phase !== 'idle') return false
    this.publish(idle(this.snapshot.workspaceId, this.snapshot.workspaceEpoch, error))
    return true
  }

  fail(operationId: string, error: MutationPageError): boolean {
    if (this.disposed || (this.snapshot.phase !== 'submitting' && this.snapshot.phase !== 'reconciling')
      || this.snapshot.operationId !== operationId) return false
    if (this.snapshot.draft.kind === 'delete') {
      this.publish({
        phase: 'confirming',
        workspaceId: this.snapshot.workspaceId,
        workspaceEpoch: this.snapshot.workspaceEpoch,
        draft: this.snapshot.draft,
        impact: this.snapshot.impact,
        error,
        focusRequest: { requestId: ++this.focusSequence, target: 'confirm' },
      })
    } else {
      this.publish({
        phase: 'editing',
        workspaceId: this.snapshot.workspaceId,
        workspaceEpoch: this.snapshot.workspaceEpoch,
        draft: this.snapshot.draft,
        error,
        focusRequest: { requestId: ++this.focusSequence, target: 'name' },
      })
    }
    return true
  }

  cancel(): boolean {
    if (this.disposed || (this.snapshot.phase !== 'editing' && this.snapshot.phase !== 'confirming')) return false
    this.publish(idle(this.snapshot.workspaceId, this.snapshot.workspaceEpoch))
    return true
  }

  acknowledgeFocus(requestId: number): boolean {
    if (this.disposed || (this.snapshot.phase !== 'editing' && this.snapshot.phase !== 'confirming')
      || this.snapshot.focusRequest?.requestId !== requestId) return false
    const { focusRequest: _focusRequest, ...snapshot } = this.snapshot
    this.publish(snapshot)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private publish(snapshot: WorkspaceMutationSnapshot): void {
    if (this.disposed || snapshot === this.snapshot) return
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* observers cannot roll back committed state */ }
    }
  }
}
