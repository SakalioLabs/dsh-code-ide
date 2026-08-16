/** Error safe to project across the local HTTP/WebSocket boundary. */
export class IdeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'IdeHostError'
  }
}

export function hostError(error: unknown): IdeHostError {
  if (error instanceof IdeHostError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
  if (code === 'ENOENT') return new IdeHostError('NOT_FOUND', 'The requested path does not exist.', 404)
  if (code === 'EACCES' || code === 'EPERM') {
    return new IdeHostError('PERMISSION_DENIED', 'The host denied access to the requested path.', 403)
  }
  return new IdeHostError('INTERNAL_ERROR', 'The IDE Host operation failed.', 500, { cause: error })
}
