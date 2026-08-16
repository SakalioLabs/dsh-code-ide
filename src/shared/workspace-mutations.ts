/** Versioned, JSON-safe workspace mutation protocol shared by Host and browser. */

export const WORKSPACE_MUTATIONS_PROTOCOL = 'dsh-code-ide.workspace-mutations.v1' as const
export const WORKSPACE_MUTATIONS_ROUTE = '/dsh-code-ide/api/workspace-mutations/v1' as const

export const MUTATION_BUDGETS = Object.freeze({
  maxWorkspaceIdBytes: 256,
  maxProviderEpochBytes: 64,
  maxOperationIdBytes: 64,
  maxVersionBytes: 256,
  maxPathBytes: 16 * 1024,
  maxPathSegments: 128,
  maxNameBytes: 255,
})

export type MutableResourceKind = 'file' | 'directory'

export interface ExpectedResource {
  kind: MutableResourceKind
  version: string
}

export interface CreateFileMutation {
  kind: 'createFile'
  path: string
}

export interface CreateDirectoryMutation {
  kind: 'createDirectory'
  path: string
}

export interface RenameMutation {
  kind: 'rename'
  path: string
  destinationPath: string
  expected: ExpectedResource
}

export interface DeleteMutation {
  kind: 'delete'
  path: string
  expected: ExpectedResource
  recursive: boolean
}

export type WorkspaceMutation =
  | CreateFileMutation
  | CreateDirectoryMutation
  | RenameMutation
  | DeleteMutation

export interface MutationProviderRequest {
  op: 'provider'
}

export interface MutateWorkspaceRequest {
  op: 'mutate'
  providerEpoch: string
  operationId: string
  workspaceId: string
  mutation: WorkspaceMutation
}

export interface MutationStatusRequest {
  op: 'status'
  providerEpoch: string
  operationId: string
}

export type WorkspaceMutationRequest =
  | MutationProviderRequest
  | MutateWorkspaceRequest
  | MutationStatusRequest

export interface MutationProviderResponse {
  providerEpoch: string
  capabilities: {
    createFile: boolean
    createDirectory: boolean
    rename: boolean
    delete: boolean
  }
}

export interface CreateMutationResult {
  kind: MutableResourceKind
  path: string
  version: string
  refreshDirectories: string[]
}

export interface RenameMutationResult {
  kind: MutableResourceKind
  path: string
  destinationPath: string
  version: string
  refreshDirectories: string[]
}

export interface DeleteMutationResult {
  kind: MutableResourceKind
  path: string
  recursive: boolean
  refreshDirectories: string[]
}

export type WorkspaceMutationResult =
  | CreateMutationResult
  | RenameMutationResult
  | DeleteMutationResult

export type MutationReceiptState =
  | 'queued'
  | 'running'
  | 'committed'
  | 'notCommitted'
  | 'recoveryRequired'
  | 'expired'

export interface MutationProtocolError {
  code: string
  message: string
}

export interface MutationProtocolWarning {
  code: string
  message: string
}

interface MutationReceiptBase {
  providerEpoch: string
  operationId: string
  state: MutationReceiptState
}

export interface PendingMutationReceipt extends MutationReceiptBase {
  state: 'queued' | 'running'
}

export interface CommittedMutationReceipt extends MutationReceiptBase {
  state: 'committed'
  result: WorkspaceMutationResult
  warning?: MutationProtocolWarning
}

export interface FailedMutationReceipt extends MutationReceiptBase {
  state: 'notCommitted' | 'recoveryRequired'
  error: MutationProtocolError
}

export interface ExpiredMutationReceipt extends MutationReceiptBase {
  state: 'expired'
}

export type MutationReceipt =
  | PendingMutationReceipt
  | CommittedMutationReceipt
  | FailedMutationReceipt
  | ExpiredMutationReceipt
