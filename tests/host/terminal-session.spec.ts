import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IDisposable, IPty } from 'node-pty'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from '../../src/host/terminal.js'

class FakePty implements IPty {
  readonly pid: number
  readonly cols = 80
  readonly rows = 24
  readonly process = 'fake-shell'
  handleFlowControl = false
  readonly write = vi.fn()
  readonly resize = vi.fn()
  readonly clear = vi.fn()
  readonly kill = vi.fn()
  readonly pause = vi.fn()
  readonly resume = vi.fn()
  private readonly dataListeners = new Set<(value: string) => void>()
  private readonly exitListeners = new Set<(value: { exitCode: number; signal?: number }) => void>()

  constructor(pid: number) { this.pid = pid }

  readonly onData = (listener: (value: string) => void): IDisposable => {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  readonly onExit = (listener: (value: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, ...(signal === undefined ? {} : { signal }) })
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function connect(url: string): Promise<{ socket?: WebSocket; status: number }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => { resolve({ socket, status: 101 }) })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0 })
    })
    socket.once('error', (error) => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error)
    })
  })
}

async function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
}

describe('TerminalHost session handoff', () => {
  const servers: Server[] = []
  const hosts: TerminalHost[] = []

  afterEach(async () => {
    await Promise.allSettled(hosts.splice(0).map(async host => { await host.dispose() }))
    await Promise.allSettled(servers.splice(0).map(async server => {
      if (!server.listening) return
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }))
  })

  it('acknowledges explicit close only after tree cleanup and then releases capacity', async () => {
    const cleanupGate = Promise.withResolvers<void>()
    const spawned: FakePty[] = []
    const cleanup = vi.fn(async (_pty: IPty, _exited: boolean) => {
      if (cleanup.mock.calls.length === 1) await cleanupGate.promise
    })
    const spawnTerminal = ((_file: string, _args: string[] | string) => {
      const pty = new FakePty(4_000 + spawned.length)
      spawned.push(pty)
      return pty
    }) as typeof import('node-pty').spawn
    const host = new TerminalHost({
      list: () => [{ id: 'workspace-fixture', path: '/workspace', title: 'Fixture' }],
    }, {
      shell: 'fake-shell', shellArgs: [], maxMessageBytes: 1024, maxInputBytes: 1024,
      maxBufferedBytes: 1024, maxSessions: 1,
      logger: { warn() {}, error() {}, info() {}, debug() {} },
    }, {
      resolveWorkspaceRoot: async path => ({ registeredPath: path, realPath: path }),
      spawnTerminal,
      killTerminalTree: cleanup,
    })
    hosts.push(host)
    const server = createServer()
    servers.push(server)
    server.on('upgrade', (request, socket, head) => { void host.upgrade(request, socket, head) })
    const port = await listen(server)
    const url = `ws://127.0.0.1:${String(port)}/dsh-code-ide/terminal?workspaceId=workspace-fixture`

    const first = await connect(url)
    expect(first.status).toBe(101)
    first.socket?.send(JSON.stringify({ type: 'close' }))
    await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledWith(spawned[0], false) })

    const whileCleaning = await connect(url)
    expect(whileCleaning.status).toBe(429)

    cleanupGate.resolve()
    await closed(first.socket!)
    const replacement = await connect(url)
    expect(replacement.status).toBe(101)
    expect(spawned).toHaveLength(2)
    replacement.socket?.close()
    await closed(replacement.socket!)
  })

  it('rejects a close frame with extra fields as an unsupported message', async () => {
    const spawned: FakePty[] = []
    const spawnTerminal = ((_file: string, _args: string[] | string) => {
      const pty = new FakePty(5_000 + spawned.length)
      spawned.push(pty)
      return pty
    }) as typeof import('node-pty').spawn
    const host = new TerminalHost({
      list: () => [{ id: 'workspace-fixture', path: '/workspace', title: 'Fixture' }],
    }, {
      shell: 'fake-shell', shellArgs: [], maxMessageBytes: 1024, maxInputBytes: 1024,
      maxBufferedBytes: 1024, maxSessions: 1,
      logger: { warn() {}, error() {}, info() {}, debug() {} },
    }, {
      resolveWorkspaceRoot: async path => ({ registeredPath: path, realPath: path }),
      spawnTerminal,
      killTerminalTree: async () => {},
    })
    hosts.push(host)
    const server = createServer()
    servers.push(server)
    server.on('upgrade', (request, socket, head) => { void host.upgrade(request, socket, head) })
    const port = await listen(server)
    const connection = await connect(`ws://127.0.0.1:${String(port)}/dsh-code-ide/terminal?workspaceId=workspace-fixture`)
    const messages: unknown[] = []
    connection.socket?.on('message', data => { messages.push(JSON.parse(data.toString()) as unknown) })

    connection.socket?.send(JSON.stringify({ type: 'close', extra: true }))
    await vi.waitFor(() => { expect(messages).toContainEqual({ type: 'error', message: 'Unsupported terminal message.' }) })
    expect(spawned[0]?.kill).not.toHaveBeenCalled()
    connection.socket?.close()
    await closed(connection.socket!)
  })
})
