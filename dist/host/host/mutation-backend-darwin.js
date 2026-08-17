import { randomUUID } from 'node:crypto';
import { close, fstat, open } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MUTATION_BUDGETS } from '../shared/workspace-mutations.js';
import { IdeHostError } from './errors.js';
import { versionOf } from './filesystem.js';
import { isInternalWorkspaceName } from './path-policy.js';
import { MUTATION_BACKEND_ABI, createUnavailableMutationBackend, } from './mutation-backend.js';
const DARWIN_DESCRIPTOR = Object.freeze({
    abi: MUTATION_BACKEND_ABI,
    implementation: 'darwin-openat-handles',
    confinement: 'trusted-local-dirfd-relative-v1',
    capabilities: Object.freeze({
        createFile: true,
        createDirectory: true,
        // renameatx_np and unlinkat select the source by name. Without an
        // open-by-handle commit primitive, a concurrent replacement cannot be
        // excluded, so these capabilities deliberately remain disabled.
        rename: false,
        delete: false,
    }),
});
const C = {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_CREAT: 0x00000200,
    O_EXCL: 0x00000800,
    O_NOFOLLOW: 0x00000100,
    O_DIRECTORY: 0x00100000,
    O_CLOEXEC: 0x01000000,
    O_NOFOLLOW_ANY: 0x20000000,
    AT_REMOVEDIR: 0x00000080,
    RENAME_EXCL: 0x00000004,
    RENAME_NOFOLLOW_ANY: 0x00000010,
    MNT_LOCAL: 0x00001000,
};
const E = {
    EPERM: 1,
    ENOENT: 2,
    EACCES: 13,
    EEXIST: 17,
    EXDEV: 18,
    ENOTDIR: 20,
    EISDIR: 21,
    EINVAL: 22,
    ENOSPC: 28,
    EROFS: 30,
    ENOTSUP: 45,
    ELOOP: 62,
    ENAMETOOLONG: 63,
};
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_FORBIDDEN_NAME = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu;
const STAGING_PREFIX = '.__dsh_code_ide_create_';
const STATFS_BYTES = 2168;
const STATFS_FLAGS_OFFSET = 64;
const STATFS_TYPE_OFFSET = 72;
const STATFS_TYPE_BYTES = 16;
const DARWIN_NODE_IO = Object.freeze({
    open: openFd,
    fstat: fstatFd,
    lstat: async (path) => await lstat(path, { bigint: true }),
    mkdir: async (path, mode) => { await mkdir(path, { mode }); },
});
function nativeResult(value) {
    if (typeof value !== 'object' || value === null || !('value' in value) || !('errnoCode' in value)) {
        throw new Error('A Darwin syscall did not return errno-bearing evidence.');
    }
    const result = value;
    if (!Number.isInteger(result.value) || !Number.isInteger(result.errnoCode)) {
        throw new Error('A Darwin syscall returned malformed evidence.');
    }
    return { value: result.value, errnoCode: result.errnoCode };
}
function issue(code, message, httpStatus) {
    return { code, message, httpStatus };
}
function notCommitted(error) {
    return { state: 'notCommitted', error };
}
function recovery() {
    return {
        state: 'recoveryRequired',
        error: issue('MUTATION_RECOVERY_REQUIRED', 'The Host cannot prove the final mutation state.', 503),
    };
}
function unsupported() {
    return notCommitted(issue('WORKSPACE_MUTATION_UNAVAILABLE', 'This structural workspace operation is unavailable on this Host.', 501));
}
function aborted() {
    return notCommitted(issue('MUTATION_ABORTED', 'The workspace mutation was cancelled before commit.', 409));
}
function validPathSegments(input) {
    if (!Array.isArray(input) || input.length === 0 || input.length > MUTATION_BUDGETS.maxPathSegments) {
        return undefined;
    }
    const segments = [];
    let pathBytes = Math.max(0, input.length - 1);
    for (const value of input) {
        if (typeof value !== 'string')
            return undefined;
        const bytes = Buffer.byteLength(value, 'utf8');
        pathBytes += bytes;
        if (value === '' || value === '.' || value === '..'
            || value.includes('/') || value.includes('\\')
            || CONTROL_CHARACTER.test(value)
            || WINDOWS_FORBIDDEN_NAME.test(value)
            || value.endsWith('.') || value.endsWith(' ')
            || WINDOWS_RESERVED_NAME.test(value)
            || bytes > MUTATION_BUDGETS.maxNameBytes
            || isInternalWorkspaceName(value))
            return undefined;
        segments.push(value);
    }
    return pathBytes <= MUTATION_BUDGETS.maxPathBytes ? Object.freeze(segments) : undefined;
}
function fstatFd(fd) {
    return new Promise((resolve, reject) => {
        fstat(fd, { bigint: true }, (error, stats) => { error === null ? resolve(stats) : reject(error); });
    });
}
function closeFd(fd) {
    return new Promise((resolve, reject) => {
        close(fd, error => { error === null ? resolve() : reject(error); });
    });
}
function openFd(path, flags, mode) {
    return new Promise((resolve, reject) => {
        open(path, flags, mode, (error, fd) => { error === null ? resolve(fd) : reject(error); });
    });
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function expectedCreatedKind(info, directory) {
    return !info.isSymbolicLink()
        && (directory ? info.isDirectory() : info.isFile());
}
function errnoIssue(code, phase) {
    if (code === E.EEXIST && (phase === 'create' || phase === 'publish')) {
        return issue('DESTINATION_EXISTS', 'The destination already exists.', 409);
    }
    if (code === E.ENOENT)
        return issue('NOT_FOUND', 'A workspace parent directory no longer exists.', 404);
    if (code === E.ENOTDIR)
        return issue('NOT_DIRECTORY', 'A workspace parent path is not a directory.', 400);
    if (code === E.ELOOP)
        return issue('SYMLINK_NOT_ALLOWED', 'Symbolic links are not available in IDE mutation paths.', 403);
    if (code === E.EXDEV)
        return issue('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403);
    if (code === E.EACCES || code === E.EPERM || code === E.EROFS) {
        return issue('PERMISSION_DENIED', 'The Host denied the workspace mutation.', 403);
    }
    if (code === E.ENAMETOOLONG)
        return issue('INVALID_PATH', 'The workspace path is too long.', 400);
    if (code === E.ENOSPC)
        return issue('INSUFFICIENT_STORAGE', 'The Host has insufficient storage.', 507);
    if (code === E.EISDIR || code === E.EINVAL)
        return issue('INVALID_PATH', 'The workspace path is invalid.', 400);
    return issue('WORKSPACE_MUTATION_FAILED', 'The Host could not prepare the workspace mutation.', 409);
}
function nodeIssue(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    if (code === 'EEXIST')
        return issue('DESTINATION_EXISTS', 'The destination already exists.', 409);
    if (code === 'ENOENT')
        return issue('NOT_FOUND', 'A workspace parent directory no longer exists.', 404);
    if (code === 'ENOTDIR')
        return issue('NOT_DIRECTORY', 'A workspace parent path is not a directory.', 400);
    if (code === 'ELOOP')
        return issue('SYMLINK_NOT_ALLOWED', 'Symbolic links are not available in IDE mutation paths.', 403);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        return issue('PERMISSION_DENIED', 'The Host denied the workspace mutation.', 403);
    }
    if (code === 'ENAMETOOLONG')
        return issue('INVALID_PATH', 'The workspace path is too long.', 400);
    if (code === 'ENOSPC')
        return issue('INSUFFICIENT_STORAGE', 'The Host has insufficient storage.', 507);
    return issue('WORKSPACE_MUTATION_FAILED', 'The Host could not prepare the workspace mutation.', 409);
}
class DarwinKernel {
    ffi;
    library = `dsh-code-ide-darwin-${randomUUID()}`;
    disposed = false;
    constructor(ffi) {
        this.ffi = ffi;
    }
    static async create() {
        const ffi = await import('ffi-rs');
        const kernel = new DarwinKernel(ffi);
        ffi.open({ library: kernel.library, path: '' });
        return kernel;
    }
    async publishNoReplace(root, source, destination) {
        return await this.call('renameatx_np', [this.ffi.DataType.I32, this.ffi.DataType.String, this.ffi.DataType.I32, this.ffi.DataType.String, this.ffi.DataType.U32], [root, source, root, destination, C.RENAME_EXCL | C.RENAME_NOFOLLOW_ANY]);
    }
    async unlink(parent, name, directory) {
        return await this.call('unlinkat', [this.ffi.DataType.I32, this.ffi.DataType.String, this.ffi.DataType.I32], [parent, name, directory ? C.AT_REMOVEDIR : 0]);
    }
    async assertLocalApfs(fd) {
        const buffer = Buffer.alloc(STATFS_BYTES);
        const result = await this.call('fstatfs', [this.ffi.DataType.I32, this.ffi.DataType.U8Array], [fd, buffer]);
        if (result.value !== 0)
            throw new Error(`fstatfs failed with errno ${result.errnoCode}.`);
        const flags = buffer.readUInt32LE(STATFS_FLAGS_OFFSET);
        const typeBytes = buffer.subarray(STATFS_TYPE_OFFSET, STATFS_TYPE_OFFSET + STATFS_TYPE_BYTES);
        const end = typeBytes.indexOf(0);
        const filesystem = typeBytes.subarray(0, end < 0 ? typeBytes.length : end).toString('ascii');
        if ((flags & C.MNT_LOCAL) === 0 || filesystem !== 'apfs') {
            throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'Safe structural mutations require a local APFS workspace on macOS.', 501);
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.ffi.close(this.library);
    }
    async call(funcName, paramsType, paramsValue) {
        if (this.disposed)
            throw new Error('The Darwin mutation kernel is disposed.');
        return nativeResult(await this.ffi.load({
            library: this.library,
            funcName,
            retType: this.ffi.DataType.I32,
            paramsType,
            paramsValue,
            errno: true,
            runInNewThread: true,
        }));
    }
}
class DarwinMutationWorkspace {
    workspaceId;
    canonicalRoot;
    rootFd;
    rootDev;
    rootIno;
    kernel;
    io;
    onDispose;
    tail = Promise.resolve();
    disposed = false;
    poisoned = false;
    disposePromise;
    constructor(workspaceId, canonicalRoot, rootFd, rootDev, rootIno, kernel, io, onDispose) {
        this.workspaceId = workspaceId;
        this.canonicalRoot = canonicalRoot;
        this.rootFd = rootFd;
        this.rootDev = rootDev;
        this.rootIno = rootIno;
        this.kernel = kernel;
        this.io = io;
        this.onDispose = onDispose;
    }
    execute(request) {
        if (this.disposed)
            return Promise.resolve(unsupported());
        if (this.poisoned)
            return Promise.resolve(recovery());
        const execution = this.tail.then(async () => await this.executeSerial(request));
        this.tail = execution.then(() => { }, () => { });
        return execution;
    }
    dispose() {
        this.disposePromise ??= (async () => {
            this.disposed = true;
            await this.tail;
            await closeFd(this.rootFd);
            this.onDispose(this);
        })();
        return this.disposePromise;
    }
    async executeSerial(request) {
        if (this.poisoned)
            return recovery();
        if (request.operation.kind !== 'createFile' && request.operation.kind !== 'createDirectory')
            return unsupported();
        const segments = validPathSegments(request.operation.path.segments);
        if (segments === undefined)
            return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400));
        if (request.signal.aborted)
            return aborted();
        const held = [];
        let stagingName;
        let stagingDirectory = false;
        let stagingCreated = false;
        let commitEntered = false;
        const cleanStaging = async () => {
            if (stagingName === undefined || !stagingCreated)
                return true;
            const cleaned = await this.kernel.unlink(this.rootFd, stagingName, stagingDirectory).catch(() => undefined);
            if (cleaned !== undefined && (cleaned.value === 0 || cleaned.errnoCode === E.ENOENT)) {
                stagingName = undefined;
                stagingCreated = false;
                return true;
            }
            return false;
        };
        const poisonRecovery = () => {
            this.poisoned = true;
            return recovery();
        };
        const cleanBeforeCommit = async (outcome) => {
            if (await cleanStaging())
                return outcome;
            return poisonRecovery();
        };
        try {
            if (request.signal.aborted)
                return aborted();
            const leaf = segments.at(-1);
            if (leaf === undefined)
                return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400));
            const destination = segments.join('/');
            const rootInfo = await this.io.fstat(this.rootFd);
            const namedRootInfo = await this.io.lstat(this.canonicalRoot);
            if (!expectedCreatedKind(rootInfo, true) || !expectedCreatedKind(namedRootInfo, true)
                || rootInfo.dev !== this.rootDev || rootInfo.ino !== this.rootIno
                || !sameIdentity(rootInfo, namedRootInfo))
                return poisonRecovery();
            stagingName = `${STAGING_PREFIX}${randomUUID()}`;
            const stagingPath = join(this.canonicalRoot, stagingName);
            let createdFd;
            if (request.operation.kind === 'createFile') {
                try {
                    createdFd = await this.io.open(stagingPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_CLOEXEC | C.O_NOFOLLOW_ANY, 0o666);
                    stagingCreated = true;
                }
                catch (error) {
                    return notCommitted(nodeIssue(error));
                }
            }
            else {
                stagingDirectory = true;
                try {
                    await this.io.mkdir(stagingPath, 0o777);
                    stagingCreated = true;
                }
                catch (error) {
                    return notCommitted(nodeIssue(error));
                }
                try {
                    createdFd = await this.io.open(stagingPath, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_CLOEXEC | C.O_NOFOLLOW_ANY, 0);
                }
                catch (error) {
                    return await cleanBeforeCommit(notCommitted(nodeIssue(error)));
                }
            }
            held.push(createdFd);
            const stagedInfo = await this.io.fstat(createdFd);
            const namedStagedInfo = await this.io.lstat(stagingPath);
            const expectedDirectory = request.operation.kind === 'createDirectory';
            if (stagedInfo.dev !== this.rootDev || namedStagedInfo.dev !== this.rootDev
                || !expectedCreatedKind(stagedInfo, expectedDirectory)
                || !expectedCreatedKind(namedStagedInfo, expectedDirectory)
                || !sameIdentity(stagedInfo, namedStagedInfo)) {
                await cleanStaging();
                return poisonRecovery();
            }
            if (request.signal.aborted)
                return await cleanBeforeCommit(aborted());
            const commitRootInfo = await this.io.lstat(this.canonicalRoot);
            const commitStagingInfo = await this.io.lstat(stagingPath);
            if (!sameIdentity(rootInfo, commitRootInfo)
                || !sameIdentity(stagedInfo, commitStagingInfo)
                || !expectedCreatedKind(commitStagingInfo, expectedDirectory)) {
                await cleanStaging();
                return poisonRecovery();
            }
            commitEntered = true;
            // Resolve every destination component and publish the reserved staging
            // object in one kernel operation. RENAME_NOFOLLOW_ANY prevents an
            // ancestor symlink swap between a JavaScript preflight and commit.
            const published = await this.kernel.publishNoReplace(this.rootFd, stagingName, destination);
            if (published.value !== 0) {
                commitEntered = false;
                const error = errnoIssue(published.errnoCode, 'publish');
                return await cleanBeforeCommit(notCommitted(error));
            }
            stagingName = undefined;
            stagingCreated = false;
            const finalInfo = await this.io.fstat(createdFd);
            const namedFinalInfo = await this.io.lstat(join(this.canonicalRoot, ...segments));
            if (!sameIdentity(stagedInfo, finalInfo) || !sameIdentity(finalInfo, namedFinalInfo)
                || finalInfo.dev !== this.rootDev
                || !expectedCreatedKind(finalInfo, expectedDirectory)
                || !expectedCreatedKind(namedFinalInfo, expectedDirectory))
                return poisonRecovery();
            return {
                state: 'committed',
                evidence: expectedDirectory
                    ? { kind: 'createDirectory', resourceKind: 'directory', version: versionOf(namedFinalInfo) }
                    : { kind: 'createFile', resourceKind: 'file', version: versionOf(namedFinalInfo) },
            };
        }
        catch {
            if (commitEntered)
                return poisonRecovery();
            if (stagingCreated) {
                await cleanStaging();
                return poisonRecovery();
            }
            return notCommitted(issue('WORKSPACE_MUTATION_FAILED', 'The Host could not prepare the workspace mutation.', 409));
        }
        finally {
            await Promise.allSettled(held.reverse().map(async (fd) => await closeFd(fd)));
        }
    }
}
/** Construct only the workspace state machine for deterministic native mocks. */
export function createDarwinMutationWorkspaceForTesting(options) {
    return new DarwinMutationWorkspace(options.workspaceId, options.canonicalRoot, options.rootFd, options.rootIdentity.dev, options.rootIdentity.ino, options.kernel, options.io ?? DARWIN_NODE_IO, () => { });
}
class DarwinMutationBackend {
    kernel;
    descriptor = DARWIN_DESCRIPTOR;
    workspaces = new Set();
    opens = new Set();
    disposed = false;
    disposePromise;
    constructor(kernel) {
        this.kernel = kernel;
    }
    openWorkspace(request) {
        if (this.disposed)
            return Promise.reject(new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'The mutation backend is disposed.', 501));
        const admitted = this.openWorkspaceAdmitted(request);
        this.opens.add(admitted);
        void admitted.finally(() => { this.opens.delete(admitted); }).catch(() => { });
        return admitted;
    }
    dispose() {
        this.disposePromise ??= (async () => {
            this.disposed = true;
            await Promise.allSettled([...this.opens]);
            await Promise.allSettled([...this.workspaces].map(async (workspace) => await workspace.dispose()));
            this.kernel.dispose();
        })();
        return this.disposePromise;
    }
    async openWorkspaceAdmitted(request) {
        if (request.signal.aborted)
            throw new IdeHostError('MUTATION_ABORTED', 'The workspace mutation was cancelled.', 409);
        let rootFd;
        try {
            rootFd = await openFd(request.registeredRoot, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_CLOEXEC | C.O_NOFOLLOW_ANY, 0);
        }
        catch (error) {
            throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'The Host could not open the workspace root without following symbolic links.', 501, { cause: error });
        }
        try {
            const info = await fstatFd(rootFd);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'The registered workspace root is not a local directory.', 501);
            if (info.dev !== request.expectedRootIdentity.dev || info.ino !== request.expectedRootIdentity.ino) {
                throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root identity changed before it was opened.', 409);
            }
            const namedInfo = await lstat(request.registeredRoot, { bigint: true });
            if (!expectedCreatedKind(namedInfo, true) || !sameIdentity(info, namedInfo)) {
                throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root path changed before it was opened.', 409);
            }
            await this.kernel.assertLocalApfs(rootFd);
            const canonicalRoot = await realpath(request.registeredRoot);
            const canonicalInfo = await lstat(canonicalRoot, { bigint: true });
            if (!expectedCreatedKind(canonicalInfo, true) || !sameIdentity(info, canonicalInfo)) {
                throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root path changed before it was opened.', 409);
            }
            if (request.signal.aborted || this.disposed)
                throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'Workspace opening was cancelled during Host shutdown.', 501);
            const workspace = new DarwinMutationWorkspace(request.workspaceId, canonicalRoot, rootFd, info.dev, info.ino, this.kernel, DARWIN_NODE_IO, value => { this.workspaces.delete(value); });
            this.workspaces.add(workspace);
            return workspace;
        }
        catch (error) {
            await closeFd(rootFd).catch(() => { });
            throw error;
        }
    }
}
/** Construct the backend around a fixed-signature native test port. */
export function createDarwinMutationBackendForTesting(kernel) {
    return new DarwinMutationBackend(kernel);
}
async function probe(backend) {
    // macOS commonly exposes /var as a system symlink to /private/var. The
    // backend intentionally opens roots with O_NOFOLLOW_ANY, so construct the
    // witness below the canonical temp directory spelling.
    const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-darwin-backend-'));
    let workspace;
    try {
        const identity = await lstat(root, { bigint: true });
        workspace = await backend.openWorkspace({
            workspaceId: 'darwin-runtime-witness',
            registeredRoot: root,
            expectedRootIdentity: { dev: identity.dev, ino: identity.ino },
            signal: new AbortController().signal,
        });
        const signal = new AbortController().signal;
        const file = await workspace.execute({
            executionId: randomUUID(), operation: { kind: 'createFile', path: { segments: ['file'] } }, signal,
        });
        const collision = await workspace.execute({
            executionId: randomUUID(), operation: { kind: 'createFile', path: { segments: ['file'] } }, signal,
        });
        const directory = await workspace.execute({
            executionId: randomUUID(), operation: { kind: 'createDirectory', path: { segments: ['directory'] } }, signal,
        });
        await symlink(root, join(root, 'link'));
        const symlinkTraversal = await workspace.execute({
            executionId: randomUUID(), operation: { kind: 'createFile', path: { segments: ['link', 'escape'] } }, signal,
        });
        if (file.state !== 'committed'
            || collision.state !== 'notCommitted' || collision.error.code !== 'DESTINATION_EXISTS'
            || directory.state !== 'committed'
            || symlinkTraversal.state !== 'notCommitted'
            || !['SYMLINK_NOT_ALLOWED', 'NOT_DIRECTORY'].includes(symlinkTraversal.error.code)) {
            throw new Error('The Darwin mutation primitive failed its runtime witness.');
        }
    }
    finally {
        await workspace?.dispose().catch(() => { });
        await rm(root, { recursive: true, force: true });
    }
}
/**
 * Create the macOS handle-relative backend only after libSystem, local APFS,
 * no-follow traversal and atomic no-replace publication pass a live witness.
 */
export async function createDarwinMutationBackend() {
    if (process.platform !== 'darwin' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
        return createUnavailableMutationBackend();
    }
    let kernel;
    let backend;
    try {
        kernel = await DarwinKernel.create();
        backend = new DarwinMutationBackend(kernel);
        await probe(backend);
        return backend;
    }
    catch {
        await backend?.dispose().catch(() => { });
        if (backend === undefined)
            kernel?.dispose();
        return createUnavailableMutationBackend();
    }
}
