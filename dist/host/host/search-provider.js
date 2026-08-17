import { WORKSPACE_SEARCH_CAPABILITY } from './capabilities.js';
import { WorkspaceSearchService } from './search.js';
/** Own the v1 bounded workspace-search capability independently from HTTP. */
export function workspaceSearchProvider(ctx, config) {
    const search = new WorkspaceSearchService(ctx.workspaceRegistry, ctx.subprocess, {
        ...config,
        logger: ctx.logger,
    });
    ctx.effect(() => {
        const withdraw = ctx.provide(WORKSPACE_SEARCH_CAPABILITY, search);
        return async () => {
            await withdraw();
            await search.dispose();
        };
    }, 'dsh-code-ide: workspace-search capability');
}
workspaceSearchProvider.inject = ['workspaceRegistry', 'subprocess'];
workspaceSearchProvider.provide = WORKSPACE_SEARCH_CAPABILITY;
