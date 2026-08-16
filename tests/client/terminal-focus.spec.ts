import { describe, expect, it, vi } from 'vitest'
import {
  activateRelativeTerminalCommand,
  applyTerminalFocusRequest,
  clearActiveTerminalCommand,
  clearActiveTerminalSearch,
  searchActiveTerminalCommand,
  terminalSearchKeyboardAction,
  type TerminalCommandTarget,
  type TerminalFocusRequest,
} from '../../src/client/TerminalPane.tsx'
import { TerminalSessionStore } from '../../src/client/terminal/session.ts'

const commandTarget = (overrides: Partial<TerminalCommandTarget> = {}): TerminalCommandTarget => ({
  workspaceId: 'workspace',
  workspaceEpoch: 7,
  id: 'terminal-1',
  lifecycleId: 11,
  ...overrides,
})

const request = (
  requestId: number,
  overrides: Partial<TerminalCommandTarget> = {},
): TerminalFocusRequest => ({ requestId, ...commandTarget(overrides) })

describe('terminal focus requests', () => {
  it('focuses and acknowledges each newer request once on an exact visible active lease', () => {
    const lease = { focus: vi.fn() }
    const acknowledge = vi.fn()
    const target = { ...commandTarget(), active: true, visible: true }

    let applied = applyTerminalFocusRequest(request(2), target, lease, undefined, acknowledge)
    expect(applied).toBe(2)
    expect(lease.focus).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledWith(2)

    applied = applyTerminalFocusRequest(request(2), target, lease, applied, acknowledge)
    applied = applyTerminalFocusRequest(request(1), target, lease, applied, acknowledge)
    expect(applied).toBe(2)
    expect(lease.focus).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledOnce()

    applied = applyTerminalFocusRequest(request(3), target, lease, applied, acknowledge)
    expect(applied).toBe(3)
    expect(lease.focus).toHaveBeenCalledTimes(2)
    expect(acknowledge).toHaveBeenLastCalledWith(3)
  })

  it.each([
    ['workspace', { workspaceId: 'other-workspace' }],
    ['workspace epoch', { workspaceEpoch: 8 }],
    ['terminal id', { id: 'terminal-2' }],
    ['terminal lifecycle', { lifecycleId: 12 }],
  ] as const)('lets only the active surface acknowledge a stale %s request', (_label, overrides) => {
    const lease = { focus: vi.fn() }
    const acknowledge = vi.fn()
    const focusRequest = request(4, overrides)

    expect(applyTerminalFocusRequest(
      focusRequest,
      { ...commandTarget(), active: false, visible: true },
      lease,
      undefined,
      acknowledge,
    )).toBeUndefined()
    expect(acknowledge).not.toHaveBeenCalled()

    expect(applyTerminalFocusRequest(
      focusRequest,
      { ...commandTarget(), active: true, visible: false },
      undefined,
      undefined,
      acknowledge,
    )).toBe(4)
    expect(lease.focus).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledWith(4)
  })

  it.each([
    ['hidden pane', false, { focus: vi.fn() }],
    ['unmounted lease', true, undefined],
  ] as const)('retains an exact request for a temporarily %s', (_label, visible, lease) => {
    const acknowledge = vi.fn()
    expect(applyTerminalFocusRequest(
      request(5),
      { ...commandTarget(), active: true, visible },
      lease,
      undefined,
      acknowledge,
    )).toBeUndefined()
    if (lease !== undefined) expect(lease.focus).not.toHaveBeenCalled()
    expect(acknowledge).not.toHaveBeenCalled()
  })
})

describe('terminal command navigation', () => {
  it('wraps in authoritative workspace order and rejects stale publication, selection, and source identities', () => {
    const store = new TerminalSessionStore()
    const first = store.createTerminal('workspace')!
    store.createTerminal('workspace')
    const third = store.createTerminal('workspace')!
    const publication = { workspaceId: 'workspace', workspaceEpoch: 7 }
    const source = { ...publication, id: third.id, lifecycleId: third.lifecycleId }

    const wrappedNext = activateRelativeTerminalCommand(store, publication, publication, source, 1)
    expect(wrappedNext).toEqual({ ...publication, id: first.id, lifecycleId: first.lifecycleId })
    expect(store.activeTerminal('workspace')).toBe(first)

    const wrappedPrevious = activateRelativeTerminalCommand(store, publication, publication, wrappedNext!, -1)
    expect(wrappedPrevious).toEqual(source)
    expect(store.activeTerminal('workspace')).toBe(third)

    expect(activateRelativeTerminalCommand(
      store,
      { ...publication, workspaceEpoch: 6 },
      publication,
      source,
      1,
    )).toBeUndefined()
    expect(activateRelativeTerminalCommand(
      store,
      publication,
      { ...publication, workspaceEpoch: 8 },
      source,
      1,
    )).toBeUndefined()

    const restarted = store.restartTerminal('workspace', third.id, third.lifecycleId)!
    expect(activateRelativeTerminalCommand(store, publication, publication, source, 1)).toBeUndefined()
    expect(store.activeTerminal('workspace')).toBe(restarted)

    const single = store.createTerminal('single-workspace')!
    const singlePublication = { workspaceId: single.workspaceId, workspaceEpoch: 9 }
    expect(activateRelativeTerminalCommand(store, singlePublication, singlePublication, {
      ...singlePublication,
      id: single.id,
      lifecycleId: single.lifecycleId,
    }, 1)).toBeUndefined()
  })
})

