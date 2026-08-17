import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_MARKDOWN_PREVIEW_BYTES,
  MarkdownPreview,
  renderMarkdownPreview,
  resolveMarkdownLinkTarget,
} from '../../src/client/MarkdownPreview.tsx'

function render(content: string, overrides: Partial<Parameters<typeof MarkdownPreview>[0]> = {}): string {
  return renderToStaticMarkup(createElement(MarkdownPreview, {
    path: 'docs/readme.md',
    content,
    ...overrides,
  }))
}

describe('MarkdownPreview', () => {
  it('renders common GFM structure without an HTML output boundary', () => {
    const html = render([
      '# Heading',
      '',
      'Paragraph with *emphasis*, **strength**, ~~removed~~, and `code`.',
      '',
      '> quoted',
      '',
      '- [x] done',
      '- pending',
      '',
      '2. second',
      '3. third',
      '',
      '~~~ts',
      'const answer = 42',
      '~~~',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| answer | 42 |',
    ].join('\n'))

    expect(html).toContain('<h1> Heading</h1>')
    expect(html).toContain('<em>emphasis</em>')
    expect(html).toContain('<strong>strength</strong>')
    expect(html).toContain('<del>removed</del>')
    expect(html).toContain('<blockquote')
    expect(html).toContain('<ul>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('aria-label="Completed task"')
    expect(html).toContain('<ol start="2">')
    expect(html).toContain('<pre')
    expect(html).toContain('const answer = 42')
    expect(html).toContain('<table')
    expect(html).toContain('<th>Name</th>')
    expect(html).toContain('<td>42</td>')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })

  it('keeps raw HTML inert and decodes entities only into escaped React text', () => {
    const html = render([
      '<script>alert("owned")</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      'Safe &lt;strong&gt;text&lt;/strong&gt;.',
    ].join('\n'))

    expect(html).not.toContain('<script>')
    expect(html).not.toMatch(/<img\s+src="x"/u)
    expect(html).not.toContain('onerror="')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('Safe &lt;strong&gt;text&lt;/strong&gt;.')
  })

  it('allows explicit web links, resolves confined workspace links, and rejects active URLs', () => {
    const onOpenPath = vi.fn()
    const html = render([
      '[web](https://example.com/docs)',
      '<https://example.com/automatic>',
      '[local](../guide.md#intro)',
      '[root](/README.md)',
      '[active](javascript:alert(1))',
      '[escape](../../../secret.md)',
      '[reference][guide]',
      '[missing][absent]',
      '',
      '[guide]: ./guide.md "Guide"',
    ].join('\n'), { onOpenPath })

    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('href="https://example.com/automatic"')
    expect(html).toContain('>https://example.com/automatic</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('referrerPolicy="no-referrer"')
    expect(html).toContain('data-markdown-workspace-path="guide.md"')
    expect(html).toContain('data-markdown-workspace-path="README.md"')
    expect(html).toContain('data-markdown-workspace-path="docs/guide.md"')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('data-markdown-workspace-path="secret.md"')
    expect(html).toContain('data-markdown-link-blocked="unresolved"')
    expect(onOpenPath).not.toHaveBeenCalled()
  })

  it('passes only canonical local image paths to the trusted media resolver', () => {
    const resolveImageSrc = vi.fn((path: string) => `/workspace-media/${encodeURIComponent(path)}`)
    const html = render([
      '![logo](../assets/logo.png "Logo")',
      '![remote](https://example.com/tracker.png)',
      '![active](javascript:alert(1))',
      '![escape](../../../outside.png)',
    ].join('\n'), { resolveImageSrc })

    expect(resolveImageSrc).toHaveBeenCalledTimes(1)
    expect(resolveImageSrc).toHaveBeenCalledWith('assets/logo.png')
    expect(html).toContain('src="/workspace-media/assets%2Flogo.png"')
    expect(html).toContain('alt="logo"')
    expect(html).toContain('title="Logo"')
    expect(html).not.toContain('example.com/tracker.png')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('outside.png"')
  })

  it('accepts only app-minted root-relative or blob image sources from the resolver', () => {
    const active = render('![x](../assets/x.png)', {
      resolveImageSrc: () => 'javascript:alert(1)',
    })
    const remote = render('![x](../assets/x.png)', {
      resolveImageSrc: () => 'https://example.com/x.png',
    })
    const blob = render('![x](../assets/x.png)', {
      resolveImageSrc: () => 'blob:https://ide.invalid/local-id',
    })

    expect(active).not.toContain('src=')
    expect(remote).not.toContain('src=')
    expect(blob).toContain('src="blob:https://ide.invalid/local-id"')
  })

  it('fails closed before rendering oversized or adversarially complex documents', () => {
    const oversized = render('a'.repeat(MAX_MARKDOWN_PREVIEW_BYTES + 1))
    expect(oversized).toContain('data-markdown-preview-state="too-large"')
    expect(oversized).toContain('too large to preview safely')

    const complex = render('*x* '.repeat(17_000))
    expect(complex).toContain('data-markdown-preview-state="too-complex"')
    expect(complex).not.toContain('<em>')
  })

  it('exposes editor focus semantics and a bounded pure rendering result', () => {
    const html = render('# focus', { focusRequest: 7, onFocusApplied: vi.fn() })
    expect(html).toContain('data-workbench-focus="editor"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Markdown preview: docs/readme.md"')
    expect(renderMarkdownPreview('# ready', 'README.md')).toMatchObject({ kind: 'ready' })
  })
})

describe('resolveMarkdownLinkTarget', () => {
  it('normalizes workspace paths and rejects root escapes, controls, credentials, and unsafe schemes', () => {
    expect(resolveMarkdownLinkTarget('docs/nested/readme.md', '../../guide.md#start')).toEqual({
      kind: 'workspace', path: 'guide.md', fragment: 'start',
    })
    expect(resolveMarkdownLinkTarget('docs/readme.md', './guide%20one.md')).toEqual({
      kind: 'workspace', path: 'docs/guide one.md',
    })
    expect(resolveMarkdownLinkTarget('docs/readme.md', '../../../secret')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownLinkTarget('docs/readme.md', '//example.com/path')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownLinkTarget('docs/readme.md', 'file:///etc/passwd')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownLinkTarget('docs/readme.md', 'data:text/html,owned')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownLinkTarget('docs/readme.md', 'https://user:secret@example.com')).toEqual({ kind: 'blocked' })
    expect(resolveMarkdownLinkTarget('docs/readme.md', '#section')).toEqual({ kind: 'fragment', href: '#section' })
  })
})
