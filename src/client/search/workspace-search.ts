import type { DocumentSessionsSnapshot, EditorTab } from '../documents/session.ts'
import {
  searchTextContent,
  type SearchTextResponse,
  type TextSearchItem,
  type WorkspaceTextSearchQuery,
} from '../../shared/workspace-search.ts'

export type WorkspaceSearchStatus = 'idle' | 'running' | 'complete' | 'empty' | 'cancelled' | 'error'
export type WorkspaceSearchSource = 'disk' | 'buffer'

export interface WorkspaceSearchItem extends TextSearchItem {
  readonly source: WorkspaceSearchSource
  readonly bufferLifecycleId?: number
  readonly bufferRevision?: number
}

export interface WorkspaceSearchSession {
  readonly query: WorkspaceTextSearchQuery
  readonly requestGeneration: number
  readonly status: WorkspaceSearchStatus
  readonly items: readonly WorkspaceSearchItem[]
  readonly selectedIndex: number
  readonly matchCount: number
  readonly fileCount: number
  readonly truncated: boolean
  /** Regex matching of dirty buffers is omitted until it can run in an interruptible worker. */
  readonly dirtyBuffersOmitted: boolean
  readonly limit?: number
  readonly error?: string
}

export interface WorkspaceSearchSnapshot {
  readonly activeWorkspaceId?: string
  readonly activeWorkspaceEpoch: number
  readonly workspaces: ReadonlyMap<string, WorkspaceSearchSession>
}

export interface WorkspaceSearchIntent {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly requestGeneration: number
  readonly query: WorkspaceTextSearchQuery
}

export interface SearchTextPort {
  searchText(workspaceId: string, query: WorkspaceTextSearchQuery, signal?: AbortSignal): Promise<SearchTextResponse>
}

export interface SearchBufferSource {
  getSnapshot(): DocumentSessionsSnapshot
  subscribe(listener: () => void): () => void
}

type Listener = () => void

function withoutError(session: WorkspaceSearchSession): WorkspaceSearchSession {
  const { error: _error, ...current } = session
  return current
}

export const DEFAULT_WORKSPACE_SEARCH_QUERY: WorkspaceTextSearchQuery = {
  pattern: '', mode: 'literal', caseSensitive: false, wholeWord: false,
}

function queryCopy(query: WorkspaceTextSearchQuery): WorkspaceTextSearchQuery {
  return {
    pattern: query.pattern,
    mode: query.mode,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    ...(query.include === undefined ? {} : { include: [...query.include] }),
    ...(query.exclude === undefined ? {} : { exclude: [...query.exclude] }),
  }
}

function initialSession(query: WorkspaceTextSearchQuery = DEFAULT_WORKSPACE_SEARCH_QUERY): WorkspaceSearchSession {
  return {
    query: queryCopy(query), requestGeneration: 0, status: 'idle', items: [], selectedIndex: -1,
    matchCount: 0, fileCount: 0, truncated: false, dirtyBuffersOmitted: false,
  }
}

export class WorkspaceSearchStore {
  private snapshot: WorkspaceSearchSnapshot = { activeWorkspaceEpoch: 0, workspaces: new Map() }
  private readonly listeners = new Set<Listener>()

