import { type BigIntStats } from 'node:fs';
import { type MutationBackend, type MutationBackendWorkspace } from './mutation-backend.js';
export interface DarwinNativeResult {
    readonly value: number;
    readonly errnoCode: number;
}
/** Fixed-signature native surface; exported only to support ABI-focused tests. */
export interface DarwinMutationKernelPort {
    publishNoReplace(root: number, source: string, destination: string): Promise<DarwinNativeResult>;
    unlink(parent: number, name: string, directory: boolean): Promise<DarwinNativeResult>;
    assertLocalApfs(fd: number): Promise<void>;
    dispose(): void;
}
export interface DarwinNodeIoPort {
    open(path: string, flags: number, mode: number): Promise<number>;
    fstat(fd: number): Promise<BigIntStats>;
    lstat(path: string): Promise<BigIntStats>;
    mkdir(path: string, mode: number): Promise<void>;
}
/** Select the modern 64-bit-inode statfs symbol for each Darwin ABI. */
export declare function darwinFstatfsSymbolForTesting(arch: string): string;
export interface DarwinMutationWorkspaceTestOptions {
    readonly workspaceId: string;
    readonly canonicalRoot: string;
    /** Ownership transfers to the returned workspace. */
    readonly rootFd: number;
    readonly rootIdentity: {
        readonly dev: bigint;
        readonly ino: bigint;
    };
    readonly kernel: DarwinMutationKernelPort;
    readonly io?: DarwinNodeIoPort;
}
/** Construct only the workspace state machine for deterministic native mocks. */
export declare function createDarwinMutationWorkspaceForTesting(options: DarwinMutationWorkspaceTestOptions): MutationBackendWorkspace;
/** Construct the backend around a fixed-signature native test port. */
export declare function createDarwinMutationBackendForTesting(kernel: DarwinMutationKernelPort): MutationBackend;
/**
 * Create the macOS handle-relative backend only after libSystem, local APFS,
 * no-follow traversal and atomic no-replace publication pass a live witness.
 */
export declare function createProbedDarwinMutationBackendForTesting(): Promise<MutationBackend>;
export declare function createDarwinMutationBackend(): Promise<MutationBackend>;
