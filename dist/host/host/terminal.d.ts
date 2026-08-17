import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn as spawnPty, type IPty } from 'node-pty';
import type { HostLogger, HostWorkspaceRegistry } from './contracts.js';
import { type ResolvedWorkspaceRoot } from './path-policy.js';
export interface TerminalHostOptions {
    shell: string;
    shellArgs: string[];
    maxMessageBytes: number;
    maxInputBytes: number;
    maxBufferedBytes: number;
    maxSessions: number;
    logger: HostLogger;
}
/** Deterministic async-boundary seam used by capacity tests. */
export interface TerminalHostInternals {
    resolveWorkspaceRoot?: (path: string) => Promise<ResolvedWorkspaceRoot>;
    spawnTerminal?: typeof spawnPty;
    killTerminalTree?: (pty: IPty, exited: boolean) => Promise<void>;
}
export declare function sanitizeTerminalEnv(source: NodeJS.ProcessEnv): Record<string, string>;
export declare function rejectUpgrade(socket: Duplex, status: number, message: string): void;
/** Raw xterm-compatible PTY WebSocket owner. */
export declare class TerminalHost {
    private readonly registry;
    private readonly options;
    private readonly server;
    private readonly active;
    private readonly resolveRoot;
    private readonly spawnTerminal;
    private readonly killTree;
    private pendingUpgrades;
    private disposing;
    constructor(registry: HostWorkspaceRegistry, options: TerminalHostOptions, internals?: TerminalHostInternals);
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
    dispose(): Promise<void>;
    private open;
    private handleMessage;
    private isCloseMessage;
    private send;
}
export declare function resolveTerminalShell(value: string | undefined): {
    shell: string;
    args: string[];
};
