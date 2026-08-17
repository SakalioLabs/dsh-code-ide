import { IdeHostError } from './errors.js';
/**
 * Internal ABI between receipt/orchestration code and a containment-safe
 * native workspace mutator. This is not a browser protocol capability.
 */
export const MUTATION_BACKEND_ABI = 'dsh-code-ide.mutation-backend.v1';
const NO_CAPABILITIES = Object.freeze({
    createFile: false,
    createDirectory: false,
    rename: false,
    delete: false,
});
const UNAVAILABLE_DESCRIPTOR = Object.freeze({
    abi: MUTATION_BACKEND_ABI,
    implementation: 'unavailable',
    confinement: 'backend-owned-handle-relative-v1',
    capabilities: NO_CAPABILITIES,
});
/** Side-effect-free production fallback while no proven native backend exists. */
export class UnavailableMutationBackend {
    descriptor = UNAVAILABLE_DESCRIPTOR;
    async openWorkspace(_request) {
        throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'A containment-safe workspace mutation backend is unavailable on this Host.', 501);
    }
    async dispose() { }
}
export function createUnavailableMutationBackend() {
    return new UnavailableMutationBackend();
}
