import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyShortcutRecorder,
  filterKeyboardShortcutRows,
  formatShortcutSequence,
  hasKeyboardShortcutRow,
  keyboardShortcutFocusRecoveryTarget,
  KeyboardShortcutsDialog,
  MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS,
  keyboardShortcutRows,
  recordedShortcutSequence,
  reduceShortcutRecorder,
  type KeyboardShortcutsDialogProps,
  type ShortcutRecorderInput,
} from '../../src/client/KeyboardShortcutsDialog.tsx'
import type {
  CommandKeybindingView,
  EffectiveKeybindingView,
  KeybindingEditOutcome,
  KeybindingSequence,
  KeybindingSnapshot,
} from '../../src/client/commands/keybindings.ts'
import type { WorkbenchCommandCatalogEntry } from '../../src/client/commands/types.ts'

const CTRL_K: KeybindingSequence = [{ ctrl: true, key: 'k' }]
const CTRL_K_S: KeybindingSequence = [{ ctrl: true, key: 'k' }, { key: 's' }]

function effective(
  commandId: string,
  bindingId: string,
  label: string,
  source: EffectiveKeybindingView['source'] = 'default',
  state: EffectiveKeybindingView['state'] = 'active',
  sequence: KeybindingSequence = CTRL_K,
): EffectiveKeybindingView {
  return { id: `${source}:${commandId}:${bindingId}`, bindingId, commandId, source, sequence, label, state }
}

function command(
  commandId: string,
  state: CommandKeybindingView['state'],
  bindings: readonly EffectiveKeybindingView[],
): CommandKeybindingView {
  return {
    commandId,
    state,
    defaultBindings: bindings.filter(binding => binding.source === 'default').map(binding => ({
      id: binding.bindingId,
      sequence: binding.sequence,
    })),
    userBindings: bindings.filter(binding => binding.source === 'user').map(binding => ({
      id: binding.bindingId,
      commandId,
      sequence: binding.sequence,
    })),
    effectiveBindings: bindings,
    conflicts: state === 'conflict'
      ? [{ kind: 'exact', signature: 'ctrl+k', candidateIds: ['a', 'b'], commandIds: [commandId, 'file.open'] }]
      : [],
  }
}

function catalog(): readonly WorkbenchCommandCatalogEntry[] {
  return [
    {
      id: 'file.save', title: 'Save', category: 'File', description: 'Save the active file.',
      defaultKeybindings: [{ id: 'save', sequence: [{ ctrl: true, key: 's' }] }], keybindingPolicy: 'allow',
    },
    {
      id: 'file.open', title: 'Quick Open', category: 'File',
      defaultKeybindings: [{ id: 'open', sequence: [{ ctrl: true, key: 'p' }] }], keybindingPolicy: 'allow',
    },
    { id: 'view.search', title: 'Search', category: 'View', defaultKeybindings: [], keybindingPolicy: 'allow' },
    { id: 'terminal.copy', title: 'Terminal Copy', category: 'Terminal', defaultKeybindings: [], keybindingPolicy: 'none' },
  ]
}

function snapshot(
  persistence: KeybindingSnapshot['persistence'] = { kind: 'ready' },
  canResetInvalid = false,
): KeybindingSnapshot {
  return {
    revision: 4,
    platform: 'windows',
    commands: [
      command('file.save', 'default', [effective('file.save', 'save', 'Ctrl+S', 'default', 'active', [{ ctrl: true, key: 's' }])]),
      command('file.open', 'customized', [effective('file.open', 'user-open', 'Ctrl+K S', 'user', 'active', CTRL_K_S)]),
      command('view.search', 'unbound', []),
      command('terminal.copy', 'conflict', [effective('terminal.copy', 'copy', 'Ctrl+K', 'default', 'conflict')]),
      command('missing.command', 'customized', [effective('missing.command', 'missing-user', 'Ctrl+M', 'user')]),
    ],
    conflicts: [{
      kind: 'exact', signature: 'ctrl+k', candidateIds: ['a', 'b'], commandIds: ['terminal.copy', 'file.open'],
    }],
    dispatchBlocked: false,
    canResetInvalid,
    persistence,
  }
}

