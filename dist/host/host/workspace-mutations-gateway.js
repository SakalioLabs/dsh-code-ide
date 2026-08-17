import { WORKSPACE_MUTATIONS_ROUTE } from '../shared/workspace-mutations.js';
import { WORKSPACE_MUTATIONS_CAPABILITY, } from './capabilities.js';
import { hostError, IdeHostError } from './errors.js';
import { isTrustedLocalRequest } from './trust.js';
import { createWorkspaceMutationsApi } from './workspace-mutations-api.js';
function sendError(response, error) {
    const projected = hostError(error);
    const body = JSON.stringify({ error: { code: projected.code, message: projected.message } });
    response.writeHead(projected.status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
    });
    response.end(body);
}
/** Route fiber whose lifetime is a reactive coeffect of web + mutations. */
export function workspaceMutationsGateway(ctx, config) {
    const api = createWorkspaceMutationsApi(ctx[WORKSPACE_MUTATIONS_CAPABILITY], {
        maxRequestBytes: config.maxRequestBytes,
        logger: ctx.logger,
    });
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: WORKSPACE_MUTATIONS_ROUTE,
        handler: async (request, response) => {
            if (!isTrustedLocalRequest(request)) {
                sendError(response, new IdeHostError('FORBIDDEN', 'The IDE is available only to a same-origin loopback browser.', 403));
                return;
            }
            await api(request, response);
        },
    }), 'dsh-code-ide: workspace-mutations HTTP route');
}
workspaceMutationsGateway.inject = ['webServer', WORKSPACE_MUTATIONS_CAPABILITY];
