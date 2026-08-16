import {
  MAX_CLIENT_DIRECTORY_ENTRIES,
  MAX_CLIENT_FILE_VERSION_BYTES,
} from './contracts.ts'
import {
  MAX_CLIENT_EDITABLE_FILE_BYTES,
  READ_ONLY_FILE_PREVIEW_BYTES,
  type ReadOnlyFilePresentation,
} from '../shared/workspace-files.ts'
import type {
  FileApiRequest, ListFilesResponse, ReadFileResponse, TerminalClientMessage,
  TerminalServerMessage, WorkspacesResponse, WriteFileResponse,
} from './contracts.ts'
import {
  DEFAULT_MAX_INSPECT_TARGETS,
  type InspectResponse,
  type ObservationSnapshot,
  type ObservationTarget,
} from '../shared/workspace-observation.ts'
import type {
  FindFilesResponse,
  SearchTextResponse,
  TextSearchItem,
  WorkspaceTextSearchQuery,
} from '../shared/workspace-search.ts'
import {
  decodeWorkspacePath,
  decodeWorkspacePathSegment,
} from './workspace-path.ts'
import {
  MUTATION_BUDGETS,
  WORKSPACE_MUTATIONS_ROUTE,
  type CommittedMutationReceipt,
  type MutationProtocolError,
  type MutationProtocolWarning,
  type MutationProviderResponse,
  type MutationReceipt,
  type MutateWorkspaceRequest,
  type WorkspaceMutation,
  type WorkspaceMutationResult,
} from '../shared/workspace-mutations.ts'

const FILE_ENDPOINT = '/dsh-code-ide/api'
const UTF8 = new TextEncoder()

interface ErrorDetails {
  code?: string
  message: string
}

export class ApiError extends Error {
  readonly code: string | undefined
  readonly status: number

  constructor(details: ErrorDetails, status: number) {
    super(details.message)
    this.name = 'ApiError'
    this.code = details.code
    this.status = status
  }
}

function errorDetails(value: unknown, fallback: string): ErrorDetails {
  if (typeof value !== 'object' || value === null) return { message: fallback }
  const record = value as Record<string, unknown>
  const nested = typeof record.error === 'object' && record.error !== null
    ? record.error as Record<string, unknown>
    : record
  return {
    ...(typeof nested.code === 'string' ? { code: nested.code } : {}),
    message: typeof nested.message === 'string' ? nested.message : fallback,
  }
}

async function request<T>(body: FileApiRequest, signal?: AbortSignal): Promise<T> {
  return requestEndpoint<T>(FILE_ENDPOINT, body, signal)
}

async function requestEndpoint<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    let payload: unknown
    try { payload = await response.json() } catch { payload = undefined }
    throw new ApiError(errorDetails(payload, `IDE request failed (${response.status})`), response.status)
  }
  try {
    return await response.json() as T
  } catch (error) {
    // Cancellation is a transport outcome, not evidence of a malformed Host
    // payload. Preserve it so request owners can fence stale work normally.
    if (signal?.aborted === true) throw error
    throw new ApiError({
      code: 'INVALID_RESPONSE',
      message: 'Host returned a malformed JSON response.',
    }, 502)
  }
}

function boundedWireString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0)
    && UTF8.encode(value).byteLength <= maximumBytes
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safePositiveInteger(value: unknown): value is number {
  return safeNonNegativeInteger(value) && value > 0
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && UTF8.encode(value).byteLength <= MAX_CLIENT_FILE_VERSION_BYTES
}

