import { type WorkspaceMutationsGatewayContext } from './capabilities.js';
export interface WorkspaceMutationsGatewayConfig {
    maxRequestBytes: number;
}
/** Route fiber whose lifetime is a reactive coeffect of web + mutations. */
export declare function workspaceMutationsGateway(ctx: WorkspaceMutationsGatewayContext, config: WorkspaceMutationsGatewayConfig): void;
export declare namespace workspaceMutationsGateway {
    var inject: string[];
}
