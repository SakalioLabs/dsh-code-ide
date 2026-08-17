import { WORKSPACE_MUTATION_BACKEND_CAPABILITY, } from './capabilities.js';
import { createUnavailableMutationBackend } from './mutation-backend.js';
function createPlatformMutationBackend() {
    if (process.platform !== 'win32')
        return createUnavailableMutationBackend();
    return import('./mutation-backend-windows.js').then(async (module) => await module.createWindowsMutationBackend(), () => createUnavailableMutationBackend());
}
function isPromiseLike(value) {
    return typeof value === 'object' && value !== null && 'then' in value;
}
function inactiveEffect(error) {
    return typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'INACTIVE_EFFECT';
}
async function installBackend(ctx, backend) {
    try {
        ctx.effect(() => {
            const withdraw = ctx.provide(WORKSPACE_MUTATION_BACKEND_CAPABILITY, backend);
            return async () => {
                await withdraw();
                await backend.dispose();
            };
        }, 'dsh-code-ide: workspace mutation native backend');
    }
    catch (error) {
        await backend.dispose();
        if (!inactiveEffect(error))
            throw error;
    }
}
/**
 * Owns the native containment boundary as an independent reversible effect.
 * Platform implementations replace only this factory; the receipt service
 * reacts through its injected coeffect and never probes native state itself.
 *
 * This must stay non-constructible: Cordis treats ordinary function
 * declarations as class plugins, whose constructor return value is not the
 * async setup effect. An arrow function keeps native probing in the fiber's
 * awaited loading transaction.
 */
export const workspaceMutationBackendProvider = (ctx, _config, createBackend = createPlatformMutationBackend) => {
    let created;
    try {
        created = createBackend();
    }
    catch {
        created = createUnavailableMutationBackend();
    }
    if (!isPromiseLike(created))
        return installBackend(ctx, created);
    return Promise.resolve(created).then(async (backend) => await installBackend(ctx, backend), async () => await installBackend(ctx, createUnavailableMutationBackend()));
};
workspaceMutationBackendProvider.inject = [];
workspaceMutationBackendProvider.provide = WORKSPACE_MUTATION_BACKEND_CAPABILITY;
