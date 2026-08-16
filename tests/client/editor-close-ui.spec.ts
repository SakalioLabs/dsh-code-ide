import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  editorCloseBackdropAction,
  editorCloseDialogKeyboardAction,
  editorClosePresentationRequest,
  EditorCloseDialog,
  nextEditorCloseFocusIndex,
  type EditorCloseDialogProps,
} from '../../src/client/EditorCloseDialog.tsx'
import type { EditorCloseSnapshot } from '../../src/client/editor/close.ts'

const identity = {
  workspaceId: 'workspace-a',
  workspaceEpoch: 7,
  path: 'src/nested/file.ts',
  lifecycleId: 19,
} as const

function confirming(deleted = false): EditorCloseSnapshot {
  return {
    phase: 'confirming',
    identity,
    name: 'file.ts',
    deleted,
    origin: 'tab',
    presentationRequest: { requestId: 10, target: 'cancel' },
  } as EditorCloseSnapshot
}

function saving(deleted = false): EditorCloseSnapshot {
  return {
    phase: 'saving',
    identity,
    name: 'file.ts',
    deleted,
    origin: 'tab',
  } as EditorCloseSnapshot
}

function error(actions: 'decide' | 'dismiss'): EditorCloseSnapshot {
  return {
    phase: 'error',
    identity,
    name: 'file.ts',
    deleted: false,
    origin: 'tab',
    actions,
    error: { code: 'SAVE_FAILED', message: 'The version changed while saving.' },
    presentationRequest: { requestId: 11, target: actions === 'decide' ? 'cancel' : 'dismiss' },
  } as EditorCloseSnapshot
}

function props(snapshot: EditorCloseSnapshot): EditorCloseDialogProps {
  return {
    snapshot,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    onPresentationApplied: vi.fn(),
  }
}

describe('editor close modal keyboard decisions', () => {
  it('maps Escape to cancel and both Tab directions to the focus trap', () => {
    expect(editorCloseDialogKeyboardAction('Escape')).toEqual({ kind: 'cancel' })
    expect(editorCloseDialogKeyboardAction('Tab')).toEqual({ kind: 'trap', backwards: false })
    expect(editorCloseDialogKeyboardAction('Tab', true)).toEqual({ kind: 'trap', backwards: true })
    expect(editorCloseDialogKeyboardAction('Enter')).toEqual({ kind: 'none' })
  })

  it('contains Escape and backdrop input while the irreversible save is running', () => {
    expect(editorCloseDialogKeyboardAction('Escape', false, true)).toEqual({ kind: 'contain' })
    expect(editorCloseDialogKeyboardAction('Tab', false, true)).toEqual({ kind: 'trap', backwards: false })
    expect(editorCloseBackdropAction(true, true)).toBe('contain')
    expect(editorCloseBackdropAction(true, false)).toBe('cancel')
    expect(editorCloseBackdropAction(false, false)).toBe('none')
  })

  it('cycles focus in either direction and recovers focus that starts outside', () => {
    expect(nextEditorCloseFocusIndex(0, 3, false)).toBe(1)
    expect(nextEditorCloseFocusIndex(2, 3, false)).toBe(0)
    expect(nextEditorCloseFocusIndex(0, 3, true)).toBe(2)
    expect(nextEditorCloseFocusIndex(-1, 3, false)).toBe(0)
    expect(nextEditorCloseFocusIndex(-1, 3, true)).toBe(2)
    expect(nextEditorCloseFocusIndex(0, 0, false)).toBe(-1)
  })

  it('exposes only confirming/error presentation requests for exact acknowledgement', () => {
    expect(editorClosePresentationRequest(confirming())).toEqual({ requestId: 10, target: 'cancel' })
    expect(editorClosePresentationRequest(error('dismiss'))).toEqual({ requestId: 11, target: 'dismiss' })
    expect(editorClosePresentationRequest(saving())).toBeUndefined()
    expect(editorClosePresentationRequest({
      phase: 'idle', workspaceEpoch: 7,
    } as EditorCloseSnapshot)).toBeUndefined()
  })
})

describe('EditorCloseDialog SSR contract', () => {
  it('is SSR safe and renders nothing while idle', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props({
      phase: 'idle', workspaceEpoch: 7,
    } as EditorCloseSnapshot)))
    expect(html).toBe('')
  })

  it('renders a labelled modal with the full path, safe initial focus, and all decisions', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props(confirming())))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('Save changes to file.ts?')
    expect(html).toContain('src/nested/file.ts')
    expect(html).toContain('data-initial-focus="true"')
    expect(html).toContain('>Don&#x27;t Save</button>')
    expect(html).toContain('>Cancel</button>')
    expect(html).toContain('>Save</button>')
  })

  it('changes the primary action to Recreate for a dirty externally deleted file', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props(confirming(true))))
    expect(html).toContain('Recreate file.ts?')
    expect(html).toContain('deleted outside the IDE')
    expect(html).toContain('>Recreate</button>')
    expect(html).not.toContain('>Save</button>')
  })

  it('announces saving and disables every action while retaining a programmatic focus fallback', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props(saving())))
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('Saving changes before closing...')
    expect(html).toContain('tabindex="-1"')
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })

  it('announces a recoverable error while keeping the three safe decisions', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props(error('decide'))))
    expect(html).toContain('role="alert"')
    expect(html).toContain('The version changed while saving.')
    expect(html).toContain('>Don&#x27;t Save</button>')
    expect(html).toContain('>Cancel</button>')
    expect(html).toContain('>Save</button>')
  })

  it('contains admission/retirement failures to one dismiss action', () => {
    const html = renderToStaticMarkup(createElement(EditorCloseDialog, props(error('dismiss'))))
    expect(html).toContain('Cannot close file.ts')
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Dismiss</button>')
    expect(html).not.toContain('>Don&#x27;t Save</button>')
    expect(html).not.toContain('>Save</button>')
  })
})
