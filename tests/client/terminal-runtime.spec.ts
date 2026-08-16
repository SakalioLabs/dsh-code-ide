import { describe, expect, it, vi } from 'vitest'
import type { TerminalClientMessage } from '../../src/client/contracts.ts'
import {
  TerminalRuntime,
  type TerminalDisposable,
  type TerminalEmulatorPort,
  type TerminalRuntimeEnvironment,
  type TerminalRuntimeEvents,
  type TerminalSearchDirection,
  type TerminalSocketOptions,
  type TerminalSocketPort,
} from '../../src/client/terminal/runtime.ts'

class FakeEmulator implements TerminalEmulatorPort {
  cols = 80
  rows = 24
  readonly writes: string[] = []
  readonly fit = vi.fn()
  readonly focus = vi.fn()
  readonly clear = vi.fn()
  readonly search = vi.fn((_query: string, _direction: TerminalSearchDirection) => true)
  readonly clearSearch = vi.fn()
  readonly dispose = vi.fn()
  openHost: HTMLElement | undefined
  private dataListener: ((data: string) => void) | undefined

  open(host: HTMLElement): void { this.openHost = host }
  write(data: string): void { this.writes.push(data) }
  onData(listener: (data: string) => void): TerminalDisposable {
    this.dataListener = listener
    return { dispose: () => { if (this.dataListener === listener) this.dataListener = undefined } }
  }
  emitData(data: string): void { this.dataListener?.(data) }
}

class FakeSocket implements TerminalSocketPort {
  readonly messages: TerminalClientMessage[] = []
  readonly close = vi.fn()
  accepting = true
  send(message: TerminalClientMessage): boolean {
    if (!this.accepting) return false
    this.messages.push(message)
    return true
  }
}

class FakeEnvironment implements TerminalRuntimeEnvironment {
  readonly emulator = new FakeEmulator()
  readonly socket = new FakeSocket()
  readonly surface = {} as HTMLElement
  readonly attachSurface = vi.fn()
  readonly detachSurface = vi.fn()
  socketOptions: TerminalSocketOptions | undefined
  resizeListeners: Array<{ listener: () => void; disposed: boolean }> = []
  frames: Array<{ listener: () => void; disposed: boolean }> = []

  createSurface(): HTMLElement { return this.surface }
  createEmulator(): TerminalEmulatorPort { return this.emulator }
  openSocket(options: TerminalSocketOptions): TerminalSocketPort {
    this.socketOptions = options
    return this.socket
  }
  observeResize(_host: HTMLElement, listener: () => void): TerminalDisposable {
    const value = { listener, disposed: false }
    this.resizeListeners.push(value)
    return { dispose: () => { value.disposed = true } }
  }
  scheduleFrame(listener: () => void): TerminalDisposable {
    const value = { listener, disposed: false }
    this.frames.push(value)
    return { dispose: () => { value.disposed = true } }
  }
  open(): void { this.socketOptions?.onOpen() }
  message(message: Parameters<TerminalSocketOptions['onMessage']>[0]): void { this.socketOptions?.onMessage(message) }
  close(details = { code: 1006, reason: '', wasClean: false }): void { this.socketOptions?.onClose(details) }
  error(message: string): void { this.socketOptions?.onError(message) }
  resize(): void { this.resizeListeners.filter(value => !value.disposed).at(-1)?.listener() }
  flushFrames(): void {
    const frames = this.frames.splice(0)
    for (const frame of frames) if (!frame.disposed) frame.listener()
  }
}

function events(): TerminalRuntimeEvents & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onConnected: vi.fn(),
    onExited: vi.fn(),
    onError: vi.fn(),
    onTransportClosed: vi.fn(),
  }
}

const identity = { workspaceId: 'workspace', id: 'terminal-1', lifecycleId: 1 }

