export const CLOSED_EDITOR_HISTORY_LIMIT = 50

export interface ClosedEditorHistoryEntry {
  readonly sequence: number
  readonly workspaceId: string
  readonly path: string
}

export interface ClosedEditorHistorySnapshot {
  readonly workspaces: ReadonlyMap<string, readonly ClosedEditorHistoryEntry[]>
}

type Listener = () => void

function emptySnapshot(): ClosedEditorHistorySnapshot {
  return Object.freeze({ workspaces: new Map() })
}

/** Bounded, page-local history of authoritatively completed editor closes. */
export class ClosedEditorHistoryStore {
  private snapshot = emptySnapshot()
  private readonly listeners = new Set<Listener>()
  private sequence = 0

  constructor(readonly limitPerWorkspace = CLOSED_EDITOR_HISTORY_LIMIT) {
    if (!Number.isSafeInteger(limitPerWorkspace) || limitPerWorkspace <= 0) {
      throw new Error('Closed editor history limit must be a positive integer.')
    }
  }

  readonly getSnapshot = (): ClosedEditorHistorySnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Record one completed close, moving an older occurrence of the path to the top. */
  record(workspaceId: string, path: string): ClosedEditorHistoryEntry | undefined {
    if (workspaceId.length === 0 || path.length === 0) return undefined
    const entry = Object.freeze({
      sequence: ++this.sequence,
      workspaceId,
      path,
    })
    const current = this.snapshot.workspaces.get(workspaceId) ?? []
    const entries = Object.freeze([
      ...current.filter(candidate => candidate.path !== path),
      entry,
    ].slice(-this.limitPerWorkspace))
    const workspaces = new Map(this.snapshot.workspaces)
    workspaces.set(workspaceId, entries)
    this.publish(Object.freeze({ workspaces }))
    return entry
  }

  peek(workspaceId: string): ClosedEditorHistoryEntry | undefined {
    return this.snapshot.workspaces.get(workspaceId)?.at(-1)
  }

  /** Pop only the exact entry that was current when an asynchronous reopen began. */
  consumeIfCurrent(entry: ClosedEditorHistoryEntry): boolean {
    const current = this.snapshot.workspaces.get(entry.workspaceId)
    if (current?.at(-1) !== entry) return false
    const workspaces = new Map(this.snapshot.workspaces)
    if (current.length === 1) workspaces.delete(entry.workspaceId)
    else workspaces.set(entry.workspaceId, Object.freeze(current.slice(0, -1)))
    this.publish(Object.freeze({ workspaces }))
    return true
  }

  private publish(snapshot: ClosedEditorHistorySnapshot): void {
    if (snapshot === this.snapshot) return
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try { listener() } catch { /* observers cannot roll back a history transition */ }
    }
  }
}
