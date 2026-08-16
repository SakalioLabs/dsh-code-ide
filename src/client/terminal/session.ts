export type TerminalSessionStatus = 'connecting' | 'connected' | 'exited' | 'failed'

export interface TerminalSession {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly lifecycleId: number
  readonly status: TerminalSessionStatus
  readonly exitCode?: number
  readonly signal?: string
  readonly error?: string
}

export interface WorkspaceTerminalSession {
  readonly terminals: readonly TerminalSession[]
  readonly activeTerminalId?: string
  readonly initialized: boolean
}

export interface TerminalSessionsSnapshot {
  readonly workspaces: ReadonlyMap<string, WorkspaceTerminalSession>
}

export interface TerminalIdentity {
  readonly id: string
  readonly workspaceId: string
  readonly lifecycleId: number
}

type Listener = () => void

function withoutRuntimeResult(session: TerminalSession): TerminalSession {
  const { exitCode: _exitCode, signal: _signal, error: _error, ...identity } = session
  return identity
}

/** Desired terminal topology and lifecycle state; it owns no PTY or DOM resource. */
export class TerminalSessionStore {
  private snapshot: TerminalSessionsSnapshot = { workspaces: new Map() }
  private readonly listeners = new Set<Listener>()
  private readonly nameSequences = new Map<string, number>()
  private terminalSequence = 0
  private lifecycleSequence = 0

