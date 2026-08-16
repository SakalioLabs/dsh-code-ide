import type { TerminalIdentity } from './session.ts'
import type {
  TerminalRuntimePort,
  TerminalSearchDirection,
  TerminalSearchRuntimeResult,
} from './runtime.ts'

export interface TerminalRuntimeLease {
  setVisible(visible: boolean): void
  focus(): void
  interrupt(): boolean
  terminate(): Promise<void>
  dispose(): void
}

interface RuntimeEntry {
  readonly runtime: TerminalRuntimePort
  readonly host: HTMLElement
  leases: number
  disposalEpoch: number
}

export type TerminalRuntimeFactory = (identity: TerminalIdentity) => TerminalRuntimePort
export type MicrotaskScheduler = (listener: () => void) => void

function identityKey(identity: TerminalIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.id, identity.lifecycleId])
}

/** Keeps PTY runtimes outside React effects and absorbs StrictMode effect replay. */
export class TerminalRuntimeRegistry {
  private readonly entries = new Map<string, RuntimeEntry>()

  constructor(
    private readonly factory: TerminalRuntimeFactory,
    private readonly scheduleMicrotask: MicrotaskScheduler = queueMicrotask,
  ) {}

  attach(identity: TerminalIdentity, host: HTMLElement, visible: boolean): TerminalRuntimeLease {
    const key = identityKey(identity)
    let entry = this.entries.get(key)
    if (entry !== undefined && entry.host !== host) {
      if (entry.leases > 0) throw new Error('Terminal runtime is already attached to another surface.')
      entry.runtime.dispose()
      this.entries.delete(key)
      entry = undefined
    }
    if (entry === undefined) {
      const runtime = this.factory(identity)
      entry = { runtime, host, leases: 0, disposalEpoch: 0 }
      this.entries.set(key, entry)
      try {
        runtime.mount(host, visible)
      } catch (error) {
        this.entries.delete(key)
        runtime.dispose()
        throw error
      }
    }
    entry.leases += 1
    entry.disposalEpoch += 1
    entry.runtime.setVisible(visible)
    let disposed = false

    return {
      setVisible: (nextVisible) => {
        if (!disposed && this.entries.get(key) === entry) entry.runtime.setVisible(nextVisible)
      },
      focus: () => {
        if (!disposed && this.entries.get(key) === entry) entry.runtime.focus()
      },
      interrupt: () => (
        !disposed && this.entries.get(key) === entry ? entry.runtime.interrupt() : false
      ),
      terminate: async () => {
        if (!disposed && this.entries.get(key) === entry) await entry.runtime.terminate()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.entries.get(key) !== entry) return
        entry.leases = Math.max(0, entry.leases - 1)
        const disposalEpoch = ++entry.disposalEpoch
        this.scheduleMicrotask(() => {
          if (this.entries.get(key) !== entry || entry.leases !== 0 || entry.disposalEpoch !== disposalEpoch) return
          this.entries.delete(key)
          entry.runtime.dispose()
        })
      },
    }
  }

  disposeIdentity(identity: TerminalIdentity): void {
    const key = identityKey(identity)
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    entry.runtime.dispose()
  }

  focusIdentity(identity: TerminalIdentity): void {
    this.entries.get(identityKey(identity))?.runtime.focus()
  }

  clearIdentity(identity: TerminalIdentity): boolean {
    return this.entries.get(identityKey(identity))?.runtime.clear() ?? false
  }

  searchIdentity(
    identity: TerminalIdentity,
    query: string,
    direction: TerminalSearchDirection,
  ): TerminalSearchRuntimeResult {
    return this.entries.get(identityKey(identity))?.runtime.search(query, direction) ?? 'unavailable'
  }

  clearSearchIdentity(identity: TerminalIdentity): boolean {
    return this.entries.get(identityKey(identity))?.runtime.clearSearch() ?? false
  }

  interruptIdentity(identity: TerminalIdentity): boolean {
    return this.entries.get(identityKey(identity))?.runtime.interrupt() ?? false
  }

  async terminateIdentity(identity: TerminalIdentity): Promise<void> {
    const entry = this.entries.get(identityKey(identity))
    if (entry === undefined) throw new Error('Terminal runtime is not available.')
    await entry.runtime.terminate()
  }

  disposeAll(): void {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) entry.runtime.dispose()
  }

  get size(): number { return this.entries.size }
}
