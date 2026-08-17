export const MEDIA_PREVIEW_ROUTE = '/dsh-code-ide/media'

/**
 * Mint a same-origin URL for the Host-owned media transport.
 *
 * All values are encoded as query parameters; callers must not concatenate a
 * workspace path into the route itself. The version is optional so Markdown
 * can resolve an image that is not already open as a document tab.
 */
export function mediaPreviewUrl(workspaceId: string, path: string, version?: string): string {
  const query = new URLSearchParams()
  query.set('workspaceId', workspaceId)
  query.set('path', path)
  if (version !== undefined) query.set('version', version)
  return `${MEDIA_PREVIEW_ROUTE}?${query.toString()}`
}
