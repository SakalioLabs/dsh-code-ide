import type { ExpectedResource, MutableResourceKind } from '../shared/workspace-mutations.js'
import { IdeHostError } from './errors.js'

/**
 * Internal ABI between receipt/orchestration code and a containment-safe
 * native workspace mutator. This is not a browser protocol capability.
 */
export const MUTATION_BACKEND_ABI = 'dsh-code-ide.mutation-backend.v1' as const

export interface MutationBackendCapabilities {
  readonly createFile: boolean
  readonly createDirectory: boolean
  readonly rename: boolean
  readonly delete: boolean
}

/**
 * A descriptor is immutable for one backend lifetime. If probing or the
 * native implementation changes, Cordis must replace the backend component;
 * consumers must not observe an in-place capability change.
 */
export interface MutationBackendDescriptor {
  readonly abi: typeof MUTATION_BACKEND_ABI
  readonly implementation:
    | 'unavailable'
    | 'windows-nt-handles'
    | 'linux-openat2-handles'
    | 'darwin-openat-handles'
  readonly confinement:
    | 'backend-owned-handle-relative-v1'
    | 'trusted-local-dirfd-relative-v1'
  readonly capabilities: Readonly<MutationBackendCapabilities>
}

/**
 * A path is a sequence of already-canonical workspace names, never an OS
 * pathname. A backend remains a security boundary and must validate every
 * segment again before using it. A mutation backend never turns an operation
 * path into an ambient OS pathname for authority or commit: every
 * authority-bearing lookup and namespace-changing call follows the
 * descriptor's confinement tier. The strongest tier stays relative to an
 * identity-verified root handle throughout; the trusted-local POSIX tier may
 * use a verified descendant dirfd under its documented same-user race limit.
 * That tier may also create a Host-random, reserved staging name immediately
 * below a verified canonical root, bind its open fd back to the named object,
 * and then publish it relative to the pinned root fd. A browser-selected
 * target is never resolved through an ambient pathname.
 * A read-only ambient observation may be used only as commit evidence after
 * it is tied back to the already-open native handle's exact identity; it never
 * selects a target.
 */
export interface MutationBackendPath {
  readonly segments: readonly string[]
}

export type MutationBackendOperation =
  | {
      readonly kind: 'createFile'
      readonly path: MutationBackendPath
    }
  | {
      readonly kind: 'createDirectory'
      readonly path: MutationBackendPath
    }
  | {
      readonly kind: 'rename'
      readonly path: MutationBackendPath
      readonly destinationPath: MutationBackendPath
      readonly expected: ExpectedResource
    }
  | {
      readonly kind: 'delete'
      readonly path: MutationBackendPath
      readonly expected: ExpectedResource
      readonly recursive: boolean
    }

export interface MutationBackendIssue {
  readonly code: string
  readonly message: string
  readonly httpStatus: number
}

export interface MutationBackendWarning {
  readonly code: string
  readonly message: string
}

export type MutationBackendCommitEvidence =
  | {
      readonly kind: 'createFile'
      readonly resourceKind: 'file'
      readonly version: string
    }
  | {
      readonly kind: 'createDirectory'
      readonly resourceKind: 'directory'
      readonly version: string
    }
  | {
      readonly kind: 'rename'
      readonly resourceKind: MutableResourceKind
      readonly version: string
    }
  | {
      readonly kind: 'delete'
      readonly resourceKind: MutableResourceKind
      readonly recursive: boolean
    }

/**
 * One native execution has only terminal outcomes. queued/running/expired,
 * providerEpoch, replay, TTL and operation-id ownership stay exclusively in
 * WorkspaceMutationService; a backend is neither a WAL nor a status service.
 *
 * Expected filesystem failures must be returned as notCommitted. Once the
 * backend may have entered its namespace-changing syscall, it must return
 * committed evidence or recoveryRequired; cancellation is not authority to
 * claim notCommitted. A rejected execute() promise is therefore treated by
 * the caller as recoveryRequired, never as proof of rollback.
 */
export type MutationBackendOutcome =
  | {
      readonly state: 'committed'
      readonly evidence: MutationBackendCommitEvidence
      readonly warning?: MutationBackendWarning
    }
  | {
      readonly state: 'notCommitted'
      readonly error: MutationBackendIssue
    }
  | {
      readonly state: 'recoveryRequired'
      readonly error: MutationBackendIssue
    }

export interface MutationBackendExecution {
  /** Correlation only. Protocol idempotency remains owned by the service. */
  readonly executionId: string
  readonly operation: MutationBackendOperation
  /**
   * A pre-commit cancellation request. After the commit point the backend
   * must finish classification and return a terminal outcome despite abort.
   */
  readonly signal: AbortSignal
}

export interface MutationBackendWorkspace {
  readonly workspaceId: string

  /** Execute only through the descriptor's proven confinement discipline. */
  execute(request: MutationBackendExecution): Promise<MutationBackendOutcome>

  /**
   * Stop admitting executions and drain/classify those already admitted.
   * Disposal never reverses a committed namespace change.
   */
  dispose(): Promise<void>
}

export interface OpenMutationBackendWorkspace {
  readonly workspaceId: string
  /**
   * The sole ambient pathname admitted by this ABI. It opens and pins the
   * registered root. No browser-selected operation path may be resolved from
   * it. The trusted-local tier may additionally use it for a Host-random root
   * staging name that is bound to an open fd before root-fd-relative publish.
   */
  readonly registeredRoot: string
  /** Identity captured by WorkspaceResources immediately before open. */
  readonly expectedRootIdentity: {
    readonly dev: bigint
    readonly ino: bigint
  }
  readonly signal: AbortSignal
}

/**
 * A capability-bearing native backend.
 *
 * `backend-owned-handle-relative-v1` is the strongest tier: a true capability
 * proves root binding, traversal, commit-object identity, mount/reparse
 * exclusion and any recursive cleanup. `trusted-local-dirfd-relative-v1`
 * remains confined against browser-supplied traversal and symlinks, but is
 * explicitly scoped to this product's single trusted local-user model: POSIX
 * does not promise to defeat a separate same-UID process racing namespace
 * reparenting. Partial primitive availability must remain false in both tiers.
 */
export interface MutationBackend {
  readonly descriptor: Readonly<MutationBackendDescriptor>

  openWorkspace(request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace>

  /**
   * Idempotently stop admission, abort only work still before commit, await a
   * terminal classification for every admitted execution, drain backend-owned
   * cleanup, close native handles/helpers, and then resolve.
   */
  dispose(): Promise<void>
}

const NO_CAPABILITIES: Readonly<MutationBackendCapabilities> = Object.freeze({
  createFile: false,
  createDirectory: false,
  rename: false,
  delete: false,
})

const UNAVAILABLE_DESCRIPTOR: Readonly<MutationBackendDescriptor> = Object.freeze({
  abi: MUTATION_BACKEND_ABI,
  implementation: 'unavailable',
  confinement: 'backend-owned-handle-relative-v1',
  capabilities: NO_CAPABILITIES,
})

/** Side-effect-free production fallback while no proven native backend exists. */
export class UnavailableMutationBackend implements MutationBackend {
  readonly descriptor = UNAVAILABLE_DESCRIPTOR

  async openWorkspace(_request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace> {
    throw new IdeHostError(
      'WORKSPACE_MUTATION_UNAVAILABLE',
      'A containment-safe workspace mutation backend is unavailable on this Host.',
      501,
    )
  }

  async dispose(): Promise<void> {}
}

export function createUnavailableMutationBackend(): MutationBackend {
  return new UnavailableMutationBackend()
}
