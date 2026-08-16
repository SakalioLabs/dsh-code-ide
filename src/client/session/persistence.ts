import type { ReadFileResponse } from '../contracts.ts'
import type {
  DocumentSessionsSnapshot,
  EditorViewSnapshot,
  RestoredDocument,
} from '../documents/session.ts'
import {
  CANONICAL_DOCUMENT_LINE_ENDING,
  normalizeEditableText,
  type DocumentLineEnding,
} from '../documents/text-content.ts'

export const WORKBENCH_SESSION_KEY = 'dsh-code-ide.workbench.v1'
export const WORKBENCH_SESSION_LOCK = 'dsh-code-ide.workbench.v1.writer'
export const WORKBENCH_SESSION_SCHEMA = 1
export const MAX_PERSISTED_WORKSPACES = 32
export const MAX_PERSISTED_TABS = 128
export const MAX_PERSISTED_DIRTY_CODE_UNITS = 2 * 1024 * 1024
export const MAX_PERSISTED_RAW_CODE_UNITS = 3 * 1024 * 1024

export interface PersistedTabV1 {
  path: string
  name: string
  dirty: boolean
  content?: string
  version?: string
  /** Optional so schema-1 snapshots written before EOL preservation remain readable. */
  eol?: DocumentLineEnding
  viewState?: EditorViewSnapshot
}

export interface PersistedWorkspaceV1 {
  workspaceId: string
  activePath?: string
  tabs: PersistedTabV1[]
}

export interface PersistedWorkbenchV1 {
  schema: 1
  writerId: string
  savedAt: number
  activeWorkspaceId?: string
  workspaces: PersistedWorkspaceV1[]
}

export type PersistenceLoadResult =
  | { kind: 'empty'; workbench?: undefined }
  | { kind: 'ready'; workbench: PersistedWorkbenchV1 }
  | { kind: 'invalid'; message: string; resettable: boolean; workbench?: undefined }
  | { kind: 'future'; message: string; resettable: true; workbench?: undefined }

export interface InvalidWorkbenchRecoveryExport {
  readonly raw: string
  readonly kind: 'invalid' | 'future' | 'valid'
}

export type InvalidWorkbenchRecoveryResetResult =
  | { readonly status: 'saved' }
  | {
      readonly status: 'valid'
      readonly raw: string
      readonly workbench: PersistedWorkbenchV1
      readonly message: string
    }
  | { readonly status: 'changed'; readonly message: string }

export type PersistenceStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saved'; savedAt: number }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; message: string }

export interface StoragePort {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TimeoutPort {
  set(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}

export interface ExclusiveLockPort {
  acquire(name: string): Promise<(() => void | Promise<void>) | undefined>
}

export interface SessionPersistenceOptions {
  storage?: StoragePort
  timeout?: TimeoutPort
  debounceMs?: number
  writerId?: string
  now?: () => number
  onStatus?: (status: PersistenceStatus) => void
  lock?: ExclusiveLockPort
}

function classifyStoredWorkbench(raw: string | null): PersistenceLoadResult {
  if (raw === null) return { kind: 'empty' }
  if (raw.length > MAX_PERSISTED_RAW_CODE_UNITS) {
    return {
      kind: 'invalid',
      message: 'Stored workbench recovery data exceeds its safety limit.',
      resettable: true,
    }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return {
      kind: 'invalid',
      message: 'Stored workbench recovery data is not valid JSON.',
      resettable: true,
    }
  }
  const schema = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).schema : undefined
  if (typeof schema === 'number' && schema > WORKBENCH_SESSION_SCHEMA) {
    return {
      kind: 'future',
      message: 'A newer dsh-code-ide session format is present; this version will not overwrite it.',
      resettable: true,
    }
  }
  try { return { kind: 'ready', workbench: decodeWorkbench(parsed) } } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
      resettable: true,
    }
  }
}

function defaultStorage(): StoragePort {
  // Accessing the localStorage property itself may throw in a locked-down
  // browser. Keep that access inside load()/flush() exception boundaries.
  return {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => { window.localStorage.setItem(key, value) },
  }
}

