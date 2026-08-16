import { lstat } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  textSearchPreview,
  validateSearchGlobs,
  type FindFilesResponse,
  type SearchTextResponse,
  type TextSearchItem,
  type TextSearchRange,
  type WorkspaceTextSearchQuery,
} from '../shared/workspace-search.js'
import type {
  HostLogger,
  HostSubprocessHandle,
  HostSubprocessRuntime,
  HostWorkspace,
  HostWorkspaceRegistry,
} from './contracts.js'
import { IdeHostError } from './errors.js'
import { parseWorkspacePath, resolveWorkspacePath, resolveWorkspaceRoot, type ResolvedWorkspaceRoot } from './path-policy.js'

export const DEFAULT_SEARCH_LIMITS = Object.freeze({
  maxFileResults: 200,
  maxTextResults: 500,
  maxCandidates: 50_000,
  maxRawBytes: 8 * 1024 * 1024,
  maxPreviewBytes: 2 * 1024,
  maxQueryBytes: 8 * 1024,
  maxLineBytes: 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxConcurrent: 2,
  timeoutMs: 30_000,
  terminationGraceMs: 1_000,
})

export interface WorkspaceSearchOptions {
  maxFileBytes: number
  maxFileResults: number
  maxTextResults: number
  maxCandidates: number
  maxRawBytes: number
  maxPreviewBytes: number
  maxQueryBytes: number
  maxLineBytes: number
  maxResponseBytes: number
  maxConcurrent: number
  timeoutMs: number
  terminationGraceMs: number
  logger: HostLogger
}

/** Deterministic packaging seam; production lazily resolves the bundled rg. */
export interface WorkspaceSearchInternals {
  resolveRipgrepPath?: () => Promise<string>
}

const ABORT_CALLER = 'caller'
const ABORT_DEADLINE = 'deadline'
const ABORT_DISPOSE = 'dispose'
const UTF8 = new TextDecoder('utf-8', { fatal: true })
let bundledRipgrepPath: Promise<string> | undefined

/** Keep platform optional-package failure behind the search capability. */
async function resolveBundledRipgrepPath(): Promise<string> {
  bundledRipgrepPath ??= import('@vscode/ripgrep').then(module => module.rgPath)
  return await bundledRipgrepPath
}

interface ActiveSearch {
  controller: AbortController
  settled: Promise<void>
  cleanupFailure?: unknown
}

interface RgOutput {
  stdout: string
  exitCode: number | null
}

class SearchTreeSettlementError extends Error {
  constructor(cause: unknown) {
    super('Workspace search process-tree settlement failed.', { cause })
    this.name = 'SearchTreeSettlementError'
  }
}

function workspaceId(workspace: HostWorkspace): string {
  return String(workspace.id)
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function decodeRgBytes(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new IdeHostError('SEARCH_FAILED', `ripgrep returned an invalid ${name}.`, 500)
  try {
    return UTF8.decode(Buffer.from(value, 'base64'))
  } catch (error) {
    throw new IdeHostError('SEARCH_FAILED', `ripgrep returned a non-UTF-8 ${name}.`, 500, { cause: error })
  }
}

function rgText(value: unknown, name: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IdeHostError('SEARCH_FAILED', `ripgrep returned an invalid ${name}.`, 500)
  }
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (record.bytes !== undefined) return decodeRgBytes(record.bytes, name)
  throw new IdeHostError('SEARCH_FAILED', `ripgrep omitted ${name}.`, 500)
}

function queryBytes(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? '')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Convert an exact UTF-8 byte boundary into a UTF-16 column. */
export function utf8ByteOffsetToUtf16(value: string, byteOffset: number): number {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned an invalid match range.', 500)
  }
  let bytes = 0
  let utf16 = 0
  for (const point of value) {
    if (bytes === byteOffset) return utf16
    bytes += byteLength(point)
    utf16 += point.length
    if (bytes > byteOffset) break
  }
  if (bytes === byteOffset) return utf16
  throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned a match range outside a UTF-8 boundary.', 500)
}

