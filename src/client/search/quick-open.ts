import type { FindFilesResponse } from '../../shared/workspace-search.ts'
import type { EditorLocation } from '../navigation/editor-navigation.ts'

export type QuickOpenStatus = 'idle' | 'debouncing' | 'running' | 'complete' | 'empty' | 'error'

export interface QuickOpenItem {
  readonly path: string
  /** Larger values are better. Only meaningful within the current result set. */
  readonly score: number
  readonly positions: readonly number[]
}

export interface QuickOpenSnapshot {
  readonly workspaceId?: string
  readonly workspaceEpoch: number
  readonly requestGeneration: number
  readonly query: string
  readonly status: QuickOpenStatus
  readonly items: readonly QuickOpenItem[]
  readonly selectedIndex: number
  readonly incomplete: boolean
  readonly error?: string
}

export interface QuickOpenIntent {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly requestGeneration: number
  /** Trimmed user input, including an optional location suffix. */
  readonly query: string
  /** The portion sent to Host search and client fuzzy ranking. */
  readonly fileQuery: string
  readonly location?: EditorLocation
}

export interface FindFilesPort {
  findFiles(workspaceId: string, query: string, signal?: AbortSignal): Promise<FindFilesResponse>
}

export interface DebounceScheduler {
  after(milliseconds: number, callback: () => void): () => void
}

type Listener = () => void

function withoutError(snapshot: QuickOpenSnapshot): QuickOpenSnapshot {
  const { error: _error, ...current } = snapshot
  return current
}

function normalized(value: string): string {
  return value.toLowerCase()
}

export interface ParsedQuickOpenQuery {
  readonly fileQuery: string
  readonly location?: EditorLocation
}

function positiveSafeInteger(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined
}

/** Parse a rightmost VS Code-style `file:line[:column]` suffix. */
export function parseQuickOpenQuery(raw: string): ParsedQuickOpenQuery {
  const query = raw.trim()
  const pair = /^(.*):(\d+):(\d+)$/u.exec(query)
  if (pair !== null) {
    const fileQuery = pair[1]?.trim() ?? ''
    const lineNumber = positiveSafeInteger(pair[2] ?? '')
    const columnNumber = positiveSafeInteger(pair[3] ?? '')
    if (fileQuery.length > 0 && lineNumber !== undefined && columnNumber !== undefined) {
      return { fileQuery, location: { lineNumber, columnNumber } }
    }
    return { fileQuery: query }
  }

  const line = /^(.*):(\d+)$/u.exec(query)
  if (line !== null) {
    const fileQuery = line[1]?.trim() ?? ''
    const lineNumber = positiveSafeInteger(line[2] ?? '')
    if (fileQuery.length > 0 && lineNumber !== undefined) {
      return { fileQuery, location: { lineNumber, columnNumber: 1 } }
    }
  }
  return { fileQuery: query }
}

function pathBoundary(value: string, index: number): boolean {
  if (index === 0) return true
  const previous = value[index - 1]
  return previous === '/' || previous === '\\' || previous === '-' || previous === '_' || previous === '.' || previous === ' '
}

/** Deterministic client-side fuzzy scoring; ties retain Host result order. */
export function fuzzyQuickOpenMatch(path: string, query: string): Omit<QuickOpenItem, 'path'> | undefined {
  const needle = normalized(query.trim())
  if (needle.length === 0) return { score: 0, positions: [] }
  const candidate = normalized(path)
  const positions: number[] = []
  let cursor = 0
  for (const character of needle) {
    const position = candidate.indexOf(character, cursor)
    if (position < 0) return undefined
    positions.push(position)
    cursor = position + 1
  }

  let score = 0
  let previous = -2
  const basenameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
  for (const position of positions) {
    score += 10
    if (position === previous + 1) score += 14
    if (pathBoundary(path, position)) score += 18
    if (position >= basenameStart) score += 6
    previous = position
  }
  const contiguous = candidate.indexOf(needle)
  if (contiguous >= 0) score += contiguous === basenameStart ? 80 : 35
  if (candidate.slice(basenameStart) === needle) score += 120
  score -= Math.min(40, path.length - needle.length)
  return { score, positions }
}

export function rankQuickOpenItems(
  files: readonly { readonly path: string }[],
  query: string,
): QuickOpenItem[] {
  return files.flatMap((file, index) => {
    const match = fuzzyQuickOpenMatch(file.path, query)
    return match === undefined ? [] : [{ ...match, path: file.path, index }]
  }).sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...item }) => item)
}

export class QuickOpenStore {
  private snapshot: QuickOpenSnapshot = {
    workspaceEpoch: 0,
    requestGeneration: 0,
    query: '',
    status: 'idle',
    items: [],
    selectedIndex: -1,
    incomplete: false,
  }
  private readonly listeners = new Set<Listener>()