const LIST_RESPONSE_KEYS = new Set(['entries'])
const FILE_ENTRY_KEYS = new Set(['name', 'path', 'type', 'size', 'version'])
const READ_RESPONSE_KEYS = new Set(['path', 'content', 'version', 'readOnlyPresentation'])
const READ_ONLY_PRESENTATION_KEYS = new Set(['reason', 'sizeBytes', 'limitBytes', 'previewBytes', 'truncated'])
const WRITE_RESPONSE_KEYS = new Set(['path', 'version'])
const INSPECT_RESPONSE_KEYS = new Set(['snapshots'])
const WORKSPACES_RESPONSE_KEYS = new Set(['workspaces', 'currentWorkspaceId', 'maxTerminalSessions'])
const WORKSPACE_SUMMARY_KEYS = new Set(['workspaceId', 'title', 'path'])
const MISSING_SNAPSHOT_KEYS = new Set(['path', 'kind', 'state'])
const FILE_SNAPSHOT_KEYS = new Set(['path', 'kind', 'state', 'version', 'size'])
const DIRECTORY_SNAPSHOT_KEYS = new Set(['path', 'kind', 'state', 'version'])
const MUTATION_PROVIDER_KEYS = new Set(['providerEpoch', 'capabilities'])
const MUTATION_CAPABILITY_KEYS = new Set(['createFile', 'createDirectory', 'rename', 'delete'])
const MUTATION_RECEIPT_BASE_KEYS = new Set(['providerEpoch', 'operationId', 'state'])
const MUTATION_RECEIPT_RESULT_KEYS = new Set(['providerEpoch', 'operationId', 'state', 'result', 'warning'])
const MUTATION_RECEIPT_ERROR_KEYS = new Set(['providerEpoch', 'operationId', 'state', 'error'])
const MUTATION_CREATE_RESULT_KEYS = new Set(['kind', 'path', 'version', 'refreshDirectories'])
const MUTATION_RENAME_RESULT_KEYS = new Set(['kind', 'path', 'destinationPath', 'version', 'refreshDirectories'])
const MUTATION_DELETE_RESULT_KEYS = new Set(['kind', 'path', 'recursive', 'refreshDirectories'])
const MUTATION_MESSAGE_KEYS = new Set(['code', 'message'])
const MAX_MUTATION_REFRESH_DIRECTORIES = 4
const MAX_MUTATION_CODE_BYTES = 128
const MAX_MUTATION_MESSAGE_BYTES = 4 * 1024
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_CLIENT_WORKSPACES = 1_024
const MAX_WORKSPACE_TITLE_BYTES = 1_024
const MAX_WORKSPACE_HOST_PATH_BYTES = 16 * 1024

function validMutationUuid(value: unknown, maximumBytes: number): value is string {
  return boundedWireString(value, maximumBytes) && CANONICAL_UUID.test(value)
}

function decodeMutationMessage(
  value: unknown,
  kind: 'error' | 'warning',
): MutationProtocolError | MutationProtocolWarning | undefined {
  const message = responseRecord(value)
  if (message === undefined || !hasOnlyKeys(message, MUTATION_MESSAGE_KEYS)
    || !boundedWireString(message.code, MAX_MUTATION_CODE_BYTES)
    || !boundedWireString(message.message, MAX_MUTATION_MESSAGE_BYTES)) return undefined
  return { code: message.code, message: message.message }
}

function decodeRefreshDirectories(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MUTATION_REFRESH_DIRECTORIES) return undefined
  const directories: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const path = decodeWorkspacePath(candidate, { allowRoot: true })
    if (path === undefined || seen.has(path)) return undefined
    seen.add(path)
    directories.push(path)
  }
  return directories
}

export function decodeMutationResult(value: unknown): WorkspaceMutationResult | undefined {
  const result = responseRecord(value)
  if (result === undefined || (result.kind !== 'file' && result.kind !== 'directory')) return undefined
  const path = decodeWorkspacePath(result.path, { allowRoot: false })
  const refreshDirectories = decodeRefreshDirectories(result.refreshDirectories)
  if (path === undefined || refreshDirectories === undefined) return undefined

  if (Object.hasOwn(result, 'destinationPath')) {
    const destinationPath = decodeWorkspacePath(result.destinationPath, { allowRoot: false })
    if (!hasOnlyKeys(result, MUTATION_RENAME_RESULT_KEYS) || destinationPath === undefined
      || !validVersion(result.version)) return undefined
    return {
      kind: result.kind,
      path,
      destinationPath,
      version: result.version,
      refreshDirectories,
    }
  }
  if (Object.hasOwn(result, 'recursive')) {
    if (!hasOnlyKeys(result, MUTATION_DELETE_RESULT_KEYS) || typeof result.recursive !== 'boolean') return undefined
    return { kind: result.kind, path, recursive: result.recursive, refreshDirectories }
  }
  if (!hasOnlyKeys(result, MUTATION_CREATE_RESULT_KEYS) || !validVersion(result.version)) return undefined
  return { kind: result.kind, path, version: result.version, refreshDirectories }
}

