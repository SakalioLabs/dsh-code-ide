import type { ReadOnlyFilePresentation } from '../../shared/workspace-files.ts'
import {
  CANONICAL_DOCUMENT_LINE_ENDING,
  materializeEditableText,
  normalizeEditableText,
  type DocumentLineEnding,
} from './text-content.ts'

export interface EditorSelectionRangeSnapshot {
  anchor: number
  head: number
}

export interface EditorViewSnapshot {
  ranges: readonly EditorSelectionRangeSnapshot[]
  mainIndex: number
  scrollTop: number
  scrollLeft: number
  /** Document position of the top visible line; stable across layout measurement. */
  viewportAnchor?: number
}

export type DocumentExternalState = 'modified' | 'deleted'

export interface EditorTab {
  path: string
  name: string
  content: string
  version: string
  /** Host serialization convention; absent only for bounded read-only presentations or legacy fixtures. */
  lineEnding?: DocumentLineEnding
  /** Known disk baseline. It is intentionally absent after a conflicted recovery. */
  baselineContent?: string
  /** Serialization convention of the same known disk baseline. */
  baselineLineEnding?: DocumentLineEnding
  dirty: boolean
  lifecycleId: number
  localRevision: number
  historyEpoch: number
  viewState?: EditorViewSnapshot
  externalState?: DocumentExternalState
  loadError?: string
  /** Bounded Host projection; its `content` is not a complete editable buffer. */
  readOnlyPresentation?: ReadOnlyFilePresentation
  pendingSaveId?: number
  pendingReloadId?: number
  /** Exact page-local three-way comparison/resolution transaction. */
  pendingConflictId?: number
  saveError?: string
  saveOutcome?: 'unknown'
  /** Runtime-only evidence needed to reconcile a write whose response was lost. */
  unknownSave?:
    | {
      kind: 'replace'
      content: string
      lineEnding: DocumentLineEnding
      expectedVersion: string
      baselineContent?: string
      baselineLineEnding?: DocumentLineEnding
    }
    | {
      kind: 'create'
      content: string
      lineEnding: DocumentLineEnding
    }
}

export interface WorkspaceDocumentSession {
  readonly tabs: readonly EditorTab[]
  readonly activePath?: string
}

const EMPTY_WORKSPACE_DOCUMENT_SESSION: WorkspaceDocumentSession = Object.freeze({
  tabs: Object.freeze([]),
})

export interface DocumentSessionsSnapshot {
  readonly activeWorkspaceId?: string
  readonly activeWorkspaceEpoch: number
  readonly workspaces: ReadonlyMap<string, WorkspaceDocumentSession>
}

/** Exact page-local identity; workspace epoch and lifecycle fence both ABA forms. */
export interface DocumentIdentity {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly path: string
  readonly lifecycleId: number
}

export type DocumentTabDropPlacement = 'before' | 'after'

export type DocumentTabReorderResult = 'applied' | 'not-needed' | 'stale'

export interface OpenDocumentIntent {
  workspaceId: string
  workspaceEpoch: number
  requestId: number
  resourceGeneration: number
  path: string
  name: string
  mutationOperationId?: string
}

export interface SaveDocumentIntent {
  workspaceId: string
  path: string
  lifecycleId: number
  requestId: number
  resourceGeneration: number
  localRevision: number
  content: string
  lineEnding: DocumentLineEnding
  expectedVersion: string
  baselineContent?: string
  baselineLineEnding?: DocumentLineEnding
}

export interface ReloadDocumentIntent {
  workspaceId: string
  path: string
  lifecycleId: number
  requestId: number
  resourceGeneration: number
  localRevision: number
  expectedVersion: string
  lineEnding: DocumentLineEnding
}

/** Explicit user-authorized replacement of one dirty active buffer from disk. */
export interface RevertDocumentIntent {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly path: string
  readonly lifecycleId: number
  readonly requestId: number
  readonly resourceGeneration: number
  readonly localRevision: number
  readonly expectedVersion: string
  readonly lineEnding: DocumentLineEnding
}

export type DocumentReplacementCapture =
  | {
    readonly kind: 'open'
    readonly workspaceId: string
    readonly workspaceEpoch: number
    readonly path: string
    readonly name: string
    readonly resourceGeneration: number
    readonly lifecycleId: number
    readonly localRevision: number
    readonly version: string
    readonly content: string
    readonly lineEnding: DocumentLineEnding
  }
  | {
    readonly kind: 'closed'
    readonly workspaceId: string
    readonly workspaceEpoch: number
    readonly path: string
    readonly name: string
    readonly resourceGeneration: number
  }

export interface DocumentReplacementTarget {
  readonly capture: DocumentReplacementCapture
  /** Canonical authoritative buffer; equal to capture.content for an open target. */
  readonly originalContent: string
  /** Exact Host bytes, required only for a closed target's verify-before-apply read. */
  readonly rawOriginalContent?: string
  readonly version: string
  readonly replacementContent: string
  readonly lineEnding: DocumentLineEnding
}

export interface DocumentReplacementIntent {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly targets: readonly DocumentReplacementTarget[]
}

export interface RecreateDeletedIntent {
  workspaceId: string
  path: string
  lifecycleId: number
  requestId: number
  resourceGeneration: number
  localRevision: number
  content: string
  lineEnding: DocumentLineEnding
}

export const DOCUMENT_CONFLICT_VARIANT_UTF8_LIMIT = 1024 * 1024
export const MAX_RESOURCE_FENCES = 512

export type DocumentConflictVariantError = 'nul' | 'invalid-unicode' | 'too-large'

/** A conflict variant is text-only, NUL-free, and bounded by encoded UTF-8 bytes. */
export function validateDocumentConflictVariant(content: string): DocumentConflictVariantError | undefined {
  if (content.includes('\0')) return 'nul'
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trail = content.charCodeAt(index + 1)
      if (!(trail >= 0xdc00 && trail <= 0xdfff)) return 'invalid-unicode'
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return 'invalid-unicode'
  }
  return new TextEncoder().encode(content).byteLength > DOCUMENT_CONFLICT_VARIANT_UTF8_LIMIT
    ? 'too-large'
    : undefined
}

export interface DocumentConflictIntent extends DocumentIdentity {
  readonly requestId: number
  readonly resourceGeneration: number
  readonly localRevision: number
  readonly baseVersion: string
  readonly lineEnding: DocumentLineEnding
  readonly local: string
  readonly base?: string
}

export interface DocumentConflictRemote {
  readonly content: string
  readonly version: string
  readonly lineEnding: DocumentLineEnding
}

export type DocumentLineEndingChangeResult = 'applied' | 'not-needed' | 'stale' | 'read-only' | 'blocked'

export type DocumentConflictResolution =
  | { readonly kind: 'accept-remote' }
  | { readonly kind: 'keep-local' }
  | { readonly kind: 'apply-merged'; readonly content: string }

export type DocumentMutationBlockerCode =
  | 'dirty'
  | 'pending-save'
  | 'pending-reload'
  | 'pending-conflict'
  | 'unknown-save'
  | 'destination-open'
  | 'external-state'

export interface DocumentMutationBlocker {
  readonly code: DocumentMutationBlockerCode
  readonly path: string
}

export interface DocumentMutationImpact {
  readonly affectedDocuments: number
  readonly preservesDirtyFile: boolean
  readonly blockers: readonly DocumentMutationBlocker[]
}

export interface DocumentRenameCommitResult {
  readonly applied: boolean
  readonly rekeyed: readonly {
    readonly fromPath: string
    readonly toPath: string
    readonly lifecycleId: number
  }[]
  readonly impact: DocumentMutationImpact
}

export interface CommittedRenameDocumentRecovery {
  readonly sourcePath: string
  readonly lifecycleId: number
  readonly localRevision: number
  readonly lineEnding: DocumentLineEnding
  readonly disk:
    | {
      readonly state: 'present'
      readonly content: string
      readonly version: string
      readonly lineEnding?: DocumentLineEnding
      readonly readOnlyPresentation?: ReadOnlyFilePresentation
    }
    | { readonly state: 'missing' }
}

