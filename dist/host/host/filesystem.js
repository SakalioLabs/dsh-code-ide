import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { DEFAULT_MAX_INSPECT_TARGETS, } from '../shared/workspace-observation.js';
import { READ_ONLY_FILE_PREVIEW_BYTES, } from '../shared/workspace-files.js';
import { mediaPreviewDescriptor, } from '../shared/media-preview.js';
import { IdeHostError } from './errors.js';
import { assertNoNestedMount, isInternalWorkspaceName, isPathInside, parseWorkspacePath, resolveWorkspacePath, resolveWorkspaceRoot, } from './path-policy.js';
import { WorkspaceResources } from './workspace-resources.js';
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const READ_CHUNK_BYTES = 64 * 1024;
function workspaceId(workspace) {
    return String(workspace.id);
}
function compareNames(left, right) {
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
export function versionOf(info) {
    const basis = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode]
        .map(value => value.toString())
        .join(':');
    return createHash('sha256').update(basis).digest('base64url');
}
export function sameFileIdentity(left, right) {
    // Node reports FileHandle.stat().dev and lstat(path).dev differently on
    // Windows for the same file. The file index (`ino`) is the stable identity
    // there; POSIX additionally requires the device id.
    return left.ino === right.ino && (process.platform === 'win32' || left.dev === right.dev);
}
export function sameFileSnapshot(left, right) {
    return sameFileIdentity(left, right)
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs
        && left.mode === right.mode;
}
function concurrencyConflict(message, cause) {
    return new IdeHostError('VERSION_CONFLICT', message, 409, cause === undefined ? undefined : { cause });
}
async function lstatDuringVersionedOperation(path, message) {
    try {
        return await lstat(path, { bigint: true });
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
        if (code === 'ENOENT')
            throw concurrencyConflict(message, error);
        throw error;
    }
}
function wireChild(parent, name) {
    return parent === '' ? name : `${parent}/${name}`;
}
function nodeErrorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}
function parseObservationTarget(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new IdeHostError('INVALID_INSPECT_TARGET', 'Each inspect target must be an object.');
    }
    const candidate = value;
    const kind = candidate.kind;
    if (kind !== 'file' && kind !== 'directory') {
        throw new IdeHostError('INVALID_INSPECT_TARGET', 'Inspect target kind must be file or directory.');
    }
    return {
        kind,
        path: parseWorkspacePath(candidate.path, { allowRoot: kind === 'directory' }),
    };
}
function missingSnapshot(target) {
    return { path: target.path, kind: target.kind, state: 'missing' };
}
function directChildFingerprint(children) {
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return createHash('sha256')
        .update('dsh-code-ide:directory-children:v1\0')
        .update(JSON.stringify(children))
        .digest('base64url');
}
async function boundedRead(path, maxBytes, afterRead) {
    const handle = await open(path, READ_FLAGS);
    try {
        const openedBefore = await handle.stat({ bigint: true });
        if (!openedBefore.isFile())
            throw new IdeHostError('NOT_FILE', 'The requested path is not a regular file.');
        const initiallyTooLarge = openedBefore.size > BigInt(maxBytes);
        const readLimit = initiallyTooLarge ? READ_ONLY_FILE_PREVIEW_BYTES : maxBytes + 1;
        const chunks = [];
        let total = 0;
        let position = 0;
        while (total < readLimit) {
            const room = readLimit - total;
            const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, room));
            const result = await handle.read(chunk, 0, chunk.length, position);
            if (result.bytesRead === 0)
                break;
            chunks.push(chunk.subarray(0, result.bytesRead));
            total += result.bytesRead;
            position += result.bytesRead;
        }
        await afterRead?.(path);
        const openedAfter = await handle.stat({ bigint: true });
        const pathInfo = await lstatDuringVersionedOperation(path, 'The file changed while it was being read.');
        if (!pathInfo.isFile() || pathInfo.isSymbolicLink()
            || !sameFileSnapshot(openedBefore, openedAfter)
            || !sameFileSnapshot(openedAfter, pathInfo)) {
            throw concurrencyConflict('The file changed while it was being read.');
        }
        if (pathInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new IdeHostError('FILE_SIZE_UNREPRESENTABLE', 'File size exceeds the exact JSON integer range.', 413);
        }
        const tooLarge = pathInfo.size > BigInt(maxBytes);
        const bytes = Buffer.concat(chunks, total);
        return {
            bytes: tooLarge ? bytes.subarray(0, READ_ONLY_FILE_PREVIEW_BYTES) : bytes,
            info: pathInfo,
            tooLarge,
        };
    }
    finally {
        await handle.close();
    }
}
async function verifyPublishedFile(path, expected, content) {
    const handle = await open(path, READ_FLAGS);
    try {
        const openedBefore = await handle.stat({ bigint: true });
        if (!openedBefore.isFile() || !sameFileSnapshot(expected, openedBefore)) {
            throw concurrencyConflict('The file changed while the save was being verified.');
        }
        let position = 0;
        while (position < content.length) {
            const length = Math.min(READ_CHUNK_BYTES, content.length - position);
            const chunk = Buffer.allocUnsafe(length);
            const result = await handle.read(chunk, 0, length, position);
            if (result.bytesRead !== length
                || !chunk.subarray(0, result.bytesRead).equals(content.subarray(position, position + result.bytesRead))) {
                throw concurrencyConflict('The file content changed while the save was being verified.');
            }
            position += result.bytesRead;
        }
        const trailing = Buffer.allocUnsafe(1);
        if ((await handle.read(trailing, 0, 1, position)).bytesRead !== 0) {
            throw concurrencyConflict('The file content changed while the save was being verified.');
        }
        const openedAfter = await handle.stat({ bigint: true });
        const pathInfo = await lstatDuringVersionedOperation(path, 'The file changed while the save was being verified.');
        if (!sameFileSnapshot(openedBefore, openedAfter)
            || !sameFileSnapshot(openedAfter, pathInfo)
            || !sameFileSnapshot(expected, pathInfo)) {
            throw concurrencyConflict('The file changed while the save was being verified.');
        }
        return pathInfo;
    }
    finally {
        await handle.close();
    }
}
function decodeText(bytes) {
    if (bytes.includes(0))
        throw new IdeHostError('NOT_TEXT', 'Binary files cannot be opened in the text editor.', 415);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (error) {
        throw new IdeHostError('NOT_TEXT', 'The file is not valid UTF-8 text.', 415, { cause: error });
    }
}
function decodeTextPrefix(bytes) {
    if (bytes.includes(0))
        return undefined;
    try {
        // Streaming mode retains only a possibly incomplete final code point while
        // still rejecting every malformed sequence inside the sampled prefix.
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    }
    catch {
        return undefined;
    }
}
function decodeReadOnlyText(bytes, complete) {
    if (!complete)
        return decodeTextPrefix(bytes);
    try {
        return decodeText(bytes);
    }
    catch (error) {
        if (error instanceof IdeHostError && error.code === 'NOT_TEXT')
            return undefined;
        throw error;
    }
}
function readOnlyPresentation(reason, info, limitBytes, content) {
    return {
        reason,
        sizeBytes: Number(info.size),
        limitBytes,
        previewBytes: Buffer.byteLength(content, 'utf8'),
        truncated: true,
    };
}
async function currentFile(path) {
    if (!path.exists)
        return undefined;
    const info = await lstat(path.absolutePath, { bigint: true });
    if (info.isSymbolicLink())
        throw new IdeHostError('SYMLINK_NOT_ALLOWED', 'Symbolic links cannot be saved.', 403);
    if (!info.isFile())
        throw new IdeHostError('NOT_FILE', 'The requested path is not a regular file.');
    return { version: versionOf(info), mode: Number(info.mode & 511n) };
}
export async function syncDirectory(path) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY);
        await handle.sync();
    }
    catch {
        // Directory fsync is not available on every supported Windows/filesystem pair.
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
/** Workspace-scoped, symlink-rejecting text file operations for the browser IDE. */
export class WorkspaceFileService {
    registry;
    options;
    internals;
    resources;
    ownsResources;
    activeMutations = new Set();
    activeMediaOpens = new Set();
    activeMediaHandles = new Set();
    disposing = false;
    constructor(registry, options, internals = {}, resources) {
        this.registry = registry;
        this.options = options;
        this.internals = internals;
        this.resources = resources ?? new WorkspaceResources(registry);
        this.ownsResources = resources === undefined;
    }
    workspaces(maxTerminalSessions) {
        return {
            maxTerminalSessions,
            workspaces: this.registry.list().map(workspace => ({
                workspaceId: workspaceId(workspace),
                title: workspace.title,
                path: workspace.path,
            })),
        };
    }
    async list(id, pathValue) {
        const workspace = this.requireWorkspace(id);
        const relativePath = parseWorkspacePath(pathValue, { allowRoot: true });
        const root = await this.resources.resolveRoot(workspace);
        const target = await resolveWorkspacePath(root, relativePath, { allowMissingFinal: false });
        const targetInfo = await lstat(target.absolutePath);
        if (!targetInfo.isDirectory())
            throw new IdeHostError('NOT_DIRECTORY', 'The requested path is not a directory.');
        const entries = [];
        const directory = await opendir(target.absolutePath);
        try {
            for await (const child of directory) {
                if (entries.length >= this.options.maxDirectoryEntries) {
                    throw new IdeHostError('DIRECTORY_TOO_LARGE', `Directory contains more than ${String(this.options.maxDirectoryEntries)} entries.`, 413);
                }
                if (isInternalWorkspaceName(child.name))
                    continue;
                const absoluteChild = join(target.absolutePath, child.name);
                let info;
                try {
                    info = await lstat(absoluteChild, { bigint: true });
                }
                catch {
                    continue;
                }
                const type = info.isSymbolicLink()
                    ? 'other'
                    : info.isDirectory()
                        ? 'directory'
                        : info.isFile()
                            ? 'file'
                            : 'other';
                entries.push({
                    name: child.name,
                    path: wireChild(relativePath, child.name),
                    type,
                    version: versionOf(info),
                    ...(info.isFile() ? { size: Number(info.size) } : {}),
                });
            }
        }
        finally {
            await directory.close().catch(() => { });
        }
        entries.sort(compareNames);
        return { entries };
    }
    /**
     * Observe a bounded set of visible resources without reading file contents
     * or recursively walking the workspace. Directory versions fingerprint only
     * their sorted direct child names and kinds.
     */
    async inspect(id, targetsValue) {
        const workspace = this.requireWorkspace(id);
        if (!Array.isArray(targetsValue)) {
            throw new IdeHostError('INVALID_INSPECT_TARGETS', 'targets must be an array.');
        }
        const maxTargets = this.options.maxInspectTargets ?? DEFAULT_MAX_INSPECT_TARGETS;
        if (targetsValue.length > maxTargets) {
            throw new IdeHostError('TOO_MANY_INSPECT_TARGETS', `Inspect accepts at most ${String(maxTargets)} targets.`, 413);
        }
        const targets = [];
        const seen = new Set();
        for (const value of targetsValue) {
            const target = parseObservationTarget(value);
            const key = `${target.kind}\0${target.path}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            targets.push(target);
        }
        const root = await this.resources.resolveRoot(workspace);
        const snapshots = [];
        const maxDirectoryChildren = this.options.maxInspectDirectoryEntries ?? this.options.maxDirectoryEntries;
        let visitedDirectoryChildren = 0;
        for (const target of targets) {
            let resolved;
            try {
                resolved = await resolveWorkspacePath(root, target.path, { allowMissingFinal: true });
            }
            catch (error) {
                if (error instanceof IdeHostError && (error.code === 'NOT_FOUND' || error.code === 'NOT_DIRECTORY')) {
                    snapshots.push(missingSnapshot(target));
                    continue;
                }
                throw error;
            }
            if (!resolved.exists) {
                snapshots.push(missingSnapshot(target));
                continue;
            }
            let info;
            try {
                info = await lstat(resolved.absolutePath, { bigint: true });
            }
            catch (error) {
                if (nodeErrorCode(error) === 'ENOENT' || nodeErrorCode(error) === 'ENOTDIR') {
                    snapshots.push(missingSnapshot(target));
                    continue;
                }
                throw error;
            }
            if (target.kind === 'file') {
                if (!info.isFile() || info.isSymbolicLink()) {
                    snapshots.push(missingSnapshot(target));
                    continue;
                }
                snapshots.push({
                    path: target.path,
                    kind: 'file',
                    state: 'present',
                    version: versionOf(info),
                    size: Number(info.size),
                });
                continue;
            }
            if (!info.isDirectory() || info.isSymbolicLink()) {
                snapshots.push(missingSnapshot(target));
                continue;
            }
            const children = [];
            let directory;
            try {
                directory = await opendir(resolved.absolutePath);
                for await (const child of directory) {
                    if (isInternalWorkspaceName(child.name))
                        continue;
                    visitedDirectoryChildren += 1;
                    if (visitedDirectoryChildren > maxDirectoryChildren) {
                        throw new IdeHostError('INSPECT_DIRECTORY_BUDGET_EXCEEDED', `Inspect visits at most ${String(maxDirectoryChildren)} direct directory entries.`, 413);
                    }
                    let childInfo;
                    try {
                        childInfo = await lstat(join(resolved.absolutePath, child.name), { bigint: true });
                    }
                    catch (error) {
                        if (nodeErrorCode(error) === 'ENOENT')
                            continue;
                        throw error;
                    }
                    const kind = childInfo.isSymbolicLink()
                        ? 'other'
                        : childInfo.isDirectory()
                            ? 'directory'
                            : childInfo.isFile()
                                ? 'file'
                                : 'other';
                    children.push({ name: child.name, kind });
                }
            }
            catch (error) {
                if (nodeErrorCode(error) === 'ENOENT' || nodeErrorCode(error) === 'ENOTDIR') {
                    snapshots.push(missingSnapshot(target));
                    continue;
                }
                throw error;
            }
            finally {
                await directory?.close().catch(() => { });
            }
            snapshots.push({
                path: target.path,
                kind: 'directory',
                state: 'present',
                version: directChildFingerprint(children),
            });
        }
        return { snapshots };
    }
    async read(id, pathValue) {
        const workspace = this.requireWorkspace(id);
        const relativePath = parseWorkspacePath(pathValue, { allowRoot: false });
        const root = await this.resources.resolveRoot(workspace);
        const target = await resolveWorkspacePath(root, relativePath, { allowMissingFinal: false });
        const before = await realpath(target.absolutePath);
        if (!isPathInside(root.realPath, before)) {
            throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
        }
        const { bytes, info, tooLarge } = await boundedRead(target.absolutePath, this.options.maxFileBytes, this.internals.afterOpenedFileRead);
        const after = await realpath(target.absolutePath);
        if (!isPathInside(root.realPath, after)) {
            throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escaped the workspace during the read.', 403);
        }
        const finalInfo = await lstatDuringVersionedOperation(target.absolutePath, 'The file changed while it was being read.');
        if (!sameFileSnapshot(info, finalInfo)) {
            throw concurrencyConflict('The file changed while it was being read.');
        }
        const version = versionOf(finalInfo);
        if (tooLarge) {
            const preview = decodeReadOnlyText(bytes, finalInfo.size <= BigInt(bytes.byteLength));
            if (preview === undefined) {
                return {
                    path: relativePath,
                    content: '',
                    version,
                    readOnlyPresentation: readOnlyPresentation('binary', finalInfo, this.options.maxFileBytes, ''),
                };
            }
            return {
                path: relativePath,
                content: preview,
                version,
                readOnlyPresentation: readOnlyPresentation('too-large', finalInfo, this.options.maxFileBytes, preview),
            };
        }
        try {
            return { path: relativePath, content: decodeText(bytes), version };
        }
        catch (error) {
            if (!(error instanceof IdeHostError) || error.code !== 'NOT_TEXT')
                throw error;
            return {
                path: relativePath,
                content: '',
                version,
                readOnlyPresentation: readOnlyPresentation('binary', finalInfo, this.options.maxFileBytes, ''),
            };
        }
    }
    /**
     * Open one allowlisted media file while preserving the workspace root,
     * symlink, mount, snapshot, and optional observed-version boundaries used by
     * text reads. The caller owns the returned lease and must close it.
     */
    async openMedia(id, pathValue, expectedVersionValue) {
        if (this.disposing)
            throw new IdeHostError('FILES_UNAVAILABLE', 'Workspace files are stopping.', 503);
        const opening = this.openMediaAdmitted(id, pathValue, expectedVersionValue);
        this.activeMediaOpens.add(opening);
        try {
            return await opening;
        }
        finally {
            this.activeMediaOpens.delete(opening);
        }
    }
    async openMediaAdmitted(id, pathValue, expectedVersionValue) {
        const workspace = this.requireWorkspace(id);
        const relativePath = parseWorkspacePath(pathValue, { allowRoot: false });
        const descriptor = mediaPreviewDescriptor(relativePath);
        if (descriptor === undefined) {
            throw new IdeHostError('UNSUPPORTED_MEDIA_TYPE', 'This file type is not available in the media preview.', 415);
        }
        const expectedVersion = expectedVersionValue === undefined
            ? undefined
            : typeof expectedVersionValue === 'string'
                && Buffer.byteLength(expectedVersionValue, 'utf8') > 0
                && Buffer.byteLength(expectedVersionValue, 'utf8') <= 256
                ? expectedVersionValue
                : (() => { throw new IdeHostError('INVALID_VERSION', 'version must be a non-empty bounded version token.'); })();
        const root = await this.resources.resolveRoot(workspace);
        const target = await resolveWorkspacePath(root, relativePath, { allowMissingFinal: false });
        const assertMediaMountBoundary = this.internals.assertNoNestedMount ?? assertNoNestedMount;
        await assertMediaMountBoundary(root, target.absolutePath, { includeDescendants: false });
        const before = await realpath(target.absolutePath);
        if (!isPathInside(root.realPath, before)) {
            throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escapes the workspace.', 403);
        }
        const handle = await open(target.absolutePath, READ_FLAGS);
        let leased = false;
        try {
            const openedBefore = await handle.stat({ bigint: true });
            if (!openedBefore.isFile())
                throw new IdeHostError('NOT_FILE', 'The requested path is not a regular file.');
            const pathInfo = await lstatDuringVersionedOperation(target.absolutePath, 'The file changed while the media preview was being opened.');
            const after = await realpath(target.absolutePath);
            if (!isPathInside(root.realPath, after)) {
                throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'path escaped the workspace during the media open.', 403);
            }
            const openedAfter = await handle.stat({ bigint: true });
            if (pathInfo.isSymbolicLink()
                || !pathInfo.isFile()
                || !sameFileSnapshot(openedBefore, openedAfter)
                || !sameFileSnapshot(openedAfter, pathInfo)) {
                throw concurrencyConflict('The file changed while the media preview was being opened.');
            }
            await assertMediaMountBoundary(root, target.absolutePath, { includeDescendants: false });
            if (pathInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new IdeHostError('FILE_SIZE_UNREPRESENTABLE', 'File size exceeds the exact integer range.', 413);
            }
            const maxMediaBytes = this.options.maxMediaBytes ?? 512 * 1024 * 1024;
            if (pathInfo.size > BigInt(maxMediaBytes)) {
                throw new IdeHostError('MEDIA_TOO_LARGE', `Media exceeds the ${String(maxMediaBytes)} byte preview limit.`, 413);
            }
            const version = versionOf(pathInfo);
            if (expectedVersion !== undefined && expectedVersion !== version) {
                throw concurrencyConflict('The file changed after the media preview was opened.');
            }
            this.activeMediaHandles.add(handle);
            leased = true;
            let closed = false;
            return {
                descriptor,
                handle,
                path: relativePath,
                sizeBytes: Number(pathInfo.size),
                version,
                close: async () => {
                    if (closed)
                        return;
                    closed = true;
                    this.activeMediaHandles.delete(handle);
                    await handle.close().catch(() => { });
                },
            };
        }
        finally {
            if (!leased)
                await handle.close().catch(() => { });
        }
    }
    async write(id, pathValue, contentValue, expectedVersionValue) {
        if (this.disposing)
            throw new IdeHostError('FILES_UNAVAILABLE', 'Workspace files are stopping.', 503);
        const workspace = this.requireWorkspace(id);
        const relativePath = parseWorkspacePath(pathValue, { allowRoot: false });
        if (typeof contentValue !== 'string')
            throw new IdeHostError('INVALID_CONTENT', 'content must be a string.');
        if (contentValue.includes('\0'))
            throw new IdeHostError('INVALID_CONTENT', 'NUL bytes are not valid editor text.');
        const content = Buffer.from(contentValue, 'utf8');
        if (content.byteLength > this.options.maxFileBytes) {
            throw new IdeHostError('FILE_TOO_LARGE', `File exceeds the ${String(this.options.maxFileBytes)} byte IDE limit.`, 413);
        }
        const expectedVersion = expectedVersionValue === undefined
            ? undefined
            : typeof expectedVersionValue === 'string' && expectedVersionValue.length > 0 && expectedVersionValue.length <= 256
                ? expectedVersionValue
                : (() => { throw new IdeHostError('INVALID_VERSION', 'expectedVersion must be a non-empty version token.'); })();
        const pending = this.resources.runMutation(workspace, async () => {
            const root = await this.resources.resolveRoot(workspace);
            const target = await resolveWorkspacePath(root, relativePath, { allowMissingFinal: true });
            const current = await currentFile(target);
            this.assertExpectedVersion(current?.version, expectedVersion);
            const version = await this.publish(root, target, content, current?.mode, expectedVersion);
            return { path: relativePath, version };
        });
        const settled = pending.then(() => undefined, () => undefined);
        this.activeMutations.add(settled);
        try {
            return await pending;
        }
        finally {
            this.activeMutations.delete(settled);
        }
    }
    /** Wait for plugin-owned mutations before the capability provider stops. */
    async dispose() {
        this.disposing = true;
        await Promise.allSettled([...this.activeMediaOpens]);
        await Promise.allSettled([...this.activeMediaHandles].map(async (handle) => await handle.close()));
        this.activeMediaHandles.clear();
        if (this.ownsResources)
            await this.resources.dispose();
        while (this.activeMutations.size > 0)
            await Promise.allSettled([...this.activeMutations]);
    }
    requireWorkspace(value) {
        return this.resources.requireWorkspace(value);
    }
    assertExpectedVersion(current, expected) {
        if (current === undefined && expected !== undefined) {
            throw new IdeHostError('VERSION_CONFLICT', 'The file was removed after it was opened.', 409);
        }
        if (current !== undefined && expected === undefined) {
            throw new IdeHostError('EXPECTED_VERSION_REQUIRED', 'Saving an existing file requires its read version.', 428);
        }
        if (current !== undefined && current !== expected) {
            throw new IdeHostError('VERSION_CONFLICT', 'The file changed after it was opened.', 409);
        }
    }
    async publish(root, target, content, existingMode, expectedVersion) {
        const parent = dirname(target.absolutePath);
        const realParent = await realpath(parent);
        if (!isPathInside(root.realPath, realParent)) {
            throw new IdeHostError('PATH_OUTSIDE_WORKSPACE', 'The save parent escapes the workspace.', 403);
        }
        const staging = join(parent, `.${basename(target.absolutePath)}.dsh-code-ide-${randomUUID()}.tmp`);
        let stagingPresent = false;
        let stagingInfo;
        try {
            const handle = await open(staging, 'wx', existingMode ?? 0o666);
            stagingPresent = true;
            try {
                await handle.writeFile(content);
                if (existingMode !== undefined) {
                    // Atomic replacement preserves POSIX permission bits explicitly.
                    // The temporary-file strategy does not promise to preserve ACLs,
                    // extended attributes, alternate streams, or other file metadata.
                    await handle.chmod(existingMode);
                }
                await handle.sync();
                stagingInfo = await handle.stat({ bigint: true });
            }
            finally {
                await handle.close();
            }
            const freshRoot = await resolveWorkspaceRoot(root.registeredPath, root.identity);
            const freshTarget = await resolveWorkspacePath(freshRoot, target.relativePath, { allowMissingFinal: true });
            const freshCurrent = await currentFile(freshTarget);
            this.assertExpectedVersion(freshCurrent?.version, expectedVersion);
            if (freshCurrent === undefined) {
                try {
                    await link(staging, freshTarget.absolutePath);
                }
                catch (error) {
                    const code = typeof error === 'object' && error !== null && 'code' in error
                        ? String(error.code)
                        : undefined;
                    if (code === 'EEXIST') {
                        throw new IdeHostError('VERSION_CONFLICT', 'The file was created by another writer.', 409, { cause: error });
                    }
                    throw error;
                }
                await unlink(staging);
                stagingPresent = false;
            }
            else {
                await rename(staging, freshTarget.absolutePath);
                stagingPresent = false;
            }
            await syncDirectory(realParent);
            const committed = await lstatDuringVersionedOperation(freshTarget.absolutePath, 'The file changed before the save could be verified.');
            if (stagingInfo === undefined || !sameFileIdentity(stagingInfo, committed)
                || !committed.isFile() || committed.isSymbolicLink()) {
                throw concurrencyConflict('The file changed before the save could be verified.');
            }
            await this.internals.afterPublishCommit?.(freshTarget.absolutePath);
            const verified = await verifyPublishedFile(freshTarget.absolutePath, committed, content);
            return versionOf(verified);
        }
        finally {
            if (stagingPresent)
                await unlink(staging).catch(() => { });
        }
    }
}
