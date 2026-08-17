import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostLogger } from './contracts.js';
import type { WorkspaceMutationService } from './workspace-mutations.js';
export interface WorkspaceMutationsApiOptions {
    maxRequestBytes: number;
    logger: HostLogger;
}
/** Exact-route JSON carrier for the workspace-mutations.v1 capability. */
export declare function createWorkspaceMutationsApi(mutations: WorkspaceMutationService, options: WorkspaceMutationsApiOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
