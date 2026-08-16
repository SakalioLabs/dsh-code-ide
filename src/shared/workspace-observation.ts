/** Default maximum number of observation targets accepted by one Host request. */
export const DEFAULT_MAX_INSPECT_TARGETS = 256

/** A resource shape whose version can be observed without reading file contents. */
export type ObservationKind = 'file' | 'directory'

/** One workspace-relative resource selected by the browser for observation. */
export interface ObservationTarget {
  path: string
  kind: ObservationKind
}

/** Client-only knowledge paired with a wire target for first-poll comparison. */
export interface KnownObservationTarget extends ObservationTarget {
  knownVersion?: string
}

/**
 * One opaque Host snapshot. A kind replacement is reported as `missing` for
 * the requested kind; consumers subsequently re-list/read the authoritative
 * resource instead of interpreting filesystem metadata themselves.
 */
export type ObservationSnapshot =
  | {
    path: string
    kind: ObservationKind
    state: 'missing'
  }
  | {
    path: string
    kind: 'file'
    state: 'present'
    version: string
    size: number
  }
  | {
    path: string
    kind: 'directory'
    state: 'present'
    version: string
  }

/** JSON-safe request accepted by the versioned workspace-files capability. */
export interface InspectRequest {
  op: 'inspect'
  workspaceId: string
  targets: ObservationTarget[]
}

/** Snapshots preserve the first-seen order of unique `(kind, path)` targets. */
export interface InspectResponse {
  snapshots: ObservationSnapshot[]
}