function replaceSnapshotCommand(
  current: KeybindingSnapshot,
  replacement: CommandKeybindingView,
): KeybindingSnapshot {
  return {
    ...current,
    revision: current.revision + 1,
    commands: current.commands.map(command => command.commandId === replacement.commandId ? replacement : command),
  }
}

const saved = async (): Promise<KeybindingEditOutcome> => ({ status: 'saved' })

function props(overrides: Partial<KeyboardShortcutsDialogProps> = {}): KeyboardShortcutsDialogProps {
  return {
    open: true,
    snapshot: snapshot(),
    catalog: catalog(),
    onAdd: vi.fn(saved),
    onReplace: vi.fn(saved),
    onReplaceDefault: vi.fn(saved),
    onRemoveUser: vi.fn(saved),
    onUnbindDefault: vi.fn(saved),
    onResetCommand: vi.fn(saved),
    onResetAll: vi.fn(saved),
    onResetInvalid: vi.fn(saved),
    onPreview: vi.fn(input => ({
      sequence: input.sequence,
      label: formatShortcutSequence(input.sequence, 'windows'),
      signature: formatShortcutSequence(input.sequence, 'windows').toLocaleLowerCase('en-US'),
      firstStrokeSignature: formatShortcutSequence([input.sequence[0]], 'windows').toLocaleLowerCase('en-US'),
      exactMatches: [],
      prefixMatches: [],
    })),
    onFindSame: vi.fn(() => []),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

function input(overrides: Partial<ShortcutRecorderInput> = {}): ShortcutRecorderInput {
  return {
    key: 'k', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false,
    ...overrides,
  }
}

describe('shortcut recorder reducer', () => {
  it('records a modified first stroke and permits a bare printable chord tail', () => {
    const first = reduceShortcutRecorder(emptyShortcutRecorder(), input())
    expect(first.kind).toBe('update')
    expect(first.state.recording).toBe(true)
    expect(recordedShortcutSequence(first.state.strokes)).toEqual(CTRL_K)

    const second = reduceShortcutRecorder(first.state, input({ key: 's', ctrlKey: false }))
    expect(second.kind).toBe('update')
    expect(second.state.recording).toBe(false)
    expect(recordedShortcutSequence(second.state.strokes)).toEqual(CTRL_K_S)
  })

  it('rejects unsafe or unstable first strokes and reserves modal navigation keys', () => {
    const initial = emptyShortcutRecorder()
    expect(reduceShortcutRecorder(initial, input({ key: 'a', ctrlKey: false })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ key: '🙂', ctrlKey: false })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ key: 'Control' })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ repeat: true })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ isComposing: true })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ altGraph: true })).kind).toBe('ignored')
    expect(reduceShortcutRecorder(initial, input({ key: 'Tab', ctrlKey: false })).kind).toBe('navigate')
    expect(reduceShortcutRecorder(initial, input({ key: 'Escape', ctrlKey: false })).kind).toBe('stop')
  })

  it('commits one stroke with Enter and clears the latest stroke with Backspace', () => {
    const first = reduceShortcutRecorder(emptyShortcutRecorder(), input()).state
    expect(reduceShortcutRecorder(first, input({ key: 'Enter', ctrlKey: false })).kind).toBe('commit')
    const cleared = reduceShortcutRecorder(first, input({ key: 'Backspace', ctrlKey: false }))
    expect(cleared.kind).toBe('update')
    expect(cleared.state.strokes).toEqual([])
  })

  it('ignores IME fallback keyCode 229 before recorder control-key handling', () => {
    const first = reduceShortcutRecorder(emptyShortcutRecorder(), input()).state
    const imeEnter = reduceShortcutRecorder(first, input({ key: 'Enter', ctrlKey: false, keyCode: 229 }))
    const imePrintable = reduceShortcutRecorder(first, input({ key: 's', ctrlKey: false, keyCode: 229 }))

    expect(imeEnter).toEqual({ kind: 'ignored', state: first })
    expect(imePrintable).toEqual({ kind: 'ignored', state: first })
    expect(reduceShortcutRecorder(first, input({ key: 'Enter', ctrlKey: false, isComposing: true })))
      .toEqual({ kind: 'ignored', state: first })
    expect(reduceShortcutRecorder(first, input({ key: 'Enter', ctrlKey: false, repeat: true })))
      .toEqual({ kind: 'ignored', state: first })
  })

  it('formats primary and explicit Meta for each platform without icon markup', () => {
    expect(formatShortcutSequence([{ primary: true, shift: true, key: 'p' }], 'mac')).toBe('Cmd+Shift+P')
    expect(formatShortcutSequence([{ meta: true, key: 'p' }], 'windows')).toBe('Win+P')
    expect(formatShortcutSequence([{ meta: true, key: 'p' }], 'linux')).toBe('Meta+P')
  })
})

