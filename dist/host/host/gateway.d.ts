import { type IdeGatewayContext } from './capabilities.js';
export interface GatewayConfig {
    routePrefix: string;
    staticRoot: string;
    maxRequestBytes: number;
    maxTerminalSessions: number;
}
/** Own every browser route while all versioned Host capabilities are live. */
export declare function ideGateway(ctx: IdeGatewayContext, config: GatewayConfig): void;
export declare namespace ideGateway {
    var inject: string[];
}