describe('terminal command clear', () => {
  it('clears only the exact active lifecycle and reports stale or unavailable without session mutation', () => {
    const store = new TerminalSessionStore()
    const first = store.createTerminal('workspace')!
    const second = store.createTerminal('workspace')!
    store.activateTerminal('workspace', first.id)
    const publication = { workspaceId: 'workspace', workspaceEpoch: 7 }
    let selected = publication
    const target = { ...publication, id: first.id, lifecycleId: first.lifecycleId }
    const clearIdentity = vi.fn(() => true)

    expect(clearActiveTerminalCommand(store, { clearIdentity }, publication, () => selected, target)).toBe('cleared')
    expect(clearIdentity).toHaveBeenCalledWith({
      workspaceId: 'workspace', id: first.id, lifecycleId: first.lifecycleId,
    })
    expect(store.activeTerminal('workspace')).toBe(first)

    expect(clearActiveTerminalCommand(store, { clearIdentity }, publication, () => selected, {
      ...target,
      lifecycleId: target.lifecycleId + 1,
    })).toBe('stale')
    selected = { ...publication, workspaceEpoch: 8 }
    expect(clearActiveTerminalCommand(store, { clearIdentity }, publication, () => selected, target)).toBe('stale')
    expect(clearIdentity).toHaveBeenCalledOnce()

    selected = publication
    clearIdentity.mockReturnValueOnce(false)
    expect(clearActiveTerminalCommand(store, { clearIdentity }, publication, () => selected, target)).toBe('unavailable')
    expect(store.activeTerminal('workspace')).toBe(first)

    clearIdentity.mockImplementationOnce(() => {
      store.activateTerminal('workspace', second.id)
      return true
    })
    expect(clearActiveTerminalCommand(store, { clearIdentity }, publication, () => selected, target)).toBe('stale')
    expect(store.activeTerminal('workspace')).toBe(second)
  })
})

describe('terminal search', () => {
  it('maps Enter, Shift+Enter, and Escape without intercepting composition', () => {
    expect(terminalSearchKeyboardAction('Enter')).toBe('next')
    expect(terminalSearchKeyboardAction('Enter', true)).toBe('previous')
    expect(terminalSearchKeyboardAction('Escape')).toBe('close')
    expect(terminalSearchKeyboardAction('Enter', false, true)).toBe('none')
    expect(terminalSearchKeyboardAction('ArrowDown')).toBe('none')
  })

  it('searches and clears only the exact active workspace epoch and terminal lifecycle', () => {
    const store = new TerminalSessionStore()
    const first = store.createTerminal('workspace')!
    const second = store.createTerminal('workspace')!
    store.activateTerminal('workspace', first.id)
    const publication = { workspaceId: 'workspace', workspaceEpoch: 7 }
    let selected = publication
    const target = { ...publication, id: first.id, lifecycleId: first.lifecycleId }
    const searchIdentity = vi.fn(() => 'found' as const)
    const clearSearchIdentity = vi.fn(() => true)

    expect(searchActiveTerminalCommand(
      store, { searchIdentity }, publication, () => selected, target, 'needle', 'next',
    )).toBe('found')
    expect(searchIdentity).toHaveBeenCalledWith(
      { workspaceId: 'workspace', id: first.id, lifecycleId: first.lifecycleId },
      'needle',
      'next',
    )
    searchIdentity.mockReturnValueOnce('not-found')
    expect(searchActiveTerminalCommand(
      store, { searchIdentity }, publication, () => selected, target, 'needle', 'previous',
    )).toBe('not-found')

    selected = { ...publication, workspaceEpoch: 8 }
    expect(searchActiveTerminalCommand(
      store, { searchIdentity }, publication, () => selected, target, 'needle', 'next',
    )).toBe('stale')
    expect(searchIdentity).toHaveBeenCalledTimes(2)

    selected = publication
    searchIdentity.mockImplementationOnce(() => {
      store.activateTerminal('workspace', second.id)
      return 'found'
    })
    expect(searchActiveTerminalCommand(
      store, { searchIdentity }, publication, () => selected, target, 'needle', 'next',
    )).toBe('stale')
    expect(store.activeTerminal('workspace')).toBe(second)

    store.activateTerminal('workspace', first.id)
    expect(clearActiveTerminalSearch(
      store, { clearSearchIdentity }, publication, () => selected, target,
    )).toBe('cleared')
    expect(clearSearchIdentity).toHaveBeenCalledWith({
      workspaceId: 'workspace', id: first.id, lifecycleId: first.lifecycleId,
    })
    clearSearchIdentity.mockReturnValueOnce(false)
    expect(clearActiveTerminalSearch(
      store, { clearSearchIdentity }, publication, () => selected, target,
    )).toBe('unavailable')

    const restarted = store.restartTerminal('workspace', first.id, first.lifecycleId)!
    expect(searchActiveTerminalCommand(
      store, { searchIdentity }, publication, () => selected, target, 'needle', 'next',
    )).toBe('stale')
    expect(clearActiveTerminalSearch(
      store, { clearSearchIdentity }, publication, () => selected, target,
    )).toBe('stale')
    expect(store.activeTerminal('workspace')).toBe(restarted)
    expect(searchIdentity).toHaveBeenCalledTimes(3)
    expect(clearSearchIdentity).toHaveBeenCalledTimes(2)
  })
})
