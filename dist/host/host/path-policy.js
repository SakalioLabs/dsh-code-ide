import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, toNamespacedPath, win32 } from 'node:path';
import { MUTATION_BUDGETS } from '../shared/workspace-mutations.js';
import { IdeHostError } from './errors.js';
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_FORBIDDEN_NAME = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const INTERNAL_NAME_PREFIX = '.__dsh_code_ide_';
function samePath(left, right) {
    // `realpath()` may switch between DOS and extended-length (`\\?\\`)
    // spellings on Windows. Compare both inputs in the same namespace without
    // accepting an actual reparse-point/junction alias; root lstat checks below
    // still verify the directory identity.
    const comparableLeft = process.platform === 'win32' ? toNamespacedPath(left) : left;
    const comparableRight = process.platform === 'win32' ? toNamespacedPath(right) : right;
    const delta = relative(comparableLeft, comparableRight);
    return delta === '';
}
function windowsRegisteredPathParts(absolute) {
    // `win32.parse()` treats only `\\?\UNC\` as the root of a namespaced UNC
    // path. Include its server/share components explicitly so the walk starts
    // at a real filesystem root while retaining the long-path namespace.
    const namespacedUncPrefix = '\\\\?\\UNC\\';
    if (absolute.slice(0, namespacedUncPrefix.length).toLowerCase() === namespacedUncPrefix.toLowerCase()) {
        const [server, share, ...segments] = absolute
            .slice(namespacedUncPrefix.length)
            .split(win32.sep)
            .filter(segment => segment !== '');
        if (server === undefined || share === undefined) {
            return { root: '', segments: [] };
        }
        return { root: `${namespacedUncPrefix}${server}\\${share}\\`, segments };
    }
    const root = win32.parse(absolute).root;
    return {
        root,
        segments: absolute.slice(root.length).split(win32.sep).filter(segment => segment !== ''),
    };
}
async function assertWindowsRegisteredPathHasNoLinks(absolute) {
    const { root, segments } = windowsRegisteredPathParts(absolute);
    if (root === '') {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root identity has changed.', 409);
    }
    let cursor = root;
    const components = [cursor];
    for (const segment of segments) {
        cursor = win32.join(cursor, segment);
        components.push(cursor);
    }
    for (const component of components) {
        let info;
        try {
            info = await lstat(component, { bigint: true });
        }
        catch (error) {
            throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace directory is unavailable.', 409, { cause: error });
        }
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root identity has changed.', 409);
        }
    }
}
export function isPathInside(root, candidate) {
    const delta = relative(root, candidate);
    return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}
