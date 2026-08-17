export interface NativeRenameAdapter {
    supported(): Promise<boolean>;
    moveNoReplace(source: string, destination: string): Promise<void>;
    dispose(): Promise<void>;
}
export interface FfiDataTypes {
    readonly String: unknown;
    readonly WString: unknown;
    readonly I32: unknown;
    readonly U32: unknown;
}
export interface FfiRuntime {
    readonly DataType: FfiDataTypes;
    open(params: {
        library: string;
        path: string;
    }): void;
    close(library: string): void;
    load(params: {
        library: string;
        funcName: string;
        retType: unknown;
        paramsType: unknown[];
        paramsValue: unknown[];
        errno: true;
        runInNewThread: true;
    }): unknown;
}
export type NativePlatform = 'win32' | 'linux' | 'darwin' | 'unsupported';
export interface FfiNativeRenameOptions {
    platform?: NodeJS.Platform | NativePlatform;
    loadFfi?: () => Promise<FfiRuntime>;
}
/** Strict OS adapter. There is deliberately no ordinary-rename fallback. */
export declare class FfiNativeRenameAdapter implements NativeRenameAdapter {
    private readonly platform;
    private readonly library;
    private readonly loadFfi;
    private initialization;
    private ffi;
    private opened;
    private disposed;
    constructor(options?: FfiNativeRenameOptions);
    supported(): Promise<boolean>;
    moveNoReplace(source: string, destination: string): Promise<void>;
    dispose(): Promise<void>;
    private initialize;
    private call;
}
