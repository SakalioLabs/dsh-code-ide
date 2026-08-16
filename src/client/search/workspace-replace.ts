import type { DocumentFilePort } from '../documents/controller.ts'
import {
  type DocumentReplacementCapture,
  type DocumentReplacementIntent,
  type DocumentReplacementTarget,
  type DocumentSessionStore,
} from '../documents/session.ts'
import { searchTextContent, type WorkspaceTextSearchQuery } from '../../shared/workspace-search.ts'
import { WorkspaceSearchStore } from './workspace-search.ts'
import { normalizeEditableText } from '../documents/text-content.ts'

export const MAX_WORKSPACE_REPLACE_FILES = 64
export const MAX_WORKSPACE_REPLACEMENTS = 500
export const MAX_WORKSPACE_REPLACE_FILE_UTF8_BYTES = 4 * 1024 * 1024
export const MAX_WORKSPACE_REPLACE_TOTAL_UTF8_BYTES = 8 * 1024 * 1024
export const MAX_WORKSPACE_REPLACEMENT_UTF8_BYTES = 64 * 1024

export type WorkspaceReplacePhase = 'idle' | 'previewing' | 'ready' | 'applying' | 'complete' | 'error'

export interface WorkspaceReplacePreviewChange {
  readonly id: string
  readonly line: number
  /** One-based UTF-16 column of the first replacement on this line. */
  readonly column: number
  readonly before: string
  readonly after: string
}

export interface WorkspaceReplacePreviewGroup {
  readonly path: string
  readonly source: 'buffer' | 'disk'
  readonly changes: readonly WorkspaceReplacePreviewChange[]
}

export interface WorkspaceReplacePreview {
  readonly token: string
  readonly groups: readonly WorkspaceReplacePreviewGroup[]
  readonly replacementCount: number
  readonly fileCount: number
}

export interface WorkspaceReplaceSnapshot {
  readonly activeWorkspaceId?: string
  readonly activeWorkspaceEpoch: number
  readonly phase: WorkspaceReplacePhase
  readonly replacement: string
  readonly preview?: WorkspaceReplacePreview
  readonly error?: string
}

export interface WorkspaceReplaceIntent {
  readonly token: string
  readonly requestId: number
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly searchWorkspaceEpoch: number
  readonly documentWorkspaceEpoch: number
  readonly searchRequestGeneration: number
  readonly query: WorkspaceTextSearchQuery
  readonly replacement: string
}

export type WorkspaceReplacePreviewResult = 'ready' | 'empty' | 'rejected' | 'stale'
export type WorkspaceReplaceApplyResult = 'applied' | 'not-ready' | 'stale'

type Listener = () => void

function copyQuery(query: WorkspaceTextSearchQuery): WorkspaceTextSearchQuery {
  return {
    pattern: query.pattern,
    mode: query.mode,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    ...(query.include === undefined ? {} : { include: [...query.include] }),
    ...(query.exclude === undefined ? {} : { exclude: [...query.exclude] }),
  }
}

function sameQuery(left: WorkspaceTextSearchQuery, right: WorkspaceTextSearchQuery): boolean {
  return left.pattern === right.pattern && left.mode === right.mode
    && left.caseSensitive === right.caseSensitive && left.wholeWord === right.wholeWord
    && (left.include ?? []).join('\0') === (right.include ?? []).join('\0')
    && (left.exclude ?? []).join('\0') === (right.exclude ?? []).join('\0')
}

/** Small observable state machine; I/O and replacement plans remain in the controller. */
export class WorkspaceReplaceStore {
  private snapshot: WorkspaceReplaceSnapshot = {
    activeWorkspaceEpoch: 0,
    phase: 'idle',
    replacement: '',
  }
  private requestSequence = 0
  private readonly listeners = new Set<Listener>()