export interface DocumentDeleteCommitResult {
  readonly applied: boolean
  readonly retired: readonly EditorTab[]
  readonly retainedDeleted: readonly EditorTab[]
  readonly impact: DocumentMutationImpact
}

export interface RestoredDocument {
  path: string
  name: string
  content: string
  version: string
  lineEnding?: DocumentLineEnding
  dirty: boolean
  baselineContent?: string
  baselineLineEnding?: DocumentLineEnding
  viewState?: EditorViewSnapshot
  externalState?: DocumentExternalState
  loadError?: string
  readOnlyPresentation?: ReadOnlyFilePresentation
}

type Listener = () => void

interface ResourceFence {
  readonly workspaceId: string
  readonly prefix: string
  readonly sequence: number
}

export interface ResourceFenceUsage {
  readonly retained: number
  readonly limit: number
  readonly current: number
  readonly floor: number
}

function sameViewState(left: EditorViewSnapshot | undefined, right: EditorViewSnapshot): boolean {
  if (left === undefined || left.mainIndex !== right.mainIndex
    || left.scrollTop !== right.scrollTop || left.scrollLeft !== right.scrollLeft
    || left.viewportAnchor !== right.viewportAnchor
    || left.ranges.length !== right.ranges.length) return false
  return left.ranges.every((range, index) => {
    const other = right.ranges[index]
    return other !== undefined && range.anchor === other.anchor && range.head === other.head
  })
}

function withoutOptional<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const output = { ...value }
  for (const key of keys) delete output[key]
  return output
}

