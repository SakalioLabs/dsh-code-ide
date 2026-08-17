/** Namespaced capability keys are protocol names; changing shape requires v2. */
export const WORKSPACE_FILES_CAPABILITY = 'dsh-code-ide.workspace-files.v1';
export const TERMINAL_CAPABILITY = 'dsh-code-ide.terminal.v1';
export const WORKSPACE_SEARCH_CAPABILITY = 'dsh-code-ide.workspace-search.v1';
export const WORKSPACE_MUTATIONS_CAPABILITY = 'dsh-code-ide.workspace-mutations.v1';
/** Internal resource protocol; never projected onto the browser transport. */
export const WORKSPACE_RESOURCES_CAPABILITY = 'dsh-code-ide.workspace-resources.v1';
/** Internal native containment boundary; never projected onto browser transport. */
export const WORKSPACE_MUTATION_BACKEND_CAPABILITY = 'dsh-code-ide.mutation-backend.v1';
