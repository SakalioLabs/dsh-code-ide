import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** The small Host surface used by this package, kept independent of Harness internals. */
export interface HostWebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}
/** The small WebSocket upgrade surface used by this package. */
export interface HostWebUpgradeRoute {
    path: string;
    handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
export interface HostWebServer {
    register(route: HostWebRoute): () => void;
    registerUpgrade(route: HostWebUpgradeRoute): () => void;
}
export interface HostWorkspace {
    readonly id: unknown;
    readonly path: string;
    readonly title: string;
}
export interface HostWorkspaceRegistry {
    list(): HostWorkspace[];
    get?(id: unknown): HostWorkspace | undefined;
}
/** Structural view of Harness' managed subprocess seam used by this plugin. */
export interface HostSubprocessOutputRead {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
}
export interface HostSubprocessOutputReader {
    readFrom(fromByte: number): HostSubprocessOutputRead;
}
export interface HostSubprocessHandle {
    readonly collected: {
        readonly stdout?: HostSubprocessOutputReader;
        readonly stderr?: HostSubprocessOutputReader;
    };
    readonly done: Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
    }>;
    terminate(): void;
    waitForExit(signal?: AbortSignal): Promise<boolean>;
}
export interface HostSubprocessSpawnSpec {
    argv: readonly string[];
    cwd: string;
    stdio: {
        stdin: 'ignore';
        stdout: {
            maxBytes: number;
        };
        stderr: {
            maxBytes: number;
        };
    };
    graceMs: number;
    signal?: AbortSignal;
}
export interface HostSubprocessRuntime {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    spawn(spec: HostSubprocessSpawnSpec): HostSubprocessHandle;
}
export interface HostLogger {
    warn(format: unknown, ...params: unknown[]): void;
    error(format: unknown, ...params: unknown[]): void;
    info(format: unknown, ...params: unknown[]): void;
    debug(format: unknown, ...params: unknown[]): void;
}
export interface HostPluginContext {
    readonly logger: HostLogger;
    plugin(plugin: unknown, config?: unknown): unknown;
    provide(name: string, value?: unknown): unknown;
    effect(execute: () => (() => void | Promise<void>) | Promise<() => void | Promise<void>>, label?: string): unknown;
}
export interface WorkspaceSummary {
    workspaceId: string;
    title: string;
    path: string;
}
export type FileKind = 'file' | 'directory' | 'other';
export interface FileEntry {
    name: string;
    path: string;
    type: FileKind;
    size?: number;
    version?: string;
}
export interface ApiErrorBody {
    error: {
        code: string;
        message: string;
    };
}
