import type { HostPluginContext, HostSubprocessRuntime, HostWebServer, HostWorkspaceRegistry } from './contracts.js';
import type { WorkspaceFileService } from './filesystem.js';
import type { WorkspaceSearchService } from './search.js';
import type { TerminalHost } from './terminal.js';
import type { WorkspaceMutationService } from './workspace-mutations.js';
import type { MutationBackend } from './mutation-backend.js';
import type { WorkspaceResources } from './workspace-resources.js';
/** Namespaced capability keys are protocol names; changing shape requires v2. */
export declare const WORKSPACE_FILES_CAPABILITY = "dsh-code-ide.workspace-files.v1";
export declare const TERMINAL_CAPABILITY = "dsh-code-ide.terminal.v1";
export declare const WORKSPACE_SEARCH_CAPABILITY = "dsh-code-ide.workspace-search.v1";
export declare const WORKSPACE_MUTATIONS_CAPABILITY = "dsh-code-ide.workspace-mutations.v1";
/** Internal resource protocol; never projected onto the browser transport. */
export declare const WORKSPACE_RESOURCES_CAPABILITY = "dsh-code-ide.workspace-resources.v1";
/** Internal native containment boundary; never projected onto browser transport. */
export declare const WORKSPACE_MUTATION_BACKEND_CAPABILITY = "dsh-code-ide.mutation-backend.v1";
export type WorkspaceMutationBackendProviderContext = HostPluginContext;
export type WorkspaceResourcesProviderContext = HostPluginContext & {
    readonly workspaceRegistry: HostWorkspaceRegistry;
};
export type WorkspaceFilesProviderContext = HostPluginContext & {
    readonly [WORKSPACE_RESOURCES_CAPABILITY]: WorkspaceResources;
};
export type WorkspaceMutationsProviderContext = HostPluginContext & {
    readonly [WORKSPACE_RESOURCES_CAPABILITY]: WorkspaceResources;
    readonly [WORKSPACE_MUTATION_BACKEND_CAPABILITY]: MutationBackend;
};
export type WorkspaceMutationsGatewayContext = HostPluginContext & {
    readonly webServer: HostWebServer;
    readonly [WORKSPACE_MUTATIONS_CAPABILITY]: WorkspaceMutationService;
};
export type TerminalProviderContext = HostPluginContext & {
    readonly workspaceRegistry: HostWorkspaceRegistry;
};
export type WorkspaceSearchProviderContext = HostPluginContext & {
    readonly workspaceRegistry: HostWorkspaceRegistry;
    readonly subprocess: HostSubprocessRuntime;
};
export type IdeGatewayContext = HostPluginContext & {
    readonly webServer: HostWebServer;
    readonly [WORKSPACE_FILES_CAPABILITY]: WorkspaceFileService;
    readonly [TERMINAL_CAPABILITY]: TerminalHost;
    readonly [WORKSPACE_SEARCH_CAPABILITY]: WorkspaceSearchService;
};