/** Names in this namespace are Host-owned staging/quarantine resources. */
export function isInternalWorkspaceName(name) {
    return name.toLowerCase().startsWith(INTERNAL_NAME_PREFIX);
}
function validateWorkspaceSegment(segment) {
    if (Buffer.byteLength(segment, 'utf8') > MUTATION_BUDGETS.maxNameBytes) {
        throw new IdeHostError('INVALID_PATH', 'path contains a name that is too long.');
    }
    // Mutation names remain portable across workspaces that may later move
    // between supported Hosts; Windows ADS/device normalization must never
    // create a second interpretation of a v1 wire path.
    if (CONTROL_CHARACTER.test(segment)
        || WINDOWS_FORBIDDEN_NAME.test(segment)
        || segment.endsWith('.')
        || segment.endsWith(' ')
        || WINDOWS_RESERVED_NAME.test(segment)) {
        throw new IdeHostError('INVALID_PATH', 'path contains a platform-forbidden name.');
    }
    if (isInternalWorkspaceName(segment)) {
        throw new IdeHostError('INVALID_PATH', 'path uses a Host-reserved name.');
    }
}
/** Parse a browser path into a canonical slash-separated relative path. */
export function parseWorkspacePath(value, options) {
    if (typeof value !== 'string')
        throw new IdeHostError('INVALID_PATH', 'path must be a string.');
    if (Buffer.byteLength(value, 'utf8') > MUTATION_BUDGETS.maxPathBytes) {
        throw new IdeHostError('INVALID_PATH', 'path is too long.');
    }
    if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || win32.isAbsolute(value)) {
        throw new IdeHostError('INVALID_PATH', 'path must be workspace-relative.');
    }
    if (value === '') {
        if (options.allowRoot)
            return '';
        throw new IdeHostError('INVALID_PATH', 'A file path is required.');
    }
    const segments = value.split('/');
    if (segments.length > MUTATION_BUDGETS.maxPathSegments) {
        throw new IdeHostError('INVALID_PATH', 'path contains too many segments.');
    }
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
        throw new IdeHostError('INVALID_PATH', 'path contains a forbidden segment.');
    }
    for (const segment of segments)
        validateWorkspaceSegment(segment);
    return segments.join('/');
}
/** Revalidate that the durable Workspace root still names the original directory, not a symlink. */
export async function resolveWorkspaceRoot(registeredPath, expectedIdentity) {
    const absolute = resolve(registeredPath);
    let linkInfo;
    try {
        linkInfo = await lstat(absolute, { bigint: true });
    }
    catch (error) {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace directory is unavailable.', 409, { cause: error });
    }
    if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root is not a real directory.', 409);
    }
    const canonical = await realpath(absolute);
    if (!samePath(absolute, canonical)) {
        if (process.platform !== 'win32') {
            throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root identity has changed.', 409);
        }
        // Windows `realpath()` expands 8.3 components (for example RUNNER~1 on
        // hosted CI) even when the registered path contains no reparse point. A
        // component-by-component lstat walk distinguishes that benign spelling
        // change from a symlink/junction alias without weakening the final
        // dev/ino identity checks below.
        await assertWindowsRegisteredPathHasNoLinks(absolute);
    }
    const canonicalInfo = await lstat(canonical, { bigint: true });
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()
        || canonicalInfo.dev !== linkInfo.dev || canonicalInfo.ino !== linkInfo.ino) {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root identity has changed.', 409);
    }
    const identity = { dev: linkInfo.dev, ino: linkInfo.ino };
    if (expectedIdentity !== undefined
        && (expectedIdentity.dev !== identity.dev || expectedIdentity.ino !== identity.ino)) {
        throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root identity has changed.', 409);
    }
    return { registeredPath: absolute, realPath: canonical, identity };
}
function decodeLinuxMountField(value) {
    return value.replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
async function linuxMountPoints() {
    if (process.platform !== 'linux')
        return [];
    let source;
    try {
        source = await readFile('/proc/self/mountinfo', 'utf8');
    }
    catch (error) {
        throw new IdeHostError('MOUNT_POLICY_UNAVAILABLE', 'The Host cannot prove the workspace mount boundary.', 501, { cause: error });
    }
    const points = [];
    for (const line of source.split('\n')) {
        if (line === '')
            continue;
        const fields = line.split(' ');
        const mountPoint = fields[4];
        if (mountPoint === undefined) {
            throw new IdeHostError('MOUNT_POLICY_UNAVAILABLE', 'The Host cannot prove the workspace mount boundary.', 501);
        }
        points.push(resolve(decodeLinuxMountField(mountPoint)));
    }
    return points;
}
/**
 * Reject a target reached through a nested mount and, for directory moves or
 * recursive deletion, any mount rooted below it. Linux mount IDs are required
 * because same-device bind mounts deliberately preserve `stat.dev`.
 */
export async function assertNoNestedMount(root, candidate, options) {
    const absolute = resolve(candidate);
    if (!isPathInside(root.realPath, absolute)) {
        throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
    }
    for (const mountPoint of await linuxMountPoints()) {
        if (samePath(mountPoint, root.realPath) || !isPathInside(root.realPath, mountPoint))
            continue;
        const reachesCandidate = samePath(mountPoint, absolute) || isPathInside(mountPoint, absolute);
        const nestedBelowCandidate = options.includeDescendants && isPathInside(absolute, mountPoint);
        if (reachesCandidate || nestedBelowCandidate) {
            throw new IdeHostError('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403);
        }
    }
}
/**
 * Resolve a relative path without following repository-owned symlinks.
 * When `allowMissingFinal` is true, only the final component may be absent.
 */
export async function resolveWorkspacePath(root, wirePath, options) {
    if (wirePath === '')
        return { absolutePath: root.realPath, relativePath: '', exists: true };
    const segments = wirePath.split('/');
    let cursor = root.realPath;
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === undefined)
            throw new IdeHostError('INVALID_PATH', 'Invalid path segment.');
        cursor = join(cursor, segment);
        if (!isPathInside(root.realPath, cursor)) {
            throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
        }
        let info;
        try {
            info = await lstat(cursor, { bigint: true });
        }
        catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : undefined;
            const isFinal = index === segments.length - 1;
            if (code === 'ENOENT' && isFinal && options.allowMissingFinal) {
                const parent = await realpath(join(cursor, '..'));
                if (!isPathInside(root.realPath, parent)) {
                    throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
                }
                return { absolutePath: cursor, relativePath: wirePath, exists: false };
            }
            throw new IdeHostError('NOT_FOUND', `Path not found: ${wirePath}`, 404, { cause: error });
        }
        if (info.isSymbolicLink()) {
            throw new IdeHostError('SYMLINK_NOT_ALLOWED', `Symbolic links are not available in the IDE: ${wirePath}`, 403);
        }
        if (info.dev !== root.identity.dev) {
            throw new IdeHostError('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403);
        }
        if (index < segments.length - 1 && !info.isDirectory()) {
            throw new IdeHostError('NOT_DIRECTORY', `A parent path is not a directory: ${wirePath}`, 400);
        }
    }
    const canonical = await realpath(cursor);
    if (!isPathInside(root.realPath, canonical)) {
        throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
    }
    return { absolutePath: canonical, relativePath: wirePath, exists: true };
}
