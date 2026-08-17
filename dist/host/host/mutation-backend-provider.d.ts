import { type WorkspaceMutationBackendProviderContext } from './capabilities.js';
import { type MutationBackend } from './mutation-backend.js';
export type MutationBackendFactory = () => MutationBackend | Promise<MutationBackend>;
export interface PlatformMutationBackendFactories {
    readonly win32: MutationBackendFactory;
    readonly linux: MutationBackendFactory;
    readonly darwin: MutationBackendFactory;
}
/** Select exactly one platform backend and fail closed on load or probe errors. */
export declare function createPlatformMutationBackend(platform?: NodeJS.Platform, factories?: PlatformMutationBackendFactories): Promise<MutationBackend>;
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
export declare const workspaceMutationBackendProvider: {
    (ctx: WorkspaceMutationBackendProviderContext, _config: Record<string, never>, createBackend?: MutationBackendFactory): Promise<void>;
    inject: string[];
    provide: string;
};
