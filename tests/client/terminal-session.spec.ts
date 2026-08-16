import { describe, expect, it, vi } from 'vitest'
import { terminalCommandSnapshot } from '../../src/client/TerminalPane.tsx'
import { TerminalSessionStore } from '../../src/client/terminal/session.ts'

describe('TerminalSessionStore', () => {
  it('initializes a workspace once and does not resurrect its last killed terminal', () => {
    const store = new TerminalSessionStore()
    const first = store.ensureWorkspaceTerminal('workspace')!

    expect(store.ensureWorkspaceTerminal('workspace')).toBe(first)
    expect(store.workspace('workspace').terminals).toHaveLength(1)
    expect(store.closeTerminal('workspace', first.id)).toBe(first)
    expect(store.ensureWorkspaceTerminal('workspace')).toBeUndefined()
    expect(store.workspace('workspace')).toMatchObject({ terminals: [], initialized: true })
  })

  it('keeps independent active sessions while switching workspaces', () => {
    const store = new TerminalSessionStore()
    const first = store.createTerminal('workspace-a')!
    const second = store.createTerminal('workspace-a')!
    const other = store.createTerminal('workspace-b')!
    store.activateTerminal('workspace-a', first.id)

    expect(store.activeTerminal('workspace-a')).toBe(first)
    expect(store.activeTerminal('workspace-b')).toBe(other)
    expect(store.workspace('workspace-a').terminals).toEqual([first, second])
  })

  it('enforces a global client limit across background workspaces', () => {
    const store = new TerminalSessionStore(2)
    expect(terminalCommandSnapshot(store, 'workspace-a', 4)).toEqual({
      workspaceId: 'workspace-a', workspaceEpoch: 4, canCreate: true, canNavigate: false,
    })
    const first = store.createTerminal('workspace-a')!
    expect(store.createTerminal('workspace-b')).toBeDefined()
    expect(terminalCommandSnapshot(store, 'workspace-a', 4)).toEqual({
      workspaceId: 'workspace-a',
      workspaceEpoch: 4,
      active: {
        workspaceId: 'workspace-a', workspaceEpoch: 4, id: first.id, lifecycleId: first.lifecycleId,
      },
      canCreate: false,
      canNavigate: false,
    })
    expect(terminalCommandSnapshot(store, undefined, 4)).toEqual({ canCreate: false, canNavigate: false })
    expect(store.createTerminal('workspace-a')).toBeUndefined()
    expect(store.allTerminals()).toHaveLength(2)
  })

  it('chooses the adjacent terminal deterministically when closing the active tab', () => {
    const store = new TerminalSessionStore()
    const first = store.createTerminal('workspace')!
    const second = store.createTerminal('workspace')!
    const third = store.createTerminal('workspace')!

    store.activateTerminal('workspace', second.id)
    store.closeTerminal('workspace', second.id)
    expect(store.activeTerminal('workspace')).toBe(third)
    store.closeTerminal('workspace', third.id)
    expect(store.activeTerminal('workspace')).toBe(first)
  })

  it('uses a new lifecycle for restart and rejects every late event from the old runtime', () => {
    const store = new TerminalSessionStore()
    const original = store.createTerminal('workspace')!
    store.markConnected(original)
    const restarted = store.restartTerminal('workspace', original.id)!

    expect(restarted).toMatchObject({ id: original.id, name: original.name, status: 'connecting' })
    expect(restarted.lifecycleId).toBeGreaterThan(original.lifecycleId)
    expect(store.markExited(original, 99)).toBe(false)
    expect(store.markTransportClosed(original, 'late close')).toBe(false)
    expect(store.markConnected(restarted)).toBe(true)
    expect(store.activeTerminal('workspace')?.status).toBe('connected')
  })

  it('keeps process exit authoritative over the following transport close', () => {
    const store = new TerminalSessionStore()
    const terminal = store.createTerminal('workspace')!
    store.markConnected(terminal)
    store.markExited(terminal, 7, 'SIGTERM')

    expect(store.markTransportClosed(terminal, 'socket closed')).toBe(false)
    expect(store.activeTerminal('workspace')).toMatchObject({ status: 'exited', exitCode: 7, signal: 'SIGTERM' })
  })

  it('retains the useful protocol error when the socket subsequently closes', () => {
    const store = new TerminalSessionStore()
    const terminal = store.createTerminal('workspace')!
    store.noteError(terminal, 'Failed to start the terminal.')
    store.markTransportClosed(terminal, 'Terminal connection closed (1006).')

    expect(store.activeTerminal('workspace')).toMatchObject({
      status: 'failed',
      error: 'Failed to start the terminal.',
    })
  })

  it('validates names without changing runtime identity and publishes stable snapshots', () => {
    const store = new TerminalSessionStore()
    const terminal = store.createTerminal('workspace')!
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    expect(store.renameTerminal('workspace', terminal.id, '  Build  ')).toBe(true)
    expect(store.activeTerminal('workspace')).toMatchObject({ name: 'Build', lifecycleId: terminal.lifecycleId })
    expect(store.renameTerminal('workspace', terminal.id, '   ')).toBe(false)
    unsubscribe()
    store.createTerminal('workspace')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
