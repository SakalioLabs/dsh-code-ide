import type { IncomingMessage, ServerResponse } from 'node:http';
export interface StaticHandler {
    (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>;
}
/** Build a traversal- and symlink-safe Vite static/SPA handler. */
export declare function createStaticHandler(staticRoot: string, routePrefix: string): StaticHandler;
