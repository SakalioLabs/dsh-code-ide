import type { DocumentIdentity } from '../documents/session.ts'
import type { EditorCloseOutcome } from './close.ts'

export interface EditorCloseBatchWorkspace {
  readonly workspaceId: string
  readonly workspaceEpoch: number
}

export interface EditorCloseBatchSelection {
  readonly activeWorkspaceId: string | undefined
  readonly activeWorkspaceEpoch: number
}

export interface EditorCloseBatchPort {
  requestClose(identity: DocumentIdentity, origin: 'editor'): EditorCloseOutcome
}

export type EditorCloseBatchStopReason =
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'stale'
  | 'unavailable'
  | 'workspace-changed'

export type EditorCloseBatchResult =
  | {
    readonly status: 'completed'
    readonly closed: readonly DocumentIdentity[]
  }
  | {
    readonly status: 'confirming'
    readonly target: DocumentIdentity
    readonly closed: readonly DocumentIdentity[]
  }
  | {
    readonly status: 'terminated'
    readonly reason: EditorCloseBatchStopReason
    readonly closed: readonly DocumentIdentity[]
  }
  | {
    /** A late modal completion cannot consume or terminate a newer batch. */
    readonly status: 'ignored'
    readonly closed: readonly []
  }

interface ActiveBatch {
  readonly workspace: EditorCloseBatchWorkspace
  readonly queue: readonly DocumentIdentity[]
  index: number
  awaiting: DocumentIdentity | undefined
}

function ownIdentity(identity: DocumentIdentity): DocumentIdentity {
  return Object.freeze({ ...identity })
}

function ownWorkspace(workspace: EditorCloseBatchWorkspace): EditorCloseBatchWorkspace {
  return Object.freeze({ ...workspace })
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return left.workspaceId === right.workspaceId
    && left.workspaceEpoch === right.workspaceEpoch
    && left.path === right.path
    && left.lifecycleId === right.lifecycleId
}

function belongsTo(identity: DocumentIdentity, workspace: EditorCloseBatchWorkspace): boolean {
  return identity.workspaceId === workspace.workspaceId
    && identity.workspaceEpoch === workspace.workspaceEpoch
}

function freezeClosed(closed: DocumentIdentity[]): readonly DocumentIdentity[] {
  return Object.freeze(closed.map(ownIdentity))
}

/**
 * Framework-neutral coordinator for one frozen Close All Editors transaction.
 * DocumentSessionStore remains the authority and EditorCloseController remains
 * the only close effect; this class merely sequences exact identities.
 */
export class EditorCloseBatchCoordinator {
  private active: ActiveBatch | undefined
  private disposed = false

  constructor(
    private readonly close: EditorCloseBatchPort,
    private readonly currentSelection: () => EditorCloseBatchSelection,
  ) {}

  get isActive(): boolean { return this.active !== undefined }

  start(
    workspace: EditorCloseBatchWorkspace,
    identities: readonly DocumentIdentity[],
  ): EditorCloseBatchResult {
    if (this.disposed || this.active !== undefined) {
      return { status: 'terminated', reason: 'unavailable', closed: Object.freeze([]) }
    }
    if (!this.isCurrent(workspace)) {
      return { status: 'terminated', reason: 'workspace-changed', closed: Object.freeze([]) }
    }
    if (identities.some(identity => !belongsTo(identity, workspace))) {
      return { status: 'terminated', reason: 'stale', closed: Object.freeze([]) }
    }
    if (identities.length === 0) return { status: 'completed', closed: Object.freeze([]) }

    this.active = {
      workspace: ownWorkspace(workspace),
      queue: Object.freeze(identities.map(ownIdentity)),
      index: 0,
      awaiting: undefined,
    }
    return this.advance([])
  }

  resume(identity: DocumentIdentity, outcome: EditorCloseOutcome): EditorCloseBatchResult {
    const active = this.active
    if (this.disposed || active?.awaiting === undefined || !sameIdentity(active.awaiting, identity)) {
      return { status: 'ignored', closed: Object.freeze([]) }
    }
    if (outcome.status !== 'closed') {
      this.active = undefined
      return {
        status: 'terminated',
        reason: outcome.status === 'confirming' ? 'unavailable' : outcome.status,
        closed: Object.freeze([]),
      }
    }

    active.awaiting = undefined
    active.index += 1
    return this.advance([identity])
  }

  cancel(identity: DocumentIdentity): EditorCloseBatchResult {
    const active = this.active
    if (this.disposed || active?.awaiting === undefined || !sameIdentity(active.awaiting, identity)) {
      return { status: 'ignored', closed: Object.freeze([]) }
    }
    this.active = undefined
    return { status: 'terminated', reason: 'cancelled', closed: Object.freeze([]) }
  }

  /** Releases a paused queue immediately when workspace ownership moves. */
  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean {
    const active = this.active
    if (active === undefined) return true
    if (active.workspace.workspaceId === workspaceId
      && active.workspace.workspaceEpoch === workspaceEpoch) return true
    this.active = undefined
    return true
  }

  dispose(): void {
    this.disposed = true
    this.active = undefined
  }

  private advance(closed: DocumentIdentity[]): EditorCloseBatchResult {
    const active = this.active
    if (active === undefined) return { status: 'ignored', closed: Object.freeze([]) }
    while (active.index < active.queue.length) {
      if (!this.isCurrent(active.workspace)) {
        this.active = undefined
        return { status: 'terminated', reason: 'workspace-changed', closed: freezeClosed(closed) }
      }
      const target = active.queue[active.index]
      if (target === undefined) {
        this.active = undefined
        return { status: 'terminated', reason: 'stale', closed: freezeClosed(closed) }
      }
      const outcome = this.close.requestClose(target, 'editor')
      if (outcome.status === 'closed') {
        closed.push(target)
        active.index += 1
        continue
      }
      if (outcome.status === 'confirming') {
        active.awaiting = target
        return { status: 'confirming', target: ownIdentity(target), closed: freezeClosed(closed) }
      }
      this.active = undefined
      return { status: 'terminated', reason: outcome.status, closed: freezeClosed(closed) }
    }
    this.active = undefined
    return { status: 'completed', closed: freezeClosed(closed) }
  }

  private isCurrent(expected: EditorCloseBatchWorkspace): boolean {
    const current = this.currentSelection()
    return current.activeWorkspaceId === expected.workspaceId
      && current.activeWorkspaceEpoch === expected.workspaceEpoch
  }
}