  readonly getSnapshot = (): WorkspaceSearchSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  session(workspaceId: string | undefined = this.snapshot.activeWorkspaceId): WorkspaceSearchSession {
    return workspaceId === undefined ? initialSession() : this.snapshot.workspaces.get(workspaceId) ?? initialSession()
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.snapshot.activeWorkspaceId === workspaceId) return
    const workspaces = new Map(this.snapshot.workspaces)
    if (workspaceId !== undefined && !workspaces.has(workspaceId)) workspaces.set(workspaceId, initialSession())
    this.publish({
      ...(workspaceId === undefined ? {} : { activeWorkspaceId: workspaceId }),
      activeWorkspaceEpoch: this.snapshot.activeWorkspaceEpoch + 1,
      workspaces,
    })
  }

  setDraft(workspaceId: string, query: WorkspaceTextSearchQuery): void {
    const current = this.session(workspaceId)
    this.replaceWorkspace(workspaceId, {
      ...initialSession(query),
      requestGeneration: current.requestGeneration + 1,
    })
  }

  /** Clear only the active result projection while preserving its complete query draft. */
  clear(workspaceId: string): boolean {
    if (this.snapshot.activeWorkspaceId !== workspaceId) return false
    const current = this.session(workspaceId)
    this.replaceWorkspace(workspaceId, {
      ...initialSession(current.query),
      requestGeneration: current.requestGeneration + 1,
    })
    return true
  }

  begin(query: WorkspaceTextSearchQuery): WorkspaceSearchIntent | undefined {
    const workspaceId = this.snapshot.activeWorkspaceId
    if (workspaceId === undefined || query.pattern.length === 0) {
      if (workspaceId !== undefined) this.setDraft(workspaceId, query)
      return undefined
    }
    const current = this.session(workspaceId)
    const intent: WorkspaceSearchIntent = {
      workspaceId,
      workspaceEpoch: this.snapshot.activeWorkspaceEpoch,
      requestGeneration: current.requestGeneration + 1,
      query: queryCopy(query),
    }
    this.replaceWorkspace(workspaceId, {
      query: intent.query,
      requestGeneration: intent.requestGeneration,
      status: 'running', items: [], selectedIndex: -1, matchCount: 0, fileCount: 0,
      truncated: false, dirtyBuffersOmitted: false,
    })
    return intent
  }

  complete(intent: WorkspaceSearchIntent, result: WorkspaceSearchResult): boolean {
    if (!this.accepts(intent)) return false
    this.replaceWorkspace(intent.workspaceId, {
      query: intent.query,
      requestGeneration: intent.requestGeneration,
      status: result.items.length === 0 ? 'empty' : 'complete',
      items: result.items,
      selectedIndex: result.items.length === 0 ? -1 : 0,
      matchCount: result.matchCount,
      fileCount: result.fileCount,
      truncated: result.truncated,
      dirtyBuffersOmitted: result.dirtyBuffersOmitted,
      limit: result.limit,
    })
    return true
  }

  refresh(intent: WorkspaceSearchIntent, result: WorkspaceSearchResult): boolean {
    if (!this.accepts(intent)) return false
    const current = this.session(intent.workspaceId)
    if (current.status !== 'complete' && current.status !== 'empty') return false
    const selectedPath = current.items[current.selectedIndex]?.path
    const selectedIndex = selectedPath === undefined
      ? (result.items.length === 0 ? -1 : 0)
      : Math.max(0, result.items.findIndex(item => item.path === selectedPath))
    this.replaceWorkspace(intent.workspaceId, {
      ...current,
      status: result.items.length === 0 ? 'empty' : 'complete',
      items: result.items,
      selectedIndex: result.items.length === 0 ? -1 : selectedIndex,
      matchCount: result.matchCount,
      fileCount: result.fileCount,
      truncated: result.truncated,
      dirtyBuffersOmitted: result.dirtyBuffersOmitted,
      limit: result.limit,
    })
    return true
  }

  cancel(intent: WorkspaceSearchIntent): boolean {
    if (!this.accepts(intent)) return false
    const current = this.session(intent.workspaceId)
    this.replaceWorkspace(intent.workspaceId, {
      ...withoutError(current), status: 'cancelled', items: [], selectedIndex: -1, matchCount: 0, fileCount: 0,
      truncated: false, dirtyBuffersOmitted: false,
    })
    return true
  }

  fail(intent: WorkspaceSearchIntent, error: string): boolean {
    if (!this.accepts(intent)) return false
    const current = this.session(intent.workspaceId)
    this.replaceWorkspace(intent.workspaceId, {
      ...current, status: 'error', items: [], selectedIndex: -1, matchCount: 0, fileCount: 0,
      truncated: false, dirtyBuffersOmitted: false, error,
    })
    return true
  }

  moveSelection(delta: number, workspaceId = this.snapshot.activeWorkspaceId): WorkspaceSearchItem | undefined {
    if (workspaceId === undefined || !Number.isFinite(delta)) return undefined
    const current = this.session(workspaceId)
    if (current.items.length === 0) return undefined
    const index = current.selectedIndex < 0 ? 0 : current.selectedIndex
    const selectedIndex = ((index + Math.trunc(delta)) % current.items.length + current.items.length) % current.items.length
    if (selectedIndex !== current.selectedIndex) this.replaceWorkspace(workspaceId, { ...current, selectedIndex })
    return current.items[selectedIndex]
  }

  selectIndex(index: number, workspaceId = this.snapshot.activeWorkspaceId): WorkspaceSearchItem | undefined {
    if (workspaceId === undefined || !Number.isSafeInteger(index)) return undefined
    const current = this.session(workspaceId)
    if (index < 0 || index >= current.items.length) return undefined
    if (index !== current.selectedIndex) this.replaceWorkspace(workspaceId, { ...current, selectedIndex: index })
    return current.items[index]
  }

  private accepts(intent: WorkspaceSearchIntent): boolean {
    return this.snapshot.activeWorkspaceId === intent.workspaceId
      && this.snapshot.activeWorkspaceEpoch === intent.workspaceEpoch
      && this.session(intent.workspaceId).requestGeneration === intent.requestGeneration
  }

  private replaceWorkspace(workspaceId: string, session: WorkspaceSearchSession): void {
    const workspaces = new Map(this.snapshot.workspaces)
    workspaces.set(workspaceId, session)
    this.publish({ ...this.snapshot, workspaces })
  }

  private publish(snapshot: WorkspaceSearchSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

export interface WorkspaceSearchResult {
  readonly items: readonly WorkspaceSearchItem[]
  readonly matchCount: number
  readonly fileCount: number
  readonly truncated: boolean
  readonly dirtyBuffersOmitted: boolean
  readonly limit: number
}

function itemOrder(left: WorkspaceSearchItem, right: WorkspaceSearchItem): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1
    : left.lineNumber - right.lineNumber || (left.ranges[0]?.start ?? 0) - (right.ranges[0]?.start ?? 0)
}