  constructor(readonly maxSessions = 8) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
      throw new Error('Terminal session limit must be a positive integer.')
    }
  }

  readonly getSnapshot = (): TerminalSessionsSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  workspace(workspaceId: string | undefined): WorkspaceTerminalSession {
    return workspaceId === undefined
      ? { terminals: [], initialized: false }
      : this.snapshot.workspaces.get(workspaceId) ?? { terminals: [], initialized: false }
  }

  allTerminals(): readonly TerminalSession[] {
    return [...this.snapshot.workspaces.values()].flatMap(workspace => workspace.terminals)
  }

  activeTerminal(workspaceId: string | undefined): TerminalSession | undefined {
    const workspace = this.workspace(workspaceId)
    return workspace.terminals.find(terminal => terminal.id === workspace.activeTerminalId)
  }

  ensureWorkspaceTerminal(workspaceId: string): TerminalSession | undefined {
    const workspace = this.workspace(workspaceId)
    const active = this.activeTerminal(workspaceId) ?? workspace.terminals[0]
    if (active !== undefined) {
      if (workspace.activeTerminalId !== active.id) this.activateTerminal(workspaceId, active.id)
      return active
    }
    if (workspace.initialized) return undefined
    return this.createTerminal(workspaceId)
  }

  createTerminal(workspaceId: string, requestedName?: string): TerminalSession | undefined {
    if (this.allTerminals().length >= this.maxSessions) return undefined
    const sequence = (this.nameSequences.get(workspaceId) ?? 0) + 1
    this.nameSequences.set(workspaceId, sequence)
    const fallbackName = `Terminal ${String(sequence)}`
    const name = this.validName(requestedName) ?? fallbackName
    const terminal: TerminalSession = {
      id: `terminal-${String(++this.terminalSequence)}`,
      workspaceId,
      name,
      lifecycleId: ++this.lifecycleSequence,
      status: 'connecting',
    }
    const workspace = this.workspace(workspaceId)
    this.replaceWorkspace(workspaceId, {
      terminals: [...workspace.terminals, terminal],
      activeTerminalId: terminal.id,
      initialized: true,
    })
    return terminal
  }

  activateTerminal(workspaceId: string, terminalId: string): boolean {
    const workspace = this.workspace(workspaceId)
    if (!workspace.terminals.some(terminal => terminal.id === terminalId)) return false
    if (workspace.activeTerminalId === terminalId) return true
    this.replaceWorkspace(workspaceId, { ...workspace, activeTerminalId: terminalId })
    return true
  }

  renameTerminal(workspaceId: string, terminalId: string, name: string): boolean {
    const valid = this.validName(name)
    if (valid === undefined) return false
    const current = this.workspace(workspaceId).terminals.find(terminal => terminal.id === terminalId)
    if (current === undefined) return false
    if (current.name === valid) return true
    return this.update(workspaceId, terminalId, undefined, terminal => (
      { ...terminal, name: valid }
    ))
  }

  restartTerminal(workspaceId: string, terminalId: string, expectedLifecycleId?: number): TerminalSession | undefined {
    let restarted: TerminalSession | undefined
    this.update(workspaceId, terminalId, expectedLifecycleId, (terminal) => {
      restarted = {
        ...withoutRuntimeResult(terminal),
        lifecycleId: ++this.lifecycleSequence,
        status: 'connecting',
      }
      return restarted
    })
    return restarted
  }

  closeTerminal(workspaceId: string, terminalId: string, expectedLifecycleId?: number): TerminalSession | undefined {
    const workspace = this.workspace(workspaceId)
    const index = workspace.terminals.findIndex(terminal => (
      terminal.id === terminalId
      && (expectedLifecycleId === undefined || terminal.lifecycleId === expectedLifecycleId)
    ))
    const removed = workspace.terminals[index]
    if (removed === undefined) return undefined
    const terminals = workspace.terminals.filter(terminal => terminal.id !== terminalId)
    const activeTerminalId = workspace.activeTerminalId === terminalId
      ? terminals[Math.min(index, Math.max(0, terminals.length - 1))]?.id
      : workspace.activeTerminalId
    this.replaceWorkspace(workspaceId, {
      terminals,
      initialized: true,
      ...(activeTerminalId === undefined ? {} : { activeTerminalId }),
    })
    return removed
  }

  markConnected(identity: TerminalIdentity): boolean {
    return this.update(identity.workspaceId, identity.id, identity.lifecycleId, terminal => ({
      ...withoutRuntimeResult(terminal),
      status: 'connected',
    }))
  }

  markExited(identity: TerminalIdentity, exitCode?: number, signal?: string): boolean {
    return this.update(identity.workspaceId, identity.id, identity.lifecycleId, terminal => ({
      ...withoutRuntimeResult(terminal),
      status: 'exited',
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(signal === undefined ? {} : { signal }),
    }))
  }

  noteError(identity: TerminalIdentity, message: string): boolean {
    return this.update(identity.workspaceId, identity.id, identity.lifecycleId, terminal => ({
      ...terminal,
      error: message,
    }))
  }

  markTransportClosed(identity: TerminalIdentity, message: string): boolean {
    return this.update(identity.workspaceId, identity.id, identity.lifecycleId, (terminal) => {
      if (terminal.status === 'exited') return terminal
      return {
        ...withoutRuntimeResult(terminal),
        status: 'failed',
        error: terminal.error ?? message,
      }
    })
  }

  private validName(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const trimmed = value.trim()
    return trimmed.length === 0 || trimmed.length > 64 || trimmed.includes('\0') ? undefined : trimmed
  }

  private update(
    workspaceId: string,
    terminalId: string,
    lifecycleId: number | undefined,
    transform: (terminal: TerminalSession) => TerminalSession,
  ): boolean {
    const workspace = this.workspace(workspaceId)
    let applied = false
    const terminals = workspace.terminals.map((terminal) => {
      if (terminal.id !== terminalId || (lifecycleId !== undefined && terminal.lifecycleId !== lifecycleId)) return terminal
      const next = transform(terminal)
      if (next !== terminal) applied = true
      return next
    })
    if (applied) this.replaceWorkspace(workspaceId, { ...workspace, terminals })
    return applied
  }

  private replaceWorkspace(workspaceId: string, workspace: WorkspaceTerminalSession): void {
    const workspaces = new Map(this.snapshot.workspaces)
    workspaces.set(workspaceId, workspace)
    this.snapshot = { workspaces }
    for (const listener of this.listeners) listener()
  }
}
