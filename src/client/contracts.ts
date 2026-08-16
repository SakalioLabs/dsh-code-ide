import type { InspectRequest, InspectResponse } from '../shared/workspace-observation.ts'
import type {
  FindFilesRequest,
  SearchTextRequest,
  FindFilesResponse,
  SearchTextResponse,
} from '../shared/workspace-search.ts'
import type { ReadFileResponse } from '../shared/workspace-files.ts'

export type FileKind = 'file' | 'directory' | 'other'

/** Browser-side response ceilings; Host configuration may be stricter. */
export const MAX_CLIENT_DIRECTORY_ENTRIES = 5_000
export const MAX_CLIENT_FILE_VERSION_BYTES = 256

export interface FileEntry {
  name: string
  path: string
  type: FileKind
  size?: number
  version?: string
}

export interface ListFilesResponse {
  entries: FileEntry[]
}

export interface WriteFileResponse {
  path: string
  version: string
}

export interface WorkspaceSummary {
  workspaceId: string
  title: string
  path: string
}

export interface WorkspacesResponse {
  workspaces: WorkspaceSummary[]
  currentWorkspaceId?: string
  maxTerminalSessions: number
}

export type FileApiRequest =
  | { op: 'workspaces' }
  | { op: 'list'; workspaceId: string; path: string }
  | { op: 'read'; workspaceId: string; path: string }
  | InspectRequest
  | FindFilesRequest
  | SearchTextRequest
  | { op: 'write'; workspaceId: string; path: string; content: string; expectedVersion?: string }

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' }
  | { type: 'close' }

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code?: number; signal?: string }
  | { type: 'error'; message: string }

export type { FindFilesResponse, InspectResponse, SearchTextResponse }
export type { ReadFileResponse, ReadOnlyFilePresentation } from '../shared/workspace-files.ts'
