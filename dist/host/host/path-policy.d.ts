export declare function isPathInside(root: string, candidate: string): boolean;
/** Names in this namespace are Host-owned staging/quarantine resources. */
export declare function isInternalWorkspaceName(name: string): boolean;
/** Parse a browser path into a canonical slash-separated relative path. */
export declare function parseWorkspacePath(value: unknown, options: {
    allowRoot: boolean;
}): string;
export interface WorkspaceRootIdentity {
    dev: bigint;
    ino: bigint;
}
export interface ResolvedWorkspaceRoot {
    registeredPath: string;
    realPath: string;
    identity: WorkspaceRootIdentity;
}
/** Revalidate that the durable Workspace root still names the original directory, not a symlink. */
export declare function resolveWorkspaceRoot(registeredPath: string, expectedIdentity?: WorkspaceRootIdentity): Promise<ResolvedWorkspaceRoot>;
export interface ResolvedWorkspacePath {
    absolutePath: string;
    relativePath: string;
    exists: boolean;
}
/**
 * Reject a target reached through a nested mount and, for directory moves or
 * recursive deletion, any mount rooted below it. Linux mount IDs are required
 * because same-device bind mounts deliberately preserve `stat.dev`.
 */
export declare function assertNoNestedMount(root: ResolvedWorkspaceRoot, candidate: string, options: {
    includeDescendants: boolean;
}): Promise<void>;
/**
 * Resolve a relative path without following repository-owned symlinks.
 * When `allowMissingFinal` is true, only the final component may be absent.
 */
export declare function resolveWorkspacePath(root: ResolvedWorkspaceRoot, wirePath: string, options: {
    allowMissingFinal: boolean;
}): Promise<ResolvedWorkspacePath>;
