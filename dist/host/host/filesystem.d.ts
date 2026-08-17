import { type BigIntStats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import { type InspectResponse } from '../shared/workspace-observation.js';
import { type ReadFileResponse } from '../shared/workspace-files.js';
import { type MediaPreviewDescriptor } from '../shared/media-preview.js';
import type { FileEntry, HostWorkspaceRegistry, WorkspaceSummary } from './contracts.js';
import { assertNoNestedMount } from './path-policy.js';
import { WorkspaceResources } from './workspace-resources.js';
export interface WorkspaceFileServiceOptions {
    maxFileBytes: number;
    /** Maximum byte size exposed through the bounded media streaming route. */
    maxMediaBytes?: number;
    maxDirectoryEntries: number;
    /** Raw targets accepted by one inspect request, before exact de-duplication. */
    maxInspectTargets?: number;
    /** Direct directory children visited across one inspect request. */
    maxInspectDirectoryEntries?: number;
}
/** Deterministic race seams used by integration tests; production leaves both absent. */
export interface WorkspaceFileServiceInternals {
    /** Runs after bytes are read from the opened handle but before its path/version is accepted. */
    afterOpenedFileRead?: (path: string) => void | Promise<void>;
    /** Runs after atomic publication and capture of our committed snapshot, before response verification. */
    afterPublishCommit?: (path: string) => void | Promise<void>;
    /** Overrides Linux mount-boundary evidence for deterministic media-open tests. */
    assertNoNestedMount?: typeof assertNoNestedMount;
}
export type ReadFileResult = ReadFileResponse;
export interface OpenMediaResult {
    readonly descriptor: MediaPreviewDescriptor;
    readonly handle: FileHandle;
    readonly path: string;
    readonly sizeBytes: number;
    readonly version: string;
    close(): Promise<void>;
}
export interface WriteFileResult {
    path: string;
    version: string;
}
export declare function versionOf(info: BigIntStats): string;
export declare function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean;
export declare function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean;
export declare function syncDirectory(path: string): Promise<void>;
/** Workspace-scoped, symlink-rejecting text file operations for the browser IDE. */
export declare class WorkspaceFileService {
    private readonly registry;
    private readonly options;
    private readonly internals;
    private readonly resources;
    private readonly ownsResources;
    private readonly activeMutations;
    private readonly activeMediaOpens;
    private readonly activeMediaHandles;
    private disposing;
    constructor(registry: HostWorkspaceRegistry, options: WorkspaceFileServiceOptions, internals?: WorkspaceFileServiceInternals, resources?: WorkspaceResources);
    workspaces(maxTerminalSessions: number): {
        workspaces: WorkspaceSummary[];
        maxTerminalSessions: number;
    };
    list(id: unknown, pathValue: unknown): Promise<{
        entries: FileEntry[];
    }>;
    /**
     * Observe a bounded set of visible resources without reading file contents
     * or recursively walking the workspace. Directory versions fingerprint only
     * their sorted direct child names and kinds.
     */
    inspect(id: unknown, targetsValue: unknown): Promise<InspectResponse>;
    read(id: unknown, pathValue: unknown): Promise<ReadFileResult>;
    /**
     * Open one allowlisted media file while preserving the workspace root,
     * symlink, mount, snapshot, and optional observed-version boundaries used by
     * text reads. The caller owns the returned lease and must close it.
     */
    openMedia(id: unknown, pathValue: unknown, expectedVersionValue?: unknown): Promise<OpenMediaResult>;
    private openMediaAdmitted;
    write(id: unknown, pathValue: unknown, contentValue: unknown, expectedVersionValue: unknown): Promise<WriteFileResult>;
    /** Wait for plugin-owned mutations before the capability provider stops. */
    dispose(): Promise<void>;
    private requireWorkspace;
    private assertExpectedVersion;
    private publish;
}
