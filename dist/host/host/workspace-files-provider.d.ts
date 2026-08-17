import { type WorkspaceFilesProviderContext } from './capabilities.js';
export interface WorkspaceFilesProviderConfig {
    maxFileBytes: number;
    maxDirectoryEntries: number;
    maxInspectTargets: number;
    maxInspectDirectoryEntries: number;
}
/** Own the v1 workspace-files capability independently from HTTP transport. */
export declare function workspaceFilesProvider(ctx: WorkspaceFilesProviderContext, config: WorkspaceFilesProviderConfig): void;
export declare namespace workspaceFilesProvider {
    var inject: string[];
    var provide: string;
}