describe('TerminalRuntime', () => {
  it('keeps early input, streams output and coalesces active resize frames', () => {
    const environment = new FakeEnvironment()
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    const host = {} as HTMLElement
    runtime.mount(host, true)

    expect(environment.attachSurface).toHaveBeenCalledWith(environment.surface, host)
    expect(environment.socketOptions).toMatchObject({ workspaceId: 'workspace', cols: 80, rows: 24 })
    environment.emulator.emitData('queued')
    expect(environment.socket.messages).toEqual([])

    environment.open()
    expect(callbacks.onConnected).toHaveBeenCalledWith(identity)
    expect(environment.socket.messages).toEqual([{ type: 'input', data: 'queued' }])
    environment.message({ type: 'output', data: 'hello' })
    expect(environment.emulator.writes).toContain('hello')

    environment.emulator.cols = 100
    environment.emulator.rows = 40
    environment.resize()
    environment.resize()
    environment.flushFrames()
    expect(environment.socket.messages.filter(message => message.type === 'resize')).toEqual([
      { type: 'resize', cols: 100, rows: 40 },
    ])
    environment.resize()
    environment.flushFrames()
    expect(environment.socket.messages.filter(message => message.type === 'resize')).toHaveLength(1)
  })

  it('detaches inactive surfaces without closing their transport and restores resize on activation', () => {
    const environment = new FakeEnvironment()
    const runtime = new TerminalRuntime(identity, environment, events())
    runtime.mount({} as HTMLElement, true)
    environment.open()
    environment.flushFrames()

    runtime.setVisible(false)
    expect(environment.detachSurface).toHaveBeenCalledTimes(1)
    expect(environment.socket.close).not.toHaveBeenCalled()
    expect(environment.resizeListeners.at(-1)?.disposed).toBe(true)

    environment.emulator.cols = 120
    runtime.setVisible(true)
    environment.flushFrames()
    expect(environment.attachSurface).toHaveBeenCalledTimes(2)
    expect(environment.socket.messages).toContainEqual({ type: 'resize', cols: 120, rows: 24 })
  })

  it('clears a hidden emulator locally without writing to its terminal transport', () => {
    const environment = new FakeEnvironment()
    const runtime = new TerminalRuntime(identity, environment, events())
    runtime.mount({} as HTMLElement, false)
    const transportMessages = [...environment.socket.messages]

    expect(runtime.clear()).toBe(true)
    expect(environment.emulator.clear).toHaveBeenCalledOnce()
    expect(environment.socket.messages).toEqual(transportMessages)

    runtime.dispose()
    expect(runtime.clear()).toBe(false)
    expect(environment.emulator.clear).toHaveBeenCalledOnce()
  })

  it('searches a hidden emulator locally with bounded literal input and clears its selection', () => {
    const environment = new FakeEnvironment()
    const runtime = new TerminalRuntime(identity, environment, events())
    runtime.mount({} as HTMLElement, false)
    const transportMessages = [...environment.socket.messages]

    expect(runtime.search('needle', 'next')).toBe('found')
    expect(environment.emulator.search).toHaveBeenLastCalledWith('needle', 'next')
    environment.emulator.search.mockReturnValueOnce(false)
    expect(runtime.search('needle', 'previous')).toBe('not-found')
    expect(environment.emulator.search).toHaveBeenLastCalledWith('needle', 'previous')
    expect(runtime.search('', 'next')).toBe('invalid')
    expect(runtime.search('x'.repeat(1_025), 'next')).toBe('invalid')
    expect(environment.emulator.search).toHaveBeenCalledTimes(2)
    expect(runtime.clearSearch()).toBe(true)
    expect(environment.emulator.clearSearch).toHaveBeenCalledOnce()
    expect(environment.socket.messages).toEqual(transportMessages)

    runtime.dispose()
    expect(runtime.search('needle', 'next')).toBe('unavailable')
    expect(runtime.clearSearch()).toBe(false)
    expect(environment.emulator.search).toHaveBeenCalledTimes(2)
    expect(environment.emulator.clearSearch).toHaveBeenCalledOnce()
  })

  it('keeps process exit authoritative and ignores every event after disposal', () => {
    const environment = new FakeEnvironment()
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    runtime.mount({} as HTMLElement, true)
    environment.open()
    environment.message({ type: 'exit', code: 7, signal: 'SIGTERM' })
    environment.close({ code: 1000, reason: 'terminal exited', wasClean: true })

    expect(callbacks.onExited).toHaveBeenCalledWith(identity, 7, 'SIGTERM')
    expect(callbacks.onTransportClosed).not.toHaveBeenCalled()
    expect(runtime.interrupt()).toBe(false)

    runtime.dispose()
    environment.message({ type: 'output', data: 'late' })
    environment.error('late error')
    environment.close()
    expect(environment.emulator.writes).not.toContain('late')
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(environment.socket.close).toHaveBeenCalledTimes(1)
    expect(environment.emulator.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports protocol detail before classifying an unexpected disconnect', () => {
    const environment = new FakeEnvironment()
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    runtime.mount({} as HTMLElement, false)
    environment.open()
    environment.message({ type: 'error', message: 'spawn rejected' })
    environment.close({ code: 1011, reason: 'terminal spawn failed', wasClean: true })

    expect(callbacks.onError).toHaveBeenCalledWith(identity, 'spawn rejected')
    expect(callbacks.onTransportClosed).toHaveBeenCalledWith(identity, 'terminal spawn failed')
  })

  it('handles a transport whose open callback fires before its factory returns', () => {
    const environment = new FakeEnvironment()
    environment.openSocket = (options): TerminalSocketPort => {
      environment.socketOptions = options
      options.onOpen()
      return environment.socket
    }
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    runtime.mount({} as HTMLElement, true)
    environment.emulator.emitData('after synchronous open')

    expect(callbacks.onConnected).toHaveBeenCalledTimes(1)
    expect(environment.socket.messages).toContainEqual({ type: 'input', data: 'after synchronous open' })
  })

  it('waits for process exit before completing an explicit termination handoff', async () => {
    const environment = new FakeEnvironment()
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    runtime.mount({} as HTMLElement, true)
    environment.open()

    let finished = false
    const termination = runtime.terminate().then(() => { finished = true })
    expect(environment.socket.messages).toContainEqual({ type: 'close' })
    await Promise.resolve()
    expect(finished).toBe(false)
    environment.message({ type: 'exit', code: 0 })
    await termination
    expect(finished).toBe(true)
    expect(callbacks.onExited).toHaveBeenCalledWith(identity, 0, undefined)
  })

  it('keeps a connecting handshake pending and closes through Host after it opens', async () => {
    const environment = new FakeEnvironment()
    const callbacks = events()
    const runtime = new TerminalRuntime(identity, environment, callbacks)
    runtime.mount({} as HTMLElement, true)

    let finished = false
    const termination = runtime.terminate().then(() => { finished = true })
    expect(environment.socket.close).not.toHaveBeenCalled()
    expect(environment.socket.messages).toEqual([])
    environment.open()
    expect(callbacks.onConnected).not.toHaveBeenCalled()
    expect(environment.socket.messages).toEqual([{ type: 'close' }])
    expect(finished).toBe(false)
    environment.close({ code: 1000, reason: '', wasClean: true })
    await termination
    expect(finished).toBe(true)
  })

})
