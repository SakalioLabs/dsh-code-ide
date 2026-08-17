import { type MutationProviderResponse, type MutationReceipt, type WorkspaceMutationRequest } from '../shared/workspace-mutations.js';
import type { HostLogger } from './contracts.js';
import { type NativeRenameAdapter } from './native-rename.js';
import { type MutationBackend, type MutationBackendCapabilities } from './mutation-backend.js';
import { WorkspaceResources } from './workspace-resources.js';
export interface WorkspaceMutationServiceOptions {
    receiptTtlMs?: number;
    maxReceipts?: number;
    maxOperationIds?: number;
    maxPurgeJobs?: number;
    maxPurgeEntries?: number;
}
export interface WorkspaceMutationServiceInternals {
    nativeRename?: NativeRenameAdapter;
    /**
     * Capabilities proven by a containment-safe native backend. Omission is
     * deliberately all-false: Node path APIs cannot bind every ancestor against
     * a same-identity rename/symlink race or safely purge by directory handle.
     */
    backendCapabilities?: Readonly<MutationBackendCapabilities>;
    now?: () => number;
    afterCreateCommit?: (kind: 'file' | 'directory', destination: string) => void | Promise<void>;
    afterNativeCommit?: (kind: 'rename' | 'delete', destination: string) => void | Promise<void>;
}
export declare function parseWorkspaceMutationRequest(value: unknown): WorkspaceMutationRequest;
/** Receipt-backed, fail-closed workspace mutation capability. */
export declare class WorkspaceMutationService {
    private readonly resources;
    private readonly logger;
    private readonly internals;
    readonly providerEpoch: `${string}-${string}-${string}-${string}-${string}`;
    private readonly nativeRename;
    private readonly backend;
    private readonly ownsBackend;
    private readonly backendWorkspaces;
    private readonly backendLifetime;
    private readonly now;
    private readonly receiptTtlMs;
    private readonly maxReceipts;
    private readonly maxOperationIds;
    private readonly receipts;
    private readonly seen;
    private readonly inflight;
    private readonly purger;
    private accepting;
    constructor(resources: WorkspaceResources, logger: HostLogger, options?: WorkspaceMutationServiceOptions, internals?: WorkspaceMutationServiceInternals, backend?: MutationBackend);
    request(value: unknown, signal?: AbortSignal): Promise<MutationProviderResponse | MutationReceipt>;
    provider(): Promise<MutationProviderResponse>;
    status(operationId: string): MutationReceipt;
    dispose(): Promise<void>;
    private mutate;
    private replay;
    private executeReceipt;
    private execute;
    private backendOperation;
    private backendWorkspace;
    private executeBackend;
    private createFile;
    private createDirectory;
    private rename;
    private delete;
    private directoryHasEntries;
    private assertEpoch;
    private capabilities;
    private assertCapability;
    private assertNativeCapability;
    private assertNotAborted;
    private sweep;
}