function validateTextQuery(value: unknown, maxBytes: number): WorkspaceTextSearchQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || queryBytes(value) > maxBytes) {
    throw new IdeHostError('SEARCH_INVALID_QUERY', 'Search query is invalid or exceeds its byte limit.')
  }
  const query = value as Record<string, unknown>
  if (typeof query.pattern !== 'string' || query.pattern.length === 0 || query.pattern.includes('\0')) {
    throw new IdeHostError('SEARCH_INVALID_QUERY', 'Search pattern must be a non-empty string.')
  }
  if (query.mode !== 'literal' && query.mode !== 'regex') {
    throw new IdeHostError('SEARCH_INVALID_QUERY', 'Search mode must be literal or regex.')
  }
  if (typeof query.caseSensitive !== 'boolean' || typeof query.wholeWord !== 'boolean') {
    throw new IdeHostError('SEARCH_INVALID_QUERY', 'Search flags must be boolean.')
  }
  let include: string[]
  let exclude: string[]
  try {
    include = validateSearchGlobs(query.include, 'include')
    exclude = validateSearchGlobs(query.exclude, 'exclude')
  } catch (error) {
    throw new IdeHostError('SEARCH_INVALID_PATTERN', 'Search file glob is invalid.', 400, { cause: error })
  }
  return {
    pattern: query.pattern,
    mode: query.mode,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    ...(include.length === 0 ? {} : { include }),
    ...(exclude.length === 0 ? {} : { exclude }),
  }
}

function fuzzyScore(path: string, query: string): number | undefined {
  const candidate = path.toLowerCase()
  const needle = query.toLowerCase()
  const direct = candidate.indexOf(needle)
  if (direct >= 0) return direct * 4 + candidate.length - needle.length
  let cursor = 0
  let gap = 0
  for (const character of needle) {
    const next = candidate.indexOf(character, cursor)
    if (next < 0) return undefined
    gap += next - cursor
    cursor = next + character.length
  }
  return 10_000 + gap * 4 + candidate.length
}

function normalizeRgPath(value: string): string {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) {
    throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned a path outside the workspace.', 500)
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  return parseWorkspacePath(normalized, { allowRoot: false })
}

/** Decode a bounded prefix of rg's NUL-delimited path protocol. */
export function parseNulPathRecords(value: string, maxRecords = Number.MAX_SAFE_INTEGER): string[] {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    throw new IdeHostError('SEARCH_FAILED', 'Invalid workspace search candidate limit.', 500)
  }
  if (value.length === 0) return []
  if (!value.endsWith('\0')) {
    throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned malformed file framing.', 500)
  }
  const records: string[] = []
  let offset = 0
  while (records.length < maxRecords && offset < value.length) {
    const end = value.indexOf('\0', offset)
    if (end < 0) throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned malformed file framing.', 500)
    records.push(value.slice(offset, end))
    offset = end + 1
  }
  return records
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned malformed JSON.', 500, { cause: error })
  }
}

function stripLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

interface ByteMatchRange {
  start: number
  end: number
}

interface BoundedMatchRanges {
  ranges: TextSearchRange[]
  incomplete: boolean
}

function utf8CodePointBytes(point: string): number {
  const value = point.codePointAt(0) ?? 0
  return value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4
}

/** Validate every byte range, but map only the bounded prefix in one line scan. */
function matchRanges(
  value: unknown,
  line: string,
  maxRanges: number,
  signal: AbortSignal,
): BoundedMatchRanges {
  if (!Array.isArray(value)) throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned invalid submatches.', 500)
  const accepted: ByteMatchRange[] = []
  const boundaries = new Set<number>()
  let priorEnd = -1
  for (const [index, item] of value.entries()) {
    if ((index & 1023) === 0) signal.throwIfAborted()
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned an invalid submatch.', 500)
    }
    const record = item as Record<string, unknown>
    if (typeof record.start !== 'number' || !Number.isSafeInteger(record.start) || record.start < 0
      || typeof record.end !== 'number' || !Number.isSafeInteger(record.end) || record.end < record.start
      || record.start < priorEnd) {
      throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned an invalid submatch.', 500)
    }
    const range = { start: record.start, end: record.end }
    if (accepted.length < maxRanges) {
      accepted.push(range)
      boundaries.add(range.start)
      boundaries.add(range.end)
    }
    priorEnd = range.end
  }

  const columns = new Map<number, number>()
  let bytes = 0
  let utf16 = 0
  const recordBoundary = (): void => {
    if (!boundaries.delete(bytes)) return
    columns.set(bytes, utf16)
  }
  recordBoundary()
  let scanned = 0
  for (const point of line) {
    if ((scanned & 0x3fff) === 0) signal.throwIfAborted()
    scanned += point.length
    bytes += utf8CodePointBytes(point)
    utf16 += point.length
    recordBoundary()
  }
  if (boundaries.size > 0) {
    throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned a match range outside a UTF-8 boundary.', 500)
  }
  return {
    ranges: accepted.map(range => ({
      start: columns.get(range.start)!,
      end: columns.get(range.end)!,
    })),
    incomplete: accepted.length < value.length,
  }
}

