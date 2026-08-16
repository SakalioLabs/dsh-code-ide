import type { TerminalClientMessage, TerminalServerMessage } from '../contracts.ts'
import type { TerminalIdentity } from './session.ts'

export interface TerminalDisposable {
  dispose(): void
}

export interface TerminalEmulatorPort {
  readonly cols: number
  readonly rows: number
  open(host: HTMLElement): void
  fit(): void
  focus(): void
  clear(): void
  search(query: string, direction: TerminalSearchDirection): boolean
  clearSearch(): void
  write(data: string): void
  onData(listener: (data: string) => void): TerminalDisposable
  dispose(): void
}

export interface TerminalSocketClose {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

export interface TerminalSocketPort {
  close(): void
  send(message: TerminalClientMessage): boolean
}

export interface TerminalSocketOptions {
  readonly workspaceId: string
  readonly cols: number
  readonly rows: number
  readonly onOpen: () => void
  readonly onClose: (details: TerminalSocketClose) => void
  readonly onError: (message: string) => void
  readonly onMessage: (message: TerminalServerMessage) => void
}

export interface TerminalRuntimeEnvironment {
  createSurface(): HTMLElement
  createEmulator(): TerminalEmulatorPort
  attachSurface(surface: HTMLElement, host: HTMLElement): void
  detachSurface(surface: HTMLElement): void
  openSocket(options: TerminalSocketOptions): TerminalSocketPort
  observeResize(host: HTMLElement, listener: () => void): TerminalDisposable
  scheduleFrame(listener: () => void): TerminalDisposable
}

export interface TerminalRuntimeEvents {
  onConnected(identity: TerminalIdentity): void
  onExited(identity: TerminalIdentity, code?: number, signal?: string): void
  onError(identity: TerminalIdentity, message: string): void
  onTransportClosed(identity: TerminalIdentity, message: string): void
}

export interface TerminalRuntimePort {
  mount(host: HTMLElement, visible: boolean): void
  setVisible(visible: boolean): void
  focus(): void
  clear(): boolean
  search(query: string, direction: TerminalSearchDirection): TerminalSearchRuntimeResult
  clearSearch(): boolean
  interrupt(): boolean
  terminate(): Promise<void>
  dispose(): void
}

const MAX_PENDING_INPUT_UNITS = 64 * 1024
export const MAX_TERMINAL_SEARCH_QUERY_UNITS = 1_024

export type TerminalSearchDirection = 'next' | 'previous'
export type TerminalSearchRuntimeResult = 'found' | 'not-found' | 'invalid' | 'unavailable'

function dimensions(emulator: TerminalEmulatorPort): { cols: number; rows: number } {
  return {
    cols: Number.isSafeInteger(emulator.cols) && emulator.cols >= 2 ? Math.min(500, emulator.cols) : 80,
    rows: Number.isSafeInteger(emulator.rows) && emulator.rows >= 2 ? Math.min(300, emulator.rows) : 24,
  }
}

function closeMessage(details: TerminalSocketClose): string {
  if (details.reason.trim().length > 0) return details.reason
  return details.code === 1000 ? 'Terminal connection closed.' : `Terminal connection closed (${String(details.code)}).`
}

/** Owns one emulator + one transport, independent from React rendering. */
export class TerminalRuntime implements TerminalRuntimePort {
  private emulator: TerminalEmulatorPort | undefined
  private surface: HTMLElement | undefined
  private host: HTMLElement | undefined
  private socket: TerminalSocketPort | undefined
  private inputSubscription: TerminalDisposable | undefined
  private resizeSubscription: TerminalDisposable | undefined
  private scheduledFit: TerminalDisposable | undefined
  private readonly pendingInput: string[] = []
  private pendingInputUnits = 0
  private mounted = false
  private visible = false
  private connected = false
  private exited = false
  private disposed = false
  private inputOverflowReported = false
  private lastSentDimensions: string | undefined
  private terminating = false
  private transportClosed = false
  private terminationPromise: Promise<void> | undefined
  private resolveTermination: (() => void) | undefined

  constructor(
    readonly identity: TerminalIdentity,
    private readonly environment: TerminalRuntimeEnvironment,
    private readonly events: TerminalRuntimeEvents,
  ) {}

  mount(host: HTMLElement, visible: boolean): void {
    if (this.disposed) throw new Error('Cannot mount a disposed terminal runtime.')
    if (this.mounted) throw new Error('Terminal runtime is already mounted.')
    this.mounted = true
    this.visible = visible

    const surface = this.environment.createSurface()
    const emulator = this.environment.createEmulator()
    this.surface = surface
    this.host = host
    this.emulator = emulator
    if (visible) this.environment.attachSurface(surface, host)
    emulator.open(surface)
    if (visible) this.fit(false)
    this.inputSubscription = emulator.onData(data => { this.acceptInput(data) })
    if (visible) this.observeHost()

    let openedDuringCreation = false
    const initialDimensions = dimensions(emulator)
    this.lastSentDimensions = `${String(initialDimensions.cols)}x${String(initialDimensions.rows)}`
    const socket = this.environment.openSocket({
      workspaceId: this.identity.workspaceId,
      ...initialDimensions,
      onOpen: () => {
        if (this.disposed) return
        openedDuringCreation = true
        if (this.terminating) {
          if (this.socket !== undefined) this.requestClose()
          return
        }
        this.connected = true
        this.events.onConnected(this.identity)
        if (this.socket !== undefined) this.afterConnected()
      },
      onClose: details => {
        if (this.disposed) return
        this.transportClosed = true
        if (this.terminating) {
          this.settleTermination()
          return
        }
        if (this.exited) return
        this.connected = false
        this.events.onTransportClosed(this.identity, closeMessage(details))
      },
      onError: message => {
        if (this.disposed) return
        this.reportError(message)
      },
      onMessage: message => { this.acceptMessage(message) },
    })
    this.socket = socket
    if (openedDuringCreation) this.afterConnected()
    if (visible) this.scheduleFit()
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    const surface = this.surface
    const host = this.host
    if (!visible) {
      this.scheduledFit?.dispose()
      this.scheduledFit = undefined
      this.resizeSubscription?.dispose()
      this.resizeSubscription = undefined
      if (surface !== undefined) this.environment.detachSurface(surface)
      return
    }
    if (surface !== undefined && host !== undefined) {
      this.environment.attachSurface(surface, host)
      this.observeHost()
      this.scheduleFit()
    }
  }

