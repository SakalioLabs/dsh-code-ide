import { randomUUID } from 'node:crypto';
import { IdeHostError } from './errors.js';
function resultOf(value) {
    if (typeof value !== 'object' || value === null
        || !('value' in value) || !('errnoCode' in value)) {
        throw new IdeHostError('ATOMIC_RENAME_OUTCOME_UNKNOWN', 'The atomic rename outcome could not be determined.', 503);
    }
    const result = value;
    if (typeof result.value !== 'number' || !Number.isInteger(result.value)
        || typeof result.errnoCode !== 'number' || !Number.isInteger(result.errnoCode)) {
        throw new IdeHostError('ATOMIC_RENAME_OUTCOME_UNKNOWN', 'The atomic rename outcome could not be determined.', 503);
    }
    return { value: result.value, errnoCode: result.errnoCode };
}
function platformOf(value) {
    return value === 'win32' || value === 'linux' || value === 'darwin' ? value : 'unsupported';
}
function failedRename(platform, code) {
    const destinationExists = platform === 'win32' ? code === 80 || code === 183 : code === 17;
    if (destinationExists) {
        return new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409);
    }
    const crossDevice = platform === 'win32' ? code === 17 : code === 18;
    if (crossDevice) {
        return new IdeHostError('CROSS_DEVICE_RENAME', 'Cross-device workspace mutations are not allowed.', 409);
    }
    const unsupported = platform === 'win32'
        ? code === 1 || code === 50 || code === 120
        : code === 22 || code === 38 || code === 45 || code === 95;
    if (unsupported || platform === 'unsupported') {
        return new IdeHostError('ATOMIC_RENAME_UNSUPPORTED', 'Atomic no-replace rename is unavailable on this Host.', 501);
    }
    const missing = platform === 'win32' ? code === 2 || code === 3 : code === 2;
    if (missing)
        return new IdeHostError('NOT_FOUND', 'The source or destination parent no longer exists.', 409);
    const denied = platform === 'win32' ? code === 5 : code === 1 || code === 13;
    if (denied)
        return new IdeHostError('PERMISSION_DENIED', 'The Host denied the atomic rename.', 403);
    return new IdeHostError('ATOMIC_RENAME_FAILED', 'The Host could not perform the atomic rename.', 409);
}
async function defaultFfiLoader() {
    return await import('ffi-rs');
}
/** Strict OS adapter. There is deliberately no ordinary-rename fallback. */
export class FfiNativeRenameAdapter {
    platform;
    library = `dsh-code-ide-native-rename-${randomUUID()}`;
    loadFfi;
    initialization;
    ffi;
    opened = false;
    disposed = false;
    constructor(options = {}) {
        this.platform = platformOf(options.platform ?? process.platform);
        this.loadFfi = options.loadFfi ?? defaultFfiLoader;
    }
    async supported() {
        if (this.disposed || this.platform === 'unsupported')
            return false;
        this.initialization ??= this.initialize();
        return await this.initialization;
    }
    async moveNoReplace(source, destination) {
        if (!await this.supported() || this.ffi === undefined) {
            throw new IdeHostError('ATOMIC_RENAME_UNSUPPORTED', 'Atomic no-replace rename is unavailable on this Host.', 501);
        }
        let result;
        try {
            result = await this.call(this.ffi, source, destination);
        }
        catch (error) {
            if (error instanceof IdeHostError)
                throw error;
            throw new IdeHostError('ATOMIC_RENAME_OUTCOME_UNKNOWN', 'The atomic rename outcome could not be determined.', 503, { cause: error });
        }
        // Win32 BOOL is a signed 32-bit integer, not C/C++ bool. Any non-zero
        // value is success; POSIX rename functions return exactly zero.
        const succeeded = this.platform === 'win32' ? result.value !== 0 : result.value === 0;
        if (!succeeded)
            throw failedRename(this.platform, result.errnoCode);
    }
    async dispose() {
        this.disposed = true;
        await this.initialization?.catch(() => false);
        if (this.opened && this.ffi !== undefined) {
            try {
                this.ffi.close(this.library);
            }
            catch { /* library teardown is best-effort */ }
            this.opened = false;
        }
        this.ffi = undefined;
    }
    async initialize() {
        let ffi;
        try {
            ffi = await this.loadFfi();
            if (this.disposed)
                return false;
            ffi.open({
                library: this.library,
                path: this.platform === 'win32' ? 'kernel32.dll' : '',
            });
            this.opened = true;
            this.ffi = ffi;
            // Empty names cannot rename a resource. ENOENT proves that the exact
            // symbol and ABI can be invoked without mutating filesystem state.
            const probe = await this.call(ffi, '', '');
            const succeeded = this.platform === 'win32' ? probe.value !== 0 : probe.value === 0;
            if (succeeded)
                return false;
            const unsupported = this.platform !== 'win32'
                && [22, 38, 45, 95].includes(probe.errnoCode);
            return !unsupported;
        }
        catch {
            if (this.opened && this.ffi !== undefined) {
                try {
                    this.ffi.close(this.library);
                }
                catch { /* ignore unavailable ABI teardown */ }
            }
            this.opened = false;
            this.ffi = undefined;
            return false;
        }
    }
    async call(ffi, source, destination) {
        const types = ffi.DataType;
        if (this.platform === 'win32') {
            return resultOf(await ffi.load({
                library: this.library,
                funcName: 'MoveFileExW',
                retType: types.I32,
                paramsType: [types.WString, types.WString, types.U32],
                paramsValue: [source, destination, 0],
                errno: true,
                // ffi-rs 1.3.7 captures last_os_error immediately after ffi_call only
                // on this path. Its synchronous path converts/frees values first and
                // can overwrite GetLastError/errno before exposing it to JavaScript.
                runInNewThread: true,
            }));
        }
        if (this.platform === 'linux') {
            return resultOf(await ffi.load({
                library: this.library,
                funcName: 'renameat2',
                retType: types.I32,
                paramsType: [types.I32, types.String, types.I32, types.String, types.U32],
                paramsValue: [-100, source, -100, destination, 1],
                errno: true,
                runInNewThread: true,
            }));
        }
        if (this.platform === 'darwin') {
            return resultOf(await ffi.load({
                library: this.library,
                funcName: 'renamex_np',
                retType: types.I32,
                paramsType: [types.String, types.String, types.U32],
                paramsValue: [source, destination, 0x4],
                errno: true,
                runInNewThread: true,
            }));
        }
        throw failedRename('unsupported', 0);
    }
}
