import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { IdeHostError } from './errors.js';
import { resolveWorkspaceRoot } from './path-policy.js';
const execFileAsync = promisify(execFile);
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i;
export function sanitizeTerminalEnv(source) {
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined || SENSITIVE_ENV.test(key) || key.toUpperCase().startsWith('DSH_'))
            continue;
        result[key] = value;
    }
    result.TERM = 'xterm-256color';
    result.COLORTERM = 'truecolor';
    return result;
}
function dimensions(value, fallback, max) {
    if (value === null)
        return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 2 && parsed <= max ? parsed : fallback;
}
function rawText(data) {
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString('utf8');
    return data.toString('utf8');
}
export function rejectUpgrade(socket, status, message) {
    socket.end(`HTTP/1.1 ${String(status)} ${message}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${String(Buffer.byteLength(message))}\r\n\r\n${message}`);
}
function workspaceById(registry, value) {
    if (value === null || value.length === 0 || value.length > 256) {
        throw new IdeHostError('INVALID_WORKSPACE_ID', 'workspaceId is required.');
    }
    const workspace = registry.list().find(item => String(item.id) === value);
    if (workspace === undefined)
        throw new IdeHostError('WORKSPACE_NOT_FOUND', 'Unknown workspace.', 404);
    return workspace;
}
async function killTerminalTree(pty, exited) {
    if (process.platform === 'win32') {
        if (exited)
            return;
        await execFileAsync('taskkill.exe', ['/pid', String(pty.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 3_000,
        }).catch(() => { });
        try {
            pty.kill();
        }
        catch { }
        return;
    }
    // forkpty normally makes the PTY child a process-group leader. Signal that
    // group first so a surviving foreground/helper process is not missed merely
    // because the top-level shell has already exited. This remains best-effort:
    // node-pty exposes no portable tree-quiescence handle.
    try {
        process.kill(-pty.pid, 'SIGHUP');
        return;
    }
    catch {
        if (exited)
            return;
        try {
            pty.kill('SIGHUP');
        }
        catch {
            try {
                pty.kill();
            }
            catch { }
        }
    }
}
/** Raw xterm-compatible PTY WebSocket owner. */
export class TerminalHost {
    registry;
    options;
    server;
    active = new Set();
    resolveRoot;
    spawnTerminal;
    killTree;
    pendingUpgrades = 0;
    disposing = false;
    constructor(registry, options, internals = {}) {
        this.registry = registry;
        this.options = options;
        this.resolveRoot = internals.resolveWorkspaceRoot ?? resolveWorkspaceRoot;
        this.spawnTerminal = internals.spawnTerminal ?? spawnPty;
        this.killTree = internals.killTerminalTree ?? killTerminalTree;
        this.server = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: options.maxMessageBytes,
        });
    }
    async upgrade(request, socket, head) {
        if (this.disposing) {
            rejectUpgrade(socket, 503, 'IDE terminal is stopping');
            return;
        }
        let url;
        let workspace;
        try {
            url = new URL(request.url ?? '/', 'http://localhost');
            workspace = workspaceById(this.registry, url.searchParams.get('workspaceId') ?? url.searchParams.get('sessionId'));
        }
        catch {
            rejectUpgrade(socket, 400, 'Invalid IDE terminal request');
            return;
        }
        // Reserve synchronously before the first await. Without this pending count,
        // concurrent handshakes can all pass an active.size-only check and exceed
        // maxSessions while workspace canonicalization is in flight.
        if (this.active.size + this.pendingUpgrades >= this.options.maxSessions) {
            rejectUpgrade(socket, 429, 'Too many IDE terminals');
            return;
        }
        this.pendingUpgrades += 1;
        try {
            let root;
            try {
                root = await this.resolveRoot(workspace.path);
            }
            catch {
                rejectUpgrade(socket, 409, 'Workspace is unavailable');
                return;
            }
            if (this.disposing) {
                rejectUpgrade(socket, 503, 'IDE terminal is stopping');
                return;
            }
            const cols = dimensions(url.searchParams.get('cols'), 120, 500);
            const rows = dimensions(url.searchParams.get('rows'), 30, 300);
            this.server.handleUpgrade(request, socket, head, (webSocket) => {
                this.open(webSocket, root.realPath, cols, rows);
            });
        }
        finally {
            this.pendingUpgrades -= 1;
        }
    }
    async dispose() {
        this.disposing = true;
        await Promise.allSettled([...this.active].map(session => session.close()));
        for (const client of this.server.clients)
            client.terminate();
        await new Promise((resolve) => this.server.close(() => { resolve(); }));
    }
    open(webSocket, cwd, cols, rows) {
        let pty;
        try {
            pty = this.spawnTerminal(this.options.shell, this.options.shellArgs, {
                cwd,
                cols,
                rows,
                name: 'xterm-256color',
                env: sanitizeTerminalEnv(process.env),
            });
        }
        catch (error) {
            this.send(webSocket, { type: 'error', message: 'Failed to start the terminal.' });
            webSocket.close(1011, 'terminal spawn failed');
            this.options.logger.warn(error);
            return;
        }
        let exited = false;
        let closing;
        const dataSubscription = pty.onData((data) => {
            if (webSocket.bufferedAmount > this.options.maxBufferedBytes) {
                this.send(webSocket, { type: 'error', message: 'Terminal output exceeded the browser buffer.' });
                void close();
                return;
            }
            this.send(webSocket, { type: 'output', data });
        });
        const session = { close };
        this.active.add(session);
        const exitSubscription = pty.onExit(({ exitCode, signal }) => {
            exited = true;
            // Once the owned PTY has exited it no longer consumes a terminal slot.
            // Release before publishing exit so a client restart that waits for this
            // frame cannot race the old lifecycle in the maxSessions admission gate.
            this.active.delete(session);
            this.send(webSocket, {
                type: 'exit',
                code: exitCode,
                ...(signal === undefined ? {} : { signal: String(signal) }),
            });
            webSocket.close(1000, 'terminal exited');
        });
        webSocket.on('message', (data) => {
            try {
                const value = JSON.parse(rawText(data));
                if (this.isCloseMessage(value)) {
                    void close();
                    return;
                }
                this.handleMessage(pty, value);
            }
            catch (error) {
                const message = error instanceof IdeHostError ? error.message : 'Malformed terminal message.';
                this.send(webSocket, { type: 'error', message });
            }
        });
        webSocket.on('error', error => { this.options.logger.debug(error); });
        webSocket.once('close', () => { void close(); });
        function close() {
            closing ??= (async () => {
                dataSubscription.dispose();
                exitSubscription.dispose();
                await thisHost.killTree(pty, exited);
                if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
                    webSocket.close();
                }
                thisHost.active.delete(session);
            })();
            return closing;
        }
        const thisHost = this;
    }
    handleMessage(pty, value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new IdeHostError('INVALID_TERMINAL_MESSAGE', 'Terminal message must be an object.');
        }
        const message = value;
        if (message.type === 'input') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data, 'utf8') > this.options.maxInputBytes) {
                throw new IdeHostError('INVALID_TERMINAL_INPUT', 'Terminal input exceeds its limit.');
            }
            pty.write(message.data);
            return;
        }
        if (message.type === 'resize') {
            const cols = Number(message.cols);
            const rows = Number(message.rows);
            if (!Number.isSafeInteger(cols) || cols < 2 || cols > 500
                || !Number.isSafeInteger(rows) || rows < 2 || rows > 300) {
                throw new IdeHostError('INVALID_TERMINAL_SIZE', 'Invalid terminal dimensions.');
            }
            pty.resize(cols, rows);
            return;
        }
        if (message.type === 'signal' && message.signal === 'SIGINT') {
            pty.write('\x03');
            return;
        }
        throw new IdeHostError('INVALID_TERMINAL_MESSAGE', 'Unsupported terminal message.');
    }
    isCloseMessage(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            && value.type === 'close'
            && Object.keys(value).length === 1;
    }
    send(webSocket, value) {
        if (webSocket.readyState === WebSocket.OPEN)
            webSocket.send(JSON.stringify(value));
    }
}
export function resolveTerminalShell(value) {
    if (value !== undefined && value !== '' && value !== 'auto')
        return { shell: value, args: [] };
    if (process.platform === 'win32')
        return { shell: process.env.COMSPEC ?? 'powershell.exe', args: [] };
    return { shell: process.env.SHELL ?? '/bin/bash', args: [] };
}
