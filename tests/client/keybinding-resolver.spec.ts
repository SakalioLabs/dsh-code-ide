import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KeybindingController,
  detectKeybindingPlatform,
  formatKeybindingSequence,
  type DefaultKeybinding,
  type KeybindingPlatform,
  type ShortcutKeyboardEventLike,
} from '../../src/client/commands/keybindings.ts'

interface Context {
  mode: 'editor' | 'explorer'
  workspace: boolean
}

function keyboard(
  key: string,
  modifiers: Partial<Omit<ShortcutKeyboardEventLike, 'key'>> = {},
): ShortcutKeyboardEventLike {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

function controller(
  context: Context,
  platform: KeybindingPlatform = 'windows',
): KeybindingController<Context> {
  const active = new Set<string>()
  const value = new KeybindingController({
    platform,
    getContext: () => context,
    contextSchema: {
      mode: ['editor', 'explorer'],
      workspace: 'boolean',
    },
    isCommandActive: commandId => active.has(commandId),
    createId: (() => {
      let next = 0
      return () => `kb-test.${String(++next)}`
    })(),
  })
  const register = value.registerCommand.bind(value)
  value.registerCommand = (commandId, bindings, policy) => {
    active.add(commandId)
    const dispose = register(commandId, bindings, policy)
    value.contextChanged()
    return () => { active.delete(commandId); dispose() }
  }
  return value
}

function defaults(...bindings: DefaultKeybinding[]): readonly DefaultKeybinding[] {
  return bindings
}

afterEach(() => { vi.useRealTimers() })

describe('KeybindingController', () => {
  it('detects macOS, Windows and Linux as distinct browser platforms', () => {
    expect(detectKeybindingPlatform({ platform: 'MacIntel', userAgent: 'Browser' })).toBe('mac')
    expect(detectKeybindingPlatform({ platform: 'Win32', userAgent: 'Browser' })).toBe('windows')
    expect(detectKeybindingPlatform({ platform: 'Linux x86_64', userAgent: 'Browser' })).toBe('linux')
  })

  it('expands primary on all three platforms and publishes stable deeply frozen snapshots', () => {
    const context: Context = { mode: 'editor', workspace: true }
    for (const [platform, expected] of [
      ['windows', 'Ctrl+P'],
      ['linux', 'Ctrl+P'],
      ['mac', '鈱?'],
    ] as const) {
      const shortcuts = controller(context, platform)
      shortcuts.registerCommand('workbench.open', defaults({
        id: 'primary', sequence: [{ primary: true, key: 'p' }],
      }), 'allow')
      const first = shortcuts.store.getSnapshot()
      expect(shortcuts.store.getSnapshot()).toBe(first)
      expect(first.commands[0]?.effectiveBindings[0]?.label).toBe(expected === '鈱?' ? formatKeybindingSequence([{ primary: true, key: 'p' }], 'mac') : expected)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.commands)).toBe(true)
      expect(() => { (first.commands as unknown as unknown[]).push('mutate') }).toThrow()
      shortcuts.dispose()
    }
  })

  it('applies user over default, reports equal user conflicts, unbinds and resets defaults', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.first', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'p' }],
    }), 'allow')
    shortcuts.registerCommand('workbench.second', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'b' }],
    }), 'allow')
    shortcuts.registerCommand('workbench.third', [], 'allow')

    expect(shortcuts.commandForKeyboardEvent(keyboard('p', { ctrlKey: true }))).toBe('workbench.first')
    await expect(shortcuts.addUserBinding({
      commandId: 'workbench.second', sequence: [{ primary: true, key: 'p' }],
    })).resolves.toEqual({ status: 'saved' })
    expect(shortcuts.commandForKeyboardEvent(keyboard('p', { ctrlKey: true }))).toBe('workbench.second')
    expect(shortcuts.bindingsForCommand('workbench.first')?.effectiveBindings[0]?.state).toBe('shadowed')

    await shortcuts.addUserBinding({
      commandId: 'workbench.third', sequence: [{ primary: true, key: 'p' }],
    })
    const conflict = shortcuts.acceptKeyboardEvent(keyboard('p', { ctrlKey: true }))
    expect(conflict).toMatchObject({ kind: 'conflict', consume: true, conflict: { kind: 'exact' } })
    expect(shortcuts.commandForKeyboardEvent(keyboard('p', { ctrlKey: true }))).toBeUndefined()

    const thirdId = shortcuts.bindingsForCommand('workbench.third')?.userBindings[0]?.id
    expect(thirdId).toBeDefined()
    await shortcuts.removeUserBinding(thirdId ?? '')
    expect(shortcuts.commandForKeyboardEvent(keyboard('p', { ctrlKey: true }))).toBe('workbench.second')

    await shortcuts.unbindDefault('workbench.first', 'primary')
    expect(shortcuts.bindingsForCommand('workbench.first')?.state).toBe('unbound')
    await shortcuts.resetCommand('workbench.first')
    expect(shortcuts.bindingsForCommand('workbench.first')?.state).toBe('default')
    shortcuts.dispose()
  })

  it('atomically replaces one default and previews platform-normalized exact and prefix matches', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.open', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'p' }],
    }), 'allow')
    shortcuts.registerCommand('workbench.chord', defaults({
      id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
    }), 'allow')

    const exact = shortcuts.previewUserBinding({
      commandId: 'workbench.open', sequence: [{ primary: true, key: 'p' }],
    })
    expect(exact).toMatchObject({ label: 'Ctrl+P', signature: 'ctrl+p', firstStrokeSignature: 'ctrl+p' })
    expect(exact.exactMatches.map(binding => binding.commandId)).toEqual(['workbench.open'])
    expect(exact.prefixMatches).toEqual([])
    const prefix = shortcuts.previewUserBinding({
      commandId: 'workbench.open', sequence: [{ primary: true, key: 'k' }],
    })
    expect(prefix.prefixMatches.map(binding => binding.commandId)).toEqual(['workbench.chord'])

    await expect(shortcuts.replaceDefaultBinding('workbench.open', 'primary', {
      commandId: 'workbench.open', sequence: [{ primary: true, key: 'o' }],
    })).resolves.toEqual({ status: 'saved' })
    expect(shortcuts.bindingsForCommand('workbench.open')).toMatchObject({
      state: 'customized', userBindings: [{ commandId: 'workbench.open' }],
    })
    expect(shortcuts.commandForKeyboardEvent(keyboard('p', { ctrlKey: true }))).toBeUndefined()
    expect(shortcuts.commandForKeyboardEvent(keyboard('o', { ctrlKey: true }))).toBe('workbench.open')
    shortcuts.dispose()
  })

  it('uses allowlisted contexts and strict implication without registration-order winners', () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.broad', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'm' }],
      when: [{ key: 'workspace', equals: true }],
    }), 'allow')
    shortcuts.registerCommand('workbench.editor', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'm' }],
      when: [{ key: 'mode', equals: 'editor' }, { key: 'workspace', equals: true }],
    }), 'allow')
    shortcuts.registerCommand('workbench.explorer', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'm' }],
      when: [{ key: 'mode', equals: 'explorer' }, { key: 'workspace', equals: true }],
    }), 'allow')

    expect(shortcuts.commandForKeyboardEvent(keyboard('m', { ctrlKey: true }))).toBe('workbench.editor')
    context.mode = 'explorer'
    shortcuts.contextChanged()
    expect(shortcuts.commandForKeyboardEvent(keyboard('m', { ctrlKey: true }))).toBe('workbench.explorer')
    expect(() => shortcuts.registerCommand('workbench.invalid', defaults({
      id: 'bad', sequence: [{ primary: true, key: 'i' }], when: [{ key: 'unknown', equals: true }],
    }), 'allow')).toThrow(/unknown/u)
    expect(() => shortcuts.registerCommand('workbench.dead', defaults({
      id: 'dead', sequence: [{ primary: true, key: 'Dead' }],
    }), 'allow')).toThrow(/dead|composing/u)
    shortcuts.dispose()
  })

  it('runs a two-stroke chord, preserves a still-valid prefix across context refresh, and fences invalid or expired state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.keys', defaults({
      id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
      when: [{ key: 'workspace', equals: true }],
    }), 'allow')

    expect(shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))).toMatchObject({ kind: 'pending', consume: true })
    expect(shortcuts.store.getSnapshot().pending?.expiresAt).toBe(2_000)
    expect(shortcuts.acceptKeyboardEvent(keyboard('Control', { ctrlKey: true }))).toEqual({ kind: 'none', consume: false })
    expect(shortcuts.store.getSnapshot().pending).toBeDefined()
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toMatchObject({
      kind: 'execute', commandId: 'workbench.keys', bindingId: 'primaryChord',
    })

    shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    expect(shortcuts.acceptKeyboardEvent(keyboard('x', { ctrlKey: true }))).toEqual({ kind: 'none', consume: false })
    expect(shortcuts.store.getSnapshot().pending).toBeUndefined()

    shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    context.mode = 'explorer'
    shortcuts.contextChanged()
    expect(shortcuts.store.getSnapshot().pending).toBeDefined()
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toMatchObject({
      kind: 'execute', commandId: 'workbench.keys', bindingId: 'primaryChord',
    })

    shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    context.workspace = false
    shortcuts.contextChanged()
    expect(shortcuts.store.getSnapshot().pending).toBeUndefined()
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toEqual({ kind: 'none', consume: false })

    context.workspace = true
    shortcuts.contextChanged()
    shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    shortcuts.cancelPendingChord()
    expect(shortcuts.store.getSnapshot().pending).toBeUndefined()
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toEqual({ kind: 'none', consume: false })

    shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    vi.advanceTimersByTime(1_000)
    expect(shortcuts.store.getSnapshot().pending).toBeUndefined()
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toEqual({ kind: 'none', consume: false })
    shortcuts.dispose()
  })

  it('fails closed for prefix conflicts and lets a user chord shadow a default single stroke', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.single', defaults({
      id: 'primary', sequence: [{ primary: true, key: 'k' }],
    }), 'allow')
    shortcuts.registerCommand('workbench.chord', defaults({
      id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
    }), 'allow')
    expect(shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))).toMatchObject({
      kind: 'conflict', conflict: { kind: 'prefix' },
    })

    await shortcuts.addUserBinding({
      commandId: 'workbench.chord',
      sequence: [{ primary: true, key: 'k' }, { primary: true, key: 'x' }],
    })
    expect(shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))).toMatchObject({ kind: 'pending' })
    expect(shortcuts.acceptKeyboardEvent(keyboard('x', { ctrlKey: true }))).toMatchObject({
      kind: 'execute', commandId: 'workbench.chord',
    })
    shortcuts.dispose()
  })

  it('removes stale exact conflicts when prefix precedence shadows every exact candidate', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    const chord = defaults({
      id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
    })
    shortcuts.registerCommand('workbench.chordFirst', chord, 'allow')
    shortcuts.registerCommand('workbench.chordSecond', chord, 'allow')
    shortcuts.registerCommand('workbench.single', [], 'allow')

    expect(shortcuts.store.getSnapshot().conflicts).toMatchObject([{
      kind: 'exact', commandIds: ['workbench.chordFirst', 'workbench.chordSecond'],
    }])
    expect(shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))).toMatchObject({ kind: 'pending' })
    expect(shortcuts.acceptKeyboardEvent(keyboard('s', { ctrlKey: true }))).toMatchObject({
      kind: 'conflict', consume: true, conflict: { kind: 'exact' },
    })

    await shortcuts.addUserBinding({
      commandId: 'workbench.single', sequence: [{ primary: true, key: 'k' }],
    })

    expect(shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))).toMatchObject({
      kind: 'execute', commandId: 'workbench.single', source: 'user',
    })
    expect(shortcuts.bindingsForCommand('workbench.chordFirst')?.effectiveBindings[0]?.state).toBe('shadowed')
    expect(shortcuts.bindingsForCommand('workbench.chordSecond')?.effectiveBindings[0]?.state).toBe('shadowed')
    expect(shortcuts.store.getSnapshot().conflicts).toEqual([])
    expect(shortcuts.bindingsForCommand('workbench.chordFirst')?.conflicts).toEqual([])
    expect(shortcuts.bindingsForCommand('workbench.chordSecond')?.conflicts).toEqual([])
    shortcuts.dispose()
  })

  it('reports only preferred user candidates in a genuine prefix conflict', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    shortcuts.registerCommand('workbench.defaultChord', defaults({
      id: 'primaryChord', sequence: [{ primary: true, key: 'k' }, { primary: true, key: 's' }],
    }), 'allow')
    shortcuts.registerCommand('workbench.userSingle', [], 'allow')
    shortcuts.registerCommand('workbench.userChord', [], 'allow')

    await shortcuts.addUserBinding({
      commandId: 'workbench.userSingle', sequence: [{ primary: true, key: 'k' }],
    })
    await shortcuts.addUserBinding({
      commandId: 'workbench.userChord',
      sequence: [{ primary: true, key: 'k' }, { primary: true, key: 'x' }],
    })

    const decision = shortcuts.acceptKeyboardEvent(keyboard('k', { ctrlKey: true }))
    expect(decision).toMatchObject({
      kind: 'conflict', consume: true,
      conflict: {
        kind: 'prefix',
        commandIds: ['workbench.userChord', 'workbench.userSingle'],
      },
    })
    const prefix = shortcuts.store.getSnapshot().conflicts.find(conflict => conflict.kind === 'prefix')
    expect(prefix?.candidateIds).toHaveLength(2)
    expect(prefix?.candidateIds.every(candidateId => candidateId.startsWith('user:'))).toBe(true)
    expect(shortcuts.bindingsForCommand('workbench.defaultChord')?.effectiveBindings[0]?.state).toBe('shadowed')
    expect(shortcuts.bindingsForCommand('workbench.defaultChord')?.conflicts).toEqual([])
    shortcuts.dispose()
  })

  it('retains orphan preferences across disposal and stricter policy replacement', async () => {
    const context: Context = { mode: 'editor', workspace: true }
    const shortcuts = controller(context)
    const disposeChanging = shortcuts.registerCommand('workbench.changing', [], 'allow')
    shortcuts.registerCommand('workbench.other', [], 'allow')
    await shortcuts.addUserBinding({
      commandId: 'workbench.changing', sequence: [{ alt: true, key: 'j' }],
    })
    await shortcuts.addUserBinding({
      commandId: 'workbench.other', sequence: [{ primary: true, key: 'o' }],
    })
    disposeChanging()
    expect(shortcuts.bindingsForCommand('workbench.changing')?.userBindings).toHaveLength(1)
    expect(shortcuts.bindingsForCommand('workbench.other')?.userBindings).toHaveLength(1)

    const disposeDenied = shortcuts.registerCommand('workbench.changing', [], 'none')
    expect(shortcuts.bindingsForCommand('workbench.changing')?.effectiveBindings[0]?.state).toBe('inactive')
    expect(shortcuts.commandForKeyboardEvent(keyboard('o', { ctrlKey: true }))).toBe('workbench.other')
    disposeDenied()
    const disposeModified = shortcuts.registerCommand('workbench.changing', [], 'modified-only')
    expect(shortcuts.bindingsForCommand('workbench.changing')?.effectiveBindings[0]?.state).toBe('inactive')
    expect(shortcuts.commandForKeyboardEvent(keyboard('j', { altKey: true }))).toBeUndefined()
    expect(shortcuts.bindingsForCommand('workbench.other')?.userBindings).toHaveLength(1)
    disposeModified()
    shortcuts.registerCommand('workbench.changing', [], 'allow')
    expect(shortcuts.commandForKeyboardEvent(keyboard('j', { altKey: true }))).toBe('workbench.changing')
    shortcuts.dispose()
  })
})