describe('keyboard shortcut view projection', () => {
  it('merges the immutable catalog with effective, unbound and orphan rows', () => {
    const rows = keyboardShortcutRows(snapshot(), catalog())
    expect(rows.some(row => row.command.id === 'view.search' && row.binding === undefined)).toBe(true)
    expect(rows.some(row => row.command.id === 'missing.command' && row.orphan)).toBe(true)
    expect(rows.some(row => row.binding?.source === 'user')).toBe(true)
    expect(hasKeyboardShortcutRow(rows, rows[0]?.id)).toBe(true)
    expect(hasKeyboardShortcutRow(rows, 'removed:row')).toBe(false)
  })

  it('sorts independently of catalog, registration and storage order', () => {
    const current = snapshot()
    const forward = keyboardShortcutRows(current, catalog()).map(row => row.id)
    const reverse = keyboardShortcutRows(
      { ...current, commands: [...current.commands].reverse() },
      [...catalog()].reverse(),
    ).map(row => row.id)

    expect(reverse).toEqual(forward)
    expect(forward).toEqual([
      'missing.command:user:missing.command:missing-user',
      'file.open:user:file.open:user-open',
      'file.save:default:file.save:save',
      'terminal.copy:default:terminal.copy:copy',
      'view.search:unbound',
    ])
  })

  it('searches title, id, category and rendered binding text', () => {
    const rows = keyboardShortcutRows(snapshot(), catalog())
    expect(filterKeyboardShortcutRows(rows, 'Quick Open').map(row => row.command.id)).toEqual(['file.open'])
    expect(filterKeyboardShortcutRows(rows, 'view.search').map(row => row.command.id)).toEqual(['view.search'])
    expect(filterKeyboardShortcutRows(rows, 'Terminal').map(row => row.command.id)).toEqual(['terminal.copy'])
    expect(filterKeyboardShortcutRows(rows, 'Ctrl+S').map(row => row.command.id)).toEqual(['file.save'])
    expect(filterKeyboardShortcutRows(rows, `${'x'.repeat(MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS)}Quick Open`)).toEqual([])
  })

  it('recovers a local Remove whose toolbar button disables onto the same command unbound row', () => {
    const before = keyboardShortcutRows(snapshot(), catalog())
    const selected = before.find(row => row.command.id === 'file.open' && row.binding?.source === 'user')
    const after = keyboardShortcutRows(
      replaceSnapshotCommand(snapshot(), command('file.open', 'unbound', [])),
      catalog(),
    )

    expect(keyboardShortcutFocusRecoveryTarget(after, {
      currentFocusUsable: false,
      previousFocusTracked: true,
      previousFocusUsable: false,
      ...(selected === undefined ? {} : { activeRowId: selected.id }),
      preferredCommandId: 'file.open',
    })).toEqual({ kind: 'row', rowId: 'file.open:unbound' })
  })

  it('recovers a cross-tab removed focused row but preserves another valid control in the dialog', () => {
    const before = keyboardShortcutRows(snapshot(), catalog())
    const selected = before.find(row => row.command.id === 'file.open' && row.binding?.source === 'user')
    const after = keyboardShortcutRows(
      replaceSnapshotCommand(snapshot(), command('file.open', 'unbound', [])),
      catalog(),
    )
    const transition = {
      currentFocusUsable: false,
      previousFocusTracked: true,
      previousFocusUsable: false,
      ...(selected === undefined ? {} : { activeRowId: selected.id }),
      preferredCommandId: 'file.open',
    }

    expect(keyboardShortcutFocusRecoveryTarget(after, transition))
      .toEqual({ kind: 'row', rowId: 'file.open:unbound' })
    expect(keyboardShortcutFocusRecoveryTarget(after, { ...transition, currentFocusUsable: true }))
      .toEqual({ kind: 'preserve' })
  })

  it('recovers Confirm Reset All after it disables onto the reset command row', () => {
    const before = keyboardShortcutRows(snapshot(), catalog())
    const selected = before.find(row => row.command.id === 'file.open' && row.binding?.source === 'user')
    const defaultOpen = effective(
      'file.open', 'open', 'Ctrl+P', 'default', 'active', [{ ctrl: true, key: 'p' }],
    )
    const after = keyboardShortcutRows(
      replaceSnapshotCommand(snapshot(), command('file.open', 'default', [defaultOpen])),
      catalog(),
    )

    expect(keyboardShortcutFocusRecoveryTarget(after, {
      currentFocusUsable: false,
      previousFocusTracked: true,
      previousFocusUsable: false,
      ...(selected === undefined ? {} : { activeRowId: selected.id }),
      preferredCommandId: 'file.open',
    })).toEqual({ kind: 'row', rowId: 'file.open:default:file.open:open' })
  })
})

