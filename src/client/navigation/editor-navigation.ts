import type { DocumentController } from '../documents/controller.ts'
import type { DocumentIdentity, EditorTab } from '../documents/session.ts'
import type { TextSearchItem } from '../../shared/workspace-search.ts'

export const EDITOR_NAVIGATION_HISTORY_LIMIT = 100

export interface EditorRevealIdentity {
  readonly workspaceId: string
  readonly path: string
  readonly lifecycleId: number
  readonly historyEpoch: number
  readonly localRevision: number
}

export interface EditorRevealRequest extends EditorRevealIdentity {
  readonly requestId: number
  readonly navigationGeneration: number
  readonly workspaceEpoch: number
  readonly from: number
  readonly to: number
  readonly lineNumber: number
}

export interface EditorLocation {
  readonly lineNumber: number
  readonly columnNumber: number
}

export interface EditorCursorIdentity extends EditorRevealIdentity {
  readonly workspaceEpoch: number
}

export interface EditorNavigationHistoryAvailability {
  readonly back: number
  readonly forward: number
}

/** Stable external-store projection; entries remain private to the controller. */
export interface EditorNavigationHistorySnapshot {
  readonly revision: number
  readonly workspaces: ReadonlyMap<string, EditorNavigationHistoryAvailability>
}

export type EditorNavigationResult = 'revealed' | 'stale' | 'failed' | 'invalid'

type Listener = () => void

interface NavigationHistoryEntry extends EditorLocation {
  readonly path: string
}

interface ObservedEditorLocation {
  readonly identity: EditorCursorIdentity
  readonly entry: NavigationHistoryEntry
}

interface WorkspaceNavigationHistory {
  readonly back: NavigationHistoryEntry[]
  readonly forward: NavigationHistoryEntry[]
}

function basename(path: string): string {
  const offset = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  return path.slice(offset)
}

/** Parse VS Code-style one-based line and optional UTF-16 column input. */
export function parseEditorLocation(raw: string): EditorLocation | undefined {
  const match = /^:?(\d+)(?::(\d+))?$/u.exec(raw.trim())
  if (match === null) return undefined
  const lineNumber = Number(match[1])
  const columnNumber = match[2] === undefined ? 1 : Number(match[2])
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1
    || !Number.isSafeInteger(columnNumber) || columnNumber < 1) return undefined
  return { lineNumber, columnNumber }
}

function lineAt(content: string, lineNumber: number): { from: number; text: string } | undefined {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined
  let from = 0
  for (let current = 1; current < lineNumber; current += 1) {
    const lf = content.indexOf('\n', from)
    if (lf < 0) return undefined
    from = lf + 1
  }
  const lf = content.indexOf('\n', from)
  let to = lf < 0 ? content.length : lf
  if (to > from && content.charCodeAt(to - 1) === 13) to -= 1
  return { from, text: content.slice(from, to) }
}

function locationAtOffset(content: string, rawOffset: number): EditorLocation {
  const offset = Math.min(content.length, Math.max(0, rawOffset))
  let lineNumber = 1
  let lineFrom = 0
  for (;;) {
    const lf = content.indexOf('\n', lineFrom)
    if (lf < 0 || lf >= offset) break
    lineNumber += 1
    lineFrom = lf + 1
  }
  return { lineNumber, columnNumber: offset - lineFrom + 1 }
}

function sameLocation(left: NavigationHistoryEntry, right: NavigationHistoryEntry): boolean {
  return left.path === right.path && left.lineNumber === right.lineNumber
    && left.columnNumber === right.columnNumber
}

function frozenHistorySnapshot(
  revision: number,
  histories: ReadonlyMap<string, WorkspaceNavigationHistory>,
): EditorNavigationHistorySnapshot {
  const workspaces = new Map<string, EditorNavigationHistoryAvailability>()
  for (const [workspaceId, history] of histories) {
    if (history.back.length > 0 || history.forward.length > 0) {
      workspaces.set(workspaceId, Object.freeze({
        back: history.back.length,
        forward: history.forward.length,
      }))
    }
  }
  return Object.freeze({ revision, workspaces })
}

function firstRange(match: TextSearchItem): { start: number; end: number } | undefined {
  const range = match.ranges[0]
  if (range === undefined || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start) return undefined
  return range
}

