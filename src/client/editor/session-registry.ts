import type { EditorState } from '@codemirror/state'

export interface EditorSessionIdentity {
  workspaceId: string
  path: string
  lifecycleId: number
  historyEpoch: number
}

export interface CachedEditorSession {
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

function key(identity: EditorSessionIdentity): string {
  return `${identity.workspaceId}\0${identity.path}\0${identity.lifecycleId}\0${identity.historyEpoch}`
}

export type CurrentEditorDocumentAuthority = (
  identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path' | 'lifecycleId'>,
) => boolean

/** In-memory only: CodeMirror history never crosses a browser reload or schema boundary. */
export class EditorSessionRegistry {
  private readonly sessions = new Map<string, CachedEditorSession>()

  constructor(private readonly isCurrent: CurrentEditorDocumentAuthority) {}

  private pathKey(identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path'>): string {
    return `${identity.workspaceId}\0${identity.path}`
  }

  private documentPrefix(identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path' | 'lifecycleId'>): string {
    return `${this.pathKey(identity)}\0${identity.lifecycleId}\0`
  }

  private admits(identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path' | 'lifecycleId'>): boolean {
    if (!this.isCurrent(identity)) return false
    const pathKey = this.pathKey(identity)
    const pathPrefix = `${pathKey}\0`
    const lifecyclePrefix = this.documentPrefix(identity)
    for (const candidate of this.sessions.keys()) {
      if (candidate.startsWith(pathPrefix) && !candidate.startsWith(lifecyclePrefix)) {
        this.sessions.delete(candidate)
      }
    }
    return true
  }

  get(identity: EditorSessionIdentity): CachedEditorSession | undefined {
    if (!this.admits(identity)) return undefined
    return this.sessions.get(key(identity))
  }

  set(identity: EditorSessionIdentity, session: CachedEditorSession): void {
    if (!this.admits(identity)) return
    this.sessions.set(key(identity), session)
  }

  deleteDocument(identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path' | 'lifecycleId'>): void {
    const prefix = this.documentPrefix(identity)
    for (const candidate of this.sessions.keys()) if (candidate.startsWith(prefix)) this.sessions.delete(candidate)
  }

  /** Atomically move every cached history epoch for one live document identity. */
  rebaseDocument(
    identity: Pick<EditorSessionIdentity, 'workspaceId' | 'path' | 'lifecycleId'>,
    destinationPath: string,
  ): boolean {
    if (destinationPath === identity.path || destinationPath.length === 0 || destinationPath.includes('\0')) return false
    const destinationKey = this.pathKey({ workspaceId: identity.workspaceId, path: destinationPath })
    if (!this.isCurrent({
      workspaceId: identity.workspaceId,
      path: destinationPath,
      lifecycleId: identity.lifecycleId,
    })) return false
    const sourcePrefix = this.documentPrefix(identity)
    const destinationPrefix = `${destinationKey}\0`
    for (const candidate of this.sessions.keys()) {
      if (candidate.startsWith(destinationPrefix)) this.sessions.delete(candidate)
    }
    const moved: [string, CachedEditorSession][] = []
    for (const [candidate, session] of this.sessions) {
      if (!candidate.startsWith(sourcePrefix)) continue
      const historyEpoch = candidate.slice(sourcePrefix.length)
      moved.push([`${destinationKey}\0${identity.lifecycleId}\0${historyEpoch}`, session])
      this.sessions.delete(candidate)
    }
    for (const [candidate, session] of moved) this.sessions.set(candidate, session)
    return true
  }

  retainHistoryEpoch(identity: EditorSessionIdentity): void {
    if (!this.admits(identity)) return
    const prefix = this.documentPrefix(identity)
    const retained = key(identity)
    for (const candidate of this.sessions.keys()) {
      if (candidate.startsWith(prefix) && candidate !== retained) this.sessions.delete(candidate)
    }
  }

  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\0`
    for (const candidate of this.sessions.keys()) if (candidate.startsWith(prefix)) this.sessions.delete(candidate)
  }

  usage(): { readonly sessions: number } {
    return { sessions: this.sessions.size }
  }

  clear(): void {
    this.sessions.clear()
  }
}
