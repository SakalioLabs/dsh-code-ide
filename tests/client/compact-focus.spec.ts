import { describe, expect, it, vi } from 'vitest'
import {
  hiddenCompactFocusTarget,
  isComposedFocusTarget,
  prepareEditorFocusCommand,
  quickInputRestoreDisposition,
  type EditorFocusCommandOwnership,
} from '../../src/client/compact-focus.ts'

describe('compact hidden-surface focus policy', () => {
  const active = { id: 'active' }
  const rail = { contains: (candidate: typeof active) => candidate.id === 'rail' }
  const harness = { contains: (candidate: typeof active) => candidate.id === 'harness' }

  it('hands hidden rail and Harness focus to their visible toolbar controls', () => {
    expect(hiddenCompactFocusTarget(true, 'none', { id: 'rail' }, rail, harness)).toBe('files')
    expect(hiddenCompactFocusTarget(true, 'none', { id: 'harness' }, rail, harness)).toBe('harness')
  })

  it('does not move focus outside compact mode, while a drawer is open, or from the workbench', () => {
    expect(hiddenCompactFocusTarget(false, 'none', { id: 'harness' }, rail, harness)).toBeUndefined()
    expect(hiddenCompactFocusTarget(true, 'harness', { id: 'harness' }, rail, harness)).toBeUndefined()
    expect(hiddenCompactFocusTarget(true, 'none', active, rail, harness)).toBeUndefined()
    expect(hiddenCompactFocusTarget(true, 'none', null, rail, harness)).toBeUndefined()
  })

  it('rejects disconnected, hidden, inert, and aria-hidden restore destinations through their ancestors', () => {
    interface Target {
      isConnected: boolean
      hidden: boolean
      parentElement: Target | null
      attributes: ReadonlySet<string>
      values: ReadonlyMap<string, string>
      hasAttribute(name: string): boolean
      getAttribute(name: string): string | null
    }
    const target = (parentElement: Target | null = null, options: Partial<Pick<Target, 'isConnected' | 'hidden'>> & {
      attributes?: readonly string[]
      values?: Readonly<Record<string, string>>
    } = {}): Target => ({
      isConnected: options.isConnected ?? true,
      hidden: options.hidden ?? false,
      parentElement,
      attributes: new Set(options.attributes),
      values: new Map(Object.entries(options.values ?? {})),
      hasAttribute(name) { return this.attributes.has(name) },
      getAttribute(name) { return this.values.get(name) ?? null },
    })

    expect(isComposedFocusTarget(target())).toBe(true)
    expect(isComposedFocusTarget(target(null, { isConnected: false }))).toBe(false)
    expect(isComposedFocusTarget(target(null, { hidden: true }))).toBe(false)
    expect(isComposedFocusTarget(target(target(null, { attributes: ['inert'] })))).toBe(false)
    expect(isComposedFocusTarget(target(target(null, { values: { 'aria-hidden': 'true' } })))).toBe(false)
    expect(isComposedFocusTarget(target(target(null, { values: { 'aria-hidden': '' } })))).toBe(false)
    expect(isComposedFocusTarget(target(target(null, { values: { 'aria-hidden': 'false' } })))).toBe(true)
  })

  function focusOwnership(events: string[], leave = true): EditorFocusCommandOwnership {
    return {
      leaveMutationSurface: vi.fn(() => { events.push('leave-mutation'); return leave }),
      cancelPendingChord: vi.fn(() => { events.push('cancel-chord') }),
      dismissPortals: vi.fn(() => { events.push('dismiss-portals') }),
      claimQuickInputEditorRestore: vi.fn(() => { events.push('claim-editor') }),
      closeQuickInput: vi.fn(() => { events.push('close-quick-input') }),
      clearCompactRestoreOwner: vi.fn(() => { events.push('clear-compact-owner') }),
      closeCompactPanel: vi.fn(() => { events.push('close-compact-panel') }),
    }
  }

  it.each([
    ['desktop Command Palette', 'none' as const],
    ['compact Commands button', 'none' as const],
    ['Files drawer followed by F1', 'rail' as const],
  ])('defers editor focus until %s cleanup consumes its restore ownership', (_name, compactPanel) => {
    const events: string[] = []
    const result = prepareEditorFocusCommand({
      keyboardShortcutsOpen: false,
      editorCloseIdle: true,
      documentConflictIdle: true,
      quickInputActive: true,
      compactPanel,
    }, focusOwnership(events))

    expect(result).toBe('deferred')
    expect(events).toEqual([
      'leave-mutation',
      'cancel-chord',
      'dismiss-portals',
      'claim-editor',
      'close-quick-input',
      'clear-compact-owner',
      ...(compactPanel === 'none' ? [] : ['close-compact-panel']),
    ])
  })

  it('requests immediate focus for the editor or its empty surface without a Quick Input cleanup owner', () => {
    const events: string[] = []
    expect(prepareEditorFocusCommand({
      keyboardShortcutsOpen: false,
      editorCloseIdle: true,
      documentConflictIdle: true,
      quickInputActive: false,
      compactPanel: 'none',
    }, focusOwnership(events))).toBe('immediate')
    expect(events).toEqual(['leave-mutation', 'cancel-chord', 'dismiss-portals', 'clear-compact-owner'])
  })

  it('does not cross Keyboard Shortcuts, editor-close, or non-cancellable mutation ownership', () => {
    const dialogEvents: string[] = []
    expect(prepareEditorFocusCommand({
      keyboardShortcutsOpen: true,
      editorCloseIdle: true,
      documentConflictIdle: true,
      quickInputActive: true,
      compactPanel: 'rail',
    }, focusOwnership(dialogEvents))).toBe('blocked')
    expect(dialogEvents).toEqual([])

    const closeEvents: string[] = []
    expect(prepareEditorFocusCommand({
      keyboardShortcutsOpen: false,
      editorCloseIdle: false,
      documentConflictIdle: true,
      quickInputActive: true,
      compactPanel: 'rail',
    }, focusOwnership(closeEvents))).toBe('blocked')
    expect(closeEvents).toEqual([])

    const conflictEvents: string[] = []
    expect(prepareEditorFocusCommand({
      keyboardShortcutsOpen: false,
      editorCloseIdle: true,
      documentConflictIdle: false,
      quickInputActive: true,
      compactPanel: 'rail',
    }, focusOwnership(conflictEvents))).toBe('blocked')
    expect(conflictEvents).toEqual([])

    const mutationEvents: string[] = []
    expect(prepareEditorFocusCommand({
      keyboardShortcutsOpen: false,
      editorCloseIdle: true,
      documentConflictIdle: true,
      quickInputActive: true,
      compactPanel: 'rail',
    }, focusOwnership(mutationEvents, false))).toBe('blocked')
    expect(mutationEvents).toEqual(['leave-mutation'])
  })

  it('lets an idle cleanup request the editor but clears ownership for a dirty-close modal', () => {
    expect(quickInputRestoreDisposition('editor', false, true)).toBe('editor')
    expect(quickInputRestoreDisposition('editor', false, false)).toBe('clear')
    expect(quickInputRestoreDisposition('editor', true, true)).toBe('clear')
    expect(quickInputRestoreDisposition('explorer', false, true)).toBe('default')
  })
})
