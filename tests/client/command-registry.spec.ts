import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../src/client/commands/registry.ts'
import {
  dispatchTerminalPaletteShortcut,
  dispatchWorkbenchShortcut,
} from '../../src/client/commands/dispatcher.ts'
import { formatKeybinding, matchesKeybinding } from '../../src/client/commands/shortcuts.ts'

interface Context {
  workspace?: string
  dirty: boolean
}

function context(): Context {
  return { workspace: 'w1', dirty: false }
}

describe('CommandRegistry', () => {
  it('fails loudly for invalid metadata, duplicate ids and shortcut collisions', async () => {
    const current = context()
    const registry = new CommandRegistry(() => current)
    expect(() => registry.register({ id: 'Bad id', title: 'Bad', run: () => undefined })).toThrow(/Invalid command id/u)
    expect(() => registry.register({
      id: 'workbench.policy', title: 'Bad policy', keybindingPolicy: 'unsafe' as 'allow', run: () => undefined,
    })).toThrow(/keybindingPolicy/u)
    expect(() => registry.register({
      id: 'workbench.dual', title: 'Dual bindings',
      keybindings: [{ primary: true, key: 'd' }],
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'd' }] }],
      run: () => undefined,
    })).toThrow(/cannot combine/u)

    const first = registry.register({
      id: 'workbench.first', title: 'First', keybindings: [{ primary: true, key: 'p' }], run: () => undefined,
    })
    expect(() => registry.register({ id: 'workbench.first', title: 'Again', run: () => undefined })).toThrow(/already registered/u)
    expect(() => registry.register({
      id: 'workbench.second', title: 'Second', keybindings: [{ primary: true, key: 'P' }], run: () => undefined,
    })).toThrow(/already owned/u)
    expect(() => registry.register({
      id: 'workbench.ctrl', title: 'Ctrl', keybindings: [{ ctrl: true, key: 'p' }], run: () => undefined,
    })).toThrow(/already owned/u)
    await first.dispose()
    const replacement = registry.register({
      id: 'workbench.second', title: 'Second', keybindings: [{ primary: true, key: 'p' }], run: () => undefined,
    })
    await replacement.dispose()
  })

  it('bounds the local contribution count', () => {
    const registry = new CommandRegistry(() => context())
    for (let index = 0; index < 1_000; index += 1) {
      registry.register({ id: `workbench.command${String(index)}`, title: `Command ${String(index)}`, run: () => undefined })
    }
    expect(() => registry.register({ id: 'workbench.overflow', title: 'Overflow', run: () => undefined }))
      .toThrow(/limit of 1000/u)
  })

  it('projects live visibility and enablement and rechecks them at execution', async () => {
    const current = context()
    const run = vi.fn()
    const registry = new CommandRegistry(() => current)
    registry.register({
      id: 'file.save', title: 'Save', category: 'File',
      when: value => value.workspace !== undefined,
      enablement: value => value.dirty ? { enabled: true } : { enabled: false, reason: 'No changes.' },
      run,
    })

    expect(registry.list()[0]).toMatchObject({ enabled: false, disabledReason: 'No changes.' })
    expect(await registry.execute('file.save')).toMatchObject({ status: 'disabled', message: 'No changes.' })
    current.dirty = true
    expect(await registry.execute('file.save')).toMatchObject({ status: 'completed' })
    expect(run).toHaveBeenCalledTimes(1)
    current.workspace = undefined
    expect(registry.list()).toEqual([])
    expect(await registry.execute('file.save')).toMatchObject({ status: 'unavailable' })
  })

  it('keeps a stable immutable full catalog when live when hides a command', () => {
    const current = { ...context(), workspace: undefined as string | undefined }
    const registry = new CommandRegistry(() => current)
    registry.register({
      id: 'workbench.hidden', title: 'Hidden', when: value => value.workspace !== undefined,
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'h' }] }],
      run: () => undefined,
    })
    expect(registry.list()).toEqual([])
    const catalog = registry.catalog()
    expect(registry.catalog()).toBe(catalog)
    expect(catalog[0]).toMatchObject({ id: 'workbench.hidden', title: 'Hidden' })
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog[0]?.defaultKeybindings)).toBe(true)
  })

  it('is single-flight and withdraw aborts and joins the exact active invocation', async () => {
    const current = context()
    let observedAbort = false
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const registry = new CommandRegistry(() => current)
    const registration = registry.register({
      id: 'workbench.long', title: 'Long task',
      run: async (_value, signal) => {
        signal.addEventListener('abort', () => { observedAbort = true; finish() }, { once: true })
        await gate
      },
    })

    const first = registry.execute('workbench.long')
    expect(await registry.execute('workbench.long')).toMatchObject({ status: 'busy' })
    let disposed = false
    const withdrawal = registration.dispose().then(() => { disposed = true })
    expect(observedAbort).toBe(true)
    expect(disposed).toBe(false)
    expect(await first).toMatchObject({ status: 'cancelled' })
    await withdrawal
    expect(disposed).toBe(true)
    expect(await registry.execute('workbench.long')).toMatchObject({ status: 'unavailable' })
  })

  it('uses exact idempotent disposal without deleting a later replacement', async () => {
    const current = context()
    const registry = new CommandRegistry(() => current)
    const old = registry.register({ id: 'workbench.replace', title: 'Old', run: () => undefined })
    await Promise.all([old.dispose(), old.dispose()])
    const replacement = registry.register({ id: 'workbench.replace', title: 'New', run: () => undefined })
    await old.dispose()
    expect(registry.list().map(item => item.title)).toEqual(['New'])
    await replacement.dispose()
  })

  it('isolates subscriber failures from lifecycle mutations', async () => {
    const registry = new CommandRegistry(() => context())
    registry.subscribe(() => { throw new Error('broken subscriber') })
    const registration = registry.register({ id: 'workbench.safe', title: 'Safe', run: () => undefined })
    expect(await registry.execute('workbench.safe')).toMatchObject({ status: 'completed' })
    await registration.dispose()
  })

  it('rejects admission callback failure without running the handler', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry(() => context())
    registry.register({ id: 'workbench.admit', title: 'Admit', run })
    const outcome = await registry.execute('workbench.admit', { onAdmitted: () => { throw new Error('close failed') } })
    expect(outcome).toMatchObject({ status: 'failed', message: 'close failed' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('command keybindings', () => {
  it('matches primary shortcuts exactly and formats platform labels', () => {
    const binding = { primary: true, shift: true, key: 'p' } as const
    expect(matchesKeybinding({ key: 'P', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, binding)).toBe(true)
    expect(matchesKeybinding({ key: 'P', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }, binding)).toBe(false)
    expect(matchesKeybinding({ key: 'P', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false }, binding, 'mac')).toBe(true)
    expect(matchesKeybinding({ key: 'P', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, binding, 'mac')).toBe(false)
    expect(matchesKeybinding({ key: 'P', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, binding)).toBe(false)
    expect(matchesKeybinding({ key: 'P', ctrlKey: true, metaKey: true, shiftKey: true, altKey: false }, binding)).toBe(false)
    expect(formatKeybinding(binding, 'other')).toBe('Ctrl+Shift+P')
    expect(formatKeybinding(binding, 'mac')).toBe('⇧⌘P')
    expect(formatKeybinding({ key: 'F1' }, 'other')).toBe('F1')
  })

  it('dispatches an exact outer shortcut once while respecting local owners and composition', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry(() => context())
    registry.register({
      id: 'workbench.open', title: 'Open', keybindings: [{ primary: true, key: 'p' }], run,
    })
    const makeEvent = (overrides: Partial<Parameters<typeof dispatchWorkbenchShortcut>[0]> = {}) => ({
      key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, isComposing: false, repeat: false,
      preventDefault: vi.fn(), ...overrides,
    })
    const event = makeEvent()
    expect(dispatchWorkbenchShortcut(event, registry)).toBe(true)
    await Promise.resolve()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()

    const repeated = makeEvent({ repeat: true })
    expect(dispatchWorkbenchShortcut(repeated, registry)).toBe(false)
    await Promise.resolve()
    expect(repeated.preventDefault).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
    expect(dispatchWorkbenchShortcut(makeEvent({ isComposing: true }), registry)).toBe(false)
    expect(dispatchWorkbenchShortcut(makeEvent({ defaultPrevented: true }), registry)).toBe(false)
    expect(dispatchWorkbenchShortcut(makeEvent({ altKey: true }), registry)).toBe(false)
  })

  it('does not let the legacy registration compatibility path bypass a user unbind', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry(() => context())
    registry.register({
      id: 'workbench.legacy', title: 'Legacy',
      keybindings: [{ primary: true, key: 'p' }], run,
    })
    await expect(registry.keybindings.unbindDefault('workbench.legacy', 'legacy.1'))
      .resolves.toEqual({ status: 'saved' })
    const event = {
      key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, isComposing: false, repeat: false, preventDefault: vi.fn(),
    }
    expect(registry.commandForKeyboardEvent(event)).toBeUndefined()
    expect(dispatchWorkbenchShortcut(event, registry)).toBe(false)
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
  })

  it('reports chord/conflict decisions, excludes terminal targets, and distinguishes real Ctrl+Alt from AltGraph', async () => {
    const chordRun = vi.fn()
    const ctrlAltRun = vi.fn()
    const registry = new CommandRegistry(() => context())
    registry.register({
      id: 'workbench.chord', title: 'Chord',
      defaultKeybindings: [{ id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }] }],
      run: chordRun,
    })
    registry.register({
      id: 'workbench.ctrlAlt', title: 'Ctrl Alt',
      defaultKeybindings: [{ id: 'ctrlAlt', sequence: [{ ctrl: true, alt: true, key: 'x' }] }],
      run: ctrlAltRun,
    })
    const event = (key: string, overrides: Record<string, unknown> = {}) => ({
      key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, isComposing: false, repeat: false,
      preventDefault: vi.fn(), ...overrides,
    })
    const decisions = vi.fn()
    const terminal = event('k', {
      target: { closest: () => ({}) } as unknown as EventTarget,
    })
    expect(dispatchWorkbenchShortcut(terminal, registry, undefined, decisions)).toBe(false)
    expect(terminal.preventDefault).not.toHaveBeenCalled()

    expect(dispatchWorkbenchShortcut(event('k'), registry, undefined, decisions)).toBe(true)
    expect(decisions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'pending' }))
    expect(dispatchWorkbenchShortcut(event('s'), registry, undefined, decisions)).toBe(true)
    await Promise.resolve()
    expect(chordRun).toHaveBeenCalledOnce()

    const ctrlAlt = event('x', { altKey: true, getModifierState: () => false })
    expect(dispatchWorkbenchShortcut(ctrlAlt, registry)).toBe(true)
    await Promise.resolve()
    expect(ctrlAltRun).toHaveBeenCalledOnce()
    const altGraph = event('x', { altKey: true, getModifierState: () => true })
    expect(dispatchWorkbenchShortcut(altGraph, registry)).toBe(false)

    registry.register({
      id: 'workbench.conflictA', title: 'Conflict A',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'g' }] }], run: vi.fn(),
    })
    registry.register({
      id: 'workbench.conflictB', title: 'Conflict B',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'g' }] }], run: vi.fn(),
    })
    const conflict = event('g')
    expect(dispatchWorkbenchShortcut(conflict, registry, undefined, decisions)).toBe(true)
    expect(decisions).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'conflict' }))
  })

  it('does not fall through to a single-stroke command when an unrelated context refresh preserves a chord', async () => {
    const chordRun = vi.fn()
    const saveRun = vi.fn()
    const registry = new CommandRegistry(() => context())
    registry.register({
      id: 'workbench.chord', title: 'Chord',
      defaultKeybindings: [{ id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }] }],
      run: chordRun,
    })
    registry.register({
      id: 'file.save', title: 'Save',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 's' }] }],
      run: saveRun,
    })
    const event = (key: string) => ({
      key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, isComposing: false, repeat: false, preventDefault: vi.fn(),
    })

    expect(dispatchWorkbenchShortcut(event('k'), registry)).toBe(true)
    registry.contextChanged()
    expect(registry.keybindings.store.getSnapshot().pending).toBeDefined()
    expect(dispatchWorkbenchShortcut(event('Control'), registry)).toBe(false)
    expect(registry.keybindings.store.getSnapshot().pending).toBeDefined()
    expect(dispatchWorkbenchShortcut(event('s'), registry)).toBe(true)
    await Promise.resolve()
    expect(chordRun).toHaveBeenCalledOnce()
    expect(saveRun).not.toHaveBeenCalled()
  })

  it('bridges only untouched built-in Palette defaults from a terminal capture listener', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry(() => context(), 'windows')
    registry.register({
      id: 'workbench.action.showCommands', title: 'Commands',
      defaultKeybindings: [
        { id: 'primary', sequence: [{ primary: true, shift: true, key: 'p' }] },
        { id: 'f1', sequence: [{ key: 'F1' }] },
      ],
      run,
    })
    registry.register({ id: 'workbench.other', title: 'Other', run: vi.fn() })
    const terminalTarget = { closest: () => ({}) } as unknown as EventTarget
    const event = (key: string, overrides: Record<string, unknown> = {}) => ({
      key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, isComposing: false, repeat: false,
      target: terminalTarget, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
    })

    const primary = event('P', { ctrlKey: true, shiftKey: true })
    expect(dispatchTerminalPaletteShortcut(primary, registry)).toBe(true)
    expect(primary.preventDefault).toHaveBeenCalledOnce()
    expect(primary.stopPropagation).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()

    const f1 = event('F1')
    expect(dispatchTerminalPaletteShortcut(f1, registry)).toBe(true)
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(2)
    await registry.keybindings.unbindDefault('workbench.action.showCommands', 'f1')
    const unboundF1 = event('F1')
    expect(dispatchTerminalPaletteShortcut(unboundF1, registry)).toBe(false)
    expect(unboundF1.preventDefault).not.toHaveBeenCalled()
    await registry.keybindings.addUserBinding({
      commandId: 'workbench.action.showCommands', sequence: [{ key: 'F1' }],
    })
    expect(dispatchTerminalPaletteShortcut(event('F1'), registry)).toBe(false)

    await registry.keybindings.addUserBinding({
      commandId: 'workbench.other', sequence: [{ primary: true, shift: true, key: 'p' }],
    })
    expect(dispatchTerminalPaletteShortcut(event('p', { ctrlKey: true, shiftKey: true }), registry)).toBe(false)
    expect(dispatchTerminalPaletteShortcut(event('k', { ctrlKey: true }), registry)).toBe(false)
    expect(dispatchTerminalPaletteShortcut(event('F1', { target: null }), registry)).toBe(false)

    const mac = new CommandRegistry(() => context(), 'mac')
    mac.register({
      id: 'workbench.action.showCommands', title: 'Commands',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, shift: true, key: 'p' }] }],
      run: vi.fn(),
    })
    expect(dispatchTerminalPaletteShortcut(event('p', { ctrlKey: false, metaKey: true, shiftKey: true }), mac)).toBe(true)
    expect(dispatchTerminalPaletteShortcut(event('p', { ctrlKey: true, metaKey: false, shiftKey: true }), mac)).toBe(false)
  })
})
