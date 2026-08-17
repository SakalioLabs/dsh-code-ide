import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MediaPreview } from '../../src/client/MediaPreview.tsx'
import { MEDIA_PREVIEW_ROUTE, mediaPreviewUrl } from '../../src/client/media-preview-url.ts'
import { mediaPreviewDescriptor } from '../../src/shared/media-preview.ts'

describe('mediaPreviewDescriptor', () => {
  it('classifies the bounded image, audio, and video allowlist case-insensitively', () => {
    expect(mediaPreviewDescriptor('assets/photo.PNG')).toEqual({ kind: 'image', mimeType: 'image/png' })
    expect(mediaPreviewDescriptor('audio/track.FLAC')).toEqual({ kind: 'audio', mimeType: 'audio/flac' })
    expect(mediaPreviewDescriptor('video/demo.WebM')).toEqual({ kind: 'video', mimeType: 'video/webm' })
    expect(mediaPreviewDescriptor('unsafe.svg')).toBeUndefined()
    expect(mediaPreviewDescriptor('.mp4')).toBeUndefined()
    expect(mediaPreviewDescriptor('clip.mp4.exe')).toBeUndefined()
  })
})

describe('mediaPreviewUrl', () => {
  it('strictly query-encodes workspace, path, and version values', () => {
    const url = mediaPreviewUrl('space & 工作区', 'media/a?b#c + 猫.png', 'v=1&next')
    expect(url.startsWith(`${MEDIA_PREVIEW_ROUTE}?`)).toBe(true)

    const parsed = new URL(url, 'http://127.0.0.1:3080')
    expect(parsed.pathname).toBe(MEDIA_PREVIEW_ROUTE)
    expect([...parsed.searchParams.keys()]).toEqual(['workspaceId', 'path', 'version'])
    expect(parsed.searchParams.get('workspaceId')).toBe('space & 工作区')
    expect(parsed.searchParams.get('path')).toBe('media/a?b#c + 猫.png')
    expect(parsed.searchParams.get('version')).toBe('v=1&next')
    expect(url).not.toContain('#c')
  })

  it('omits only an absent version for Markdown-owned image URLs', () => {
    const absent = new URL(mediaPreviewUrl('workspace', 'image.png'), 'http://local.test')
    const empty = new URL(mediaPreviewUrl('workspace', 'image.png', ''), 'http://local.test')
    expect(absent.searchParams.has('version')).toBe(false)
    expect(empty.searchParams.get('version')).toBe('')
  })
})

const labels = {
  previewLabel: 'Media preview',
  loadingLabel: 'Loading media…',
  errorLabel: 'Unable to load media.',
} as const

function render(kind: 'image' | 'video' | 'audio', mimeType: string): string {
  return renderToStaticMarkup(createElement(MediaPreview, {
    workspaceId: 'workspace',
    path: `assets/demo.${kind}`,
    version: 'version-1',
    descriptor: { kind, mimeType },
    ...labels,
  }))
}

describe('MediaPreview', () => {
  it('renders an inert image view with editor focus semantics', () => {
    const html = render('image', 'image/png')
    expect(html).toContain('data-workbench-focus="editor"')
    expect(html).toContain('data-media-preview-kind="image"')
    expect(html).toContain('data-media-preview-state="loading"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<img')
    expect(html).toContain('alt="demo.image"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain('workspaceId=workspace')
    expect(html).toContain('version=version-1')
    expect(html).toContain('Loading media…')
  })

  it('uses metadata-only native controls for video and audio without autoplay', () => {
    const video = render('video', 'video/mp4')
    const audio = render('audio', 'audio/mpeg')

    expect(video).toContain('<video')
    expect(video).toContain('controls=""')
    expect(video).toContain('preload="metadata"')
    expect(video).toContain('type="video/mp4"')
    expect(video).not.toContain('autoplay')

    expect(audio).toContain('<audio')
    expect(audio).toContain('controls=""')
    expect(audio).toContain('preload="metadata"')
    expect(audio).toContain('type="audio/mpeg"')
    expect(audio).not.toContain('autoplay')
  })

  it('keeps focus acknowledgement optional during server rendering', () => {
    const acknowledge = vi.fn()
    const html = renderToStaticMarkup(createElement(MediaPreview, {
      workspaceId: 'workspace',
      path: 'assets/demo.png',
      version: 'v1',
      descriptor: { kind: 'image', mimeType: 'image/png' },
      focusRequest: 9,
      onFocusApplied: acknowledge,
      ...labels,
    }))

    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Media preview: assets/demo.png"')
    expect(acknowledge).not.toHaveBeenCalled()
  })
})
