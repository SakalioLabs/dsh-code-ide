import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { HostLogger, HostWorkspace, HostWorkspaceRegistry } from './contracts.js'
import { IdeHostError } from './errors.js'
import { resolveWorkspaceRoot, type ResolvedWorkspaceRoot } from './path-policy.js'

const execFileAsync = promisify(execFile)
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

export interface TerminalHostOptions {
  shell: string
  shellArgs: string[]
  maxMessageBytes: number
  maxInputBytes: number
  maxBufferedBytes: number
  maxSessions: number
  logger: HostLogger
}

/** Deterministic async-boundary seam used by capacity tests. */
export interface TerminalHostInternals {
  resolveWorkspaceRoot?: (path: string) => Promise<ResolvedWorkspaceRoot>
  spawnTerminal?: typeof spawnPty
  killTerminalTree?: (pty: IPty, exited: boolean) => Promise<void>
}

export function sanitizeTerminalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENV.test(key) || key.toUpperCase().startsWith('DSH_')) continue
    result[key] = value
  }
  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  return result
}

function dimensions(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 2 && parsed <= max ? parsed : fallback
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${String(status)} ${message}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(message))}\r\n\r\n${message}`,
  )
}

function workspaceById(registry: HostWorkspaceRegistry, value: string | null): HostWorkspace {
  if (value === null || value.length === 0 || value.length > 256) {
    throw new IdeHostError('INVALID_WORKSPACE_ID', 'workspaceId is required.')
  }
  const workspace = registry.list().find(item => String(item.id) === value)
  if (workspace === undefined) throw new IdeHostError('WORKSPACE_NOT_FOUND', 'Unknown workspace.', 404)
  return workspace
}

async function killTerminalTree(pty: IPty, exited: boolean): Promise<void> {
  if (process.platform === 'win32') {
    if (exited) return
    await execFileAsync('taskkill.exe', ['/pid', String(pty.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 3_000,
    }).catch(() => {})
    try { pty.kill() } catch {}
    return
  }

  // forkpty normally makes the PTY child a process-group leader. Signal that
  // group first so a surviving foreground/helper process is not missed merely
  // because the top-level shell has already exited. This remains best-effort:
  // node-pty exposes no portable tree-quiescence handle.
  try {
    process.kill(-pty.pid, 'SIGHUP')
    return
  } catch {
    if (exited) return
    try { pty.kill('SIGHUP') } catch {
      try { pty.kill() } catch {}
    }
  }
}

interface ActiveTerminal {
  close(): Promise<void>
}

/** Raw xterm-compatible PTY WebSocket owner. */
export class TerminalHost {
  private readonly server: WebSocketServer
  private readonly active = new Set<ActiveTerminal>()
  private readonly resolveRoot: (path: string) => Promise<ResolvedWorkspaceRoot>
  private readonly spawnTerminal: typeof spawnPty
  private readonly killTree: (pty: IPty, exited: boolean) => Promise<void>
  private pendingUpgrades = 0
  private disposing = false

  constructor(
    private readonly registry: HostWorkspaceRegistry,
    private readonly options: TerminalHostOptions,
    internals: TerminalHostInternals = {},
  ) {
    this.resolveRoot = internals.resolveWorkspaceRoot ?? resolveWorkspaceRoot
    this.spawnTerminal = internals.spawnTerminal ?? spawnPty
    this.killTree = internals.killTerminalTree ?? killTerminalTree
    this.server = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: options.maxMessageBytes,
    })
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.disposing) {
      rejectUpgrade(socket, 503, 'IDE terminal is stopping')
      return
    }
    let url: URL
    let workspace: HostWorkspace
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
      workspace = workspaceById(this.registry, url.searchParams.get('workspaceId') ?? url.searchParams.get('sessionId'))
    } catch {
      rejectUpgrade(socket, 400, 'Invalid IDE terminal request')
      return
    }
    // Reserve synchronously before the first await. Without this pending count,
    // concurrent handshakes can all pass an active.size-only check and exceed
    // maxSessions while workspace canonicalization is in flight.
    if (this.active.size + this.pendingUpgrades >= this.options.maxSessions) {
      rejectUpgrade(socket, 429, 'Too many IDE terminals')
      return
    }
    this.pendingUpgrades += 1
    try {
      let root: ResolvedWorkspaceRoot
      try {
        root = await this.resolveRoot(workspace.path)
      } catch {
        rejectUpgrade(socket, 409, 'Workspace is unavailable')
        return
      }
      if (this.disposing) {
        rejectUpgrade(socket, 503, 'IDE terminal is stopping')
        return
      }
      const cols = dimensions(url.searchParams.get('cols'), 120, 500)
      const rows = dimensions(url.searchParams.get('rows'), 30, 300)
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.open(webSocket, root.realPath, cols, rows)
      })
    } finally {
      this.pendingUpgrades -= 1
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true
    await Promise.allSettled([...this.active].map(session => session.close()))
    for (const client of this.server.clients) client.terminate()
    await new Promise<void>((resolve) => this.server.close(() => { resolve() }))
  }

  private open(webSocket: WebSocket, cwd: string, cols: number, rows: number): void {
    let pty: IPty
    try {
      pty = this.spawnTerminal(this.options.shell, this.options.shellArgs, {
        cwd,
        cols,
        rows,
        name: 'xterm-256color',
        env: sanitizeTerminalEnv(process.env),
      })
    } catch (error) {
      this.send(webSocket, { type: 'error', message: 'Failed to start the terminal.' })
      webSocket.close(1011, 'terminal spawn failed')
      this.options.logger.warn(error)
      return
    }

    let exited = false
    let closing: Promise<void> | undefined
    const dataSubscription = pty.onData((data) => {
      if (webSocket.bufferedAmount > this.options.maxBufferedBytes) {
        this.send(webSocket, { type: 'error', message: 'Terminal output exceeded the browser buffer.' })
        void close()
        return
      }
      this.send(webSocket, { type: 'output', data })
    })
    const session: ActiveTerminal = { close }
    this.active.add(session)
    const exitSubscription = pty.onExit(({ exitCode, signal }) => {
      exited = true
      // Once the owned PTY has exited it no longer consumes a terminal slot.
      // Release before publishing exit so a client restart that waits for this
      // frame cannot race the old lifecycle in the maxSessions admission gate.
      this.active.delete(session)
      this.send(webSocket, {
        type: 'exit',
        code: exitCode,
        ...(signal === undefined ? {} : { signal: String(signal) }),
      })
      webSocket.close(1000, 'terminal exited')
    })
    webSocket.on('message', (data) => {
      try {
        const value = JSON.parse(rawText(data)) as unknown
        if (this.isCloseMessage(value)) {
          void close()
          return
        }
        this.handleMessage(pty, value)
      } catch (error) {
        const message = error instanceof IdeHostError ? error.message : 'Malformed terminal message.'
        this.send(webSocket, { type: 'error', message })
      }
    })
    webSocket.on('error', error => { this.options.logger.debug(error) })
    webSocket.once('close', () => { void close() })

    function close(): Promise<void> {
      closing ??= (async () => {
        dataSubscription.dispose()
        exitSubscription.dispose()
        await thisHost.killTree(pty, exited)
        if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
          webSocket.close()
        }
        thisHost.active.delete(session)
      })()
      return closing
    }
    const thisHost = this
  }

  private handleMessage(pty: IPty, value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new IdeHostError('INVALID_TERMINAL_MESSAGE', 'Terminal message must be an object.')
    }
    const message = value as Record<string, unknown>
    if (message.type === 'input') {
      if (typeof message.data !== 'string' || Buffer.byteLength(message.data, 'utf8') > this.options.maxInputBytes) {
        throw new IdeHostError('INVALID_TERMINAL_INPUT', 'Terminal input exceeds its limit.')
      }
      pty.write(message.data)
      return
    }
    if (message.type === 'resize') {
      const cols = Number(message.cols)
      const rows = Number(message.rows)
      if (!Number.isSafeInteger(cols) || cols < 2 || cols > 500
        || !Number.isSafeInteger(rows) || rows < 2 || rows > 300) {
        throw new IdeHostError('INVALID_TERMINAL_SIZE', 'Invalid terminal dimensions.')
      }
      pty.resize(cols, rows)
      return
    }
    if (message.type === 'signal' && message.signal === 'SIGINT') {
      pty.write('\x03')
      return
    }
    throw new IdeHostError('INVALID_TERMINAL_MESSAGE', 'Unsupported terminal message.')
  }

  private isCloseMessage(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).type === 'close'
      && Object.keys(value).length === 1
  }

  private send(webSocket: WebSocket, value: unknown): void {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(value))
  }
}

export function resolveTerminalShell(value: string | undefined): { shell: string; args: string[] } {
  if (value !== undefined && value !== '' && value !== 'auto') return { shell: value, args: [] }
  if (process.platform === 'win32') return { shell: process.env.COMSPEC ?? 'powershell.exe', args: [] }
  return { shell: process.env.SHELL ?? '/bin/bash', args: [] }
}
