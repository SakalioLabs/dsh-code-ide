import { useEffect, useRef, useState } from 'react'
import type { MediaPreviewDescriptor } from '../shared/media-preview.ts'
import css from './ide.module.css'
import { mediaPreviewUrl } from './media-preview-url.ts'

type MediaLoadStatus = 'loading' | 'ready' | 'error'

interface MediaLoadState {
  readonly source: string
  readonly status: MediaLoadStatus
}

export interface MediaPreviewProps {
  readonly workspaceId: string
  readonly path: string
  readonly version?: string
  readonly descriptor: MediaPreviewDescriptor
  readonly previewLabel: string
  readonly loadingLabel: string
  readonly errorLabel: string
  readonly focusRequest?: number
  readonly onFocusApplied?: (requestId: number) => void
}

function filename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

/** A read-only, native browser presentation for an allowlisted media file. */
export function MediaPreview({
  workspaceId,
  path,
  version,
  descriptor,
  previewLabel,
  loadingLabel,
  errorLabel,
  focusRequest,
  onFocusApplied,
}: MediaPreviewProps) {
  const surface = useRef<HTMLElement>(null)
  const onFocusAppliedRef = useRef(onFocusApplied)
  onFocusAppliedRef.current = onFocusApplied

  const source = mediaPreviewUrl(workspaceId, path, version)
  const [loadState, setLoadState] = useState<MediaLoadState>({ source, status: 'loading' })
  const status: MediaLoadStatus = loadState.source === source ? loadState.status : 'loading'

  const mark = (nextStatus: Exclude<MediaLoadStatus, 'loading'>) => {
    setLoadState(current => current.source === source && current.status === nextStatus
      ? current
      : { source, status: nextStatus })
  }

  useEffect(() => {
    if (focusRequest === undefined) return
    const element = surface.current
    element?.focus()
    if (element !== null && document.activeElement === element) {
      onFocusAppliedRef.current?.(focusRequest)
    }
  }, [descriptor.kind, focusRequest, path, version, workspaceId])

  return (
    <section
      ref={surface}
      className={css.mediaPreview}
      data-workbench-focus="editor"
      data-media-preview-kind={descriptor.kind}
      data-media-preview-state={status}
      data-media-mime={descriptor.mimeType}
      tabIndex={0}
      aria-label={`${previewLabel}: ${path}`}
      aria-busy={status === 'loading'}
    >
      <div className={css.mediaPreviewContent}>
        {status !== 'error' && descriptor.kind === 'image' && (
          <img
            key={source}
            className={css.mediaPreviewImage}
            src={source}
            alt={filename(path)}
            draggable={false}
            onLoad={() => { mark('ready') }}
            onError={() => { mark('error') }}
          />
        )}
        {status !== 'error' && descriptor.kind === 'video' && (
          <video
            key={source}
            className={css.mediaPreviewVideo}
            controls
            preload="metadata"
            onLoadedMetadata={() => { mark('ready') }}
            onError={() => { mark('error') }}
          >
            <source src={source} type={descriptor.mimeType} />
          </video>
        )}
        {status !== 'error' && descriptor.kind === 'audio' && (
          <audio
            key={source}
            className={css.mediaPreviewAudio}
            controls
            preload="metadata"
            onLoadedMetadata={() => { mark('ready') }}
            onError={() => { mark('error') }}
          >
            <source src={source} type={descriptor.mimeType} />
          </audio>
        )}
        {status === 'loading' && (
          <p className={css.mediaPreviewStatus} role="status">{loadingLabel}</p>
        )}
        {status === 'error' && (
          <p className={css.mediaPreviewError} role="alert">{errorLabel}</p>
        )}
      </div>
    </section>
  )
}
