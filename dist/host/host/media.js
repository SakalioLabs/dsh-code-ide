import { hostError, IdeHostError } from './errors.js';
const UNSATISFIABLE = Symbol('unsatisfiable-byte-range');
function sendError(response, error) {
    const projected = hostError(error);
    const body = JSON.stringify({ error: { code: projected.code, message: projected.message } });
    response.writeHead(projected.status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
    });
    response.end(body);
}
function singleQueryValue(params, name, required) {
    const values = params.getAll(name);
    if (values.length > 1)
        throw new IdeHostError('INVALID_MEDIA_QUERY', `${name} must appear at most once.`);
    const value = values[0];
    if (value === undefined) {
        if (required)
            throw new IdeHostError('INVALID_MEDIA_QUERY', `${name} is required.`);
        return undefined;
    }
    if (value === '')
        throw new IdeHostError('INVALID_MEDIA_QUERY', `${name} must not be empty.`);
    return value;
}
function mediaQuery(request) {
    let url;
    try {
        url = new URL(request.url ?? '/', 'http://localhost');
    }
    catch (error) {
        throw new IdeHostError('INVALID_URL', 'Invalid request URL.', 400, { cause: error });
    }
    for (const name of url.searchParams.keys()) {
        if (name !== 'workspaceId' && name !== 'path' && name !== 'version') {
            throw new IdeHostError('INVALID_MEDIA_QUERY', `Unknown media query parameter: ${name}`);
        }
    }
    const workspaceId = singleQueryValue(url.searchParams, 'workspaceId', true);
    const path = singleQueryValue(url.searchParams, 'path', true);
    const version = singleQueryValue(url.searchParams, 'version', false);
    if (workspaceId === undefined || path === undefined) {
        throw new IdeHostError('INVALID_MEDIA_QUERY', 'workspaceId and path are required.');
    }
    return { workspaceId, path, ...(version === undefined ? {} : { version }) };
}
function headerValue(request, name) {
    const value = request.headers[name];
    return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : undefined;
}
/** Parse one RFC 9110 byte range without converting attacker-sized digits to Number first. */
function byteRange(value, size) {
    if (value === undefined)
        return undefined;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
    if (match === null || (match[1] === '' && match[2] === ''))
        return UNSATISFIABLE;
    const sizeBig = BigInt(size);
    if (sizeBig === 0n)
        return UNSATISFIABLE;
    if (match[1] === '') {
        const suffix = BigInt(match[2]);
        if (suffix === 0n)
            return UNSATISFIABLE;
        const start = suffix >= sizeBig ? 0n : sizeBig - suffix;
        return { start: Number(start), end: size - 1 };
    }
    const start = BigInt(match[1]);
    if (start >= sizeBig)
        return UNSATISFIABLE;
    const requestedEnd = match[2] === '' ? sizeBig - 1n : BigInt(match[2]);
    if (requestedEnd < start)
        return UNSATISFIABLE;
    const end = requestedEnd >= sizeBig ? sizeBig - 1n : requestedEnd;
    return { start: Number(start), end: Number(end) };
}
async function pipeMedia(request, response, stream) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            request.off('aborted', aborted);
            response.off('finish', finished);
            response.off('close', closed);
            stream.off('error', failed);
        };
        const settle = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error === undefined)
                resolve();
            else
                reject(error);
        };
        const aborted = () => {
            stream.destroy();
            response.destroy();
            settle();
        };
        const finished = () => settle();
        const closed = () => {
            stream.destroy();
            settle();
        };
        const failed = (error) => {
            if (response.destroyed)
                settle();
            else
                settle(error);
        };
        request.once('aborted', aborted);
        response.once('finish', finished);
        response.once('close', closed);
        stream.once('error', failed);
        if (request.aborted || response.destroyed) {
            closed();
            return;
        }
        stream.pipe(response);
    });
}
/** Serve allowlisted workspace media with bounded, same-origin byte ranges. */
export function createMediaHandler(files) {
    return async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, {
                allow: 'GET, HEAD',
                'cache-control': 'no-store',
                'cross-origin-resource-policy': 'same-origin',
                'x-content-type-options': 'nosniff',
            });
            response.end();
            return;
        }
        let media;
        try {
            const query = mediaQuery(request);
            media = await files.openMedia(query.workspaceId, query.path, query.version);
            if (request.aborted || response.destroyed)
                return;
            const etag = `"${media.version}"`;
            const ifRange = headerValue(request, 'if-range');
            const range = ifRange === undefined || ifRange === etag
                ? byteRange(headerValue(request, 'range'), media.sizeBytes)
                : undefined;
            response.setHeader('accept-ranges', 'bytes');
            response.setHeader('cache-control', 'no-store');
            response.setHeader('content-type', media.descriptor.mimeType);
            response.setHeader('cross-origin-resource-policy', 'same-origin');
            response.setHeader('etag', etag);
            response.setHeader('x-content-type-options', 'nosniff');
            if (range === UNSATISFIABLE) {
                response.setHeader('content-range', `bytes */${String(media.sizeBytes)}`);
                response.setHeader('content-length', '0');
                response.writeHead(416);
                response.end();
                return;
            }
            const start = range?.start ?? 0;
            const end = range?.end ?? Math.max(0, media.sizeBytes - 1);
            const contentLength = media.sizeBytes === 0 ? 0 : end - start + 1;
            response.setHeader('content-length', String(contentLength));
            if (range !== undefined)
                response.setHeader('content-range', `bytes ${String(start)}-${String(end)}/${String(media.sizeBytes)}`);
            response.writeHead(range === undefined ? 200 : 206);
            if (request.method === 'HEAD' || contentLength === 0) {
                response.end();
                return;
            }
            const stream = media.handle.createReadStream({
                autoClose: false,
                start,
                end,
            });
            try {
                await pipeMedia(request, response, stream);
            }
            finally {
                stream.destroy();
            }
        }
        catch (error) {
            if (!response.headersSent)
                sendError(response, error);
            else
                response.destroy();
        }
        finally {
            await media?.close();
        }
    };
}
