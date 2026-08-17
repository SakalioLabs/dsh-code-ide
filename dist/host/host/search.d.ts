import { type FindFilesResponse, type SearchTextResponse } from '../shared/workspace-search.js';
import type { HostLogger, HostSubprocessRuntime, HostWorkspaceRegistry } from './contracts.js';
export declare const DEFAULT_SEARCH_LIMITS: Readonly<{
    maxFileResults: 200;
    maxTextResults: 500;
    maxCandidates: 50000;
    maxRawBytes: number;
    maxPreviewBytes: number;
    maxQueryBytes: number;
    maxLineBytes: number;
    maxResponseBytes: number;
    maxConcurrent: 2;
    timeoutMs: 30000;
    terminationGraceMs: 1000;
}>;
export interface WorkspaceSearchOptions {
    maxFileBytes: number;
    maxFileResults: number;
    maxTextResults: number;
    maxCandidates: number;
    maxRawBytes: number;
    maxPreviewBytes: number;
    maxQueryBytes: number;
    maxLineBytes: number;
    maxResponseBytes: number;
    maxConcurrent: number;
    timeoutMs: number;
    terminationGraceMs: number;
    logger: HostLogger;
}
/** Deterministic packaging seam; production lazily resolves the bundled rg. */
export interface WorkspaceSearchInternals {
    resolveRipgrepPath?: () => Promise<string>;
}
/** Convert an exact UTF-8 byte boundary into a UTF-16 column. */
export declare function utf8ByteOffsetToUtf16(value: string, byteOffset: number): number;
/** Decode a bounded prefix of rg's NUL-delimited path protocol. */
export declare function parseNulPathRecords(value: string, maxRecords?: number): string[];
/** Bounded one-shot workspace path and text search over Harness subprocess. */
export declare class WorkspaceSearchService {
    private readonly registry;
    private readonly subprocess;
    private readonly options;
    private readonly internals;
    private readonly active;
    private disposing;
    constructor(registry: HostWorkspaceRegistry, subprocess: HostSubprocessRuntime, options: WorkspaceSearchOptions, internals?: WorkspaceSearchInternals);
    findFiles(id: unknown, queryValue: unknown, callerSignal?: AbortSignal): Promise<FindFilesResponse>;
    searchText(id: unknown, queryValue: unknown, callerSignal?: AbortSignal): Promise<SearchTextResponse>;
    dispose(): Promise<void>;
    private requireWorkspace;
    private workspace;
    private run;
    private failed;
    private execute;
    private validateOutputPath;
    private parseTextOutput;
}
