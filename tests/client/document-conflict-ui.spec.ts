import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  documentConflictDialogKeyboardAction,
  documentConflictDraft,
  documentConflictPresentationRequest,
  documentConflictRelationMessage,
  documentConflictVariantMessage,
  DocumentConflictDialog,
  nextDocumentConflictFocusIndex,
  type DocumentConflictDialogProps,
  type DocumentConflictDraft,
} from '../../src/client/DocumentConflictDialog.tsx'
import type { DocumentConflictSnapshot } from '../../src/client/documents/conflict.ts'
import { validateDocumentConflictVariant } from '../../src/client/documents/session.ts'

const intent = {
  workspaceId: 'workspace-a',
  workspaceEpoch: 7,
  path: 'src/nested/file.ts',
  lifecycleId: 19,
  requestId: 23,
  resourceGeneration: 4,
  localRevision: 6,
  baseVersion: 'base-v1',
  base: 'base text\n',
  local: 'local text\n',
} as const

function ready(remote = 'remote text\n'): DocumentConflictSnapshot {
  return {
    phase: 'ready',
    intent,
    base: intent.base,
    local: intent.local,
    remote: { content: remote, version: 'remote-v2' },
    relation: 'diverged',
    presentationRequest: { requestId: 31, target: 'summary' },
  } as DocumentConflictSnapshot
}

function applying(): DocumentConflictSnapshot {
  return {
    ...ready(),
    phase: 'applying',
    resolution: { kind: 'apply-merged', content: 'merged text\n' },
  } as DocumentConflictSnapshot
}

function verifyError(): DocumentConflictSnapshot {
  return {
    ...ready(),
    phase: 'error',
    operation: 'verify',
    error: { code: 'REMOTE_VERIFY_FAILED', message: 'Remote verification timed out.' },
  } as DocumentConflictSnapshot
}

function baseUnavailable(): DocumentConflictSnapshot {
  const { base: _base, ...withoutBase } = intent
  return {
    phase: 'ready',
    intent: withoutBase,
    local: withoutBase.local,
    remote: { content: 'remote text\n', version: 'remote-v2' },
    relation: 'base-unavailable',
  } as DocumentConflictSnapshot
}

function props(snapshot: DocumentConflictSnapshot): DocumentConflictDialogProps {
  return {
    snapshot,
    onAcceptRemote: vi.fn(),
    onKeepLocal: vi.fn(),
    onApplyMerged: vi.fn(),
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onPresentationApplied: vi.fn(),
  }
}