export function decodeWorkspacesResponse(value: unknown): WorkspacesResponse | undefined {
  const response = responseRecord(value)
  if (response === undefined || !hasOnlyKeys(response, WORKSPACES_RESPONSE_KEYS)
    || !Array.isArray(response.workspaces) || response.workspaces.length > MAX_CLIENT_WORKSPACES
    || !safePositiveInteger(response.maxTerminalSessions) || response.maxTerminalSessions > 4_096) return undefined
  const workspaces: WorkspacesResponse['workspaces'] = []
  const ids = new Set<string>()
  for (const value of response.workspaces) {
    const workspace = responseRecord(value)
    if (workspace === undefined || !hasOnlyKeys(workspace, WORKSPACE_SUMMARY_KEYS)
      || !boundedWireString(workspace.workspaceId, MUTATION_BUDGETS.maxWorkspaceIdBytes)
      || !boundedWireString(workspace.title, MAX_WORKSPACE_TITLE_BYTES)
      || !boundedWireString(workspace.path, MAX_WORKSPACE_HOST_PATH_BYTES)
      || workspace.workspaceId.includes('\0') || workspace.title.includes('\0') || workspace.path.includes('\0')
      || ids.has(workspace.workspaceId)) return undefined
    ids.add(workspace.workspaceId)
    workspaces.push({ workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path })
  }
  if (response.currentWorkspaceId !== undefined
    && (!boundedWireString(response.currentWorkspaceId, MUTATION_BUDGETS.maxWorkspaceIdBytes)
      || !ids.has(response.currentWorkspaceId))) return undefined
  return {
    workspaces,
    ...(response.currentWorkspaceId === undefined ? {} : { currentWorkspaceId: response.currentWorkspaceId }),
    maxTerminalSessions: response.maxTerminalSessions,
  }
}

export function decodeMutationProviderResponse(value: unknown): MutationProviderResponse | undefined {
  const response = responseRecord(value)
  const capabilities = responseRecord(response?.capabilities)
  if (response === undefined || capabilities === undefined
    || !hasOnlyKeys(response, MUTATION_PROVIDER_KEYS)
    || !hasOnlyKeys(capabilities, MUTATION_CAPABILITY_KEYS)
    || !validMutationUuid(response.providerEpoch, MUTATION_BUDGETS.maxProviderEpochBytes)
    || typeof capabilities.createFile !== 'boolean' || typeof capabilities.createDirectory !== 'boolean'
    || typeof capabilities.rename !== 'boolean' || typeof capabilities.delete !== 'boolean') return undefined
  return {
    providerEpoch: response.providerEpoch,
    capabilities: {
      createFile: capabilities.createFile,
      createDirectory: capabilities.createDirectory,
      rename: capabilities.rename,
      delete: capabilities.delete,
    },
  }
}

export function decodeMutationReceipt(
  value: unknown,
  expected?: { readonly providerEpoch: string; readonly operationId: string },
): MutationReceipt | undefined {
  const receipt = responseRecord(value)
  if (receipt === undefined
    || !validMutationUuid(receipt.providerEpoch, MUTATION_BUDGETS.maxProviderEpochBytes)
    || !validMutationUuid(receipt.operationId, MUTATION_BUDGETS.maxOperationIdBytes)
    || (expected !== undefined && (receipt.providerEpoch !== expected.providerEpoch
      || receipt.operationId !== expected.operationId))) return undefined

  const base = {
    providerEpoch: receipt.providerEpoch,
    operationId: receipt.operationId,
  }
  if (receipt.state === 'queued' || receipt.state === 'running' || receipt.state === 'expired') {
    if (!hasOnlyKeys(receipt, MUTATION_RECEIPT_BASE_KEYS)) return undefined
    return { ...base, state: receipt.state }
  }
  if (receipt.state === 'committed') {
    if (!hasOnlyKeys(receipt, MUTATION_RECEIPT_RESULT_KEYS)) return undefined
    const result = decodeMutationResult(receipt.result)
    if (result === undefined) return undefined
    let warning: MutationProtocolWarning | undefined
    if (Object.hasOwn(receipt, 'warning')) {
      warning = decodeMutationMessage(receipt.warning, 'warning')
      if (warning === undefined) return undefined
    }
    const decoded: CommittedMutationReceipt = {
      ...base,
      state: 'committed',
      result,
      ...(warning === undefined ? {} : { warning }),
    }
    return decoded
  }
  if (receipt.state === 'notCommitted' || receipt.state === 'recoveryRequired') {
    if (!hasOnlyKeys(receipt, MUTATION_RECEIPT_ERROR_KEYS)) return undefined
    const error = decodeMutationMessage(receipt.error, 'error')
    if (error === undefined) return undefined
    return { ...base, state: receipt.state, error }
  }
  return undefined
}

