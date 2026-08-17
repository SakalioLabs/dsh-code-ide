/** Versioned, JSON-safe workspace mutation protocol shared by Host and browser. */
export const WORKSPACE_MUTATIONS_PROTOCOL = 'dsh-code-ide.workspace-mutations.v1';
export const WORKSPACE_MUTATIONS_ROUTE = '/dsh-code-ide/api/workspace-mutations/v1';
export const MUTATION_BUDGETS = Object.freeze({
    maxWorkspaceIdBytes: 256,
    maxProviderEpochBytes: 64,
    maxOperationIdBytes: 64,
    maxVersionBytes: 256,
    maxPathBytes: 16 * 1024,
    maxPathSegments: 128,
    maxNameBytes: 255,
});
