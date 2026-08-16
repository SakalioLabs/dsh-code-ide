import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EditorLineEndingStatus } from '../../src/client/EditorLineEndingStatus.tsx'

describe('editor line ending status', () => {
  it('shows the current convention and exposes both choices through one action', () => {
    const onOpen = vi.fn()
    const button = EditorLineEndingStatus({ lineEnding: '\n', disabled: false, onOpen })
    const html = renderToStaticMarkup(createElement(EditorLineEndingStatus, {
      lineEnding: '\n', disabled: false, onOpen,
    }))

    expect(html).toContain('>LF</button>')
    expect(html).toContain('aria-label="End of line sequence: LF. Open LF and CRLF choices."')
    expect(html).toContain('title="End of line sequence: LF. Open LF and CRLF choices."')
    button.props.onClick()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('renders a blocked CRLF editor as disabled', () => {
    const html = renderToStaticMarkup(createElement(EditorLineEndingStatus, {
      lineEnding: '\r\n', disabled: true, onOpen: vi.fn(),
    }))

    expect(html).toContain('disabled=""')
    expect(html).toContain('>CRLF</button>')
    expect(html).toContain('End of line sequence: CRLF. Open LF and CRLF choices.')
  })
})
