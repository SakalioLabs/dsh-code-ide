import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceFileService } from './filesystem.js';
export interface MediaHandler {
    (request: IncomingMessage, response: ServerResponse): Promise<void>;
}
/** Serve allowlisted workspace media with bounded, same-origin byte ranges. */
export declare function createMediaHandler(files: WorkspaceFileService): MediaHandler;
