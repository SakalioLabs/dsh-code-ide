import { hostError, IdeHostError } from './errors.js';
function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'x-content-type-options': 'nosniff',
    });
    response.end(body);
}
async function readBody(request, maxBytes) {
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
        throw new IdeHostError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415);
    }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new IdeHostError('REQUEST_TOO_LARGE', 'Request body exceeds the IDE limit.', 413);
    }
    const chunks = [];
    let size = 0;
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes)
            throw new IdeHostError('REQUEST_TOO_LARGE', 'Request body exceeds the IDE limit.', 413);
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    }
    catch (error) {
        throw new IdeHostError('INVALID_JSON', 'Request body is not valid JSON.', 400, { cause: error });
    }
}
function record(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new IdeHostError('INVALID_REQUEST', 'Request body must be an object.');
    }
    return value;
}
function requestWorkspaceId(body) {
    return body.workspaceId ?? body.sessionId;
}
/** Tie a one-shot operation to premature request/response disconnect only. */
function transportAbort(request, response) {
    const controller = new AbortController();
    const abort = () => { controller.abort('transport disconnected'); };
    const requestClose = () => { if (!request.complete)
        abort(); };
    request.once('aborted', abort);
    request.once('close', requestClose);
    const responseEvents = response;
    const responseClose = () => { if (!response.writableEnded)
        abort(); };
    responseEvents.once?.('close', responseClose);
    return {
        signal: controller.signal,
        dispose() {
            request.off('aborted', abort);
            request.off('close', requestClose);
            responseEvents.off?.('close', responseClose);
        },
    };
}
export function createApiHandler(files, options, search) {
    return async (request, response) => {
        const transport = transportAbort(request, response);
        try {
            if (request.method !== 'POST') {
                response.setHeader('allow', 'POST');
                throw new IdeHostError('METHOD_NOT_ALLOWED', 'Only POST is accepted.', 405);
            }
            const body = record(await readBody(request, options.maxRequestBytes));
            let result;
            switch (body.op) {
                case 'workspaces':
                    result = files.workspaces(options.maxTerminalSessions);
                    break;
                case 'list':
                    result = await files.list(requestWorkspaceId(body), body.path);
                    break;
                case 'read':
                    result = await files.read(requestWorkspaceId(body), body.path);
                    break;
                case 'inspect':
                    result = await files.inspect(requestWorkspaceId(body), body.targets);
                    break;
                case 'write':
                    result = await files.write(requestWorkspaceId(body), body.path, body.content, body.expectedVersion);
                    break;
                case 'findFiles':
                    if (search === undefined)
                        throw new IdeHostError('SEARCH_UNAVAILABLE', 'Workspace search is unavailable.', 503);
                    result = await search.findFiles(requestWorkspaceId(body), body.query, transport.signal);
                    break;
                case 'searchText':
                    if (search === undefined)
                        throw new IdeHostError('SEARCH_UNAVAILABLE', 'Workspace search is unavailable.', 503);
                    result = await search.searchText(requestWorkspaceId(body), body.query, transport.signal);
                    break;
                default:
                    throw new IdeHostError('UNKNOWN_OPERATION', 'Unknown IDE operation.');
            }
            if (!transport.signal.aborted && !response.destroyed && !response.writableEnded)
                sendJson(response, 200, result);
        }
        catch (error) {
            const projected = hostError(error);
            if (projected.status >= 500)
                options.logger.warn(error);
            const body = { error: { code: projected.code, message: projected.message } };
            if (!transport.signal.aborted && !response.destroyed && !response.writableEnded) {
                sendJson(response, projected.status, body);
            }
        }
        finally {
            transport.dispose();
        }
    };
}