function defaultTimeout(): TimeoutPort {
  return {
    set: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clear: handle => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

function defaultLock(): ExclusiveLockPort | undefined {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return undefined
  return {
    acquire: async (name) => await new Promise<(() => Promise<void>) | undefined>((resolve) => {
      let settled = false
      let releaseGate: (() => void) | undefined
      const holding = new Promise<void>((release) => { releaseGate = release })
      const request = navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null) {
          settled = true
          resolve(undefined)
          return
        }
        settled = true
        let released = false
        resolve(async () => {
          if (!released) {
            released = true
            releaseGate?.()
          }
          // Resolving the callback's gate only schedules lock release. Waiting
          // for request completion proves the browser has actually released it.
          await request
        })
        await holding
      }).catch(() => {
        if (!settled) resolve(undefined)
      })
    }),
  }
}

function safePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
    && !/^[a-zA-Z]:/.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function safeWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function safeName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function persistedLineEnding(value: unknown): DocumentLineEnding | undefined {
  return value === '\n' || value === '\r\n' ? value : undefined
}

function decodeViewState(value: unknown): EditorViewSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.ranges) || record.ranges.length === 0 || record.ranges.length > 16
    || !Number.isSafeInteger(record.mainIndex) || (record.mainIndex as number) < 0
    || (record.mainIndex as number) >= record.ranges.length
    || !finiteNonNegative(record.scrollTop) || !finiteNonNegative(record.scrollLeft)) return undefined
  const ranges = record.ranges.map((range) => {
    if (typeof range !== 'object' || range === null) return undefined
    const candidate = range as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.anchor) || (candidate.anchor as number) < 0
      || !Number.isSafeInteger(candidate.head) || (candidate.head as number) < 0) return undefined
    return { anchor: candidate.anchor as number, head: candidate.head as number }
  })
  if (ranges.some(range => range === undefined)) return undefined
  return {
    ranges: ranges as { anchor: number; head: number }[],
    mainIndex: record.mainIndex as number,
    scrollTop: record.scrollTop,
    scrollLeft: record.scrollLeft,
    ...(Number.isSafeInteger(record.viewportAnchor) && (record.viewportAnchor as number) >= 0
      ? { viewportAnchor: record.viewportAnchor as number }
      : {}),
  }
}