describe('KeyboardShortcutsDialog SSR', () => {
  it('renders a named modal, searchbox, independent toolbar and semantic roving list', () => {
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props()))

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('role="searchbox"')
    expect(html).toContain(`maxLength="${String(MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS)}"`)
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('<ul')
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('role="option"')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toContain('>Add</button>')
    expect(html).toContain('>Change</button>')
    expect(html).toContain('>Remove</button>')
    expect(html).toContain('>Reset</button>')
    expect(html).toContain('>Show Same</button>')
    expect(html).toContain('>Reset All</button>')
    expect(html).not.toContain('<svg')

    const current = snapshot()
    const save = current.commands.find(command => command.commandId === 'file.save')
    expect(save).toBeDefined()
    const defaultOnly = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props({
      snapshot: { ...current, commands: save === undefined ? [] : [save], conflicts: [] },
      catalog: catalog().filter(command => command.id === 'file.save'),
    })))
    expect(defaultOnly).toContain('>Unbind</button>')
  })

  it('exposes Default, User, Customized, Unbound, Conflict and Orphan states as text', () => {
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props()))

    for (const status of ['Default', 'User', 'Customized', 'Unbound', 'Conflict', 'Orphan']) {
      expect(html).toContain(`>${status}<`)
    }
  })

  it('announces read-only persistence and disables all mutation actions', () => {
    const html = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props({
      snapshot: snapshot({ kind: 'readOnly', message: 'A future settings version is read-only.' }),
    })))

    expect(html).toContain('role="alert"')
    expect(html).toContain('A future settings version is read-only.')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('offers explicit invalid-settings recovery only when the core permits it', () => {
    const recoverable = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props({
      snapshot: snapshot({ kind: 'readOnly', message: 'Stored settings are invalid.' }, true),
    })))
    const ordinary = renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props({
      snapshot: snapshot({ kind: 'readOnly', message: 'Another page owns settings.' }),
    })))

    expect(recoverable).toContain('Reset Invalid Settings')
    expect(recoverable).toContain('overwrite the local shortcut settings')
    expect(ordinary).not.toContain('Reset Invalid Settings')
  })

  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(createElement(KeyboardShortcutsDialog, props({ open: false })))).toBe('')
  })
})
