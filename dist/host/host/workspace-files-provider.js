import { WORKSPACE_FILES_CAPABILITY, WORKSPACE_RESOURCES_CAPABILITY, } from './capabilities.js';
import { WorkspaceFileService } from './filesystem.js';
/** Own the v1 workspace-files capability independently from HTTP transport. */
export function workspaceFilesProvider(ctx, config) {
    const resources = ctx[WORKSPACE_RESOURCES_CAPABILITY];
    const files = new WorkspaceFileService(resources.registry, {
        maxFileBytes: config.maxFileBytes,
        maxMediaBytes: config.maxMediaBytes,
        maxDirectoryEntries: config.maxDirectoryEntries,
        maxInspectTargets: config.maxInspectTargets,
        maxInspectDirectoryEntries: config.maxInspectDirectoryEntries,
    }, {}, resources);
    // Cordis unloads sibling effects concurrently. Nesting provide inside the
    // provider-resource effect gives this disposer an explicit sequencing
    // barrier: withdraw first (which waits for dependent fibers), clean up last.
    ctx.effect(() => {
        const withdraw = ctx.provide(WORKSPACE_FILES_CAPABILITY, files);
        return async () => {
            await withdraw();
            await files.dispose();
        };
    }, 'dsh-code-ide: workspace-files capability');
}
workspaceFilesProvider.inject = [WORKSPACE_RESOURCES_CAPABILITY];
workspaceFilesProvider.provide = WORKSPACE_FILES_CAPABILITY;