  readonly getSnapshot = (): WorkspaceReplaceSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.snapshot.activeWorkspaceId === workspaceId) return
    this.requestSequence += 1
    this.publish({
      ...(workspaceId === undefined ? {} : { activeWorkspaceId: workspaceId }),
      activeWorkspaceEpoch: this.snapshot.activeWorkspaceEpoch + 1,
      phase: 'idle',
      replacement: '',
    })
  }

  begin(
    workspaceId: string,
    searchWorkspaceEpoch: number,
    documentWorkspaceEpoch: number,
    searchRequestGeneration: number,
    query: WorkspaceTextSearchQuery,
    replacement: string,
  ): WorkspaceReplaceIntent | undefined {
    if (this.snapshot.activeWorkspaceId !== workspaceId) return undefined
    const requestId = ++this.requestSequence
    const intent: WorkspaceReplaceIntent = {
      token: `replace-${String(requestId)}`,
      requestId,
      workspaceId,
      workspaceEpoch: this.snapshot.activeWorkspaceEpoch,
      searchWorkspaceEpoch,
      documentWorkspaceEpoch,
      searchRequestGeneration,
      query: copyQuery(query),
      replacement,
    }
    this.publish({
      activeWorkspaceId: workspaceId,
      activeWorkspaceEpoch: intent.workspaceEpoch,
      phase: 'previewing',
      replacement,
    })
    return intent
  }

  reject(replacement: string, error: string): void {
    this.requestSequence += 1
    this.publish({ ...this.snapshot, phase: 'error', replacement, error })
  }

  isCurrent(intent: WorkspaceReplaceIntent): boolean {
    return this.snapshot.activeWorkspaceId === intent.workspaceId
      && this.snapshot.activeWorkspaceEpoch === intent.workspaceEpoch
      && this.requestSequence === intent.requestId
  }

  ready(intent: WorkspaceReplaceIntent, preview: WorkspaceReplacePreview): boolean {
    if (!this.isCurrent(intent) || this.snapshot.phase !== 'previewing') return false
    this.publish({ ...this.snapshot, phase: 'ready', preview })
    return true
  }

  beginApply(intent: WorkspaceReplaceIntent, token: string): boolean {
    if (!this.isCurrent(intent) || this.snapshot.phase !== 'ready'
      || this.snapshot.preview?.token !== token) return false
    this.publish({ ...this.snapshot, phase: 'applying' })
    return true
  }

  complete(intent: WorkspaceReplaceIntent): boolean {
    if (!this.isCurrent(intent) || this.snapshot.phase !== 'applying') return false
    this.publish({ ...this.snapshot, phase: 'complete' })
    return true
  }

  fail(intent: WorkspaceReplaceIntent, error: string): boolean {
    if (!this.isCurrent(intent)) return false
    this.publish({ ...this.snapshot, phase: 'error', error })
    return true
  }

  cancel(): void {
    this.requestSequence += 1
    this.publish({
      ...(this.snapshot.activeWorkspaceId === undefined
        ? {}
        : { activeWorkspaceId: this.snapshot.activeWorkspaceId }),
      activeWorkspaceEpoch: this.snapshot.activeWorkspaceEpoch,
      phase: 'idle',
      replacement: this.snapshot.replacement,
    })
  }

  private publish(snapshot: WorkspaceReplaceSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

interface ContentReplacement {
  readonly content: string
  readonly changes: readonly WorkspaceReplacePreviewChange[]
  readonly replacementCount: number
}

function validText(value: string, maximumBytes: number): boolean {
  if (value.includes('\0') || new TextEncoder().encode(value).byteLength > maximumBytes) return false
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trail = value.charCodeAt(index + 1)
      if (!(trail >= 0xdc00 && trail <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function replaceContent(
  path: string,
  content: string,
  query: WorkspaceTextSearchQuery,
  replacement: string,
): ContentReplacement {
  const matches = searchTextContent(path, content, query, {
    maxMatches: MAX_WORKSPACE_REPLACEMENTS + 1,
    maxPreviewBytes: MAX_WORKSPACE_REPLACE_FILE_UTF8_BYTES,
  })
  const found = matches.reduce((count, item) => count + item.ranges.length, 0)
  if (found > MAX_WORKSPACE_REPLACEMENTS) throw new Error('Replacement preview exceeds the 500-match limit.')
  const byLine = new Map(matches.map(item => [item.lineNumber, item.ranges]))
  const rawLines = content.split('\n')
  const output: string[] = []
  const changes: WorkspaceReplacePreviewChange[] = []
  let replacementCount = 0
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index] ?? ''
    const hasLf = index < rawLines.length - 1
    const hasCr = hasLf && raw.endsWith('\r')
    const line = hasCr ? raw.slice(0, -1) : raw
    const ranges = byLine.get(index + 1) ?? []
    let after = line
    let changedOnLine = 0
    for (let cursor = ranges.length - 1; cursor >= 0; cursor -= 1) {
      const range = ranges[cursor]
      if (range === undefined || line.slice(range.start, range.end) === replacement) continue
      after = `${after.slice(0, range.start)}${replacement}${after.slice(range.end)}`
      changedOnLine += 1
    }
    if (changedOnLine > 0) {
      const first = ranges.find(range => line.slice(range.start, range.end) !== replacement)!
      changes.push({
        id: `${encodeURIComponent(path)}:${String(index + 1)}`,
        line: index + 1,
        column: first.start + 1,
        before: line,
        after,
      })
      replacementCount += changedOnLine
    }
    output.push(`${after}${hasCr ? '\r' : ''}${hasLf ? '\n' : ''}`)
  }
  return { content: output.join(''), changes, replacementCount }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ReplacementPlan {
  readonly intent: WorkspaceReplaceIntent
  readonly documents: DocumentReplacementIntent
}

/** Preview and atomically apply a bounded workspace replacement without writing the Host. */
export class WorkspaceReplaceController {
  private plan: ReplacementPlan | undefined
  private disposed = false

  constructor(
    readonly store: WorkspaceReplaceStore,
    private readonly search: WorkspaceSearchStore,
    private readonly documents: DocumentSessionStore,
    private readonly files: Pick<DocumentFilePort, 'read'>,
  ) {}

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.disposed) return
    this.plan = undefined
    this.store.selectWorkspace(workspaceId)
  }

  async preview(replacement: string): Promise<WorkspaceReplacePreviewResult> {
    if (this.disposed) return 'rejected'
    this.plan = undefined
    if (!validText(replacement, MAX_WORKSPACE_REPLACEMENT_UTF8_BYTES)) {
      this.store.reject(replacement, 'Replacement text is invalid or exceeds 64 KiB.')
      return 'rejected'
    }
    const searchSnapshot = this.search.getSnapshot()
    const workspaceId = searchSnapshot.activeWorkspaceId
    const searchSession = this.search.session(workspaceId)
    const documentSnapshot = this.documents.getSnapshot()
    if (workspaceId === undefined || this.store.getSnapshot().activeWorkspaceId !== workspaceId
      || documentSnapshot.activeWorkspaceId !== workspaceId) {
      this.store.reject(replacement, 'Select one current workspace before replacing.')
      return 'rejected'
    }
    if (searchSession.status !== 'complete' || searchSession.query.pattern.length === 0
      || searchSession.items.length === 0) {
      this.store.reject(replacement, 'Run a non-empty search before previewing replacements.')
      return 'empty'
    }
    if (searchSession.query.mode !== 'literal') {
      this.store.reject(replacement, 'Regex replacement is not available in the bounded browser domain yet.')
      return 'rejected'
    }
    if (searchSession.truncated || searchSession.dirtyBuffersOmitted) {
      this.store.reject(replacement, 'Replacement requires complete search results with every dirty buffer included.')
      return 'rejected'
    }
    const paths = [...new Set(searchSession.items.map(item => item.path))]
    if (paths.length > MAX_WORKSPACE_REPLACE_FILES) {
      this.store.reject(replacement, 'Replacement preview exceeds the 64-file limit.')
      return 'rejected'
    }
    const intent = this.store.begin(
      workspaceId,
      searchSnapshot.activeWorkspaceEpoch,
      documentSnapshot.activeWorkspaceEpoch,
      searchSession.requestGeneration,
      searchSession.query,
      replacement,
    )
    if (intent === undefined) return 'stale'

    try {
      const captures = paths.map(path => {
        const capture = this.documents.captureDocumentReplacement(workspaceId, path, basename(path))
        if (capture === undefined) throw new Error(`Cannot replace ${path} while its document is busy or deleted.`)
        return capture
      })
      const originals = await Promise.all(captures.map(async capture => {
        if (capture.kind === 'open') return {
          content: capture.content,
          version: capture.version,
          lineEnding: capture.lineEnding,
          rawContent: undefined,
        }
        const result = await this.files.read(capture.workspaceId, capture.path)
        if (result.path !== capture.path) throw new Error('The Host returned a different replacement path.')
        if (result.readOnlyPresentation !== undefined) {
          throw new Error(`${capture.path} is binary or exceeds the editable text limit.`)
        }
        const normalized = normalizeEditableText(result.content)
        return {
          content: normalized.content,
          version: result.version,
          lineEnding: normalized.lineEnding,
          rawContent: result.content,
        }
      }))
      if (!this.store.isCurrent(intent) || !this.searchIsCurrent(intent)
        || !this.documents.isWorkspaceEpoch(intent.workspaceId, intent.documentWorkspaceEpoch)) return 'stale'

      const targets: DocumentReplacementTarget[] = []
      const groups: WorkspaceReplacePreviewGroup[] = []
      let replacementCount = 0
      let totalBytes = 0
      for (let index = 0; index < captures.length; index += 1) {
        const capture = captures[index]!
        const original = originals[index]!
        if (!validText(original.content, MAX_WORKSPACE_REPLACE_FILE_UTF8_BYTES)) {
          throw new Error(`${capture.path} exceeds the bounded text replacement limit.`)
        }
        const replaced = replaceContent(capture.path, original.content, intent.query, replacement)
        if (replaced.replacementCount === 0) continue
        if (!validText(replaced.content, MAX_WORKSPACE_REPLACE_FILE_UTF8_BYTES)) {
          throw new Error(`${capture.path} would exceed the bounded text replacement limit.`)
        }
        totalBytes += new TextEncoder().encode(original.content).byteLength
          + new TextEncoder().encode(replaced.content).byteLength
        if (totalBytes > MAX_WORKSPACE_REPLACE_TOTAL_UTF8_BYTES) {
          throw new Error('Replacement preview exceeds the 8 MiB aggregate limit.')
        }
        replacementCount += replaced.replacementCount
        if (replacementCount > MAX_WORKSPACE_REPLACEMENTS) {
          throw new Error('Replacement preview exceeds the 500-match limit.')
        }
        targets.push({
          capture,
          originalContent: original.content,
          ...(original.rawContent === undefined ? {} : { rawOriginalContent: original.rawContent }),
          version: original.version,
          replacementContent: replaced.content,
          lineEnding: original.lineEnding,
        })
        groups.push({
          path: capture.path,
          source: capture.kind === 'open' ? 'buffer' : 'disk',
          changes: replaced.changes,
        })
      }
      if (targets.length === 0) {
        this.store.fail(intent, 'The current content has no replacements that change text.')
        return 'empty'
      }
      const preview: WorkspaceReplacePreview = {
        token: intent.token,
        groups,
        replacementCount,
        fileCount: groups.length,
      }
      if (!this.store.ready(intent, preview)) return 'stale'
      this.plan = {
        intent,
        documents: {
          workspaceId: intent.workspaceId,
          workspaceEpoch: intent.documentWorkspaceEpoch,
          targets,
        },
      }
      return 'ready'
    } catch (error) {
      if (!this.store.fail(intent, errorMessage(error))) return 'stale'
      return 'rejected'
    }
  }

  async apply(token: string): Promise<WorkspaceReplaceApplyResult> {
    const plan = this.plan
    if (this.disposed || plan === undefined || !this.searchIsCurrent(plan.intent)
      || !this.store.beginApply(plan.intent, token)) return 'not-ready'
    try {
      // Closed targets are re-read before the atomic buffer transition. A changed
      // disk version/content invalidates the entire preview; no partial tabs open.
      await Promise.all(plan.documents.targets.map(async target => {
        if (target.capture.kind !== 'closed') return
        const current = await this.files.read(plan.intent.workspaceId, target.capture.path)
        const normalized = current.readOnlyPresentation === undefined
          ? normalizeEditableText(current.content)
          : undefined
        if (normalized === undefined
          || current.path !== target.capture.path || current.version !== target.version
          || current.content !== target.rawOriginalContent
          || normalized.content !== target.originalContent
          || normalized.lineEnding !== target.lineEnding) {
          throw new Error(`${target.capture.path} changed after the replacement preview.`)
        }
      }))
      if (!this.store.isCurrent(plan.intent) || !this.searchIsCurrent(plan.intent)
        || !this.documents.applyDocumentReplacements(plan.documents)) {
        this.store.fail(plan.intent, 'Replacement preview became stale; preview again before applying.')
        this.plan = undefined
        return 'stale'
      }
      this.store.complete(plan.intent)
      this.plan = undefined
      return 'applied'
    } catch (error) {
      this.store.fail(plan.intent, errorMessage(error))
      this.plan = undefined
      return 'stale'
    }
  }

  cancel(): void {
    if (this.disposed) return
    this.plan = undefined
    this.store.cancel()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.plan = undefined
    this.store.cancel()
  }

  private searchIsCurrent(intent: WorkspaceReplaceIntent): boolean {
    const snapshot = this.search.getSnapshot()
    const session = this.search.session(intent.workspaceId)
    return snapshot.activeWorkspaceId === intent.workspaceId
      && snapshot.activeWorkspaceEpoch === intent.searchWorkspaceEpoch
      && session.requestGeneration === intent.searchRequestGeneration
      && session.status === 'complete' && !session.truncated && !session.dirtyBuffersOmitted
      && sameQuery(session.query, intent.query)
  }
}