function dirtyTabs(snapshot: DocumentSessionsSnapshot, workspaceId: string): readonly EditorTab[] {
  return (snapshot.workspaces.get(workspaceId)?.tabs ?? []).filter(tab => tab.dirty)
}

function dirtySignature(snapshot: DocumentSessionsSnapshot, workspaceId: string): string {
  return dirtyTabs(snapshot, workspaceId)
    .map(tab => `${tab.path}\0${String(tab.lifecycleId)}\0${String(tab.localRevision)}`)
    .sort().join('\x01')
}

function dirtyPaths(snapshot: DocumentSessionsSnapshot, workspaceId: string): Set<string> {
  return new Set(dirtyTabs(snapshot, workspaceId).map(tab => tab.path))
}

const MAX_DIRTY_SCAN_CODE_UNITS = 4 * 1024 * 1024

/**
 * Disk hits for dirty paths are never authoritative: replace them with matches
 * from the current editor bytes and retain the Host's global bound.
 */
export function overlayDirtyBufferMatches(
  response: SearchTextResponse,
  query: WorkspaceTextSearchQuery,
  tabs: readonly EditorTab[],
): WorkspaceSearchResult {
  const dirty = new Map(tabs.filter(tab => tab.dirty).map(tab => [tab.path, tab]))
  // Native JS regex and glob execution are synchronous and not abortable.
  // Keep the browser event loop responsive: only the bounded literal/no-glob
  // subset is overlaid until dirty matching moves to a killable Worker.
  let dirtyBuffersOmitted = dirty.size > 0 && (query.mode === 'regex'
    || (query.include?.length ?? 0) > 0 || (query.exclude?.length ?? 0) > 0)
  const candidates: WorkspaceSearchItem[] = response.items
    .filter(item => !dirty.has(item.path))
    .map(item => ({ ...item, ranges: item.ranges.map(range => ({ ...range })), source: 'disk' as const }))
  if (!dirtyBuffersOmitted) {
    let scannedCodeUnits = 0
    let localProbeRemaining = response.limit === Number.MAX_SAFE_INTEGER ? response.limit : response.limit + 1
    for (const tab of [...dirty.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      if (localProbeRemaining <= 0 || scannedCodeUnits + tab.content.length > MAX_DIRTY_SCAN_CODE_UNITS) {
        dirtyBuffersOmitted = true
        continue
      }
      scannedCodeUnits += tab.content.length
      const localItems = searchTextContent(tab.path, tab.content, query, { maxMatches: localProbeRemaining })
      for (const item of localItems) {
        candidates.push({
          ...item,
          source: 'buffer',
          bufferLifecycleId: tab.lifecycleId,
          bufferRevision: tab.localRevision,
        })
        localProbeRemaining -= item.ranges.length
      }
    }
  }
  candidates.sort(itemOrder)

  const items: WorkspaceSearchItem[] = []
  let matchCount = 0
  let omitted = false
  for (const item of candidates) {
    const room = response.limit - matchCount
    if (room <= 0) { omitted = true; break }
    const ranges = item.ranges.slice(0, room)
    if (ranges.length < item.ranges.length) omitted = true
    if (ranges.length > 0) {
      items.push({ ...item, ranges })
      matchCount += ranges.length
    }
  }
  return {
    items,
    matchCount,
    fileCount: new Set(items.map(item => item.path)).size,
    truncated: response.incomplete || omitted || dirtyBuffersOmitted,
    dirtyBuffersOmitted,
    limit: response.limit,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WorkspaceSearchController {
  private active: {
    intent: WorkspaceSearchIntent
    request: AbortController
    observedDirtyPaths: Set<string>
    diskInvalidated: boolean
  } | undefined
  private cached: { intent: WorkspaceSearchIntent; response: SearchTextResponse } | undefined
  private stopBuffers: (() => void) | undefined
  private lastDirtySignature = ''
  private lastDirtyPaths = new Set<string>()
  private disposed = false

  constructor(
    readonly store: WorkspaceSearchStore,
    private readonly search: SearchTextPort,
    private readonly buffers: SearchBufferSource,
  ) {}

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.disposed) return
    this.startBufferObservation()
    this.abortActive(true)
    this.cached = undefined
    this.store.selectWorkspace(workspaceId)
    this.lastDirtySignature = workspaceId === undefined ? '' : dirtySignature(this.buffers.getSnapshot(), workspaceId)
    this.lastDirtyPaths = workspaceId === undefined ? new Set() : dirtyPaths(this.buffers.getSnapshot(), workspaceId)
    if (workspaceId !== undefined) {
      const session = this.store.session(workspaceId)
      if ((session.status === 'complete' || session.status === 'empty') && session.query.pattern.length > 0) {
        // Results are only reusable while their Host response remains cached;
        // switching workspaces drops that response, so revalidate on return
        // before dirty-buffer overlays can become stale.
        void this.run(session.query)
      }
    }
  }

  async run(query: WorkspaceTextSearchQuery): Promise<void> {
    if (this.disposed) return
    this.startBufferObservation()
    this.abortActive(true)
    this.cached = undefined
    const intent = this.store.begin(query)
    if (intent === undefined) return
    const startedDirtyPaths = dirtyPaths(this.buffers.getSnapshot(), intent.workspaceId)
    const request = new AbortController()
    this.active = {
      intent,
      request,
      observedDirtyPaths: new Set(startedDirtyPaths),
      diskInvalidated: false,
    }
    try {
      const response = await this.search.searchText(intent.workspaceId, intent.query, request.signal)
      if (this.disposed || request.signal.aborted) return
      const bufferSnapshot = this.buffers.getSnapshot()
      const currentDirtyPaths = dirtyPaths(bufferSnapshot, intent.workspaceId)
      if (this.active?.request === request && (this.active.diskInvalidated
        || [...startedDirtyPaths].some(path => !currentDirtyPaths.has(path)))) {
        // A save made a formerly dirty path disk-authoritative while this Host
        // query was in flight, so its disk snapshot may predate that save.
        if (this.active?.request === request) this.active = undefined
        await this.run(intent.query)
        return
      }
      const result = overlayDirtyBufferMatches(
        response, intent.query, dirtyTabs(bufferSnapshot, intent.workspaceId),
      )
      if (this.store.complete(intent, result)) {
        this.cached = { intent, response }
        const snapshot = this.buffers.getSnapshot()
        this.lastDirtySignature = dirtySignature(snapshot, intent.workspaceId)
        this.lastDirtyPaths = dirtyPaths(snapshot, intent.workspaceId)
      }
    } catch (error) {
      if (!this.disposed && !request.signal.aborted) this.store.fail(intent, errorMessage(error))
    } finally {
      if (this.active?.request === request) this.active = undefined
    }
  }

  cancel(): void {
    if (this.disposed) return
    this.abortActive(true)
    this.cached = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortActive(false)
    this.cached = undefined
    this.stopBuffers?.()
    this.stopBuffers = undefined
  }

  private startBufferObservation(): void {
    this.stopBuffers ??= this.buffers.subscribe(() => { this.onBuffersChanged() })
  }

  private abortActive(markCancelled: boolean): void {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    active.request.abort()
    if (markCancelled) this.store.cancel(active.intent)
  }

  private onBuffersChanged(): void {
    if (this.disposed) return
    const cached = this.cached
    try {
      const snapshot = this.buffers.getSnapshot()
      const active = this.active
      if (active !== undefined) {
        const current = dirtyPaths(snapshot, active.intent.workspaceId)
        if ([...active.observedDirtyPaths].some(path => !current.has(path))) active.diskInvalidated = true
        for (const path of current) active.observedDirtyPaths.add(path)
      }
      if (cached === undefined) return
      const signature = dirtySignature(snapshot, cached.intent.workspaceId)
      if (signature === this.lastDirtySignature) return
      this.lastDirtySignature = signature
      const paths = dirtyPaths(snapshot, cached.intent.workspaceId)
      const becameClean = [...this.lastDirtyPaths].some(path => !paths.has(path))
      this.lastDirtyPaths = paths
      if (becameClean) {
        // The cached Host response predates the successful save/close. A fresh
        // generation is required before disk hits for that path are authoritative.
        this.cached = undefined
        void this.run(cached.intent.query)
        return
      }
      const result = overlayDirtyBufferMatches(
        cached.response, cached.intent.query, dirtyTabs(snapshot, cached.intent.workspaceId),
      )
      this.store.refresh(cached.intent, result)
    } catch (error) {
      this.cached = undefined
      if (cached !== undefined) this.store.fail(cached.intent, errorMessage(error))
    }
  }
}