function locationFor(tab: EditorTab, match: TextSearchItem): { from: number; to: number } | undefined {
  const line = lineAt(tab.content, match.lineNumber)
  const range = firstRange(match)
  if (line === undefined || range === undefined || range.end > line.text.length) return undefined
  const previewStart = Math.max(0, Math.min(line.text.length, match.previewStart))
  if (!Number.isSafeInteger(match.previewStart) || match.previewStart < 0
    || line.text.slice(previewStart, previewStart + match.preview.length) !== match.preview) return undefined
  const previewEnd = previewStart + match.preview.length
  if (range.start < previewStart || range.end > previewEnd) return undefined
  return {
    from: line.from + range.start,
    to: line.from + range.end,
  }
}

/**
 * Opens through DocumentController, then publishes a reveal intent tied to the
 * exact in-memory buffer generation. Consumers must present the same identity.
 */
export class EditorNavigationController {
  private requestSequence = 0
  private navigationGeneration = 0
  private historyRevision = 0
  private desired: {
    generation: number
    workspaceId: string
    workspaceEpoch?: number
    path: string
    fallbackPath?: string
    fallbackLifecycleId?: number
  } | undefined
  private revealRequest: EditorRevealRequest | undefined
  private readonly histories = new Map<string, WorkspaceNavigationHistory>()
  private readonly observedLocations = new Map<string, ObservedEditorLocation>()
  private historySnapshot: EditorNavigationHistorySnapshot = frozenHistorySnapshot(0, this.histories)
  private readonly listeners = new Set<Listener>()

  constructor(private readonly documents: DocumentController) {}

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getRevealRequest = (): EditorRevealRequest | undefined => this.revealRequest

  readonly getHistorySnapshot = (): EditorNavigationHistorySnapshot => this.historySnapshot

  /** Accept a cursor report only for the exact active in-memory editor generation. */
  observeActiveLocation(identity: EditorCursorIdentity, location: EditorLocation): boolean {
    if (!Number.isSafeInteger(location.lineNumber) || location.lineNumber < 1
      || !Number.isSafeInteger(location.columnNumber) || location.columnNumber < 1
      || !this.documents.store.isWorkspaceEpoch(identity.workspaceId, identity.workspaceEpoch)) return false
    const session = this.documents.store.session(identity.workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === identity.path)
    const line = lineAt(tab?.content ?? '', location.lineNumber)
    if (session.activePath !== identity.path || tab === undefined
      || tab.lifecycleId !== identity.lifecycleId || tab.historyEpoch !== identity.historyEpoch
      || tab.localRevision !== identity.localRevision || tab.readOnlyPresentation !== undefined
      || line === undefined || location.columnNumber > line.text.length + 1) return false
    const entry = Object.freeze({ path: identity.path, ...location })
    const current = this.observedLocations.get(identity.workspaceId)
    if (current !== undefined && current.identity.workspaceEpoch === identity.workspaceEpoch
      && current.identity.path === identity.path && current.identity.lifecycleId === identity.lifecycleId
      && current.identity.historyEpoch === identity.historyEpoch
      && current.identity.localRevision === identity.localRevision
      && sameLocation(current.entry, entry)) return true
    this.observedLocations.set(identity.workspaceId, {
      identity: Object.freeze({ ...identity }),
      entry,
    })
    return true
  }

  /** Synchronous tab activation participates in history and invalidates pending traversal. */
  activateOpenDocument(identity: DocumentIdentity): boolean {
    const inspected = this.documents.store.inspect(identity)
    if (inspected === undefined) return false
    const alreadyActive = this.documents.store.session(identity.workspaceId).activePath === identity.path
    const origin = this.captureCurrentLocation(identity.workspaceId)
    this.beginNavigation(identity.workspaceId, identity.path)
    if (!this.documents.store.activateDocument(identity.workspaceId, identity.path)) return false
    const snapshot = this.documents.store.getSnapshot()
    const session = this.documents.store.session(identity.workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === identity.path)
    if (snapshot.activeWorkspaceId !== identity.workspaceId
      || snapshot.activeWorkspaceEpoch !== identity.workspaceEpoch
      || session.activePath !== identity.path || tab === undefined
      || tab.lifecycleId !== identity.lifecycleId) return false
    if (alreadyActive) return true
    const target = this.defaultEntry(tab)
    this.commitOrdinaryNavigation(identity.workspaceId, origin?.entry, target)
    this.observeTab(snapshot.activeWorkspaceEpoch, identity.workspaceId, tab, target)
    return true
  }

