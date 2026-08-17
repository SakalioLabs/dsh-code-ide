import { type WorkspaceMutationsProviderContext } from './capabilities.js';
import { type WorkspaceMutationServiceOptions } from './workspace-mutations.js';
export type WorkspaceMutationsProviderConfig = WorkspaceMutationServiceOptions;
/** Own workspace-mutations.v1 independently from its exact HTTP route. */
export declare function workspaceMutationsProvider(ctx: WorkspaceMutationsProviderContext, config: WorkspaceMutationsProviderConfig): void;
export declare namespace workspaceMutationsProvider {
    var inject: string[];
    var provide: string;
}
