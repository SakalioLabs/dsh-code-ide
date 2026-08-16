import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchRecoveryDialogBody } from '../../src/client/WorkbenchRecoveryDialog.tsx'

describe('workbench recovery safety dialog', () => {
  it('requires an exact download before its explicit second reset step', () => {
    const initial = renderToStaticMarkup(createElement(WorkbenchRecoveryDialogBody, {
      titleId: 'title',
      descriptionId: 'description',
      reviewed: false,
      busy: false,
      canReset: true,
      exported: false,
      onDismiss: vi.fn(),
      onExport: vi.fn(),
      onReview: vi.fn(),
      onKeep: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(initial.match(/role="alertdialog"/gu)).toHaveLength(1)
    expect(initial).toContain('Download Exact Recovery Data')
    expect(initial).toMatch(/Review Reset\.\.\.<\/button>/u)
    expect(initial).toMatch(/disabled=""[^>]*>Review Reset/u)
    expect(initial).not.toContain('Reset Recovery From Current Workbench')
    expect(initial).toContain('does not inspect or decide disk contents')
    expect(initial).toContain('cannot reconstruct dirty-buffer, undo, or editor history')

    const reviewed = renderToStaticMarkup(createElement(WorkbenchRecoveryDialogBody, {
      titleId: 'title',
      descriptionId: 'description',
      reviewed: true,
      busy: false,
      canReset: true,
      exported: true,
      onDismiss: vi.fn(),
      onExport: vi.fn(),
      onReview: vi.fn(),
      onKeep: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(reviewed.match(/role="alertdialog"/gu)).toHaveLength(1)
    expect(reviewed).toContain('Reset Recovery From Current Workbench')
    expect(reviewed).toContain('re-reads the checkpoint')
    expect(reviewed).toContain('became valid is preserved')
    expect(reviewed).toContain('current in-memory workbench snapshot')
  })
})