  async openPath(workspaceId: string, path: string): Promise<boolean> {
    const alreadyActive = this.documents.store.session(workspaceId).activePath === path
    const origin = this.captureCurrentLocation(workspaceId)
    const generation = this.beginNavigation(workspaceId, path)
    if (alreadyActive) return true
    let opened: boolean
    try {
      opened = await this.documents.open(workspaceId, path, basename(path))
    } catch (error) {
      if (generation !== this.navigationGeneration) {
        this.restoreLatestAfterStale()
        return false
      }
      throw error
    }
    if (generation !== this.navigationGeneration) {
      this.restoreLatestAfterStale()
      return false
    }
    if (!opened) return false
    const snapshot = this.documents.store.getSnapshot()
    const session = this.documents.store.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === path)
    if (snapshot.activeWorkspaceId !== workspaceId || session.activePath !== path || tab === undefined) return false
    const target = this.defaultEntry(tab)
    this.commitOrdinaryNavigation(workspaceId, origin?.entry, target)
    this.observeTab(snapshot.activeWorkspaceEpoch, workspaceId, tab, target)
    return true
  }

  /** Open a file and publish a caret reveal under the same navigation generation. */
  async openPathAtLocation(
    workspaceId: string,
    path: string,
    location: EditorLocation,
    acceptCompletion?: () => boolean,
  ): Promise<EditorNavigationResult> {
    if (!Number.isSafeInteger(location.lineNumber) || location.lineNumber < 1
      || !Number.isSafeInteger(location.columnNumber) || location.columnNumber < 1) return 'invalid'
    const before = this.documents.store.getSnapshot()
    if (before.activeWorkspaceId !== workspaceId) return 'stale'
    const origin = this.captureCurrentLocation(workspaceId)
    const workspaceEpoch = before.activeWorkspaceEpoch
    const generation = this.beginNavigation(workspaceId, path)
    const accepted = (): boolean => acceptCompletion === undefined || acceptCompletion()
    const current = (): boolean => generation === this.navigationGeneration && accepted()
      && this.pendingFallbackIsCurrent(generation)
    let opened: boolean
    try {
      opened = await this.documents.open(workspaceId, path, basename(path), current)
    } catch (error) {
      if (generation !== this.navigationGeneration) {
        this.restoreLatestAfterStale()
        return 'stale'
      }
      if (!accepted()) {
        this.restoreFallbackAfterInvalidation(generation)
        return 'stale'
      }
      throw error
    }
    if (generation !== this.navigationGeneration) {
      this.restoreLatestAfterStale()
      return 'stale'
    }
    if (!accepted()) {
      this.restoreFallbackAfterInvalidation(generation)
      return 'stale'
    }
    if (!opened) return 'stale'

    const snapshot = this.documents.store.getSnapshot()
    if (snapshot.activeWorkspaceId !== workspaceId
      || snapshot.activeWorkspaceEpoch !== workspaceEpoch) return 'stale'
    const session = this.documents.store.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === path)
    if (tab === undefined || session.activePath !== path) return 'failed'
    if (tab.readOnlyPresentation !== undefined) {
      this.restoreNavigationSource(generation, origin)
      return 'invalid'
    }
    const line = lineAt(tab.content, location.lineNumber)
    if (line === undefined) {
      this.restoreNavigationSource(generation, origin)
      return 'invalid'
    }
    const offset = line.from + Math.min(line.text.length, location.columnNumber - 1)
    this.revealRequest = {
      requestId: ++this.requestSequence,
      navigationGeneration: generation,
      workspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
      localRevision: tab.localRevision,
      lineNumber: location.lineNumber,
      from: offset,
      to: offset,
    }
    const target = Object.freeze({
      path: tab.path,
      ...locationAtOffset(tab.content, offset),
    })
    this.commitOrdinaryNavigation(workspaceId, origin?.entry, target)
    this.observeTab(snapshot.activeWorkspaceEpoch, workspaceId, tab, target)
    for (const listener of this.listeners) listener()
    return 'revealed'
  }

  async openSearchMatch(
    workspaceId: string,
    match: TextSearchItem,
    acceptCompletion?: () => boolean,
  ): Promise<EditorNavigationResult> {
    const origin = this.captureCurrentLocation(workspaceId)
    const generation = this.beginNavigation(workspaceId, match.path)
    const accepted = (): boolean => acceptCompletion === undefined || acceptCompletion()
    const pending = (): boolean => generation === this.navigationGeneration && accepted()
      && this.pendingFallbackIsCurrent(generation)
    let opened: boolean
    try {
      opened = await this.documents.open(workspaceId, match.path, basename(match.path), pending)
    } catch (error) {
      if (generation !== this.navigationGeneration) return 'stale'
      if (!accepted()) {
        this.restoreNavigationSource(generation, origin)
        return 'stale'
      }
      throw error
    }
    if (generation !== this.navigationGeneration) return 'stale'
    if (!accepted()) {
      this.restoreNavigationSource(generation, origin)
      return 'stale'
    }
    if (!opened) return 'stale'
    const snapshot = this.documents.store.getSnapshot()
    if (snapshot.activeWorkspaceId !== workspaceId) return 'stale'
    const session = this.documents.store.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === match.path)
    if (tab === undefined || session.activePath !== match.path) return 'failed'
    const location = locationFor(tab, match)
    if (location === undefined) {
      this.restoreNavigationSource(generation, origin)
      return 'stale'
    }
    this.revealRequest = {
      requestId: ++this.requestSequence,
      navigationGeneration: generation,
      workspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
      localRevision: tab.localRevision,
      lineNumber: match.lineNumber,
      ...location,
    }
    const target = Object.freeze({
      path: tab.path,
      ...locationAtOffset(tab.content, location.to),
    })
    this.commitOrdinaryNavigation(workspaceId, origin?.entry, target)
    this.observeTab(snapshot.activeWorkspaceEpoch, workspaceId, tab, target)
    for (const listener of this.listeners) listener()
    return 'revealed'
  }

  /** Publish a caret reveal against only the exact current in-memory active editor. */
  revealActiveLocation(location: EditorLocation): EditorNavigationResult {
    if (!Number.isSafeInteger(location.lineNumber) || location.lineNumber < 1
      || !Number.isSafeInteger(location.columnNumber) || location.columnNumber < 1) return 'invalid'
    const before = this.documents.store.getSnapshot()
    if (before.activeWorkspaceId === undefined) return 'stale'
    const beforeSession = this.documents.store.session(before.activeWorkspaceId)
    const beforeTab = beforeSession.tabs.find(tab => tab.path === beforeSession.activePath)
    if (beforeTab === undefined) return 'stale'
    if (beforeTab.readOnlyPresentation !== undefined) return 'invalid'
    if (lineAt(beforeTab.content, location.lineNumber) === undefined) return 'invalid'

    const origin = this.captureCurrentLocation(before.activeWorkspaceId)
    const generation = this.beginNavigation(before.activeWorkspaceId, beforeTab.path)
    const snapshot = this.documents.store.getSnapshot()
    const workspaceId = snapshot.activeWorkspaceId
    if (workspaceId !== before.activeWorkspaceId) return 'stale'
    const session = this.documents.store.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === session.activePath)
    if (tab === undefined || tab.path !== beforeTab.path || tab.lifecycleId !== beforeTab.lifecycleId
      || tab.historyEpoch !== beforeTab.historyEpoch || tab.localRevision !== beforeTab.localRevision) return 'stale'
    if (tab.readOnlyPresentation !== undefined) return 'invalid'
    const line = lineAt(tab.content, location.lineNumber)
    if (line === undefined) return 'invalid'
    const offset = line.from + Math.min(line.text.length, location.columnNumber - 1)
    this.revealRequest = {
      requestId: ++this.requestSequence,
      navigationGeneration: generation,
      workspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
      localRevision: tab.localRevision,
      lineNumber: location.lineNumber,
      from: offset,
      to: offset,
    }
    const target = Object.freeze({
      path: tab.path,
      ...locationAtOffset(tab.content, offset),
    })
    this.commitOrdinaryNavigation(workspaceId, origin?.entry, target)
    this.observeTab(snapshot.activeWorkspaceEpoch, workspaceId, tab, target)
    for (const listener of this.listeners) listener()
    return 'revealed'
  }

  navigateBack(): Promise<EditorNavigationResult> {
    return this.traverseHistory('back')
  }

  navigateForward(): Promise<EditorNavigationResult> {
    return this.traverseHistory('forward')
  }

  /** Returns the pending request only to the exact editor generation. */
  revealFor(identity: EditorRevealIdentity): EditorRevealRequest | undefined {
    const request = this.revealRequest
    const session = this.documents.store.session(identity.workspaceId)
    const live = session.tabs.find(tab => tab.path === identity.path)
    if (request === undefined || request.workspaceId !== identity.workspaceId || request.path !== identity.path
      || request.lifecycleId !== identity.lifecycleId || request.historyEpoch !== identity.historyEpoch
      || request.localRevision !== identity.localRevision
      || session.activePath !== identity.path || live === undefined
      || live.lifecycleId !== identity.lifecycleId || live.historyEpoch !== identity.historyEpoch
      || live.localRevision !== identity.localRevision
      || !this.documents.store.isWorkspaceEpoch(identity.workspaceId, request.workspaceEpoch)) return undefined
    return request
  }

  acknowledge(requestId: number): boolean {
    if (this.revealRequest?.requestId !== requestId) return false
    this.revealRequest = undefined
    for (const listener of this.listeners) listener()
    return true
  }

  private async traverseHistory(direction: 'back' | 'forward'): Promise<EditorNavigationResult> {
    const before = this.documents.store.getSnapshot()
    const workspaceId = before.activeWorkspaceId
    if (workspaceId === undefined) return 'stale'
    const history = this.histories.get(workspaceId)
    const source = direction === 'back' ? history?.back : history?.forward
    const destination = direction === 'back' ? history?.forward : history?.back
    const target = source?.at(-1)
    const origin = this.captureCurrentLocation(workspaceId)
    if (history === undefined || source === undefined || destination === undefined
      || target === undefined || origin === undefined || sameLocation(origin.entry, target)) return 'stale'

    const generation = this.beginNavigation(workspaceId, target.path)
    const pending = (): boolean => generation === this.navigationGeneration
      && this.pendingFallbackIsCurrent(generation) && this.isObservedCurrent(origin)
    let opened: boolean
    try {
      opened = await this.documents.open(workspaceId, target.path, basename(target.path), pending)
    } catch {
      if (generation !== this.navigationGeneration) return 'stale'
      if (!pending()) return 'stale'
      this.restoreNavigationSource(generation, origin)
      return 'failed'
    }
    if (generation !== this.navigationGeneration) return 'stale'
    if (!opened) {
      if (!pending()) return 'stale'
      this.restoreNavigationSource(generation, origin)
      return 'failed'
    }

    const snapshot = this.documents.store.getSnapshot()
    const session = this.documents.store.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === target.path)
    if (snapshot.activeWorkspaceId !== workspaceId
      || snapshot.activeWorkspaceEpoch !== before.activeWorkspaceEpoch
      || session.activePath !== target.path || tab === undefined) {
      this.restoreObservedSource(generation, origin)
      return 'failed'
    }
    if (tab.readOnlyPresentation !== undefined) {
      this.restoreObservedSource(generation, origin)
      return 'invalid'
    }
    const line = lineAt(tab.content, target.lineNumber)
    if (line === undefined) {
      this.restoreObservedSource(generation, origin)
      return 'invalid'
    }
    const offset = line.from + Math.min(line.text.length, target.columnNumber - 1)
    const actualTarget = Object.freeze({ path: tab.path, ...locationAtOffset(tab.content, offset) })
    if (source.at(-1) !== target || generation !== this.navigationGeneration) {
      this.restoreObservedSource(generation, origin)
      return 'stale'
    }

    this.revealRequest = {
      requestId: ++this.requestSequence,
      navigationGeneration: generation,
      workspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
      localRevision: tab.localRevision,
      lineNumber: actualTarget.lineNumber,
      from: offset,
      to: offset,
    }
    source.pop()
    this.pushBounded(destination, origin.entry)
    this.observeTab(snapshot.activeWorkspaceEpoch, workspaceId, tab, actualTarget)
    this.publishHistory()
    for (const listener of this.listeners) listener()
    return 'revealed'
  }

  private workspaceHistory(workspaceId: string): WorkspaceNavigationHistory {
    let history = this.histories.get(workspaceId)
    if (history === undefined) {
      history = { back: [], forward: [] }
      this.histories.set(workspaceId, history)
    }
    return history
  }

  private pushBounded(entries: NavigationHistoryEntry[], entry: NavigationHistoryEntry): void {
    if (entries.at(-1) !== undefined && sameLocation(entries.at(-1)!, entry)) return
    entries.push(Object.freeze({ ...entry }))
    if (entries.length > EDITOR_NAVIGATION_HISTORY_LIMIT) {
      entries.splice(0, entries.length - EDITOR_NAVIGATION_HISTORY_LIMIT)
    }
  }

  private publishHistory(): void {
    this.historyRevision += 1
    this.historySnapshot = frozenHistorySnapshot(this.historyRevision, this.histories)
    for (const listener of this.listeners) listener()
  }

  private commitOrdinaryNavigation(
    workspaceId: string,
    origin: NavigationHistoryEntry | undefined,
    target: NavigationHistoryEntry,
  ): void {
    if (origin !== undefined && sameLocation(origin, target)) return
    const history = this.workspaceHistory(workspaceId)
    const previousBack = history.back.length
    const previousForward = history.forward.length
    if (origin !== undefined) this.pushBounded(history.back, origin)
    history.forward.length = 0
    if (history.back.length !== previousBack || previousForward > 0) this.publishHistory()
  }

  private captureCurrentLocation(workspaceId: string): ObservedEditorLocation | undefined {
    const observed = this.observedLocations.get(workspaceId)
    return observed !== undefined && this.isObservedCurrent(observed) ? observed : undefined
  }

  private isObservedCurrent(observed: ObservedEditorLocation): boolean {
    if (this.observedLocations.get(observed.identity.workspaceId) !== observed
      || !this.documents.store.isWorkspaceEpoch(
        observed.identity.workspaceId,
        observed.identity.workspaceEpoch,
      )) return false
    const session = this.documents.store.session(observed.identity.workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === observed.identity.path)
    return session.activePath === observed.identity.path && tab !== undefined
      && tab.lifecycleId === observed.identity.lifecycleId
      && tab.historyEpoch === observed.identity.historyEpoch
      && tab.localRevision === observed.identity.localRevision
  }

  private defaultEntry(tab: EditorTab): NavigationHistoryEntry {
    const viewState = tab.viewState
    const range = viewState?.ranges[viewState.mainIndex]
    return Object.freeze({
      path: tab.path,
      ...locationAtOffset(tab.content, range?.head ?? 0),
    })
  }

  private observeTab(
    workspaceEpoch: number,
    workspaceId: string,
    tab: EditorTab,
    entry: NavigationHistoryEntry,
  ): void {
    this.observedLocations.set(workspaceId, {
      identity: Object.freeze({
        workspaceId,
        workspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
        historyEpoch: tab.historyEpoch,
        localRevision: tab.localRevision,
      }),
      entry: Object.freeze({ ...entry }),
    })
  }

  /** Pending reads may complete only while their captured source lifecycle remains active. */
  private pendingFallbackIsCurrent(generation: number): boolean {
    const desired = this.desired
    if (desired === undefined || desired.generation !== generation
      || generation !== this.navigationGeneration || desired.workspaceEpoch === undefined
      || !this.documents.store.isWorkspaceEpoch(desired.workspaceId, desired.workspaceEpoch)) return false
    const session = this.documents.store.session(desired.workspaceId)
    if (desired.fallbackPath === undefined) return session.activePath === undefined
    return session.activePath === desired.fallbackPath && desired.fallbackLifecycleId !== undefined
      && session.tabs.some(tab => tab.path === desired.fallbackPath
        && tab.lifecycleId === desired.fallbackLifecycleId)
  }

  private restoreNavigationSource(
    generation: number,
    origin: ObservedEditorLocation | undefined,
  ): void {
    if (origin !== undefined && this.isObservedCurrent(origin)) return
    if (origin !== undefined && this.restoreObservedSource(generation, origin)) return
    this.restoreFallbackAfterInvalidation(generation)
  }

  /** Restore both the exact source lifecycle and caret without committing history. */
  private restoreObservedSource(generation: number, origin: ObservedEditorLocation): boolean {
    if (generation !== this.navigationGeneration
      || !this.documents.store.isWorkspaceEpoch(origin.identity.workspaceId, origin.identity.workspaceEpoch)) return false
    const session = this.documents.store.session(origin.identity.workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === origin.identity.path)
    if (tab === undefined || tab.lifecycleId !== origin.identity.lifecycleId
      || tab.historyEpoch !== origin.identity.historyEpoch
      || tab.localRevision !== origin.identity.localRevision
      || !this.documents.store.activateDocument(origin.identity.workspaceId, origin.identity.path)) return false
    const line = lineAt(tab.content, origin.entry.lineNumber)
    if (line === undefined || tab.readOnlyPresentation !== undefined) return true
    const offset = line.from + Math.min(line.text.length, origin.entry.columnNumber - 1)
    this.observedLocations.set(origin.identity.workspaceId, origin)
    this.revealRequest = {
      requestId: ++this.requestSequence,
      navigationGeneration: generation,
      workspaceId: origin.identity.workspaceId,
      workspaceEpoch: origin.identity.workspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
      localRevision: tab.localRevision,
      lineNumber: origin.entry.lineNumber,
      from: offset,
      to: offset,
    }
    for (const listener of this.listeners) listener()
    return true
  }

  private clearReveal(): void {
    if (this.revealRequest === undefined) return
    this.revealRequest = undefined
    for (const listener of this.listeners) listener()
  }

  private beginNavigation(workspaceId: string, path: string): number {
    this.clearReveal()
    const generation = ++this.navigationGeneration
    const snapshot = this.documents.store.getSnapshot()
    const session = this.documents.store.session(workspaceId)
    const fallbackPath = session.activePath
    const fallbackLifecycleId = session.tabs.find(tab => tab.path === fallbackPath)?.lifecycleId
    this.desired = {
      generation, workspaceId, path,
      ...(snapshot.activeWorkspaceId === workspaceId
        ? { workspaceEpoch: snapshot.activeWorkspaceEpoch }
        : {}),
      ...(fallbackPath === undefined ? {} : { fallbackPath }),
      ...(fallbackLifecycleId === undefined ? {} : { fallbackLifecycleId }),
    }
    return generation
  }

  private restoreLatestAfterStale(): void {
    const desired = this.desired
    // A stale read may race an independent Explorer/open request for the same
    // path. Without request ownership from DocumentController, closing that
    // clean tab here could discard the other user's open. Restore focus only;
    // an extra clean background tab is the safe failure mode.
    if (desired === undefined || desired.generation !== this.navigationGeneration) return
    if (desired.workspaceEpoch === undefined
      || !this.documents.store.isWorkspaceEpoch(desired.workspaceId, desired.workspaceEpoch)) return
    if (this.documents.store.activateDocument(desired.workspaceId, desired.path)) return
    if (desired.fallbackPath !== undefined && desired.fallbackLifecycleId !== undefined
      && this.documents.store.session(desired.workspaceId).tabs.some(tab => (
        tab.path === desired.fallbackPath && tab.lifecycleId === desired.fallbackLifecycleId
      ))) {
      this.documents.store.activateDocument(desired.workspaceId, desired.fallbackPath)
    }
  }

  private restoreFallbackAfterInvalidation(generation: number): void {
    const desired = this.desired
    if (desired === undefined || desired.generation !== generation
      || generation !== this.navigationGeneration || desired.fallbackPath === undefined
      || desired.fallbackLifecycleId === undefined || desired.workspaceEpoch === undefined
      || !this.documents.store.isWorkspaceEpoch(desired.workspaceId, desired.workspaceEpoch)
      || !this.documents.store.session(desired.workspaceId).tabs.some(tab => (
        tab.path === desired.fallbackPath && tab.lifecycleId === desired.fallbackLifecycleId
      ))) return
    this.documents.store.activateDocument(desired.workspaceId, desired.fallbackPath)
  }
}