  readonly getSnapshot = (): QuickOpenSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.snapshot.workspaceId === workspaceId) return
    this.publish({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      workspaceEpoch: this.snapshot.workspaceEpoch + 1,
      requestGeneration: this.snapshot.requestGeneration + 1,
      query: '', status: 'idle', items: [], selectedIndex: -1, incomplete: false,
    })
  }

  setQuery(query: string): QuickOpenIntent | undefined {
    const requestGeneration = this.snapshot.requestGeneration + 1
    const parsed = parseQuickOpenQuery(query)
    if (parsed.fileQuery.length === 0 || this.snapshot.workspaceId === undefined) {
      this.publish({
        ...withoutError(this.snapshot),
        query,
        requestGeneration,
        status: 'idle', items: [], selectedIndex: -1, incomplete: false,
      })
      return undefined
    }
    const intent: QuickOpenIntent = {
      workspaceId: this.snapshot.workspaceId,
      workspaceEpoch: this.snapshot.workspaceEpoch,
      requestGeneration,
      query: query.trim(),
      fileQuery: parsed.fileQuery,
      ...(parsed.location === undefined ? {} : { location: parsed.location }),
    }
    this.publish({
      ...withoutError(this.snapshot),
      query,
      requestGeneration,
      status: 'debouncing', items: [], selectedIndex: -1, incomplete: false,
    })
    return intent
  }

  begin(intent: QuickOpenIntent): boolean {
    if (!this.accepts(intent)) return false
    this.publish({ ...withoutError(this.snapshot), status: 'running' })
    return true
  }

  complete(intent: QuickOpenIntent, response: FindFilesResponse): boolean {
    if (!this.accepts(intent)) return false
    const items = rankQuickOpenItems(response.items, intent.fileQuery)
    this.publish({
      ...withoutError(this.snapshot),
      status: items.length === 0 ? 'empty' : 'complete',
      items,
      selectedIndex: items.length === 0 ? -1 : 0,
      incomplete: response.incomplete,
    })
    return true
  }

  fail(intent: QuickOpenIntent, error: string): boolean {
    if (!this.accepts(intent)) return false
    this.publish({
      ...this.snapshot, status: 'error', items: [], selectedIndex: -1, incomplete: false, error,
    })
    return true
  }

  moveSelection(delta: number): QuickOpenItem | undefined {
    const { items } = this.snapshot
    if (items.length === 0 || !Number.isFinite(delta)) return undefined
    const current = this.snapshot.selectedIndex < 0 ? 0 : this.snapshot.selectedIndex
    const selectedIndex = ((current + Math.trunc(delta)) % items.length + items.length) % items.length
    if (selectedIndex !== this.snapshot.selectedIndex) this.publish({ ...this.snapshot, selectedIndex })
    return items[selectedIndex]
  }

  selectIndex(index: number): QuickOpenItem | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.snapshot.items.length) return undefined
    if (index !== this.snapshot.selectedIndex) this.publish({ ...this.snapshot, selectedIndex: index })
    return this.snapshot.items[index]
  }

  activeItem(): QuickOpenItem | undefined {
    return this.snapshot.items[this.snapshot.selectedIndex]
  }

  private accepts(intent: QuickOpenIntent): boolean {
    return this.snapshot.workspaceId === intent.workspaceId
      && this.snapshot.workspaceEpoch === intent.workspaceEpoch
      && this.snapshot.requestGeneration === intent.requestGeneration
  }

  private publish(snapshot: QuickOpenSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

function browserScheduler(): DebounceScheduler {
  return {
    after: (milliseconds, callback) => {
      const handle = globalThis.setTimeout(callback, milliseconds)
      return () => { globalThis.clearTimeout(handle) }
    },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class QuickOpenController {
  private readonly debounceMs: number
  private readonly scheduler: DebounceScheduler
  private cancelDelay: (() => void) | undefined
  private request: AbortController | undefined
  private disposed = false

  constructor(
    readonly store: QuickOpenStore,
    private readonly files: FindFilesPort,
    options: { debounceMs?: number; scheduler?: DebounceScheduler } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 120
    if (!Number.isSafeInteger(this.debounceMs) || this.debounceMs < 0) {
      throw new Error('Quick Open debounce must be a non-negative integer.')
    }
    this.scheduler = options.scheduler ?? browserScheduler()
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.disposed) return
    this.cancelPending()
    this.store.selectWorkspace(workspaceId)
  }

  setQuery(query: string): void {
    if (this.disposed) return
    this.cancelPending()
    const intent = this.store.setQuery(query)
    if (intent === undefined) return
    this.cancelDelay = this.scheduler.after(this.debounceMs, () => {
      this.cancelDelay = undefined
      void this.run(intent)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPending()
  }

  private cancelPending(): void {
    this.cancelDelay?.()
    this.cancelDelay = undefined
    this.request?.abort()
    this.request = undefined
  }

  private async run(intent: QuickOpenIntent): Promise<void> {
    if (this.disposed || !this.store.begin(intent)) return
    const request = new AbortController()
    this.request = request
    try {
      const response = await this.files.findFiles(intent.workspaceId, intent.fileQuery, request.signal)
      if (!this.disposed && !request.signal.aborted) this.store.complete(intent, response)
    } catch (error) {
      if (!this.disposed && !request.signal.aborted) this.store.fail(intent, message(error))
    } finally {
      if (this.request === request) this.request = undefined
    }
  }
}