  focus(): void {
    if (this.disposed || !this.visible) return
    this.emulator?.focus()
  }

  clear(): boolean {
    if (this.disposed || this.emulator === undefined) return false
    try {
      this.emulator.clear()
      return true
    } catch {
      return false
    }
  }

  search(query: string, direction: TerminalSearchDirection): TerminalSearchRuntimeResult {
    if (query.length === 0 || query.length > MAX_TERMINAL_SEARCH_QUERY_UNITS
      || direction !== 'next' && direction !== 'previous') return 'invalid'
    if (this.disposed || this.emulator === undefined) return 'unavailable'
    try {
      return this.emulator.search(query, direction) ? 'found' : 'not-found'
    } catch {
      return 'unavailable'
    }
  }

  clearSearch(): boolean {
    if (this.disposed || this.emulator === undefined) return false
    try {
      this.emulator.clearSearch()
      return true
    } catch {
      return false
    }
  }

  interrupt(): boolean {
    if (this.disposed || this.terminating || !this.connected || this.exited) return false
    return this.socket?.send({ type: 'signal', signal: 'SIGINT' }) ?? false
  }

  terminate(): Promise<void> {
    if (this.disposed || this.exited || this.transportClosed) return Promise.resolve()
    if (this.terminationPromise !== undefined) return this.terminationPromise
    const wasConnected = this.connected
    this.terminating = true
    this.connected = false
    this.terminationPromise = new Promise<void>((resolve) => {
      this.resolveTermination = resolve
    })
    if (wasConnected) this.requestClose()
    return this.terminationPromise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    this.settleTermination()
    this.scheduledFit?.dispose()
    this.scheduledFit = undefined
    this.resizeSubscription?.dispose()
    this.resizeSubscription = undefined
    this.inputSubscription?.dispose()
    this.inputSubscription = undefined
    this.socket?.close()
    this.socket = undefined
    this.emulator?.dispose()
    this.emulator = undefined
    if (this.surface !== undefined) this.environment.detachSurface(this.surface)
    this.surface = undefined
    this.host = undefined
    this.pendingInput.length = 0
    this.pendingInputUnits = 0
    this.lastSentDimensions = undefined
  }

  private acceptInput(data: string): void {
    if (this.disposed || this.terminating || this.exited || data.length === 0) return
    if (this.connected && this.socket?.send({ type: 'input', data }) === true) return
    if (this.pendingInputUnits + data.length > MAX_PENDING_INPUT_UNITS) {
      if (!this.inputOverflowReported) {
        this.inputOverflowReported = true
        this.reportError('Terminal input was discarded while the connection was unavailable.')
      }
      return
    }
    this.pendingInput.push(data)
    this.pendingInputUnits += data.length
  }

  private afterConnected(): void {
    if (this.disposed || !this.connected) return
    while (this.pendingInput.length > 0) {
      const data = this.pendingInput[0]
      if (data === undefined || this.socket?.send({ type: 'input', data }) !== true) break
      this.pendingInput.shift()
      this.pendingInputUnits -= data.length
    }
    this.inputOverflowReported = false
    if (this.visible) this.scheduleFit()
  }

  private acceptMessage(message: TerminalServerMessage): void {
    if (this.disposed) return
    if (message.type === 'output') {
      this.emulator?.write(message.data)
      return
    }
    if (message.type === 'error') {
      this.reportError(message.message)
      return
    }
    this.exited = true
    this.connected = false
    const suffix = message.code === undefined ? '' : ` ${String(message.code)}`
    this.emulator?.write(`\r\n[process exited${suffix}]\r\n`)
    this.events.onExited(this.identity, message.code, message.signal)
    this.settleTermination()
  }

  private reportError(message: string): void {
    this.emulator?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
    this.events.onError(this.identity, message)
  }

  private scheduleFit(): void {
    if (this.disposed || !this.visible || this.scheduledFit !== undefined) return
    this.scheduledFit = this.environment.scheduleFrame(() => {
      this.scheduledFit = undefined
      if (!this.disposed && this.visible) this.fit(true)
    })
  }

  private observeHost(): void {
    const host = this.host
    if (host === undefined || this.resizeSubscription !== undefined) return
    this.resizeSubscription = this.environment.observeResize(host, () => {
      if (this.visible) this.scheduleFit()
    })
  }

  private settleTermination(): void {
    const resolve = this.resolveTermination
    this.resolveTermination = undefined
    resolve?.()
  }

  private requestClose(): void {
    if (this.socket?.send({ type: 'close' }) !== true && this.transportClosed) this.settleTermination()
  }

  private fit(sendResize: boolean): void {
    const emulator = this.emulator
    if (emulator === undefined) return
    try { emulator.fit() } catch { return }
    if (sendResize && this.connected) {
      const next = dimensions(emulator)
      const key = `${String(next.cols)}x${String(next.rows)}`
      if (key !== this.lastSentDimensions && this.socket?.send({ type: 'resize', ...next }) === true) {
        this.lastSentDimensions = key
      }
    }
  }
}