export function mutationResultMatchesRequest(
  result: WorkspaceMutationResult,
  mutation: WorkspaceMutation,
): boolean {
  if (mutation.kind === 'createFile' || mutation.kind === 'createDirectory') {
    return !('destinationPath' in result) && !('recursive' in result)
      && result.path === mutation.path
      && result.kind === (mutation.kind === 'createFile' ? 'file' : 'directory')
  }
  if (mutation.kind === 'rename') {
    return 'destinationPath' in result && result.path === mutation.path
      && result.destinationPath === mutation.destinationPath && result.kind === mutation.expected.kind
  }
  return 'recursive' in result && result.path === mutation.path
    && result.recursive === mutation.recursive && result.kind === mutation.expected.kind
}

/**
 * Decode an authoritative direct-child listing. Unknown entry/envelope fields
 * reject the whole response so protocol drift cannot silently enter Explorer
 * state; optional fields are copied only after their own bounded validation.
 */
export function decodeListFilesResponse(value: unknown, requestedPath: string): ListFilesResponse | undefined {
  const parent = decodeWorkspacePath(requestedPath, { allowRoot: true })
  const response = responseRecord(value)
  if (parent === undefined || response === undefined || !hasOnlyKeys(response, LIST_RESPONSE_KEYS)
    || !Array.isArray(response.entries) || response.entries.length > MAX_CLIENT_DIRECTORY_ENTRIES) return undefined

  const entries: ListFilesResponse['entries'] = []
  const paths = new Set<string>()
  for (const value of response.entries) {
    const entry = responseRecord(value)
    if (entry === undefined || !hasOnlyKeys(entry, FILE_ENTRY_KEYS)) return undefined
    const name = decodeWorkspacePathSegment(entry.name)
    const path = decodeWorkspacePath(entry.path, { allowRoot: false })
    if (name === undefined || path === undefined || path !== (parent === '' ? name : `${parent}/${name}`)
      || paths.has(path) || (entry.type !== 'file' && entry.type !== 'directory' && entry.type !== 'other')) {
      return undefined
    }

    const hasSize = Object.hasOwn(entry, 'size')
    const hasVersion = Object.hasOwn(entry, 'version')
    if (hasSize && !safeNonNegativeInteger(entry.size)) return undefined
    if (hasVersion && !validVersion(entry.version)) return undefined
    paths.add(path)
    entries.push({
      name,
      path,
      type: entry.type,
      ...(hasSize ? { size: entry.size as number } : {}),
      ...(hasVersion ? { version: entry.version as string } : {}),
    })
  }
  return { entries }
}

export function decodeReadFileResponse(value: unknown, requestedPath: string): ReadFileResponse | undefined {
  const expectedPath = decodeWorkspacePath(requestedPath, { allowRoot: false })
  const response = responseRecord(value)
  if (expectedPath === undefined || response === undefined || !hasOnlyKeys(response, READ_RESPONSE_KEYS)
    || decodeWorkspacePath(response.path, { allowRoot: false }) !== expectedPath
    || typeof response.content !== 'string' || response.content.includes('\0')
    || !validUnicode(response.content) || !validVersion(response.version)) return undefined
  if (!Object.hasOwn(response, 'readOnlyPresentation')) {
    if (UTF8.encode(response.content).byteLength > MAX_CLIENT_EDITABLE_FILE_BYTES) return undefined
    return { path: expectedPath, content: response.content, version: response.version }
  }
  const presentation = decodeReadOnlyPresentation(response.readOnlyPresentation, response.content)
  if (presentation === undefined) return undefined
  return {
    path: expectedPath,
    content: response.content,
    version: response.version,
    readOnlyPresentation: presentation,
  }
}