describe('document conflict modal policies', () => {
  it('cancels through Escape in every cancellable phase while fencing IME and handled keys', () => {
    expect(documentConflictDialogKeyboardAction('Escape')).toEqual({ kind: 'cancel' })
    expect(documentConflictDialogKeyboardAction('Escape', false, true)).toEqual({ kind: 'none' })
    expect(documentConflictDialogKeyboardAction('Escape', false, false, true)).toEqual({ kind: 'none' })
    expect(documentConflictDialogKeyboardAction('Tab')).toEqual({ kind: 'trap', backwards: false })
    expect(documentConflictDialogKeyboardAction('Tab', true)).toEqual({ kind: 'trap', backwards: true })
    expect(documentConflictDialogKeyboardAction('Enter')).toEqual({ kind: 'none' })
  })

  it('cycles focus and recovers either direction from a programmatic focus escape', () => {
    expect(nextDocumentConflictFocusIndex(0, 4, false)).toBe(1)
    expect(nextDocumentConflictFocusIndex(3, 4, false)).toBe(0)
    expect(nextDocumentConflictFocusIndex(0, 4, true)).toBe(3)
    expect(nextDocumentConflictFocusIndex(-1, 4, false)).toBe(0)
    expect(nextDocumentConflictFocusIndex(-1, 4, true)).toBe(3)
    expect(nextDocumentConflictFocusIndex(0, 0, false)).toBe(-1)
  })

  it('keeps a merge draft across Remote refresh/error/retry projections and resets only for a new intent', () => {
    const initial = documentConflictDraft(intent.requestId, intent.local, undefined)!
    const edited: DocumentConflictDraft = { ...initial, content: 'hand merged\n' }
    expect(documentConflictDraft(intent.requestId, intent.local, edited)).toBe(edited)
    expect(documentConflictDraft(intent.requestId, intent.local, edited)?.content).toBe('hand merged\n')
    expect(documentConflictDraft(intent.requestId + 1, 'new local\n', edited)).toEqual({
      requestId: intent.requestId + 1,
      content: 'new local\n',
    })
    expect(documentConflictDraft(undefined, '', edited)).toBeUndefined()
  })

  it('uses the shared text validator for NUL, malformed Unicode, and the UTF-8 bound', () => {
    expect(documentConflictVariantMessage(validateDocumentConflictVariant('valid 😀\n'))).toBeUndefined()
    expect(documentConflictVariantMessage(validateDocumentConflictVariant('bad\0text'))).toContain('NUL')
    expect(documentConflictVariantMessage(validateDocumentConflictVariant('\ud800'))).toContain('invalid Unicode')
    expect(documentConflictVariantMessage(validateDocumentConflictVariant('a'.repeat(1024 * 1024 + 1)))).toContain('1 MiB')
  })

  it('projects deterministic relation and presentation copy', () => {
    expect(documentConflictRelationMessage('remote-equals-base')).toContain('only Local')
    expect(documentConflictRelationMessage('local-equals-base')).toContain('only Remote')
    expect(documentConflictRelationMessage('local-equals-remote')).toContain('same text')
    expect(documentConflictRelationMessage('diverged')).toContain('both differ')
    expect(documentConflictRelationMessage('base-unavailable')).toContain('unavailable')
    expect(documentConflictPresentationRequest(ready())).toEqual({ requestId: 31, target: 'summary' })
    expect(documentConflictPresentationRequest({ phase: 'idle', workspaceEpoch: 7 })).toBeUndefined()
  })
})

describe('DocumentConflictDialog SSR contract', () => {
  it('is SSR safe and renders nothing while idle', () => {
    const html = renderToStaticMarkup(createElement(DocumentConflictDialog, props({
      phase: 'idle', workspaceEpoch: 7,
    })))
    expect(html).toBe('')
  })

  it('renders a named body-modal contract with four text surfaces and non-writing actions', () => {
    const html = renderToStaticMarkup(createElement(DocumentConflictDialog, props(ready())))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('data-initial-focus="true"')
    expect(html).toContain('Resolve conflict: file.ts')
    expect(html).toContain('src/nested/file.ts')
    expect(html.match(/<textarea/g)).toHaveLength(4)
    expect(html).toContain('Use Base in Result')
    expect(html).toContain('Use Local in Result')
    expect(html).toContain('Use Remote in Result')
    expect(html).toContain('>Accept Remote</button>')
    expect(html).toContain('>Keep Local</button>')
    expect(html).toContain('>Cancel</button>')
    expect(html).toContain('>Apply Merge to Editor</button>')
    expect(html).toContain('do not save or write to the Host')
    expect(html).toContain('>local text\n</textarea>')
  })

  it('makes the missing Base explicit without fabricating an empty read-only editor', () => {
    const html = renderToStaticMarkup(createElement(DocumentConflictDialog, props(baseUnavailable())))
    expect(html).toContain('Common Base is unavailable')
    expect(html).not.toContain('Use Base in Result')
    expect(html.match(/<textarea/g)).toHaveLength(3)
    expect(html).toContain('Compare Local and Remote directly')
  })

  it('keeps Cancel available while verification disables every result or resolution mutation', () => {
    const html = renderToStaticMarkup(createElement(DocumentConflictDialog, props(applying())))
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Checking Remote again before applying')
    expect(html).toMatch(/<textarea[^>]*aria-label="Merge result[^>]*disabled=""/u)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Use Base in Result<\/button>/u)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept Remote<\/button>/u)
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/u)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/u)
  })

  it('announces verify failure, retains all four variants, and offers an explicit retry', () => {
    const html = renderToStaticMarkup(createElement(DocumentConflictDialog, props(verifyError())))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Remote verification timed out.')
    expect(html).toContain('>Retry Remote Read</button>')
    expect(html.match(/<textarea/g)).toHaveLength(4)
    expect(html).not.toMatch(/<textarea[^>]*aria-label="Merge result[^>]*disabled=""/u)
  })
})