function isPathOrDescendant(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function basename(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? path : path.slice(separator + 1)
}

function editableLineEnding(value: { readonly lineEnding?: DocumentLineEnding }): DocumentLineEnding {
  return value.lineEnding ?? CANONICAL_DOCUMENT_LINE_ENDING
}

function knownBaselineLineEnding(value: {
  readonly lineEnding?: DocumentLineEnding
  readonly baselineContent?: string
  readonly baselineLineEnding?: DocumentLineEnding
}): DocumentLineEnding | undefined {
  if (value.baselineContent === undefined) return undefined
  // Compatibility for legacy fixtures and restored adapters. Production
  // authoritative paths always write the baseline pair explicitly.
  return value.baselineLineEnding ?? editableLineEnding(value)
}

function documentIsDirty(
  content: string,
  lineEnding: DocumentLineEnding,
  baselineContent: string | undefined,
  baselineLineEnding: DocumentLineEnding | undefined,
): boolean {
  return baselineContent === undefined || baselineLineEnding === undefined
    || content !== baselineContent || lineEnding !== baselineLineEnding
}

function canonicalEditable(
  value: { readonly content: string; readonly lineEnding?: DocumentLineEnding },
): { readonly content: string; readonly lineEnding: DocumentLineEnding } {
  return normalizeEditableText(value.content, value.lineEnding)
}

function rebasePath(path: string, source: string, destination: string): string {
  return path === source ? destination : `${destination}${path.slice(source.length)}`
}

/**
 * Browser-local document domain service. It owns document identity and rejects
 * stale asynchronous completions; transport, persistence, and React are ports.
 */
export class DocumentSessionStore {
  private snapshot: DocumentSessionsSnapshot = {
    activeWorkspaceEpoch: 0,
    workspaces: new Map(),
  }
  private readonly listeners = new Set<Listener>()
  private lifecycleSequence = 0
  private requestSequence = 0
  private resourceFenceSequence = 0
  private resourceFenceFloor = 0
  /** In insertion order so eviction can conservatively advance the stale floor. */
  private readonly resourceFences = new Map<string, ResourceFence>()
  private readonly mutationLeases = new Map<string, { workspaceId: string; prefixes: readonly string[] }>()

  readonly getSnapshot = (): DocumentSessionsSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: DocumentSessionsSnapshot): void {
    if (next === this.snapshot) return
    this.snapshot = next
    for (const listener of this.listeners) {
      try { listener() } catch { /* observers cannot roll back a committed document transition */ }
    }
  }

  private replaceWorkspace(workspaceId: string, session: WorkspaceDocumentSession): void {
    const workspaces = new Map(this.snapshot.workspaces)
    workspaces.set(workspaceId, session)
    this.publish({ ...this.snapshot, workspaces })
  }

  private resourceKey(workspaceId: string, path: string): string {
    return `${workspaceId}\0${path}`
  }

  resourceFenceUsage(): ResourceFenceUsage {
    return {
      retained: this.resourceFences.size,
      limit: MAX_RESOURCE_FENCES,
      current: this.resourceFenceSequence,
      floor: this.resourceFenceFloor,
    }
  }

  private resourceGeneration(_workspaceId: string, _path: string): number {
    return this.resourceFenceSequence
  }

  private acceptsResource(workspaceId: string, path: string, generation: number): boolean {
    if (!Number.isSafeInteger(generation) || generation < 0
      || generation > this.resourceFenceSequence || generation < this.resourceFenceFloor) return false
    for (const fence of this.resourceFences.values()) {
      if (fence.sequence > generation && fence.workspaceId === workspaceId
        && isPathOrDescendant(path, fence.prefix)) return false
    }
    return true
  }

  private fenceResourcePrefixes(workspaceId: string, prefixes: readonly string[]): void {
    const unique = [...new Set(prefixes)]
    if (unique.length === 0) return
    const sequence = ++this.resourceFenceSequence
    for (const prefix of unique) {
      const key = this.resourceKey(workspaceId, prefix)
      // A newer fence for the same prefix subsumes every older one. Reinsert it
      // so Map order continues to represent the oldest retained fence first.
      this.resourceFences.delete(key)
      this.resourceFences.set(key, { workspaceId, prefix, sequence })
    }
    while (this.resourceFences.size > MAX_RESOURCE_FENCES) {
      const oldestKey = this.resourceFences.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.resourceFences.get(oldestKey)
      this.resourceFences.delete(oldestKey)
      if (oldest !== undefined) {
        // A generation equal to this sequence was captured only after the whole
        // fence call committed, so only strictly older generations become stale.
        this.resourceFenceFloor = Math.max(this.resourceFenceFloor, oldest.sequence)
      }
    }
  }

  isPathMutationLeased(workspaceId: string, path: string): boolean {
    for (const lease of this.mutationLeases.values()) {
      if (lease.workspaceId === workspaceId && lease.prefixes.some(prefix => isPathOrDescendant(path, prefix))) return true
    }
    return false
  }

  private isPathMutationLeasedBy(operationId: string, workspaceId: string, path: string): boolean {
    const lease = this.mutationLeases.get(operationId)
    return lease?.workspaceId === workspaceId
      && lease.prefixes.some(prefix => isPathOrDescendant(path, prefix))
  }

  private overlapsMutationLease(workspaceId: string, prefixes: readonly string[]): boolean {
    for (const lease of this.mutationLeases.values()) {
      if (lease.workspaceId !== workspaceId) continue
      if (lease.prefixes.some(existing => prefixes.some(prefix =>
        isPathOrDescendant(existing, prefix) || isPathOrDescendant(prefix, existing)))) return true
    }
    return false
  }

  private overlapsPendingConflict(workspaceId: string, prefixes: readonly string[]): boolean {
    return this.session(workspaceId).tabs.some(tab => tab.pendingConflictId !== undefined
      && prefixes.some(prefix => isPathOrDescendant(tab.path, prefix)
        || isPathOrDescendant(prefix, tab.path)))
  }

  acquireCreateMutationLease(operationId: string, workspaceId: string, targetPath: string): boolean {
    if (operationId.length === 0 || this.mutationLeases.has(operationId)
      || this.session(workspaceId).tabs.some(tab => isPathOrDescendant(tab.path, targetPath))
      || this.overlapsMutationLease(workspaceId, [targetPath])) return false
    this.mutationLeases.set(operationId, { workspaceId, prefixes: [targetPath] })
    this.publish({ ...this.snapshot })
    return true
  }

  acquireRenameMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): boolean {
    if (operationId.length === 0 || this.mutationLeases.has(operationId)
      || this.inspectRenameMutation(
        workspaceId, sourcePath, destinationPath, sourceKind, sourceVersion,
      ).blockers.length > 0
      || this.overlapsMutationLease(workspaceId, [sourcePath, destinationPath])) return false
    this.mutationLeases.set(operationId, { workspaceId, prefixes: [sourcePath, destinationPath] })
    this.publish({ ...this.snapshot })
    return true
  }

  acquireDeleteMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): boolean {
    if (operationId.length === 0 || this.mutationLeases.has(operationId)
      || this.inspectDeleteMutation(workspaceId, sourcePath, resourceKind, sourceVersion).blockers.length > 0
      || this.overlapsMutationLease(workspaceId, [sourcePath])) return false
    this.mutationLeases.set(operationId, { workspaceId, prefixes: [sourcePath] })
    this.publish({ ...this.snapshot })
    return true
  }

  releaseMutationLease(operationId: string): boolean {
    if (!this.mutationLeases.delete(operationId)) return false
    this.publish({ ...this.snapshot })
    return true
  }

  /** Rebuild a lease for an already-admitted operation without rerunning pre-admission blockers. */
  restoreMutationLease(
    operationId: string,
    workspaceId: string,
    prefixes: readonly string[],
  ): boolean {
    const existing = this.mutationLeases.get(operationId)
    if (existing !== undefined) {
      return existing.workspaceId === workspaceId && existing.prefixes.length === prefixes.length
        && existing.prefixes.every((prefix, index) => prefix === prefixes[index])
    }
    if (operationId.length === 0 || prefixes.length === 0
      || this.overlapsPendingConflict(workspaceId, prefixes)
      || this.overlapsMutationLease(workspaceId, prefixes)) return false
    this.mutationLeases.set(operationId, { workspaceId, prefixes: [...prefixes] })
    this.publish({ ...this.snapshot })
    return true
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.snapshot.activeWorkspaceId === workspaceId) return
    const workspaces = new Map(this.snapshot.workspaces)
    const outgoingId = this.snapshot.activeWorkspaceId
    if (outgoingId !== undefined) {
      const outgoing = workspaces.get(outgoingId)
      if (outgoing?.tabs.some(tab => tab.pendingConflictId !== undefined)) {
        workspaces.set(outgoingId, {
          ...outgoing,
          tabs: outgoing.tabs.map(tab => tab.pendingConflictId === undefined
            ? tab
            : withoutOptional(tab, 'pendingConflictId')),
        })
      }
    }
    if (workspaceId !== undefined && !workspaces.has(workspaceId)) workspaces.set(workspaceId, { tabs: [] })
    this.publish({
      ...(workspaceId === undefined ? {} : { activeWorkspaceId: workspaceId }),
      activeWorkspaceEpoch: this.snapshot.activeWorkspaceEpoch + 1,
      workspaces,
    })
  }

  restoreWorkspace(workspaceId: string, documents: readonly RestoredDocument[], activePath?: string): void {
    const tabs = documents.map((document): EditorTab => {
      if (document.readOnlyPresentation !== undefined) return {
        ...withoutOptional(document, 'lineEnding', 'baselineContent', 'baselineLineEnding'),
        lifecycleId: ++this.lifecycleSequence,
        localRevision: 0,
        historyEpoch: 0,
      }
      const normalized = canonicalEditable(document)
      const baseline = document.baselineContent === undefined
        ? undefined
        : normalizeEditableText(
          document.baselineContent,
          document.baselineLineEnding ?? normalized.lineEnding,
        ).content
      const baselineLineEnding = baseline === undefined
        ? undefined
        : document.baselineLineEnding ?? normalized.lineEnding
      const current = withoutOptional(document, 'lineEnding', 'baselineContent', 'baselineLineEnding')
      return {
        ...current,
        content: normalized.content,
        lineEnding: normalized.lineEnding,
        ...(baseline === undefined ? {} : {
          baselineContent: baseline,
          baselineLineEnding: baselineLineEnding ?? normalized.lineEnding,
        }),
        lifecycleId: ++this.lifecycleSequence,
        localRevision: 0,
        historyEpoch: 0,
      }
    })
    const selected = activePath !== undefined && tabs.some(tab => tab.path === activePath)
      ? activePath
      : tabs[0]?.path
    this.replaceWorkspace(workspaceId, {
      tabs,
      ...(selected === undefined ? {} : { activePath: selected }),
    })
  }

  session(workspaceId: string | undefined = this.snapshot.activeWorkspaceId): WorkspaceDocumentSession {
    return workspaceId === undefined
      ? EMPTY_WORKSPACE_DOCUMENT_SESSION
      : this.snapshot.workspaces.get(workspaceId) ?? EMPTY_WORKSPACE_DOCUMENT_SESSION
  }

  activeTab(): EditorTab | undefined {
    const session = this.session()
    return session.tabs.find(tab => tab.path === session.activePath)
  }

  /** Inspect only a document that still belongs to the exact active page identity. */
  inspect(identity: DocumentIdentity): EditorTab | undefined {
    if (!this.isWorkspaceEpoch(identity.workspaceId, identity.workspaceEpoch)) return undefined
    return this.session(identity.workspaceId).tabs.find(tab =>
      tab.path === identity.path && tab.lifecycleId === identity.lifecycleId)
  }

  /**
   * Reorder two tabs only while both exact page-local identities are current.
   * The transition moves the existing tab object, preserving its buffer,
   * history, dirty state, active document, and every in-flight fence.
   */
  reorderTab(
    source: DocumentIdentity,
    target: DocumentIdentity,
    placement: DocumentTabDropPlacement,
  ): DocumentTabReorderResult {
    if (source.workspaceId !== target.workspaceId
      || source.workspaceEpoch !== target.workspaceEpoch
      || !this.isWorkspaceEpoch(source.workspaceId, source.workspaceEpoch)
      || placement !== 'before' && placement !== 'after') return 'stale'

    const session = this.session(source.workspaceId)
    const sourceIndex = session.tabs.findIndex(tab =>
      tab.path === source.path && tab.lifecycleId === source.lifecycleId)
    const targetIndex = session.tabs.findIndex(tab =>
      tab.path === target.path && tab.lifecycleId === target.lifecycleId)
    if (sourceIndex < 0 || targetIndex < 0) return 'stale'
    if (sourceIndex === targetIndex) return 'not-needed'

    const tabs = [...session.tabs]
    const [moved] = tabs.splice(sourceIndex, 1)
    if (moved === undefined) return 'stale'
    const currentTargetIndex = tabs.findIndex(tab =>
      tab.path === target.path && tab.lifecycleId === target.lifecycleId)
    if (currentTargetIndex < 0) return 'stale'
    tabs.splice(currentTargetIndex + (placement === 'after' ? 1 : 0), 0, moved)
    if (tabs.every((tab, index) => tab === session.tabs[index])) return 'not-needed'

    this.replaceWorkspace(source.workspaceId, { ...session, tabs })
    return 'applied'
  }

  /** Capture the exact buffer/resource identity used by a non-writing bulk editor operation. */
  captureDocumentReplacement(
    workspaceId: string,
    path: string,
    name: string,
  ): DocumentReplacementCapture | undefined {
    if (this.snapshot.activeWorkspaceId !== workspaceId
      || this.isPathMutationLeased(workspaceId, path)) return undefined
    const workspaceEpoch = this.snapshot.activeWorkspaceEpoch
    const resourceGeneration = this.resourceGeneration(workspaceId, path)
    const tab = this.session(workspaceId).tabs.find(candidate => candidate.path === path)
    if (tab === undefined) {
      return { kind: 'closed', workspaceId, workspaceEpoch, path, name, resourceGeneration }
    }
    if (tab.readOnlyPresentation !== undefined
      || tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
      || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || tab.externalState === 'deleted') return undefined
    return {
      kind: 'open', workspaceId, workspaceEpoch, path, name: tab.name, resourceGeneration,
      lifecycleId: tab.lifecycleId, localRevision: tab.localRevision,
      version: tab.version, content: tab.content, lineEnding: editableLineEnding(tab),
    }
  }

  /**
   * Atomically apply an already-previewed replacement to editor buffers only.
   * Closed resources become dirty tabs based on their captured read/version;
   * persistence remains the ordinary version-checked Save workflow.
   */
  applyDocumentReplacements(intent: DocumentReplacementIntent): boolean {
    if (!this.isWorkspaceEpoch(intent.workspaceId, intent.workspaceEpoch)
      || intent.targets.length === 0) return false
    const paths = new Set<string>()
    const session = this.session(intent.workspaceId)
    for (const target of intent.targets) {
      const capture = target.capture
      if (capture.workspaceId !== intent.workspaceId || capture.workspaceEpoch !== intent.workspaceEpoch
        || paths.has(capture.path) || target.version.length === 0
        || target.originalContent === target.replacementContent
        || !this.acceptsResource(intent.workspaceId, capture.path, capture.resourceGeneration)
        || this.isPathMutationLeased(intent.workspaceId, capture.path)) return false
      paths.add(capture.path)
      const tab = session.tabs.find(candidate => candidate.path === capture.path)
      if (capture.kind === 'closed') {
        if (tab !== undefined || target.rawOriginalContent === undefined) return false
      } else if (tab === undefined || tab.lifecycleId !== capture.lifecycleId
        || tab.localRevision !== capture.localRevision || tab.version !== capture.version
        || tab.content !== capture.content || editableLineEnding(tab) !== capture.lineEnding
        || target.lineEnding !== capture.lineEnding || target.originalContent !== capture.content
        || target.version !== capture.version || tab.pendingSaveId !== undefined
        || tab.pendingReloadId !== undefined || tab.pendingConflictId !== undefined
        || tab.saveOutcome === 'unknown' || tab.externalState === 'deleted'
        || tab.readOnlyPresentation !== undefined) return false
    }

    const replacements = new Map(intent.targets.map(target => [target.capture.path, target]))
    const tabs = session.tabs.map((tab): EditorTab => {
      const target = replacements.get(tab.path)
      if (target === undefined || target.capture.kind !== 'open') return tab
      return {
        ...withoutOptional(tab, 'loadError'),
        content: target.replacementContent,
        lineEnding: target.lineEnding,
        dirty: documentIsDirty(
          target.replacementContent,
          target.lineEnding,
          tab.baselineContent,
          knownBaselineLineEnding(tab),
        ),
        localRevision: tab.localRevision + 1,
        historyEpoch: tab.historyEpoch + 1,
      }
    })
    for (const target of intent.targets) {
      if (target.capture.kind !== 'closed') continue
      tabs.push({
        path: target.capture.path,
        name: target.capture.name,
        content: target.replacementContent,
        baselineContent: target.originalContent,
        baselineLineEnding: target.lineEnding,
        lineEnding: target.lineEnding,
        version: target.version,
        dirty: true,
        lifecycleId: ++this.lifecycleSequence,
        localRevision: 1,
        historyEpoch: 0,
      })
    }
    const activePath = session.activePath ?? tabs[0]?.path
    this.replaceWorkspace(intent.workspaceId, {
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
    return true
  }

  isWorkspaceEpoch(workspaceId: string, epoch: number): boolean {
    return this.snapshot.activeWorkspaceId === workspaceId && this.snapshot.activeWorkspaceEpoch === epoch
  }

  activateDocument(workspaceId: string, path: string): boolean {
    const session = this.session(workspaceId)
    if (!session.tabs.some(tab => tab.path === path)) return false
    if (session.activePath !== path) this.replaceWorkspace(workspaceId, { ...session, activePath: path })
    return true
  }

  beginOpen(workspaceId: string, path: string, name: string): OpenDocumentIntent | undefined {
    return this.beginOpenWithMutation(workspaceId, path, name)
  }

  beginCommittedCreateOpen(
    operationId: string,
    workspaceId: string,
    path: string,
    name: string,
  ): OpenDocumentIntent | undefined {
    if (!this.isPathMutationLeasedBy(operationId, workspaceId, path)) return undefined
    return this.beginOpenWithMutation(workspaceId, path, name, operationId)
  }

  private beginOpenWithMutation(
    workspaceId: string,
    path: string,
    name: string,
    mutationOperationId?: string,
  ): OpenDocumentIntent | undefined {
    if (this.activateDocument(workspaceId, path)) return undefined
    if (this.snapshot.activeWorkspaceId !== workspaceId
      || this.isPathMutationLeased(workspaceId, path)
        && (mutationOperationId === undefined
          || !this.isPathMutationLeasedBy(mutationOperationId, workspaceId, path))) return undefined
    return {
      workspaceId,
      workspaceEpoch: this.snapshot.activeWorkspaceEpoch,
      requestId: ++this.requestSequence,
      resourceGeneration: this.resourceGeneration(workspaceId, path),
      path,
      name,
      ...(mutationOperationId === undefined ? {} : { mutationOperationId }),
    }
  }

  completeOpen(intent: OpenDocumentIntent, result: {
    path: string
    content: string
    version: string
    lineEnding?: DocumentLineEnding
    readOnlyPresentation?: ReadOnlyFilePresentation
  }): boolean {
    if (this.snapshot.activeWorkspaceId !== intent.workspaceId
      || this.snapshot.activeWorkspaceEpoch !== intent.workspaceEpoch
      || this.isPathMutationLeased(intent.workspaceId, intent.path)
        && (intent.mutationOperationId === undefined
          || !this.isPathMutationLeasedBy(intent.mutationOperationId, intent.workspaceId, intent.path))
      || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)
      || result.path !== intent.path) return false
    const session = this.session(intent.workspaceId)
    if (session.tabs.some(tab => tab.path === result.path)) {
      this.activateDocument(intent.workspaceId, result.path)
      return true
    }
    const normalized = result.readOnlyPresentation === undefined ? canonicalEditable(result) : undefined
    const tab: EditorTab = {
      path: result.path,
      name: intent.name,
      content: normalized?.content ?? result.content,
      ...(normalized === undefined ? {} : {
        baselineContent: normalized.content,
        baselineLineEnding: normalized.lineEnding,
        lineEnding: normalized.lineEnding,
      }),
      version: result.version,
      dirty: false,
      lifecycleId: ++this.lifecycleSequence,
      localRevision: 0,
      historyEpoch: 0,
      ...(result.readOnlyPresentation === undefined
        ? {}
        : { readOnlyPresentation: result.readOnlyPresentation }),
    }
    this.replaceWorkspace(intent.workspaceId, { tabs: [...session.tabs, tab], activePath: tab.path })
    return true
  }

  editDocument(workspaceId: string, path: string, lifecycleId: number, content: string): void {
    if (this.isPathMutationLeased(workspaceId, path)) return
    const session = this.session(workspaceId)
    let changed = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== path || tab.lifecycleId !== lifecycleId || tab.content === content
        || tab.readOnlyPresentation !== undefined) return tab
      changed = true
      return {
        ...withoutOptional(tab, 'loadError', 'pendingReloadId', 'pendingConflictId'),
        content,
        dirty: documentIsDirty(
          content,
          editableLineEnding(tab),
          tab.baselineContent,
          knownBaselineLineEnding(tab),
        ),
        localRevision: tab.localRevision + 1,
      }
    })
    if (changed) this.replaceWorkspace(workspaceId, { ...session, tabs })
  }

  changeLineEnding(
    identity: DocumentIdentity,
    next: DocumentLineEnding,
  ): DocumentLineEndingChangeResult {
    if (!this.isWorkspaceEpoch(identity.workspaceId, identity.workspaceEpoch)) return 'stale'
    const session = this.session(identity.workspaceId)
    if (session.activePath !== identity.path) return 'stale'
    const tab = session.tabs.find(candidate => candidate.path === identity.path
      && candidate.lifecycleId === identity.lifecycleId)
    if (tab === undefined) return 'stale'
    if (tab.readOnlyPresentation !== undefined) return 'read-only'
    if (tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
      || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || tab.externalState === 'deleted'
      || this.isPathMutationLeased(identity.workspaceId, identity.path)) return 'blocked'
    if (editableLineEnding(tab) === next) return 'not-needed'
    const tabs = session.tabs.map(candidate => candidate === tab ? {
      ...candidate,
      lineEnding: next,
      dirty: documentIsDirty(
        candidate.content,
        next,
        candidate.baselineContent,
        knownBaselineLineEnding(candidate),
      ),
      localRevision: candidate.localRevision + 1,
    } : candidate)
    this.replaceWorkspace(identity.workspaceId, { ...session, tabs })
    return 'applied'
  }

  updateViewState(workspaceId: string, path: string, lifecycleId: number, viewState: EditorViewSnapshot): void {
    const session = this.session(workspaceId)
    let changed = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== path || tab.lifecycleId !== lifecycleId || sameViewState(tab.viewState, viewState)) return tab
      changed = true
      return { ...tab, viewState }
    })
    if (changed) this.replaceWorkspace(workspaceId, { ...session, tabs })
  }

  closeDocument(workspaceId: string, path: string): EditorTab | undefined {
    return this.closeMatching(workspaceId, path)
  }

  /**
   * Close only the exact active identity captured by a page-owned transaction.
   * Unlike the legacy synchronous path API, this also fences an in-flight reload.
   */
  closeIfCurrent(identity: DocumentIdentity): EditorTab | undefined {
    if (this.inspect(identity) === undefined) return undefined
    return this.closeMatching(identity.workspaceId, identity.path, identity.lifecycleId, true)
  }

  private closeMatching(
    workspaceId: string,
    path: string,
    lifecycleId?: number,
    blockPendingReload = false,
  ): EditorTab | undefined {
    const session = this.session(workspaceId)
    const index = session.tabs.findIndex(tab => tab.path === path
      && (lifecycleId === undefined || tab.lifecycleId === lifecycleId))
    const removed = session.tabs[index]
    if (removed === undefined) return undefined
    // A write cannot be cancelled once the Host has received it. Keep the
    // document alive until its acknowledgement (or an authoritative outcome
    // reconciliation) arrives, so "Discard" can never imply a false rollback.
    if (removed.pendingSaveId !== undefined || blockPendingReload && removed.pendingReloadId !== undefined
      || removed.pendingConflictId !== undefined
      || removed.saveOutcome === 'unknown'
      || this.isPathMutationLeased(workspaceId, path)) return undefined
    // Exact close must retire one lifecycle even if imported or adapter-owned
    // state temporarily violates the normal one-tab-per-path invariant.
    const tabs = session.tabs.filter((_tab, candidateIndex) => candidateIndex !== index)
    const activePath = session.activePath === path
      ? tabs[Math.min(index, Math.max(0, tabs.length - 1))]?.path
      : session.activePath
    this.replaceWorkspace(workspaceId, {
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
    return removed
  }

  updateWorkspaceTabs(workspaceId: string, update: (tabs: readonly EditorTab[]) => readonly EditorTab[]): void {
    const session = this.session(workspaceId)
    const proposed = update(session.tabs)
    const conflictsRemainExact = session.tabs.every(current => current.pendingConflictId === undefined
      || proposed.some(candidate => candidate === current))
    const tabs = proposed === session.tabs || !conflictsRemainExact ? session.tabs : proposed.map((tab) => {
      const current = session.tabs.find(candidate => candidate.path === tab.path
        && candidate.lifecycleId === tab.lifecycleId)
      if (current?.pendingConflictId !== undefined) return current
      if (!this.isPathMutationLeased(workspaceId, tab.path)) return tab
      return current ?? tab
    })
    if (tabs !== session.tabs) this.replaceWorkspace(workspaceId, { ...session, tabs })
  }

  /**
   * Admit one explicit three-way comparison. Admission itself performs no I/O;
   * the returned immutable evidence is what a runtime controller may read for.
   */
  beginConflictCompare(identity: DocumentIdentity): DocumentConflictIntent | undefined {
    const tab = this.inspect(identity)
    if (tab === undefined || tab.readOnlyPresentation !== undefined || tab.externalState !== 'modified'
      || tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
      || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || this.isPathMutationLeased(identity.workspaceId, identity.path)
      || validateDocumentConflictVariant(tab.content) !== undefined
      || tab.baselineContent !== undefined
        && validateDocumentConflictVariant(tab.baselineContent) !== undefined) return undefined
    const requestId = ++this.requestSequence
    const session = this.session(identity.workspaceId)
    const tabs = session.tabs.map(candidate => candidate === tab
      ? { ...candidate, pendingConflictId: requestId }
      : candidate)
    this.replaceWorkspace(identity.workspaceId, { ...session, tabs })
    return {
      ...identity,
      requestId,
      resourceGeneration: this.resourceGeneration(identity.workspaceId, identity.path),
      localRevision: tab.localRevision,
      baseVersion: tab.version,
      local: tab.content,
      lineEnding: editableLineEnding(tab),
      ...(tab.baselineContent === undefined ? {} : { base: tab.baselineContent }),
    }
  }

  /** Validate every captured identity component before accepting an async completion. */
  isConflictCurrent(intent: DocumentConflictIntent): boolean {
    if (!this.isWorkspaceEpoch(intent.workspaceId, intent.workspaceEpoch)
      || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)
      || this.isPathMutationLeased(intent.workspaceId, intent.path)) return false
    const tab = this.session(intent.workspaceId).tabs.find(candidate => candidate.path === intent.path
      && candidate.lifecycleId === intent.lifecycleId)
    return tab !== undefined && tab.pendingConflictId === intent.requestId
      && tab.readOnlyPresentation === undefined
      && tab.pendingSaveId === undefined && tab.pendingReloadId === undefined
      && tab.saveOutcome !== 'unknown' && tab.externalState === 'modified'
      && tab.localRevision === intent.localRevision && tab.version === intent.baseVersion
      && editableLineEnding(tab) === intent.lineEnding
      && tab.content === intent.local && tab.baselineContent === intent.base
  }

  /** Release only the exact comparison; stale cancellation cannot touch a replacement lifecycle. */
  cancelConflict(intent: DocumentConflictIntent): boolean {
    if (!this.isConflictCurrent(intent)) return false
    const session = this.session(intent.workspaceId)
    const tabs = session.tabs.map((tab): EditorTab => tab.path === intent.path
      && tab.lifecycleId === intent.lifecycleId
      ? withoutOptional(tab, 'pendingConflictId')
      : tab)
    this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return true
  }

  /**
   * Apply a resolution only after the caller has authoritatively re-read this
   * exact Remote. No Host write occurs here: Remote becomes the next CAS base.
   */
  applyConflictResolution(
    intent: DocumentConflictIntent,
    remote: DocumentConflictRemote,
    resolution: DocumentConflictResolution,
  ): boolean {
    if (!this.isConflictCurrent(intent)
      || validateDocumentConflictVariant(remote.content) !== undefined
      || resolution.kind === 'apply-merged'
        && validateDocumentConflictVariant(resolution.content) !== undefined) return false
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingConflictId !== intent.requestId) return tab
      const content = resolution.kind === 'accept-remote'
        ? remote.content
        : resolution.kind === 'apply-merged' ? resolution.content : tab.content
      const contentChanged = content !== tab.content
      const lineEnding = resolution.kind === 'accept-remote' ? remote.lineEnding : intent.lineEnding
      const lineEndingChanged = lineEnding !== editableLineEnding(tab)
      applied = true
      return {
        ...withoutOptional(
          tab,
          'pendingConflictId',
          'externalState',
          'loadError',
          'saveError',
        ),
        content,
        baselineContent: remote.content,
        baselineLineEnding: remote.lineEnding,
        lineEnding,
        version: remote.version,
        dirty: documentIsDirty(content, lineEnding, remote.content, remote.lineEnding),
        localRevision: tab.localRevision + (contentChanged || lineEndingChanged ? 1 : 0),
        historyEpoch: tab.historyEpoch + (contentChanged ? 1 : 0),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  beginSave(workspaceId: string, path: string): SaveDocumentIntent | undefined {
    const session = this.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === path)
    if (tab === undefined || tab.readOnlyPresentation !== undefined || !tab.dirty
      || tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
      || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || this.isPathMutationLeased(workspaceId, path)) return undefined
    const requestId = ++this.requestSequence
    const tabs = session.tabs.map(candidate => candidate === tab ? { ...candidate, pendingSaveId: requestId } : candidate)
    this.replaceWorkspace(workspaceId, { ...session, tabs })
    return {
      workspaceId,
      path,
      lifecycleId: tab.lifecycleId,
      requestId,
      resourceGeneration: this.resourceGeneration(workspaceId, path),
      localRevision: tab.localRevision,
      content: tab.content,
      lineEnding: editableLineEnding(tab),
      expectedVersion: tab.version,
      ...(tab.baselineContent === undefined ? {} : {
        baselineContent: tab.baselineContent,
        baselineLineEnding: knownBaselineLineEnding(tab) ?? editableLineEnding(tab),
      }),
    }
  }

  completeSave(intent: SaveDocumentIntent, version: string): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingSaveId !== intent.requestId
        || editableLineEnding(tab) !== intent.lineEnding
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)) return tab
      applied = true
      return {
        ...withoutOptional(tab, 'pendingSaveId', 'externalState', 'loadError', 'saveError', 'saveOutcome', 'unknownSave'),
        version,
        baselineContent: intent.content,
        baselineLineEnding: intent.lineEnding,
        lineEnding: intent.lineEnding,
        dirty: documentIsDirty(
          tab.content,
          editableLineEnding(tab),
          intent.content,
          intent.lineEnding,
        ),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  failSave(intent: SaveDocumentIntent, message: string, outcome: 'conflict' | 'unknown' | 'failed'): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingSaveId !== intent.requestId
        || editableLineEnding(tab) !== intent.lineEnding
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)) return tab
      applied = true
      const current = withoutOptional(tab, 'pendingSaveId', 'saveOutcome', 'unknownSave')
      return {
        ...current,
        saveError: message,
        ...(outcome === 'conflict' || outcome === 'unknown' ? { externalState: 'modified' as const } : {}),
        ...(outcome === 'unknown' ? {
          saveOutcome: 'unknown' as const,
          unknownSave: {
            kind: 'replace' as const,
            content: intent.content,
            lineEnding: intent.lineEnding,
            expectedVersion: intent.expectedVersion,
            ...(intent.baselineContent === undefined ? {} : {
              baselineContent: intent.baselineContent,
              baselineLineEnding: intent.baselineLineEnding ?? intent.lineEnding,
            }),
          },
        } : {}),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  reconcileSaveOutcome(
    workspaceId: string,
    path: string,
    lifecycleId: number,
    disk: {
      /** Exact Host bytes. Lost-write reconciliation must not accept merely EOL-equivalent text. */
      rawContent?: string
      content: string
      version: string
      lineEnding?: DocumentLineEnding
    },
  ): 'committed' | 'not-committed' | 'conflict' | 'stale' {
    const session = this.session(workspaceId)
    let outcome: 'committed' | 'not-committed' | 'conflict' | 'stale' = 'stale'
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== path || tab.lifecycleId !== lifecycleId || tab.pendingConflictId !== undefined
        || tab.saveOutcome !== 'unknown' || tab.unknownSave === undefined
        || editableLineEnding(tab) !== tab.unknownSave.lineEnding) return tab
      const submitted = tab.unknownSave
      const normalizedDisk = canonicalEditable(disk)
      const rawDisk = disk.rawContent
        ?? materializeEditableText(normalizedDisk.content, normalizedDisk.lineEnding)
      if (rawDisk === materializeEditableText(submitted.content, submitted.lineEnding)) {
        outcome = 'committed'
        return {
          ...withoutOptional(tab, 'saveOutcome', 'saveError', 'externalState', 'loadError', 'unknownSave'),
          version: disk.version,
          baselineContent: submitted.content,
          baselineLineEnding: submitted.lineEnding,
          lineEnding: submitted.lineEnding,
          dirty: documentIsDirty(
            tab.content,
            editableLineEnding(tab),
            submitted.content,
            submitted.lineEnding,
          ),
        }
      }
      if (submitted.kind === 'replace' && submitted.baselineContent !== undefined
        && submitted.baselineLineEnding !== undefined
        && disk.version === submitted.expectedVersion
        && rawDisk === materializeEditableText(submitted.baselineContent, submitted.baselineLineEnding)) {
        outcome = 'not-committed'
        return withoutOptional(tab, 'saveOutcome', 'saveError', 'unknownSave')
      }
      outcome = 'conflict'
      return {
        ...withoutOptional(tab, 'saveOutcome', 'unknownSave'),
        externalState: 'modified',
        saveError: 'The save outcome was checked, but disk content differs. Local edits remain protected.',
      }
    })
    if (outcome !== 'stale') this.replaceWorkspace(workspaceId, { ...session, tabs })
    return outcome
  }

  beginReload(workspaceId: string, path: string, expectedVersion: string): ReloadDocumentIntent | undefined {
    const tab = this.session(workspaceId).tabs.find(candidate => candidate.path === path)
    if (tab === undefined || tab.dirty || tab.version !== expectedVersion
      || tab.pendingReloadId !== undefined
      || tab.pendingSaveId !== undefined || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || this.isPathMutationLeased(workspaceId, path)) return undefined
    const requestId = ++this.requestSequence
    const session = this.session(workspaceId)
    const tabs = session.tabs.map(candidate => candidate === tab ? { ...candidate, pendingReloadId: requestId } : candidate)
    this.replaceWorkspace(workspaceId, { ...session, tabs })
    return {
      workspaceId,
      path,
      lifecycleId: tab.lifecycleId,
      requestId,
      resourceGeneration: this.resourceGeneration(workspaceId, path),
      localRevision: tab.localRevision,
      expectedVersion,
      lineEnding: editableLineEnding(tab),
    }
  }

  beginRevert(identity: DocumentIdentity): RevertDocumentIntent | undefined {
    if (!this.isWorkspaceEpoch(identity.workspaceId, identity.workspaceEpoch)) return undefined
    const session = this.session(identity.workspaceId)
    if (session.activePath !== identity.path) return undefined
    const tab = session.tabs.find(candidate => candidate.path === identity.path
      && candidate.lifecycleId === identity.lifecycleId)
    if (tab === undefined || !tab.dirty || tab.readOnlyPresentation !== undefined
      || tab.externalState === 'deleted' || tab.saveOutcome === 'unknown'
      || tab.pendingReloadId !== undefined || tab.pendingSaveId !== undefined
      || tab.pendingConflictId !== undefined
      || this.isPathMutationLeased(identity.workspaceId, identity.path)) return undefined
    const requestId = ++this.requestSequence
    const tabs = session.tabs.map(candidate => candidate === tab
      ? { ...candidate, pendingReloadId: requestId }
      : candidate)
    this.replaceWorkspace(identity.workspaceId, { ...session, tabs })
    return {
      workspaceId: identity.workspaceId,
      workspaceEpoch: identity.workspaceEpoch,
      path: identity.path,
      lifecycleId: tab.lifecycleId,
      requestId,
      resourceGeneration: this.resourceGeneration(identity.workspaceId, identity.path),
      localRevision: tab.localRevision,
      expectedVersion: tab.version,
      lineEnding: editableLineEnding(tab),
    }
  }

  completeRevert(intent: RevertDocumentIntent, result: {
    path: string
    content: string
    version: string
    lineEnding?: DocumentLineEnding
    readOnlyPresentation?: ReadOnlyFilePresentation
  }): boolean {
    if (!this.isWorkspaceEpoch(intent.workspaceId, intent.workspaceEpoch)
      || result.path !== intent.path) return false
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (session.activePath !== intent.path || tab.path !== intent.path
        || tab.lifecycleId !== intent.lifecycleId || tab.pendingReloadId !== intent.requestId
        || tab.localRevision !== intent.localRevision || tab.version !== intent.expectedVersion
        || editableLineEnding(tab) !== intent.lineEnding
        || !tab.dirty || tab.readOnlyPresentation !== undefined
        || tab.externalState === 'deleted' || tab.saveOutcome === 'unknown'
        || tab.pendingSaveId !== undefined || tab.pendingConflictId !== undefined
        || this.isPathMutationLeased(intent.workspaceId, intent.path)
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)) return tab
      applied = true
      const current = withoutOptional(
        tab,
        'baselineContent',
        'externalState',
        'loadError',
        'pendingReloadId',
        'readOnlyPresentation',
        'saveError',
        'lineEnding',
        'baselineLineEnding',
      )
      const normalized = result.readOnlyPresentation === undefined ? canonicalEditable(result) : undefined
      return {
        ...current,
        content: normalized?.content ?? result.content,
        ...(normalized === undefined ? {} : {
          baselineContent: normalized.content,
          baselineLineEnding: normalized.lineEnding,
          lineEnding: normalized.lineEnding,
        }),
        version: result.version,
        dirty: false,
        historyEpoch: tab.historyEpoch + 1,
        ...(result.readOnlyPresentation === undefined
          ? {}
          : { readOnlyPresentation: result.readOnlyPresentation }),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  finishRevertFailure(intent: RevertDocumentIntent, message?: string): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingReloadId !== intent.requestId
        || editableLineEnding(tab) !== intent.lineEnding) return tab
      applied = true
      const current = withoutOptional(tab, 'pendingReloadId')
      return message === undefined ? current : { ...current, loadError: message }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  completeReload(intent: ReloadDocumentIntent, result: {
    content: string
    version: string
    lineEnding?: DocumentLineEnding
    readOnlyPresentation?: ReadOnlyFilePresentation
  }): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId || tab.dirty
        || tab.pendingReloadId !== intent.requestId
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)
        || tab.localRevision !== intent.localRevision || tab.version !== intent.expectedVersion
        || editableLineEnding(tab) !== intent.lineEnding) return tab
      applied = true
      const current = withoutOptional(
        tab,
        'externalState',
        'loadError',
        'pendingReloadId',
        'baselineContent',
        'baselineLineEnding',
        'readOnlyPresentation',
        'lineEnding',
      )
      const normalized = result.readOnlyPresentation === undefined ? canonicalEditable(result) : undefined
      return {
        ...current,
        content: normalized?.content ?? result.content,
        ...(normalized === undefined ? {} : {
          baselineContent: normalized.content,
          baselineLineEnding: normalized.lineEnding,
          lineEnding: normalized.lineEnding,
        }),
        version: result.version,
        dirty: false,
        historyEpoch: tab.historyEpoch + 1,
        ...(result.readOnlyPresentation === undefined
          ? {}
          : { readOnlyPresentation: result.readOnlyPresentation }),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  markReloadFailure(intent: ReloadDocumentIntent, message: string): void {
    const session = this.session(intent.workspaceId)
    let changed = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingReloadId !== intent.requestId
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)
        || tab.localRevision !== intent.localRevision || tab.version !== intent.expectedVersion
        || editableLineEnding(tab) !== intent.lineEnding) return tab
      changed = true
      return { ...withoutOptional(tab, 'pendingReloadId'), loadError: message, externalState: 'modified' }
    })
    if (changed) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
  }

  inspectRenameMutation(
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): DocumentMutationImpact {
    const tabs = this.session(workspaceId).tabs
    const affected = tabs.filter(tab => isPathOrDescendant(tab.path, sourcePath))
    const blockers: DocumentMutationBlocker[] = []
    const seen = new Set<string>()
    const block = (code: DocumentMutationBlockerCode, path: string): void => {
      const key = `${code}\0${path}`
      if (!seen.has(key)) {
        seen.add(key)
        blockers.push({ code, path })
      }
    }
    for (const tab of affected) {
      if (sourceKind === 'file' && tab.path === sourcePath && tab.version !== sourceVersion) {
        block('external-state', tab.path)
      }
      if (tab.pendingSaveId !== undefined) block('pending-save', tab.path)
      if (tab.pendingReloadId !== undefined) block('pending-reload', tab.path)
      if (tab.pendingConflictId !== undefined) block('pending-conflict', tab.path)
      if (tab.saveOutcome === 'unknown') block('unknown-save', tab.path)
      if (tab.externalState !== undefined) block('external-state', tab.path)
    }
    for (const tab of tabs) {
      if (isPathOrDescendant(tab.path, destinationPath)) block('destination-open', tab.path)
    }
    return { affectedDocuments: affected.length, preservesDirtyFile: false, blockers }
  }

  commitCreateMutation(workspaceId: string, workspaceEpoch: number, targetPath: string): boolean {
    if (!this.isWorkspaceEpoch(workspaceId, workspaceEpoch)) return false
    this.fenceResourcePrefixes(workspaceId, [targetPath])
    return true
  }

  canRecoverCommittedRename(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
  ): boolean {
    if (!this.isWorkspaceEpoch(workspaceId, workspaceEpoch)
      || this.session(workspaceId).tabs.some(tab => isPathOrDescendant(tab.path, sourcePath)
        && tab.pendingConflictId !== undefined)) return false
    const mappedPaths = this.session(workspaceId).tabs.map(tab => isPathOrDescendant(tab.path, sourcePath)
      ? rebasePath(tab.path, sourcePath, destinationPath)
      : tab.path)
    return new Set(mappedPaths).size === mappedPaths.length
  }

  recoverCommittedRenameDocuments(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    recoveries: readonly CommittedRenameDocumentRecovery[],
  ): boolean {
    if (!this.canRecoverCommittedRename(workspaceId, workspaceEpoch, sourcePath, destinationPath)) return false
    const session = this.session(workspaceId)
    const affected = session.tabs.filter(tab => isPathOrDescendant(tab.path, sourcePath))
    const byPath = new Map(recoveries.map(recovery => [recovery.sourcePath, recovery]))
    if (affected.some(tab => {
      const recovery = byPath.get(tab.path)
      return recovery === undefined || recovery.lifecycleId !== tab.lifecycleId
        || recovery.localRevision !== tab.localRevision
        || recovery.lineEnding !== editableLineEnding(tab)
    })) return false

    const tabs = session.tabs.map((tab): EditorTab => {
      const recovery = byPath.get(tab.path)
      if (recovery === undefined) return tab
      if (recovery.disk.state === 'missing') {
        return {
          ...withoutOptional(tab, 'pendingReloadId', 'saveError'),
          externalState: 'deleted',
          loadError: 'The committed rename destination is no longer present.',
        }
      }
      if (!tab.dirty) {
        const current = withoutOptional(
          tab,
          'externalState',
          'loadError',
          'saveError',
          'baselineContent',
          'baselineLineEnding',
          'readOnlyPresentation',
          'lineEnding',
        )
        if (recovery.disk.readOnlyPresentation !== undefined) return {
          ...current,
          content: recovery.disk.content,
          version: recovery.disk.version,
          dirty: false,
          readOnlyPresentation: recovery.disk.readOnlyPresentation,
        }
        const normalized = canonicalEditable(recovery.disk)
        return {
          ...current,
          content: normalized.content,
          baselineContent: normalized.content,
          baselineLineEnding: normalized.lineEnding,
          lineEnding: normalized.lineEnding,
          version: recovery.disk.version,
          dirty: false,
        }
      }
      if (recovery.disk.readOnlyPresentation !== undefined) {
        return {
          ...withoutOptional(tab, 'pendingReloadId', 'loadError', 'saveError'),
          externalState: 'modified',
          loadError: 'The committed rename destination is not editable UTF-8 text.',
        }
      }
      const normalized = canonicalEditable(recovery.disk)
      const currentLineEnding = editableLineEnding(tab)
      const dirty = documentIsDirty(
        tab.content,
        currentLineEnding,
        normalized.content,
        normalized.lineEnding,
      )
      return {
        ...withoutOptional(tab, 'externalState', 'loadError', 'saveError'),
        baselineContent: normalized.content,
        baselineLineEnding: normalized.lineEnding,
        lineEnding: currentLineEnding,
        version: recovery.disk.version,
        dirty,
        ...(dirty ? { externalState: 'modified' as const } : {}),
      }
    })
    this.replaceWorkspace(workspaceId, { ...session, tabs })
    return true
  }

  commitRenameMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    resourceKind: 'file' | 'directory',
    expectedVersion: string,
    freshVersion: string,
    preserveRecoveredVersions = false,
  ): DocumentRenameCommitResult {
    const impact = this.inspectRenameMutation(
      workspaceId, sourcePath, destinationPath, resourceKind, expectedVersion,
    )
    if (!this.isWorkspaceEpoch(workspaceId, workspaceEpoch)
      || sourcePath === destinationPath || destinationPath.startsWith(`${sourcePath}/`)) {
      return { applied: false, rekeyed: [], impact }
    }
    const session = this.session(workspaceId)
    const mappedPaths = session.tabs.map(tab => isPathOrDescendant(tab.path, sourcePath)
      ? rebasePath(tab.path, sourcePath, destinationPath)
      : tab.path)
    if (new Set(mappedPaths).size !== mappedPaths.length) {
      return { applied: false, rekeyed: [], impact }
    }
    const rekeyed: { fromPath: string; toPath: string; lifecycleId: number }[] = []
    this.fenceResourcePrefixes(workspaceId, [sourcePath, destinationPath])
    const tabs = session.tabs.map((tab): EditorTab => {
      if (!isPathOrDescendant(tab.path, sourcePath)) return tab
      const nextPath = rebasePath(tab.path, sourcePath, destinationPath)
      rekeyed.push({ fromPath: tab.path, toPath: nextPath, lifecycleId: tab.lifecycleId })
      return {
        ...tab,
        path: nextPath,
        name: basename(nextPath),
        ...(resourceKind === 'file' && tab.path === sourcePath && !preserveRecoveredVersions
          ? { version: freshVersion }
          : {}),
      }
    })
    const activePath = session.activePath !== undefined && isPathOrDescendant(session.activePath, sourcePath)
      ? rebasePath(session.activePath, sourcePath, destinationPath)
      : session.activePath
    this.replaceWorkspace(workspaceId, {
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
    return { applied: true, rekeyed, impact }
  }

  inspectDeleteMutation(
    workspaceId: string,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): DocumentMutationImpact {
    const affected = this.session(workspaceId).tabs.filter(tab => isPathOrDescendant(tab.path, sourcePath))
    const blockers: DocumentMutationBlocker[] = []
    const seen = new Set<string>()
    const block = (code: DocumentMutationBlockerCode, path: string): void => {
      const key = `${code}\0${path}`
      if (!seen.has(key)) {
        seen.add(key)
        blockers.push({ code, path })
      }
    }
    for (const tab of affected) {
      if (resourceKind === 'file' && tab.path === sourcePath && tab.version !== sourceVersion) {
        block('external-state', tab.path)
      }
      if (tab.pendingSaveId !== undefined) block('pending-save', tab.path)
      if (tab.pendingReloadId !== undefined) block('pending-reload', tab.path)
      if (tab.pendingConflictId !== undefined) block('pending-conflict', tab.path)
      if (tab.saveOutcome === 'unknown') block('unknown-save', tab.path)
      if (tab.externalState !== undefined) block('external-state', tab.path)
      if (tab.dirty && (resourceKind === 'directory' || tab.path !== sourcePath)) block('dirty', tab.path)
    }
    const preservesDirtyFile = resourceKind === 'file'
      && affected.some(tab => tab.path === sourcePath && tab.dirty)
      && blockers.length === 0
    return { affectedDocuments: affected.length, preservesDirtyFile, blockers }
  }

  commitDeleteMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    expectedVersion: string,
  ): DocumentDeleteCommitResult {
    const impact = this.inspectDeleteMutation(workspaceId, sourcePath, resourceKind, expectedVersion)
    if (!this.isWorkspaceEpoch(workspaceId, workspaceEpoch)) {
      return { applied: false, retired: [], retainedDeleted: [], impact }
    }
    const session = this.session(workspaceId)
    const retired: EditorTab[] = []
    const retainedDeleted: EditorTab[] = []
    this.fenceResourcePrefixes(workspaceId, [sourcePath])
    const tabs = session.tabs.flatMap((tab): EditorTab[] => {
      if (!isPathOrDescendant(tab.path, sourcePath)) return [tab]
      if (tab.dirty) {
        const retained = {
          ...withoutOptional(tab, 'pendingReloadId', 'loadError', 'saveError'),
          externalState: 'deleted',
        } satisfies EditorTab
        retainedDeleted.push(retained)
        return [retained]
      }
      retired.push(tab)
      return []
    })
    let activePath = session.activePath
    if (activePath !== undefined && !tabs.some(tab => tab.path === activePath)) {
      const activeIndex = session.tabs.findIndex(tab => tab.path === activePath)
      activePath = session.tabs.slice(activeIndex + 1).find(tab => tabs.includes(tab))?.path
        ?? [...session.tabs.slice(0, Math.max(0, activeIndex))].reverse().find(tab => tabs.includes(tab))?.path
        ?? tabs[0]?.path
    }
    this.replaceWorkspace(workspaceId, {
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
    return {
      applied: true,
      retired,
      retainedDeleted,
      impact,
    }
  }

  beginRecreateDeleted(workspaceId: string, path: string): RecreateDeletedIntent | undefined {
    const session = this.session(workspaceId)
    const tab = session.tabs.find(candidate => candidate.path === path)
    if (tab === undefined || tab.readOnlyPresentation !== undefined || !tab.dirty
      || tab.externalState !== 'deleted'
      || tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
      || tab.pendingConflictId !== undefined || tab.saveOutcome === 'unknown'
      || this.isPathMutationLeased(workspaceId, path)) return undefined
    const requestId = ++this.requestSequence
    const tabs = session.tabs.map(candidate => candidate === tab ? { ...candidate, pendingSaveId: requestId } : candidate)
    this.replaceWorkspace(workspaceId, { ...session, tabs })
    return {
      workspaceId,
      path,
      lifecycleId: tab.lifecycleId,
      requestId,
      resourceGeneration: this.resourceGeneration(workspaceId, path),
      localRevision: tab.localRevision,
      content: tab.content,
      lineEnding: editableLineEnding(tab),
    }
  }

  completeRecreateDeleted(intent: RecreateDeletedIntent, version: string): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingSaveId !== intent.requestId
        || editableLineEnding(tab) !== intent.lineEnding
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)) return tab
      applied = true
      return {
        ...withoutOptional(tab, 'pendingSaveId', 'externalState', 'loadError', 'saveError', 'saveOutcome', 'unknownSave'),
        version,
        baselineContent: intent.content,
        baselineLineEnding: intent.lineEnding,
        lineEnding: intent.lineEnding,
        dirty: documentIsDirty(
          tab.content,
          editableLineEnding(tab),
          intent.content,
          intent.lineEnding,
        ),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  failRecreateDeleted(
    intent: RecreateDeletedIntent,
    message: string,
    outcome: 'conflict' | 'unknown' | 'failed',
  ): boolean {
    const session = this.session(intent.workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== intent.path || tab.lifecycleId !== intent.lifecycleId
        || tab.pendingSaveId !== intent.requestId
        || editableLineEnding(tab) !== intent.lineEnding
        || !this.acceptsResource(intent.workspaceId, intent.path, intent.resourceGeneration)) return tab
      applied = true
      return {
        ...withoutOptional(tab, 'pendingSaveId', 'saveOutcome', 'unknownSave'),
        externalState: 'deleted',
        saveError: message,
        ...(outcome === 'unknown' ? {
          saveOutcome: 'unknown' as const,
          unknownSave: {
            kind: 'create' as const,
            content: intent.content,
            lineEnding: intent.lineEnding,
          },
        } : {}),
      }
    })
    if (applied) this.replaceWorkspace(intent.workspaceId, { ...session, tabs })
    return applied
  }

  reconcileMissingSaveOutcome(
    workspaceId: string,
    path: string,
    lifecycleId: number,
  ): 'not-committed' | 'stale' {
    const session = this.session(workspaceId)
    let applied = false
    const tabs = session.tabs.map((tab): EditorTab => {
      if (tab.path !== path || tab.lifecycleId !== lifecycleId || tab.pendingConflictId !== undefined
        || tab.saveOutcome !== 'unknown' || tab.unknownSave?.kind !== 'create'
        || editableLineEnding(tab) !== tab.unknownSave.lineEnding) return tab
      applied = true
      return {
        ...withoutOptional(tab, 'saveOutcome', 'saveError', 'unknownSave'),
        externalState: 'deleted',
      }
    })
    if (applied) this.replaceWorkspace(workspaceId, { ...session, tabs })
    return applied ? 'not-committed' : 'stale'
  }

  hasDirtyDocuments(): boolean {
    for (const session of this.snapshot.workspaces.values()) {
      if (session.tabs.some(tab => tab.dirty)) return true
    }
    return false
  }
}