/** Bounded one-shot workspace path and text search over Harness subprocess. */
export class WorkspaceSearchService {
  private readonly active = new Set<ActiveSearch>()
  private disposing = false

  constructor(
    private readonly registry: HostWorkspaceRegistry,
    private readonly subprocess: HostSubprocessRuntime,
    private readonly options: WorkspaceSearchOptions,
    private readonly internals: WorkspaceSearchInternals = {},
  ) {}

  async findFiles(id: unknown, queryValue: unknown, callerSignal?: AbortSignal): Promise<FindFilesResponse> {
    if (typeof queryValue !== 'string' || queryValue.length === 0 || queryValue.includes('\0')
      || byteLength(queryValue) > this.options.maxQueryBytes) {
      throw new IdeHostError('SEARCH_INVALID_QUERY', 'Quick Open query must be a non-empty bounded string.')
    }
    return await this.run(callerSignal, async signal => {
      const { workspace, root } = await this.workspace(id)
      const output = await this.execute(root, ['--files', '--null', '--', '.'], signal)
      signal.throwIfAborted()
      if (output.exitCode !== 0 && output.exitCode !== 1) throw this.failed(signal)
      const rawPaths = parseNulPathRecords(output.stdout, this.options.maxCandidates + 1)
      let incomplete = rawPaths.length > this.options.maxCandidates
      const scored: Array<{ path: string; score: number }> = []
      for (const rawPath of rawPaths.slice(0, this.options.maxCandidates)) {
        signal.throwIfAborted()
        const path = await this.validateOutputPath(root, rawPath)
        const score = fuzzyScore(path, queryValue)
        if (score !== undefined) scored.push({ path, score })
      }
      signal.throwIfAborted()
      scored.sort((left, right) => left.score - right.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      if (scored.length > this.options.maxFileResults) incomplete = true
      return {
        items: scored.slice(0, this.options.maxFileResults).map(({ path }) => ({ path })),
        incomplete,
        limit: this.options.maxFileResults,
      }
    })
  }

  async searchText(id: unknown, queryValue: unknown, callerSignal?: AbortSignal): Promise<SearchTextResponse> {
    const query = validateTextQuery(queryValue, this.options.maxQueryBytes)
    return await this.run(callerSignal, async signal => {
      const { root } = await this.workspace(id)
      const argv = [
        '--json',
        '--crlf',
        `--max-filesize=${String(this.options.maxFileBytes)}`,
        query.mode === 'literal' ? '--fixed-strings' : undefined,
        query.caseSensitive ? '--case-sensitive' : '--ignore-case',
        query.wholeWord ? '--word-regexp' : undefined,
        ...(query.include ?? []).map(glob => `--glob=${glob}`),
        ...(query.exclude ?? []).map(glob => `--glob=!${glob}`),
        `--regexp=${query.pattern}`,
        '--',
        '.',
      ].filter((value): value is string => value !== undefined)
      const output = await this.execute(root, argv, signal)
      signal.throwIfAborted()
      if (output.exitCode !== 0 && output.exitCode !== 1) {
        if (query.mode === 'regex' && output.exitCode === 2) {
          throw new IdeHostError('SEARCH_INVALID_PATTERN', 'Search regular expression is invalid.')
        }
        throw this.failed(signal)
      }
      return await this.parseTextOutput(root, output.stdout, signal)
    })
  }

  async dispose(): Promise<void> {
    this.disposing = true
    const active = [...this.active]
    for (const operation of active) operation.controller.abort(ABORT_DISPOSE)
    await Promise.allSettled(active.map(operation => operation.settled))
    const failures = active.flatMap(operation => operation.cleanupFailure === undefined
      ? []
      : [operation.cleanupFailure])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Workspace search process-tree cleanup failed.')
    }
  }

