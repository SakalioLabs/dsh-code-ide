import { type TerminalProviderContext } from './capabilities.js';
export interface TerminalProviderConfig {
    terminalShell: string;
    terminalArgs: string[];
    maxTerminalSessions: number;
    maxTerminalMessageBytes: number;
    maxTerminalInputBytes: number;
    maxTerminalBufferedBytes: number;
}
/** Own the native PTY lifecycle behind a versioned capability. */
export declare function terminalProvider(ctx: TerminalProviderContext, config: TerminalProviderConfig): void;
export declare namespace terminalProvider {
    var inject: string[];
    var provide: string;
}
