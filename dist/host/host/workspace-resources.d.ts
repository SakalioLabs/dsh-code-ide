import type { HostWorkspace, HostWorkspaceRegistry } from './contracts.js';
import { type ResolvedWorkspaceRoot } from './path-policy.js';
export interface WorkspaceResourcesOptions {
    maxQueuedMutations?: number;
}
/**
 * Internal resource boundary shared by every workspace writer.
 *
 * One FIFO per workspace makes parent/child mutations serializable while
 * preserving concurrency between independent workspaces. Root identity is
 * pinned for the lifetime of this provider epoch and revalidated on each use.
 */
export declare class WorkspaceResources {
    readonly registry: HostWorkspaceRegistry;
    private readonly queues;
    private readonly active;
    private readonly roots;
    private readonly maxQueuedMutations;
    private pendingCount;
    private accepting;
    constructor(registry: HostWorkspaceRegistry, options?: WorkspaceResourcesOptions);
    requireWorkspace(value: unknown): HostWorkspace;
    resolveRoot(workspace: HostWorkspace): Promise<ResolvedWorkspaceRoot>;
    runMutation<T>(workspace: HostWorkspace, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    /** Stop admission, reject work that never started, then drain active critical sections. */
    dispose(): Promise<void>;
    private pump;
    private removeIdleQueue;
}
