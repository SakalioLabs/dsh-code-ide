import type { HostPluginContext } from './contracts.js';
export interface Config {
    staticRoot?: string;
    maxFileBytes?: number;
    maxMediaBytes?: number;
    maxRequestBytes?: number;
    maxDirectoryEntries?: number;
    maxInspectTargets?: number;
    maxInspectDirectoryEntries?: number;
    terminalShell?: string;
    terminalArgs?: string[];
    maxTerminalSessions?: number;
    maxTerminalMessageBytes?: number;
    maxTerminalInputBytes?: number;
    maxTerminalBufferedBytes?: number;
    maxSearchFileResults?: number;
    maxSearchTextResults?: number;
    maxSearchCandidates?: number;
    maxSearchRawBytes?: number;
    maxSearchPreviewBytes?: number;
    maxSearchQueryBytes?: number;
    maxSearchLineBytes?: number;
    maxSearchResponseBytes?: number;
    maxConcurrentSearches?: number;
    searchTimeoutMs?: number;
    searchTerminationGraceMs?: number;
    maxQueuedMutations?: number;
    mutationReceiptTtlMs?: number;
    maxMutationReceipts?: number;
    maxMutationOperationIds?: number;
    maxMutationPurgeJobs?: number;
    maxMutationPurgeEntries?: number;
    maxMutationRequestBytes?: number;
}
export interface ResolvedConfig {
    routePrefix: string;
    staticRoot: string;
    maxFileBytes: number;
    maxMediaBytes: number;
    maxRequestBytes: number;
    maxDirectoryEntries: number;
    maxInspectTargets: number;
    maxInspectDirectoryEntries: number;
    terminalShell: string;
    terminalArgs: string[];
    maxTerminalSessions: number;
    maxTerminalMessageBytes: number;
    maxTerminalInputBytes: number;
    maxTerminalBufferedBytes: number;
    maxSearchFileResults: number;
    maxSearchTextResults: number;
    maxSearchCandidates: number;
    maxSearchRawBytes: number;
    maxSearchPreviewBytes: number;
    maxSearchQueryBytes: number;
    maxSearchLineBytes: number;
    maxSearchResponseBytes: number;
    maxConcurrentSearches: number;
    searchTimeoutMs: number;
    searchTerminationGraceMs: number;
    maxQueuedMutations: number;
    mutationReceiptTtlMs: number;
    maxMutationReceipts: number;
    maxMutationOperationIds: number;
    maxMutationPurgeJobs: number;
    maxMutationPurgeEntries: number;
    maxMutationRequestBytes: number;
}
/** Resolve and validate Host limits before any child component is registered. */
export declare function resolveConfig(config: Config): ResolvedConfig;
/** Stable Cordis plugin name. */
export declare const name = "dsh-code-ide";
/** Root orchestration deliberately owns no Host services or routes itself. */
export declare const inject: string[];
/** Compose independently reloadable providers with their route-owning gateway. */
export declare function apply(ctx: HostPluginContext, input?: Config): void;
