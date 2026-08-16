import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TerminalPane } from '../../src/client/TerminalPane.tsx'

type Props = ComponentProps<typeof TerminalPane>

function render(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(createElement(TerminalPane, {
    workspaceId: undefined,
    workspaceEpoch: 1,
    maxSessions: 4,
    paneVisible: true,
    onToggleCollapsed: vi.fn(),
    onToggleMaximized: vi.fn(),
    ...overrides,
  }))
}

describe('Terminal panel chrome', () => {
  it('keeps one panel title and every terminal operation in a compact VS Code-style header', () => {
    const html = render()

    expect(html.match(/>Terminal<\/span>/g) ?? []).toHaveLength(1)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Terminal sessions"')
    expect(html).toContain('aria-label="Terminal panel actions"')
    expect(html).toContain('aria-label="New terminal"')
    expect(html).toContain('aria-label="More actions"')
    expect(html).toContain('>Find in terminal</button>')
    expect(html).toContain('>Clear terminal</button>')
    expect(html).toContain('>Rename terminal</button>')
    expect(html).toContain('>Restart terminal</button>')
    expect(html).toContain('>Interrupt terminal</button>')
    expect(html).toContain('>Kill terminal</button>')
    expect(html).not.toContain('title="Find in terminal"')
    expect(html).not.toContain('title="Clear terminal"')
    expect(html).toMatch(/aria-label="Maximize panel"[^>]*aria-pressed="false"/)
    expect(html).toMatch(/aria-label="Collapse panel"[^>]*aria-expanded="true"/)
  })

  it('collapses only the body and exposes restore controls without dropping its contents', () => {
    const html = render({ collapsed: true, maximized: true })

    expect(html).toContain('data-collapsed="true"')
    expect(html).toMatch(/<div id="terminal-panel-body"[^>]*hidden="">/)
    expect(html).toContain('Select a workspace to start a terminal')
    expect(html).not.toContain('aria-label="Restore panel size"')
    expect(html).not.toContain('aria-label="Maximize panel"')
    expect(html).toMatch(/aria-label="Expand panel"[^>]*aria-expanded="false"/)
  })
})