function decodeWorkbench(value: unknown): PersistedWorkbenchV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Session value must be an object.')
  const record = value as Record<string, unknown>
  if (record.schema !== WORKBENCH_SESSION_SCHEMA) throw new Error('Unsupported session schema.')
  if (typeof record.writerId !== 'string' || !finiteNonNegative(record.savedAt) || !Array.isArray(record.workspaces)) {
    throw new Error('Session envelope is malformed.')
  }
  if (record.workspaces.length > MAX_PERSISTED_WORKSPACES) throw new Error('Session contains too many workspaces.')
  const workspaces: PersistedWorkspaceV1[] = []
  const seenWorkspaces = new Set<string>()
  let totalTabs = 0
  let dirtyCodeUnits = 0
  for (const rawWorkspace of record.workspaces) {
    if (typeof rawWorkspace !== 'object' || rawWorkspace === null) throw new Error('Workspace session is malformed.')
    const workspace = rawWorkspace as Record<string, unknown>
    if (!safeWorkspaceId(workspace.workspaceId) || seenWorkspaces.has(workspace.workspaceId) || !Array.isArray(workspace.tabs)) {
      throw new Error('Workspace session identity is invalid.')
    }
    seenWorkspaces.add(workspace.workspaceId)
    const tabs: PersistedTabV1[] = []
    const seenPaths = new Set<string>()
    for (const rawTab of workspace.tabs) {
      totalTabs += 1
      if (totalTabs > MAX_PERSISTED_TABS || typeof rawTab !== 'object' || rawTab === null) {
        throw new Error('Session contains too many or malformed tabs.')
      }
      const tab = rawTab as Record<string, unknown>
      if (!safePath(tab.path) || !safeName(tab.name) || typeof tab.dirty !== 'boolean' || seenPaths.has(tab.path)) {
        throw new Error('Tab session is invalid.')
      }
      seenPaths.add(tab.path)
      const viewState = decodeViewState(tab.viewState)
      if (tab.dirty) {
        if (typeof tab.content !== 'string' || typeof tab.version !== 'string' || tab.version.length === 0) {
          throw new Error('Dirty tab recovery data is incomplete.')
        }
        if (tab.eol !== undefined && persistedLineEnding(tab.eol) === undefined) {
          throw new Error('Dirty tab recovery EOL is invalid.')
        }
        dirtyCodeUnits += tab.content.length
        if (dirtyCodeUnits > MAX_PERSISTED_DIRTY_CODE_UNITS) throw new Error('Dirty recovery data exceeds its budget.')
        const normalized = normalizeEditableText(tab.content, persistedLineEnding(tab.eol))
        tabs.push({
          path: tab.path,
          name: tab.name,
          dirty: true,
          content: normalized.content,
          version: tab.version,
          eol: normalized.lineEnding,
          ...(viewState === undefined ? {} : { viewState }),
        })
      } else {
        tabs.push({
          path: tab.path,
          name: tab.name,
          dirty: false,
          ...(viewState === undefined ? {} : { viewState }),
        })
      }
    }
    const activePath = safePath(workspace.activePath) && seenPaths.has(workspace.activePath)
      ? workspace.activePath
      : undefined
    workspaces.push({
      workspaceId: workspace.workspaceId,
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
  }
  const activeWorkspaceId = safeWorkspaceId(record.activeWorkspaceId) && seenWorkspaces.has(record.activeWorkspaceId)
    ? record.activeWorkspaceId
    : undefined
  return {
    schema: WORKBENCH_SESSION_SCHEMA,
    writerId: record.writerId,
    savedAt: record.savedAt,
    workspaces,
    ...(activeWorkspaceId === undefined ? {} : { activeWorkspaceId }),
  }
}

function persistViewState(viewState: EditorViewSnapshot | undefined, documentLength: number): EditorViewSnapshot | undefined {
  if (viewState === undefined || viewState.ranges.length === 0 || viewState.ranges.length > 16) return undefined
  return {
    ranges: viewState.ranges.map(range => ({
      anchor: Math.min(documentLength, Math.max(0, Math.round(range.anchor))),
      head: Math.min(documentLength, Math.max(0, Math.round(range.head))),
    })),
    mainIndex: Math.min(viewState.ranges.length - 1, Math.max(0, Math.round(viewState.mainIndex))),
    scrollTop: Math.max(0, viewState.scrollTop),
    scrollLeft: Math.max(0, viewState.scrollLeft),
    ...(viewState.viewportAnchor === undefined ? {} : {
      viewportAnchor: Math.min(documentLength, Math.max(0, Math.round(viewState.viewportAnchor))),
    }),
  }
}

export function encodeWorkbench(
  snapshot: DocumentSessionsSnapshot,
  writerId: string,
  savedAt: number,
  retainedWorkspaces: readonly PersistedWorkspaceV1[] = [],
): string {
  const workspaces: PersistedWorkspaceV1[] = []
  let totalTabs = 0
  let dirtyCodeUnits = 0
  for (const [workspaceId, session] of snapshot.workspaces) {
    if (session.tabs.length === 0) continue
    if (workspaces.length >= MAX_PERSISTED_WORKSPACES) throw new Error('Too many workspaces are open for recovery.')
    const tabs = session.tabs.map((tab): PersistedTabV1 => {
      totalTabs += 1
      if (totalTabs > MAX_PERSISTED_TABS) throw new Error('Too many tabs are open for recovery.')
      const normalized = tab.readOnlyPresentation === undefined
        ? normalizeEditableText(tab.content, tab.lineEnding)
        : undefined
      const persistedContent = normalized?.content ?? tab.content
      const viewState = persistViewState(tab.viewState, persistedContent.length)
      if (!tab.dirty) return {
        path: tab.path,
        name: tab.name,
        dirty: false,
        ...(viewState === undefined ? {} : { viewState }),
      }
      dirtyCodeUnits += persistedContent.length
      if (dirtyCodeUnits > MAX_PERSISTED_DIRTY_CODE_UNITS) {
        throw new Error('Unsaved buffers exceed the 2 MiB recovery budget; nothing was truncated.')
      }
      return {
        path: tab.path,
        name: tab.name,
        dirty: true,
        content: persistedContent,
        version: tab.version,
        eol: normalized?.lineEnding ?? tab.lineEnding ?? CANONICAL_DOCUMENT_LINE_ENDING,
        ...(viewState === undefined ? {} : { viewState }),
      }
    })
    workspaces.push({
      workspaceId,
      tabs,
      ...(session.activePath === undefined ? {} : { activePath: session.activePath }),
    })
  }
  const currentIds = new Set(workspaces.map(workspace => workspace.workspaceId))
  for (const retained of retainedWorkspaces) {
    if (!currentIds.has(retained.workspaceId)) workspaces.push(retained)
  }
  const value: PersistedWorkbenchV1 = {
    schema: WORKBENCH_SESSION_SCHEMA,
    writerId,
    savedAt,
    workspaces,
    ...(snapshot.activeWorkspaceId === undefined ? {} : { activeWorkspaceId: snapshot.activeWorkspaceId }),
  }
  // Re-run the wire decoder so retained, not-currently-registered workspaces
  // are subject to the same aggregate tab and dirty-byte budgets.
  const raw = JSON.stringify(decodeWorkbench(value))
  if (raw.length > MAX_PERSISTED_RAW_CODE_UNITS) throw new Error('Workbench recovery snapshot exceeds its 3 MiB storage budget.')
  return raw
}

export class SessionPersistence {
  private readonly storage: StoragePort
  private readonly timeout: TimeoutPort
  private readonly debounceMs: number
  private readonly writerId: string
  private readonly now: () => number
  private readonly onStatus: (status: PersistenceStatus) => void
  private readonly lock: ExclusiveLockPort | undefined
  private formatWritable = true
  private invalidRecovery: InvalidWorkbenchRecoveryExport | undefined
  private releaseLock: (() => void | Promise<void>) | undefined
  private releasingLock: Promise<void> | undefined
  private lockGeneration = 0
  private acquiringLock: Promise<(() => void | Promise<void>) | undefined> | undefined
  private pending: { snapshot: DocumentSessionsSnapshot; retainedWorkspaces: readonly PersistedWorkspaceV1[] } | undefined
  private handle: unknown

  constructor(options: SessionPersistenceOptions = {}) {
    this.storage = options.storage ?? defaultStorage()
    this.timeout = options.timeout ?? defaultTimeout()
    this.debounceMs = options.debounceMs ?? 200
    this.writerId = options.writerId ?? globalThis.crypto?.randomUUID?.() ?? `writer-${Math.random().toString(36).slice(2)}`
    this.now = options.now ?? Date.now
    this.onStatus = options.onStatus ?? (() => {})
    this.lock = options.lock ?? defaultLock()
  }

  load(): PersistenceLoadResult {
    let raw: string | null
    try { raw = this.storage.getItem(WORKBENCH_SESSION_KEY) } catch (error) {
      this.formatWritable = false
      this.invalidRecovery = undefined
      const message = `Workbench recovery is unavailable: ${error instanceof Error ? error.message : String(error)}`
      return { kind: 'invalid', message, resettable: false }
    }
    const result = classifyStoredWorkbench(raw)
    if (result.kind === 'invalid' || result.kind === 'future') {
      this.formatWritable = false
      this.invalidRecovery = { raw: raw!, kind: result.kind }
    } else {
      this.formatWritable = true
      this.invalidRecovery = undefined
    }
    return result
  }

  async startExclusiveWriter(): Promise<boolean> {
    if (this.releaseLock !== undefined) return true
    const generation = ++this.lockGeneration
    if (this.lock === undefined) {
      this.onStatus({
        kind: 'disabled',
        message: 'This browser cannot provide an exclusive recovery lock; hot-exit recovery is disabled.',
      })
      return false
    }
    // React StrictMode deliberately runs setup -> cleanup -> setup. The second
    // setup must wait for a stale in-flight acquisition to release its lock,
    // then retry, instead of interpreting that transient owner as another tab.
    while (generation === this.lockGeneration) {
      if (this.releaseLock !== undefined) return true
      if (this.releasingLock !== undefined) {
        await this.releasingLock
        continue
      }
      if (this.acquiringLock !== undefined) {
        try { await this.acquiringLock } catch { /* the owning caller reports */ }
        continue
      }
      const attempt = this.lock.acquire(WORKBENCH_SESSION_LOCK)
      this.acquiringLock = attempt
      let release: (() => void | Promise<void>) | undefined
      try { release = await attempt } catch { release = undefined }
      if (this.acquiringLock === attempt) this.acquiringLock = undefined
      if (generation !== this.lockGeneration) {
        if (release !== undefined) await this.releaseAcquiredLock(release)
        return false
      }
      if (release === undefined) {
        this.onStatus({
          kind: 'disabled',
          message: 'Another IDE page owns workbench recovery. This page will not overwrite its unsaved buffers.',
        })
        return false
      }
      this.releaseLock = release
      this.onStatus({ kind: 'idle' })
      return true
    }
    return false
  }

  isFormatWritable(): boolean {
    return this.formatWritable
  }

  canRecoverInvalid(): boolean {
    return this.releaseLock !== undefined && this.invalidRecovery !== undefined
  }

  exportInvalidRaw(): InvalidWorkbenchRecoveryExport {
    this.requireWriterOwner()
    let raw: string | null
    try { raw = this.storage.getItem(WORKBENCH_SESSION_KEY) } catch (error) {
      this.formatWritable = false
      throw new Error(`Could not read the current workbench recovery value: ${error instanceof Error ? error.message : String(error)}`)
    }
    const result = classifyStoredWorkbench(raw)
    if (raw === null || result.kind === 'empty') {
      this.formatWritable = false
      this.invalidRecovery = undefined
      throw new Error('The stored workbench recovery value is no longer present. Nothing was exported or overwritten.')
    }
    const exported: InvalidWorkbenchRecoveryExport = {
      raw,
      kind: result.kind === 'ready' ? 'valid' : result.kind,
    }
    this.formatWritable = false
    this.invalidRecovery = exported
    return exported
  }

  resetInvalid(
    expectedRaw: string,
    snapshot: DocumentSessionsSnapshot,
    retainedWorkspaces: readonly PersistedWorkspaceV1[] = [],
  ): InvalidWorkbenchRecoveryResetResult {
    this.requireWriterOwner()
    let replacementRaw: string
    let savedAt: number
    try {
      savedAt = this.now()
      replacementRaw = encodeWorkbench(snapshot, this.writerId, savedAt, retainedWorkspaces)
    } catch (error) {
      this.formatWritable = false
      const message = error instanceof Error ? error.message : String(error)
      this.onStatus({ kind: 'error', message })
      throw new Error(`Could not prepare the current workbench snapshot; stored recovery was preserved: ${message}`)
    }
    let raw: string | null
    try { raw = this.storage.getItem(WORKBENCH_SESSION_KEY) } catch (error) {
      this.formatWritable = false
      throw new Error(`Could not re-read workbench recovery before reset: ${error instanceof Error ? error.message : String(error)}`)
    }
    const current = classifyStoredWorkbench(raw)
    if (current.kind === 'ready') {
      this.formatWritable = false
      this.invalidRecovery = { raw: raw!, kind: 'valid' }
      return {
        status: 'valid',
        raw: raw!,
        workbench: current.workbench,
        message: 'Workbench recovery became valid before reset. It was preserved and must be restored before writes resume.',
      }
    }
    if (raw === null || current.kind === 'empty' || raw !== expectedRaw) {
      this.formatWritable = false
      this.invalidRecovery = raw !== null && (current.kind === 'invalid' || current.kind === 'future')
        ? { raw, kind: current.kind }
        : undefined
      return {
        status: 'changed',
        message: 'Workbench recovery changed after export. Nothing was deleted; download and review the current value before trying again.',
      }
    }

    this.formatWritable = false
    this.invalidRecovery = { raw, kind: current.kind }
    try { this.storage.setItem(WORKBENCH_SESSION_KEY, replacementRaw) } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.onStatus({ kind: 'error', message })
      throw new Error(`Could not durably replace invalid workbench recovery; the original value was preserved and writes remain blocked: ${message}`)
    }
    this.formatWritable = true
    this.invalidRecovery = undefined
    if (this.handle !== undefined) this.timeout.clear(this.handle)
    this.handle = undefined
    this.pending = undefined
    this.onStatus({ kind: 'saved', savedAt })
    return { status: 'saved' }
  }

  resumeValidRecovery(expectedRaw: string): boolean {
    this.requireWriterOwner()
    let raw: string | null
    try { raw = this.storage.getItem(WORKBENCH_SESSION_KEY) } catch (error) {
      this.formatWritable = false
      throw new Error(`Could not re-read valid workbench recovery: ${error instanceof Error ? error.message : String(error)}`)
    }
    const current = classifyStoredWorkbench(raw)
    if (raw !== expectedRaw || current.kind !== 'ready') {
      this.formatWritable = false
      this.invalidRecovery = raw !== null && (current.kind === 'invalid' || current.kind === 'future')
        ? { raw, kind: current.kind }
        : undefined
      return false
    }
    this.formatWritable = true
    this.invalidRecovery = undefined
    if (this.handle !== undefined) this.timeout.clear(this.handle)
    this.handle = undefined
    this.pending = undefined
    this.onStatus({ kind: 'idle' })
    return true
  }

  private requireWriterOwner(): void {
    if (this.releaseLock === undefined) throw new Error('Only the current workbench recovery writer can perform this action.')
  }

  private releaseAcquiredLock(release: () => void | Promise<void>): Promise<void> {
    if (this.releasingLock !== undefined) return this.releasingLock
    let result: void | Promise<void>
    try { result = release() } catch { result = undefined }
    const task = Promise.resolve(result).catch(() => {})
    let wrapped!: Promise<void>
    wrapped = task.finally(() => {
      if (this.releasingLock === wrapped) this.releasingLock = undefined
    })
    this.releasingLock = wrapped
    return wrapped
  }

  schedule(snapshot: DocumentSessionsSnapshot, retainedWorkspaces: readonly PersistedWorkspaceV1[] = []): void {
    if (!this.formatWritable || this.releaseLock === undefined) return
    this.pending = { snapshot, retainedWorkspaces }
    if (this.handle !== undefined) this.timeout.clear(this.handle)
    this.onStatus({ kind: 'pending' })
    this.handle = this.timeout.set(() => {
      this.handle = undefined
      this.flush()
    }, this.debounceMs)
  }

  flush(): boolean {
    if (!this.formatWritable || this.releaseLock === undefined || this.pending === undefined) return false
    if (this.handle !== undefined) {
      this.timeout.clear(this.handle)
      this.handle = undefined
    }
    const pending = this.pending
    try {
      const savedAt = this.now()
      const raw = encodeWorkbench(pending.snapshot, this.writerId, savedAt, pending.retainedWorkspaces)
      this.storage.setItem(WORKBENCH_SESSION_KEY, raw)
      this.pending = undefined
      this.onStatus({ kind: 'saved', savedAt })
      return true
    } catch (error) {
      this.onStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  dispose(): void {
    this.lockGeneration += 1
    if (this.handle !== undefined) this.timeout.clear(this.handle)
    this.handle = undefined
    this.pending = undefined
    const release = this.releaseLock
    this.releaseLock = undefined
    if (release !== undefined) void this.releaseAcquiredLock(release)
  }
}

export async function hydratePersistedWorkspace(
  workspace: PersistedWorkspaceV1,
  read: (workspaceId: string, path: string) => Promise<ReadFileResponse>,
  concurrency = 4,
): Promise<{ documents: RestoredDocument[]; activePath?: string }> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('Hydration concurrency must be a positive integer.')
  const documents = new Array<RestoredDocument>(workspace.tabs.length)
  const activeIndex = workspace.activePath === undefined
    ? -1
    : workspace.tabs.findIndex(tab => tab.path === workspace.activePath)
  const pendingIndices = workspace.tabs.map((_tab, index) => index)
  if (activeIndex > 0) pendingIndices.unshift(...pendingIndices.splice(activeIndex, 1))
  let cursor = 0
  const hydrate = async (index: number): Promise<void> => {
    const tab = workspace.tabs[index]
    if (tab === undefined) return
    try {
      const result = await read(workspace.workspaceId, tab.path)
      if (!tab.dirty) {
        const normalized = result.readOnlyPresentation === undefined
          ? normalizeEditableText(result.content)
          : undefined
        documents[index] = {
          path: tab.path,
          name: tab.name,
          content: normalized?.content ?? result.content,
          ...(normalized === undefined ? {} : {
            baselineContent: normalized.content,
            baselineLineEnding: normalized.lineEnding,
            lineEnding: normalized.lineEnding,
          }),
          version: result.version,
          dirty: false,
          ...(result.readOnlyPresentation === undefined
            ? {}
            : { readOnlyPresentation: result.readOnlyPresentation }),
          ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
        }
        return
      }
      const persisted = normalizeEditableText(tab.content ?? '', tab.eol)
      const content = persisted.content
      if (result.readOnlyPresentation !== undefined) {
        documents[index] = {
          path: tab.path,
          name: tab.name,
          content,
          version: tab.version ?? result.version,
          lineEnding: persisted.lineEnding,
          dirty: true,
          externalState: 'modified',
          ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
        }
        return
      }
      const disk = normalizeEditableText(result.content)
      if (result.version === tab.version) {
        documents[index] = {
        path: tab.path,
        name: tab.name,
        content,
        baselineContent: disk.content,
        baselineLineEnding: disk.lineEnding,
        lineEnding: persisted.lineEnding,
        version: result.version,
        dirty: content !== disk.content || persisted.lineEnding !== disk.lineEnding,
        ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
      }
        return
      }
      documents[index] = {
        path: tab.path,
        name: tab.name,
        content,
        version: tab.version ?? result.version,
        lineEnding: persisted.lineEnding,
        dirty: true,
        externalState: 'modified',
        ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined
      if (tab.dirty) {
        const persisted = normalizeEditableText(tab.content ?? '', tab.eol)
        documents[index] = {
        path: tab.path,
        name: tab.name,
        content: persisted.content,
        version: tab.version ?? 'unobserved',
        lineEnding: persisted.lineEnding,
        dirty: true,
        externalState: code === 'NOT_FOUND' ? 'deleted' : 'modified',
        loadError: message,
        ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
      }
        return
      }
      documents[index] = {
        path: tab.path,
        name: tab.name,
        content: '',
        version: 'unobserved',
        dirty: false,
        ...(code === 'NOT_FOUND' ? { externalState: 'deleted' as const } : {}),
        loadError: message,
        ...(tab.viewState === undefined ? {} : { viewState: tab.viewState }),
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, pendingIndices.length) }, async () => {
    while (cursor < pendingIndices.length) {
      const index = pendingIndices[cursor]
      cursor += 1
      if (index !== undefined) await hydrate(index)
    }
  })
  await Promise.all(workers)
  return {
    documents: documents.filter((document): document is RestoredDocument => document !== undefined),
    ...(workspace.activePath === undefined ? {} : { activePath: workspace.activePath }),
  }
}