  private requireWorkspace(value: unknown): HostWorkspace {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new IdeHostError('INVALID_WORKSPACE_ID', 'workspaceId must be a non-empty string.')
    }
    const workspace = this.registry.list().find(item => workspaceId(item) === value)
    if (workspace === undefined) throw new IdeHostError('WORKSPACE_NOT_FOUND', 'Unknown workspace.', 404)
    return workspace
  }

  private async workspace(value: unknown): Promise<{ workspace: HostWorkspace; root: ResolvedWorkspaceRoot }> {
    const workspace = this.requireWorkspace(value)
    return { workspace, root: await resolveWorkspaceRoot(workspace.path) }
  }

  private async run<T>(callerSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposing) throw new IdeHostError('SEARCH_UNAVAILABLE', 'Workspace search is stopping.', 503)
    if (callerSignal?.aborted === true) throw new IdeHostError('SEARCH_ABORTED', 'Workspace search was cancelled.', 499)
    if (this.active.size >= this.options.maxConcurrent) {
      throw new IdeHostError('SEARCH_CAPACITY', 'Too many workspace searches are running.', 429)
    }
    const controller = new AbortController()
    const abortCaller = (): void => { controller.abort(ABORT_CALLER) }
    callerSignal?.addEventListener('abort', abortCaller, { once: true })
    const deadline = setTimeout(() => { controller.abort(ABORT_DEADLINE) }, this.options.timeoutMs)
    deadline.unref()
    const operation: ActiveSearch = { controller, settled: Promise.resolve() }
    this.active.add(operation)
    const settled = (async () => {
      try {
        return await task(controller.signal)
      } catch (error) {
        if (error instanceof SearchTreeSettlementError) {
          const projected = new IdeHostError(
            'SEARCH_FAILED',
            'Workspace search process cleanup could not be confirmed.',
            500,
            { cause: error },
          )
          operation.cleanupFailure = projected
          throw projected
        }
        if (controller.signal.aborted) throw this.failed(controller.signal)
        throw error
      } finally {
        clearTimeout(deadline)
        callerSignal?.removeEventListener('abort', abortCaller)
        // An unconfirmed tree keeps consuming its reservation. Releasing it
        // would let future searches exceed the proven process-tree capacity.
        if (operation.cleanupFailure === undefined) this.active.delete(operation)
      }
    })()
    operation.settled = settled.then(() => undefined, () => undefined)
    return await settled
  }

  private failed(signal: AbortSignal): IdeHostError {
    if (signal.reason === ABORT_DEADLINE) return new IdeHostError('SEARCH_TIMEOUT', 'Workspace search exceeded its deadline.', 408)
    if (signal.reason === ABORT_DISPOSE || this.disposing) return new IdeHostError('SEARCH_UNAVAILABLE', 'Workspace search is stopping.', 503)
    if (signal.aborted) return new IdeHostError('SEARCH_ABORTED', 'Workspace search was cancelled.', 499)
    return new IdeHostError('SEARCH_FAILED', 'Workspace search failed.', 500)
  }

  private async execute(root: ResolvedWorkspaceRoot, args: readonly string[], signal: AbortSignal): Promise<RgOutput> {
    let handle: HostSubprocessHandle | undefined
    try {
      let configuredRipgrep: string
      try {
        configuredRipgrep = await (this.internals.resolveRipgrepPath ?? resolveBundledRipgrepPath)()
      } catch (error) {
        this.options.logger.debug(error)
        throw new IdeHostError('SEARCH_UNAVAILABLE', 'The bundled workspace search engine is unavailable.', 503, { cause: error })
      }
      const executable = await this.subprocess.resolveExecutable(configuredRipgrep, undefined, signal)
      signal.throwIfAborted()
      handle = this.subprocess.spawn({
        argv: [executable, '--no-config', ...args],
        cwd: root.realPath,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.options.maxRawBytes },
          stderr: { maxBytes: Math.min(this.options.maxRawBytes, 64 * 1024) },
        },
        graceMs: this.options.terminationGraceMs,
        signal,
      })
      const outcome = await handle.done
      signal.throwIfAborted()
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined) throw new IdeHostError('SEARCH_FAILED', 'Workspace search output is unavailable.', 500)
      if (stdout.lossy || byteLength(stdout.text) > this.options.maxRawBytes) {
        throw new IdeHostError('SEARCH_OUTPUT_OVERFLOW', 'Workspace search output exceeded its byte limit.', 413)
      }
      return { stdout: stdout.text, exitCode: outcome.exitCode }
    } catch (error) {
      if (signal.aborted) throw this.failed(signal)
      if (error instanceof IdeHostError) throw error
      this.options.logger.debug(error)
      throw new IdeHostError('SEARCH_FAILED', 'Workspace search failed.', 500, { cause: error })
    } finally {
      // The capacity reservation remains live until the managed PROCESS TREE,
      // not merely ripgrep's direct child, is quiescent.
      if (handle !== undefined) {
        try {
          const settled = await handle.waitForExit()
          if (!settled) throw new Error('process tree did not settle')
        } catch (error) {
          this.options.logger.debug(error)
          throw new SearchTreeSettlementError(error)
        }
      }
    }
  }

  private async validateOutputPath(root: ResolvedWorkspaceRoot, value: string): Promise<string> {
    try {
      const path = normalizeRgPath(value)
      const resolved = await resolveWorkspacePath(root, path, { allowMissingFinal: false })
      const info = await lstat(resolved.absolutePath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
      return path
    } catch (error) {
      throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned an invalid workspace path.', 500, { cause: error })
    }
  }

  private async parseTextOutput(
    root: ResolvedWorkspaceRoot,
    stdout: string,
    signal: AbortSignal,
  ): Promise<SearchTextResponse> {
    const items: TextSearchItem[] = []
    const files = new Set<string>()
    let matchCount = 0
    let candidates = 0
    let responseBytes = 128
    let incomplete = false
    let offset = 0
    while (offset < stdout.length) {
      const next = stdout.indexOf('\n', offset)
      const end = next < 0 ? stdout.length : next
      const rawRecord = stdout.slice(offset, end)
      offset = next < 0 ? stdout.length : next + 1
      signal.throwIfAborted()
      if (rawRecord.length === 0) continue
      if (byteLength(rawRecord) > this.options.maxLineBytes) {
        throw new IdeHostError('SEARCH_OUTPUT_OVERFLOW', 'A workspace search record exceeded its byte limit.', 413)
      }
      const event = parseJsonRecord(rawRecord)
      if (event.type !== 'match') continue
      candidates += 1
      if (candidates > this.options.maxCandidates) {
        incomplete = true
        break
      }
      if (matchCount >= this.options.maxTextResults) {
        incomplete = true
        break
      }
      const data = event.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned invalid match data.', 500)
      }
      const match = data as Record<string, unknown>
      const path = await this.validateOutputPath(root, rgText(match.path, 'path'))
      const lineNumber = Number(match.line_number)
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        throw new IdeHostError('SEARCH_FAILED', 'ripgrep returned an invalid line number.', 500)
      }
      const line = stripLineEnding(rgText(match.lines, 'line'))
      const remaining = this.options.maxTextResults - matchCount
      const mapped = matchRanges(match.submatches, line, remaining, signal)
      const ranges = mapped.ranges
      if (mapped.incomplete) incomplete = true
      if (ranges.length === 0) continue
      const first = ranges[0]
      if (first === undefined) continue
      const preview = textSearchPreview(line, first, this.options.maxPreviewBytes)
      if (preview === undefined) {
        incomplete = true
        continue
      }
      const item: TextSearchItem = {
        path,
        lineNumber,
        preview: preview.preview,
        previewStart: preview.previewStart,
        ranges,
      }
      const itemBytes = byteLength(JSON.stringify(item)) + 1
      if (responseBytes + itemBytes > this.options.maxResponseBytes) {
        incomplete = true
        continue
      }
      responseBytes += itemBytes
      items.push(item)
      matchCount += ranges.length
      files.add(path)
    }
    signal.throwIfAborted()
    return {
      items,
      matchCount,
      fileCount: files.size,
      incomplete,
      limit: this.options.maxTextResults,
    }
  }
}
