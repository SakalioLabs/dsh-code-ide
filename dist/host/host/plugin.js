import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_INSPECT_TARGETS } from '../shared/workspace-observation.js';
import { ideGateway } from './gateway.js';
import { DEFAULT_SEARCH_LIMITS } from './search.js';
import { workspaceSearchProvider } from './search-provider.js';
import { resolveTerminalShell } from './terminal.js';
import { terminalProvider } from './terminal-provider.js';
import { workspaceFilesProvider } from './workspace-files-provider.js';
import { workspaceMutationsGateway } from './workspace-mutations-gateway.js';
import { workspaceMutationsProvider } from './workspace-mutations-provider.js';
import { workspaceMutationBackendProvider } from './mutation-backend-provider.js';
import { workspaceResourcesProvider } from './workspace-resources-provider.js';
function positiveInteger(value, fallback, name, maximum) {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
        throw new Error(`dsh-code-ide: ${name} must be a positive integer no greater than ${String(maximum)}`);
    }
    return resolved;
}
function defaultStaticRoot() {
    const compiled = fileURLToPath(new URL('../../client/', import.meta.url));
    if (existsSync(compiled))
        return compiled;
    return fileURLToPath(new URL('../../dist/client/', import.meta.url));
}
/** Resolve and validate Host limits before any child component is registered. */
export function resolveConfig(config) {
    const routePrefix = '/dsh-code-ide';
    const maxFileBytes = positiveInteger(config.maxFileBytes, 4 * 1024 * 1024, 'maxFileBytes', 64 * 1024 * 1024);
    const maxDirectoryEntries = positiveInteger(config.maxDirectoryEntries, 5_000, 'maxDirectoryEntries', 100_000);
    const terminal = resolveTerminalShell(config.terminalShell);
    return {
        routePrefix,
        staticRoot: config.staticRoot ?? defaultStaticRoot(),
        maxFileBytes,
        maxRequestBytes: positiveInteger(config.maxRequestBytes, maxFileBytes * 6 + 64 * 1024, 'maxRequestBytes', 64 * 1024 * 1024 * 6 + 64 * 1024),
        maxDirectoryEntries,
        maxInspectTargets: positiveInteger(config.maxInspectTargets, DEFAULT_MAX_INSPECT_TARGETS, 'maxInspectTargets', 4_096),
        maxInspectDirectoryEntries: positiveInteger(config.maxInspectDirectoryEntries, maxDirectoryEntries, 'maxInspectDirectoryEntries', 100_000),
        terminalShell: terminal.shell,
        terminalArgs: config.terminalArgs ?? terminal.args,
        maxTerminalSessions: positiveInteger(config.maxTerminalSessions, 8, 'maxTerminalSessions', 64),
        maxTerminalMessageBytes: positiveInteger(config.maxTerminalMessageBytes, 256 * 1024, 'maxTerminalMessageBytes', 4 * 1024 * 1024),
        maxTerminalInputBytes: positiveInteger(config.maxTerminalInputBytes, 64 * 1024, 'maxTerminalInputBytes', 1024 * 1024),
        maxTerminalBufferedBytes: positiveInteger(config.maxTerminalBufferedBytes, 4 * 1024 * 1024, 'maxTerminalBufferedBytes', 64 * 1024 * 1024),
        maxSearchFileResults: positiveInteger(config.maxSearchFileResults, DEFAULT_SEARCH_LIMITS.maxFileResults, 'maxSearchFileResults', 10_000),
        maxSearchTextResults: positiveInteger(config.maxSearchTextResults, DEFAULT_SEARCH_LIMITS.maxTextResults, 'maxSearchTextResults', 100_000),
        maxSearchCandidates: positiveInteger(config.maxSearchCandidates, DEFAULT_SEARCH_LIMITS.maxCandidates, 'maxSearchCandidates', 1_000_000),
        maxSearchRawBytes: positiveInteger(config.maxSearchRawBytes, DEFAULT_SEARCH_LIMITS.maxRawBytes, 'maxSearchRawBytes', 64 * 1024 * 1024),
        maxSearchPreviewBytes: positiveInteger(config.maxSearchPreviewBytes, DEFAULT_SEARCH_LIMITS.maxPreviewBytes, 'maxSearchPreviewBytes', 64 * 1024),
        maxSearchQueryBytes: positiveInteger(config.maxSearchQueryBytes, DEFAULT_SEARCH_LIMITS.maxQueryBytes, 'maxSearchQueryBytes', 64 * 1024),
        maxSearchLineBytes: positiveInteger(config.maxSearchLineBytes, DEFAULT_SEARCH_LIMITS.maxLineBytes, 'maxSearchLineBytes', 16 * 1024 * 1024),
        maxSearchResponseBytes: positiveInteger(config.maxSearchResponseBytes, DEFAULT_SEARCH_LIMITS.maxResponseBytes, 'maxSearchResponseBytes', 64 * 1024 * 1024),
        maxConcurrentSearches: positiveInteger(config.maxConcurrentSearches, DEFAULT_SEARCH_LIMITS.maxConcurrent, 'maxConcurrentSearches', 32),
        searchTimeoutMs: positiveInteger(config.searchTimeoutMs, DEFAULT_SEARCH_LIMITS.timeoutMs, 'searchTimeoutMs', 10 * 60 * 1_000),
        searchTerminationGraceMs: positiveInteger(config.searchTerminationGraceMs, DEFAULT_SEARCH_LIMITS.terminationGraceMs, 'searchTerminationGraceMs', 30_000),
        maxQueuedMutations: positiveInteger(config.maxQueuedMutations, 64, 'maxQueuedMutations', 4_096),
        mutationReceiptTtlMs: positiveInteger(config.mutationReceiptTtlMs, 5 * 60_000, 'mutationReceiptTtlMs', 24 * 60 * 60_000),
        maxMutationReceipts: positiveInteger(config.maxMutationReceipts, 1_024, 'maxMutationReceipts', 65_536),
        maxMutationOperationIds: positiveInteger(config.maxMutationOperationIds, 65_536, 'maxMutationOperationIds', 262_144),
        maxMutationPurgeJobs: positiveInteger(config.maxMutationPurgeJobs, 1_024, 'maxMutationPurgeJobs', 65_536),
        maxMutationPurgeEntries: positiveInteger(config.maxMutationPurgeEntries, 100_000, 'maxMutationPurgeEntries', 1_000_000),
        maxMutationRequestBytes: positiveInteger(config.maxMutationRequestBytes, 64 * 1024, 'maxMutationRequestBytes', 256 * 1024),
    };
}
/** Stable Cordis plugin name. */
export const name = 'dsh-code-ide';
/** Root orchestration deliberately owns no Host services or routes itself. */
export const inject = [];
/** Compose independently reloadable providers with their route-owning gateway. */
export function apply(ctx, input = {}) {
    const config = resolveConfig(input);
    ctx.plugin(workspaceResourcesProvider, {
        maxQueuedMutations: config.maxQueuedMutations,
    });
    ctx.plugin(workspaceMutationBackendProvider, {});
    ctx.plugin(workspaceFilesProvider, {
        maxFileBytes: config.maxFileBytes,
        maxDirectoryEntries: config.maxDirectoryEntries,
        maxInspectTargets: config.maxInspectTargets,
        maxInspectDirectoryEntries: config.maxInspectDirectoryEntries,
    });
    ctx.plugin(workspaceMutationsProvider, {
        receiptTtlMs: config.mutationReceiptTtlMs,
        maxReceipts: config.maxMutationReceipts,
        maxOperationIds: config.maxMutationOperationIds,
        maxPurgeJobs: config.maxMutationPurgeJobs,
        maxPurgeEntries: config.maxMutationPurgeEntries,
    });
    ctx.plugin(terminalProvider, {
        terminalShell: config.terminalShell,
        terminalArgs: config.terminalArgs,
        maxTerminalSessions: config.maxTerminalSessions,
        maxTerminalMessageBytes: config.maxTerminalMessageBytes,
        maxTerminalInputBytes: config.maxTerminalInputBytes,
        maxTerminalBufferedBytes: config.maxTerminalBufferedBytes,
    });
    ctx.plugin(workspaceSearchProvider, {
        maxFileBytes: config.maxFileBytes,
        maxFileResults: config.maxSearchFileResults,
        maxTextResults: config.maxSearchTextResults,
        maxCandidates: config.maxSearchCandidates,
        maxRawBytes: config.maxSearchRawBytes,
        maxPreviewBytes: config.maxSearchPreviewBytes,
        maxQueryBytes: config.maxSearchQueryBytes,
        maxLineBytes: config.maxSearchLineBytes,
        maxResponseBytes: config.maxSearchResponseBytes,
        maxConcurrent: config.maxConcurrentSearches,
        timeoutMs: config.searchTimeoutMs,
        terminationGraceMs: config.searchTerminationGraceMs,
    });
    ctx.plugin(ideGateway, {
        routePrefix: config.routePrefix,
        staticRoot: config.staticRoot,
        maxRequestBytes: config.maxRequestBytes,
        maxTerminalSessions: config.maxTerminalSessions,
    });
    ctx.plugin(workspaceMutationsGateway, {
        maxRequestBytes: config.maxMutationRequestBytes,
    });
}
