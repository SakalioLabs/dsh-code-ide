export type MediaPreviewKind = 'image' | 'audio' | 'video'

export interface MediaPreviewDescriptor {
  readonly kind: MediaPreviewKind
  readonly mimeType: string
}

const MEDIA_BY_EXTENSION: Readonly<Record<string, MediaPreviewDescriptor>> = Object.freeze({
  '.aac': { kind: 'audio', mimeType: 'audio/aac' },
  '.avif': { kind: 'image', mimeType: 'image/avif' },
  '.bmp': { kind: 'image', mimeType: 'image/bmp' },
  '.flac': { kind: 'audio', mimeType: 'audio/flac' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.ico': { kind: 'image', mimeType: 'image/x-icon' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
  '.m4v': { kind: 'video', mimeType: 'video/x-m4v' },
  '.mov': { kind: 'video', mimeType: 'video/quicktime' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.oga': { kind: 'audio', mimeType: 'audio/ogg' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.ogv': { kind: 'video', mimeType: 'video/ogg' },
  '.opus': { kind: 'audio', mimeType: 'audio/ogg' },
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
})

/** Strict extension allowlist shared by the Host transport and browser view. */
export function mediaPreviewDescriptor(path: string): MediaPreviewDescriptor | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return undefined
  return MEDIA_BY_EXTENSION[name.slice(dot).toLowerCase()]
}
