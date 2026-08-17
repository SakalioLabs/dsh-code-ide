/** Error safe to project across the local HTTP/WebSocket boundary. */
export class IdeHostError extends Error {
    code;
    status;
    constructor(code, message, status = 400, options) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.name = 'IdeHostError';
    }
}
export function hostError(error) {
    if (error instanceof IdeHostError)
        return error;
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
    if (code === 'ENOENT')
        return new IdeHostError('NOT_FOUND', 'The requested path does not exist.', 404);
    if (code === 'EACCES' || code === 'EPERM') {
        return new IdeHostError('PERMISSION_DENIED', 'The host denied access to the requested path.', 403);
    }
    return new IdeHostError('INTERNAL_ERROR', 'The IDE Host operation failed.', 500, { cause: error });
}
