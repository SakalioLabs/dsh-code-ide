import { WORKSPACE_RESOURCES_CAPABILITY } from './capabilities.js';
import { WorkspaceResources } from './workspace-resources.js';
/** Own the internal root-identity cache and workspace-scoped mutation queues. */
export function workspaceResourcesProvider(ctx, config) {
    const resources = new WorkspaceResources(ctx.workspaceRegistry, {
        maxQueuedMutations: config.maxQueuedMutations,
    });
    ctx.effect(() => {
        const withdraw = ctx.provide(WORKSPACE_RESOURCES_CAPABILITY, resources);
        return async () => {
            await withdraw();
            await resources.dispose();
        };
    }, 'dsh-code-ide: workspace-resources capability');
}
workspaceResourcesProvider.inject = ['workspaceRegistry'];
workspaceResourcesProvider.provide = WORKSPACE_RESOURCES_CAPABILITY;
