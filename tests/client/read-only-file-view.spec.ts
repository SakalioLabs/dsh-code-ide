import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatFileSize, ReadOnlyFileView } from '../../src/client/ReadOnlyFileView.tsx'

describe('read-only file presentation', () => {
  it('states why a binary file is not editable and exposes known metadata', () => {
    const html = renderToStaticMarkup(createElement(ReadOnlyFileView, {
      path: 'assets/logo.png',
      content: 'must not be rendered',
      presentation: {
        reason: 'binary',
        sizeBytes: 2048,
        limitBytes: 4 * 1024 * 1024,
        previewBytes: 0,
        truncated: true,
      },
    }))

    expect(html).toContain('Binary file is not editable')
    expect(html).toContain('assets/logo.png')
    expect(html).toContain('Binary or non-UTF-8')
    expect(html).toContain('2.00 KiB')
    expect(html).toContain('switch tabs or close this file normally')
    expect(html).not.toContain('must not be rendered')
    expect(html).not.toMatch(/<(?:textarea|input)\b|contenteditable=/)
  })

  it('shows a bounded large-file preview without presenting an editor', () => {
    const html = renderToStaticMarkup(createElement(ReadOnlyFileView, {
      path: 'logs/output.txt',
      content: 'bounded preview\n',
      presentation: {
        reason: 'too-large',
        sizeBytes: 5 * 1024 * 1024,
        limitBytes: 4 * 1024 * 1024,
        previewBytes: 16,
        truncated: true,
      },
    }))

    expect(html).toContain('File is too large for the text editor')
    expect(html).toContain('Only a bounded prefix is shown')
    expect(html).toContain('5.00 MiB')
    expect(html).toContain('4.00 MiB')
    expect(html).toContain('Read-only preview')
    expect(html).toContain('bounded preview')
    expect(html).not.toContain('class="codeMirror"')
  })

  it('formats bounded byte metadata without inventing an unknown size', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1536)).toBe('1.50 KiB')
    expect(formatFileSize(undefined)).toBe('Unknown')
  })
})
