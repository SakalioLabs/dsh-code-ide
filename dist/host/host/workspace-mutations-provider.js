import { WORKSPACE_MUTATION_BACKEND_CAPABILITY, WORKSPACE_MUTATIONS_CAPABILITY, WORKSPACE_RESOURCES_CAPABILITY, } from './capabilities.js';
import { WorkspaceMutationService } from './workspace-mutations.js';
/** Own workspace-mutations.v1 independently from its exact HTTP route. */
export function workspaceMutationsProvider(ctx, config) {
    const mutations = new WorkspaceMutationService(ctx[WORKSPACE_RESOURCES_CAPABILITY], ctx.logger, config, {}, ctx[WORKSPACE_MUTATION_BACKEND_CAPABILITY]);
    ctx.effect(() => {
        const withdraw = ctx.provide(WORKSPACE_MUTATIONS_CAPABILITY, mutations);
        return async () => {
            await withdraw();
            await mutations.dispose();
        };
    }, 'dsh-code-ide: workspace-mutations capability');
}
workspaceMutationsProvider.inject = [WORKSPACE_RESOURCES_CAPABILITY, WORKSPACE_MUTATION_BACKEND_CAPABILITY];
workspaceMutationsProvider.provide = WORKSPACE_MUTATIONS_CAPABILITY;
