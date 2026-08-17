import { type WorkspaceSearchProviderContext } from './capabilities.js';
import { type WorkspaceSearchOptions } from './search.js';
export type WorkspaceSearchProviderConfig = Omit<WorkspaceSearchOptions, 'logger'>;
/** Own the v1 bounded workspace-search capability independently from HTTP. */
export declare function workspaceSearchProvider(ctx: WorkspaceSearchProviderContext, config: WorkspaceSearchProviderConfig): void;
export declare namespace workspaceSearchProvider {
    var inject: string[];
    var provide: string;
}
