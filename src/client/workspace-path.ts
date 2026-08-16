/** Keep the browser wire boundary aligned with the Host path byte budget. */
export const MAX_WORKSPACE_PATH_BYTES = 16 * 1024
export const MAX_WORKSPACE_PATH_SEGMENTS = 128
const UTF8 = new TextEncoder()

export interface WorkspacePathOptions {
  readonly allowRoot: boolean
}

function utf8ByteLength(value: string): number {
  return UTF8.encode(value).byteLength
}

/**
 * Decode one canonical, slash-separated workspace-relative path.
 *
 * This is a browser trust boundary, not a replacement for Host authorization:
 * every accepted value is still revalidated against the live workspace root by
 * the Host before filesystem access.
 */
export function decodeWorkspacePath(
  value: unknown,
  options: WorkspacePathOptions,
): string | undefined {
  if (typeof value !== 'string' || utf8ByteLength(value) > MAX_WORKSPACE_PATH_BYTES) return undefined
  if (value === '') return options.allowRoot ? '' : undefined
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    return undefined
  }
  const segments = value.split('/')
  if (segments.length > MAX_WORKSPACE_PATH_SEGMENTS) return undefined
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return value
}

/** Parse form for callers that prefer an explicit local protocol failure. */
export function parseWorkspacePath(value: unknown, options: WorkspacePathOptions): string {
  const decoded = decodeWorkspacePath(value, options)
  if (decoded === undefined) throw new TypeError('Invalid workspace-relative path.')
  return decoded
}

/** A directory entry name is exactly one valid non-root path segment. */
export function decodeWorkspacePathSegment(value: unknown): string | undefined {
  const decoded = decodeWorkspacePath(value, { allowRoot: false })
  return decoded === undefined || decoded.includes('/') ? undefined : decoded
}