function validUnicode(value: string): boolean {
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

function decodeReadOnlyPresentation(value: unknown, content: string): ReadOnlyFilePresentation | undefined {
  const presentation = responseRecord(value)
  if (presentation === undefined || !hasOnlyKeys(presentation, READ_ONLY_PRESENTATION_KEYS)
    || (presentation.reason !== 'binary' && presentation.reason !== 'too-large')
    || !safeNonNegativeInteger(presentation.sizeBytes)
    || !safePositiveInteger(presentation.limitBytes)
    || presentation.limitBytes > MAX_CLIENT_EDITABLE_FILE_BYTES
    || !safeNonNegativeInteger(presentation.previewBytes)
    || presentation.previewBytes > READ_ONLY_FILE_PREVIEW_BYTES
    || presentation.truncated !== true) return undefined
  const encodedBytes = UTF8.encode(content).byteLength
  if (encodedBytes !== presentation.previewBytes
    || presentation.previewBytes > presentation.sizeBytes
    || presentation.reason === 'binary' && (content !== '' || presentation.previewBytes !== 0)
    || presentation.reason === 'too-large' && presentation.sizeBytes <= presentation.limitBytes) return undefined
  return {
    reason: presentation.reason,
    sizeBytes: presentation.sizeBytes,
    limitBytes: presentation.limitBytes,
    previewBytes: presentation.previewBytes,
    truncated: true,
  }
}

export function decodeWriteFileResponse(value: unknown, requestedPath: string): WriteFileResponse | undefined {
  const expectedPath = decodeWorkspacePath(requestedPath, { allowRoot: false })
  const response = responseRecord(value)
  if (expectedPath === undefined || response === undefined || !hasOnlyKeys(response, WRITE_RESPONSE_KEYS)
    || decodeWorkspacePath(response.path, { allowRoot: false }) !== expectedPath
    || !validVersion(response.version)) return undefined
  return { path: expectedPath, version: response.version }
}

function normalizeInspectTargets(targets: readonly ObservationTarget[]): ObservationTarget[] | undefined {
  if (targets.length > DEFAULT_MAX_INSPECT_TARGETS) return undefined
  const normalized: ObservationTarget[] = []
  const seen = new Set<string>()
  for (const value of targets as readonly unknown[]) {
    const target = responseRecord(value)
    if (target === undefined || !hasOnlyKeys(target, new Set(['path', 'kind']))
      || (target.kind !== 'file' && target.kind !== 'directory')) return undefined
    const path = decodeWorkspacePath(target.path, { allowRoot: target.kind === 'directory' })
    if (path === undefined) return undefined
    const key = `${target.kind}\0${path}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ path, kind: target.kind })
  }
  return normalized
}

export function decodeInspectResponse(
  value: unknown,
  requestedTargets: readonly ObservationTarget[],
): InspectResponse | undefined {
  const expected = normalizeInspectTargets(requestedTargets)
  const response = responseRecord(value)
  if (expected === undefined || response === undefined || !hasOnlyKeys(response, INSPECT_RESPONSE_KEYS)
    || !Array.isArray(response.snapshots) || response.snapshots.length !== expected.length) return undefined

  const snapshots: ObservationSnapshot[] = []
  for (let index = 0; index < expected.length; index += 1) {
    const target = expected[index]
    const snapshot = responseRecord(response.snapshots[index])
    if (target === undefined || snapshot === undefined
      || snapshot.kind !== target.kind || snapshot.path !== target.path
      || decodeWorkspacePath(snapshot.path, { allowRoot: target.kind === 'directory' }) !== target.path
      || (snapshot.state !== 'missing' && snapshot.state !== 'present')) return undefined

    if (snapshot.state === 'missing') {
      if (!hasOnlyKeys(snapshot, MISSING_SNAPSHOT_KEYS)) return undefined
      snapshots.push({ path: target.path, kind: target.kind, state: 'missing' })
      continue
    }
    if (target.kind === 'file') {
      if (!hasOnlyKeys(snapshot, FILE_SNAPSHOT_KEYS)
        || !validVersion(snapshot.version) || !safeNonNegativeInteger(snapshot.size)) return undefined
      snapshots.push({
        path: target.path,
        kind: 'file',
        state: 'present',
        version: snapshot.version,
        size: snapshot.size,
      })
      continue
    }
    if (!hasOnlyKeys(snapshot, DIRECTORY_SNAPSHOT_KEYS) || !validVersion(snapshot.version)) return undefined
    snapshots.push({
      path: target.path,
      kind: 'directory',
      state: 'present',
      version: snapshot.version,
    })
  }
  return { snapshots }
}

export function decodeFindFilesResponse(value: unknown): FindFilesResponse | undefined {
  const response = responseRecord(value)
  if (response === undefined || !Array.isArray(response.items)
    || typeof response.incomplete !== 'boolean' || !safePositiveInteger(response.limit)) return undefined
  const items: Array<{ path: string }> = []
  const paths = new Set<string>()
  for (const value of response.items) {
    const item = responseRecord(value)
    const path = item === undefined ? undefined : decodeWorkspacePath(item.path, { allowRoot: false })
    if (path === undefined || paths.has(path)) return undefined
    paths.add(path)
    items.push({ path })
  }
  if (items.length > response.limit) return undefined
  return { items, incomplete: response.incomplete, limit: response.limit }
}

function decodeTextSearchItem(value: unknown): TextSearchItem | undefined {
  const item = responseRecord(value)
  const path = item === undefined ? undefined : decodeWorkspacePath(item.path, { allowRoot: false })
  if (item === undefined || path === undefined
    || !safePositiveInteger(item.lineNumber) || typeof item.preview !== 'string'
    || !safeNonNegativeInteger(item.previewStart) || !Array.isArray(item.ranges) || item.ranges.length === 0) return undefined
  const ranges: Array<{ start: number; end: number }> = []
  let previousEnd = -1
  for (const value of item.ranges) {
    const range = responseRecord(value)
    if (range === undefined || !safeNonNegativeInteger(range.start)
      || !safeNonNegativeInteger(range.end) || range.end < range.start) return undefined
    if (range.start < previousEnd) return undefined
    ranges.push({ start: range.start, end: range.end })
    previousEnd = range.end
  }
  const first = ranges[0]
  if (first === undefined || first.start < item.previewStart
    || first.end > item.previewStart + item.preview.length) return undefined
  return {
    path,
    lineNumber: item.lineNumber,
    preview: item.preview,
    previewStart: item.previewStart,
    ranges,
  }
}

export function decodeSearchTextResponse(value: unknown): SearchTextResponse | undefined {
  const response = responseRecord(value)
  if (response === undefined || !Array.isArray(response.items)
    || !safeNonNegativeInteger(response.matchCount) || !safeNonNegativeInteger(response.fileCount)
    || typeof response.incomplete !== 'boolean' || !safePositiveInteger(response.limit)) return undefined
  const items: TextSearchItem[] = []
  let matchCount = 0
  const paths = new Set<string>()
  for (const value of response.items) {
    const item = decodeTextSearchItem(value)
    if (item === undefined) return undefined
    items.push(item)
    matchCount += item.ranges.length
    paths.add(item.path)
  }
  if (matchCount !== response.matchCount || paths.size !== response.fileCount
    || response.matchCount > response.limit) return undefined
  return {
    items,
    matchCount: response.matchCount,
    fileCount: response.fileCount,
    incomplete: response.incomplete,
    limit: response.limit,
  }
}

function malformedResponse(operation: string): ApiError {
  return new ApiError({
    code: 'INVALID_RESPONSE',
    message: `Host returned a malformed ${operation} response.`,
  }, 502)
}

function requireRequestPath(value: unknown, allowRoot: boolean): string {
  const path = decodeWorkspacePath(value, { allowRoot })
  if (path === undefined) {
    throw new ApiError({
      code: 'INVALID_PATH',
      message: 'The IDE path must be a canonical workspace-relative path.',
    }, 400)
  }
  return path
}

export const fileApi = {
  async workspaces(): Promise<WorkspacesResponse> {
    const value = await request<unknown>({ op: 'workspaces' })
    const response = decodeWorkspacesResponse(value)
    if (response === undefined) throw malformedResponse('workspaces')
    return response
  },
  async list(workspaceId: string, path: string, signal?: AbortSignal): Promise<ListFilesResponse> {
    const requestedPath = requireRequestPath(path, true)
    const value = await request<unknown>({ op: 'list', workspaceId, path: requestedPath }, signal)
    const response = decodeListFilesResponse(value, requestedPath)
    if (response === undefined) throw malformedResponse('list')
    return response
  },
  async read(workspaceId: string, path: string): Promise<ReadFileResponse> {
    const requestedPath = requireRequestPath(path, false)
    const value = await request<unknown>({ op: 'read', workspaceId, path: requestedPath })
    const response = decodeReadFileResponse(value, requestedPath)
    if (response === undefined) throw malformedResponse('read')
    return response
  },
  async inspect(workspaceId: string, targets: readonly ObservationTarget[], signal?: AbortSignal): Promise<InspectResponse> {
    const normalizedTargets = normalizeInspectTargets(targets)
    if (normalizedTargets === undefined) {
      throw new ApiError({
        code: 'INVALID_INSPECT_TARGETS',
        message: `Inspect accepts at most ${String(DEFAULT_MAX_INSPECT_TARGETS)} canonical targets.`,
      }, 400)
    }
    const value = await request<unknown>({ op: 'inspect', workspaceId, targets: normalizedTargets }, signal)
    const response = decodeInspectResponse(value, normalizedTargets)
    if (response === undefined) throw malformedResponse('inspect')
    return response
  },
  async findFiles(workspaceId: string, query: string, signal?: AbortSignal): Promise<FindFilesResponse> {
    const value = await request<unknown>({ op: 'findFiles', workspaceId, query }, signal)
    const response = decodeFindFilesResponse(value)
    if (response === undefined) throw malformedResponse('findFiles')
    return response
  },
  async searchText(
    workspaceId: string,
    query: WorkspaceTextSearchQuery,
    signal?: AbortSignal,
  ): Promise<SearchTextResponse> {
    const value = await request<unknown>({ op: 'searchText', workspaceId, query }, signal)
    const response = decodeSearchTextResponse(value)
    if (response === undefined) throw malformedResponse('searchText')
    return response
  },
  async write(workspaceId: string, path: string, content: string, expectedVersion: string | undefined): Promise<WriteFileResponse> {
    const requestedPath = requireRequestPath(path, false)
    const value = await request<unknown>({
      op: 'write', workspaceId, path: requestedPath, content,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    })
    const response = decodeWriteFileResponse(value, requestedPath)
    if (response === undefined) throw malformedResponse('write')
    return response
  },
}

const CREATE_MUTATION_KEYS = new Set(['kind', 'path'])
const RENAME_MUTATION_KEYS = new Set(['kind', 'path', 'destinationPath', 'expected'])
const DELETE_MUTATION_KEYS = new Set(['kind', 'path', 'expected', 'recursive'])
const EXPECTED_RESOURCE_KEYS = new Set(['kind', 'version'])

function invalidMutationRequest(message: string): never {
  throw new ApiError({ code: 'INVALID_MUTATION_REQUEST', message }, 400)
}

function requireMutationIdentity(value: unknown, maximumBytes: number, label: string): string {
  if (!boundedWireString(value, maximumBytes)) invalidMutationRequest(`${label} must be a non-empty bounded string.`)
  return value
}

function requireMutationUuid(value: unknown, maximumBytes: number, label: string): string {
  if (!validMutationUuid(value, maximumBytes)) invalidMutationRequest(`${label} must be a canonical UUID.`)
  return value
}

function normalizeWorkspaceMutation(value: WorkspaceMutation): WorkspaceMutation {
  const mutation = responseRecord(value)
  if (mutation === undefined) invalidMutationRequest('mutation must be an object.')
  const path = decodeWorkspacePath(mutation.path, { allowRoot: false })
  if (path === undefined) invalidMutationRequest('Mutation paths must be canonical workspace-relative paths.')
  if (mutation.kind === 'createFile' || mutation.kind === 'createDirectory') {
    if (!hasOnlyKeys(mutation, CREATE_MUTATION_KEYS)) invalidMutationRequest('Create mutation shape is invalid.')
    return { kind: mutation.kind, path }
  }

  const expected = responseRecord(mutation.expected)
  if (expected === undefined || !hasOnlyKeys(expected, EXPECTED_RESOURCE_KEYS)
    || (expected.kind !== 'file' && expected.kind !== 'directory')
    || !boundedWireString(expected.version, MUTATION_BUDGETS.maxVersionBytes)) {
    invalidMutationRequest('Mutation expected identity is invalid.')
  }
  if (mutation.kind === 'rename') {
    const destinationPath = decodeWorkspacePath(mutation.destinationPath, { allowRoot: false })
    if (!hasOnlyKeys(mutation, RENAME_MUTATION_KEYS) || destinationPath === undefined || destinationPath === path) {
      invalidMutationRequest('Rename mutation shape is invalid.')
    }
    return { kind: 'rename', path, destinationPath, expected: { kind: expected.kind, version: expected.version } }
  }
  if (mutation.kind === 'delete') {
    if (!hasOnlyKeys(mutation, DELETE_MUTATION_KEYS) || typeof mutation.recursive !== 'boolean') {
      invalidMutationRequest('Delete mutation shape is invalid.')
    }
    return { kind: 'delete', path, expected: { kind: expected.kind, version: expected.version }, recursive: mutation.recursive }
  }
  invalidMutationRequest('Unknown mutation kind.')
}

export interface MutationAdmission {
  readonly providerEpoch: string
  readonly operationId: string
  readonly workspaceId: string
  readonly mutation: WorkspaceMutation
}

export const mutationApi = {
  async provider(signal?: AbortSignal): Promise<MutationProviderResponse> {
    const value = await requestEndpoint<unknown>(WORKSPACE_MUTATIONS_ROUTE, { op: 'provider' }, signal)
    const response = decodeMutationProviderResponse(value)
    if (response === undefined) throw malformedResponse('mutation provider')
    return response
  },
  async mutate(input: MutationAdmission, signal?: AbortSignal): Promise<MutationReceipt> {
    const providerEpoch = requireMutationUuid(
      input.providerEpoch,
      MUTATION_BUDGETS.maxProviderEpochBytes,
      'providerEpoch',
    )
    const operationId = requireMutationUuid(
      input.operationId,
      MUTATION_BUDGETS.maxOperationIdBytes,
      'operationId',
    )
    const workspaceId = requireMutationIdentity(
      input.workspaceId,
      MUTATION_BUDGETS.maxWorkspaceIdBytes,
      'workspaceId',
    )
    const mutation = normalizeWorkspaceMutation(input.mutation)
    const request: MutateWorkspaceRequest = {
      op: 'mutate', providerEpoch, operationId, workspaceId, mutation,
    }
    const value = await requestEndpoint<unknown>(WORKSPACE_MUTATIONS_ROUTE, request, signal)
    const receipt = decodeMutationReceipt(value, { providerEpoch, operationId })
    if (receipt === undefined
      || receipt.state === 'committed' && !mutationResultMatchesRequest(receipt.result, mutation)) {
      throw malformedResponse('mutation receipt')
    }
    return receipt
  },
  async status(
    providerEpochValue: string,
    operationIdValue: string,
    signal?: AbortSignal,
  ): Promise<MutationReceipt> {
    const providerEpoch = requireMutationUuid(
      providerEpochValue,
      MUTATION_BUDGETS.maxProviderEpochBytes,
      'providerEpoch',
    )
    const operationId = requireMutationUuid(
      operationIdValue,
      MUTATION_BUDGETS.maxOperationIdBytes,
      'operationId',
    )
    const value = await requestEndpoint<unknown>(WORKSPACE_MUTATIONS_ROUTE, {
      op: 'status', providerEpoch, operationId,
    }, signal)
    const receipt = decodeMutationReceipt(value, { providerEpoch, operationId })
    if (receipt === undefined) throw malformedResponse('mutation status')
    return receipt
  },
}

export interface TerminalSocket {
  close(): void
  send(message: TerminalClientMessage): boolean
}

export interface TerminalSocketClose {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

export function decodeTerminalServerMessage(value: unknown): TerminalServerMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const message = value as Record<string, unknown>
  if (message.type === 'output' && typeof message.data === 'string') {
    return { type: 'output', data: message.data }
  }
  if (message.type === 'error' && typeof message.message === 'string') {
    return { type: 'error', message: message.message }
  }
  if (message.type !== 'exit') return undefined
  if (message.code !== undefined && (typeof message.code !== 'number' || !Number.isSafeInteger(message.code))) return undefined
  if (message.signal !== undefined && typeof message.signal !== 'string') return undefined
  return {
    type: 'exit',
    ...(message.code === undefined ? {} : { code: message.code }),
    ...(message.signal === undefined ? {} : { signal: message.signal }),
  }
}

export function openTerminalSocket(options: {
  workspaceId: string
  cols: number
  rows: number
  onMessage: (message: TerminalServerMessage) => void
  onOpen?: () => void
  onClose?: (details: TerminalSocketClose) => void
  onError?: (message: string) => void
}): TerminalSocket {
  const url = new URL('/dsh-code-ide/terminal', window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('workspaceId', options.workspaceId)
  url.searchParams.set('cols', String(options.cols))
  url.searchParams.set('rows', String(options.rows))
  const socket = new WebSocket(url)
  socket.addEventListener('open', () => { options.onOpen?.() })
  socket.addEventListener('close', (event) => {
    options.onClose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean })
  })
  socket.addEventListener('error', () => { options.onError?.('Terminal transport failed.') })
  socket.addEventListener('message', (event) => {
    let parsed: TerminalServerMessage | undefined
    try {
      parsed = decodeTerminalServerMessage(JSON.parse(String(event.data)))
    } catch {
      parsed = undefined
    }
    options.onMessage(parsed ?? { type: 'error', message: 'Malformed terminal message' })
  })
  return {
    close: () => { socket.close() },
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) return false
      socket.send(JSON.stringify(message))
      return true
    },
  }
}
