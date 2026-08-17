import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostLogger } from './contracts.js';
import type { WorkspaceFileService } from './filesystem.js';
import type { WorkspaceSearchService } from './search.js';
export interface ApiHandlerOptions {
    maxRequestBytes: number;
    maxTerminalSessions: number;
    logger: HostLogger;
}
export declare function createApiHandler(files: WorkspaceFileService, options: ApiHandlerOptions, search?: WorkspaceSearchService): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
