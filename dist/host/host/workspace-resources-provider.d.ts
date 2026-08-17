import { type WorkspaceResourcesProviderContext } from './capabilities.js';
export interface WorkspaceResourcesProviderConfig {
    maxQueuedMutations: number;
}
/** Own the internal root-identity cache and workspace-scoped mutation queues. */
export declare function workspaceResourcesProvider(ctx: WorkspaceResourcesProviderContext, config: WorkspaceResourcesProviderConfig): void;
export declare namespace workspaceResourcesProvider {
    var inject: string[];
    var provide: string;
}
