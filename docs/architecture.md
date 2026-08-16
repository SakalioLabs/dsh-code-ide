# Architecture

`dsh-code-ide` is an additive DeepSeek Harness plugin. It does not fork the Harness UI and it does not replace the default chat experience.

## Integration model

The package contributes two parts through its `dsh` manifest:

- a Cordis Host plugin that owns the IDE HTTP, WebSocket, file, search, terminal, and mutation capabilities;
- a Harness browser contribution that registers an optional `IDE` item in the native `conversation.view` slot.

Chat remains the official default view. The IDE is created only after a user selects its tab. While that IDE view is mounted, the normal composer for the same session is suppressed; question and approval takeovers remain available. Unmounting the view immediately restores the normal composer.

The browser contribution maps the active Harness session to its registered workspace and loads the workbench in a same-origin frame:

~~~text
DeepSeek Harness /
|-- Chat / conversation views (owned by Harness)
|-- Trace (owned by Harness)
`-- IDE (contributed by dsh-code-ide)
    `-- /dsh-code-ide/?embedded=1&workspaceId=...&locale=...
~~~

The frame is intentionally same-origin. The bridge copies an allow-list of resolved Harness theme tokens and the light/dark marker into the child document, and sends the active `zh` or `en` locale through `postMessage`. It does not mirror arbitrary host CSS. `/dsh-code-ide/` can also be opened directly for development and diagnostics.

## Host composition

The root Cordis plugin composes independently reloadable providers:

1. `WorkspaceResources` validates registered workspaces, pins root identity, and serializes writes per workspace.
2. `WorkspaceMutationBackend` supplies platform-specific structural operations or an all-false, fail-closed capability descriptor.
3. `WorkspaceFileService` lists, inspects, reads, and versioned-saves text files.
4. `WorkspaceMutationService` adds idempotent receipts and recovery classification around structural operations.
5. `WorkspaceSearchService` runs the bundled ripgrep with bounded input and output.
6. `TerminalHost` owns bounded `node-pty` sessions.
7. Route gateways publish capabilities only while their dependencies are live.

The public routes are:

| Route | Transport | Purpose |
| --- | --- | --- |
| `/dsh-code-ide/` | HTTP `GET`/`HEAD` | Static SPA and immutable built assets |
| `/dsh-code-ide/api` | HTTP `POST` JSON | Workspaces, list, inspect, read, write, and search |
| `/dsh-code-ide/api/workspace-mutations/v1` | HTTP `POST` JSON | Capability discovery, mutation submission, and receipt status |
| `/dsh-code-ide/terminal` | WebSocket | PTY input, output, resize, interrupt, and close |

Every route is restricted to same-origin loopback requests. See [security.md](./security.md) for the complete boundary.

## Browser workbench

The workbench is a React application built around:

- CodeMirror 6 for editable text and lazy, allow-listed language support;
- xterm.js for the terminal surface;
- a workspace Explorer and ripgrep-backed search;
- up to four editor groups, with tab reorder and top/right split drop targets;
- browser-local layout, keybinding, session, and dirty-buffer recovery state.

Disk versions remain authoritative. Opening and saving are correlated to a workspace, path, and lifecycle; save conflicts are surfaced instead of silently accepting a stale buffer. Structural changes use separate operation IDs and bounded receipts so an interrupted request is not guessed to have rolled back.

## Deliberate boundaries

This project borrows familiar workbench interaction patterns, but it is not a VS Code distribution. It has no VS Code extension host, VSIX compatibility layer, Marketplace client, debugger protocol, built-in Git UI, or general Language Server Protocol host. Those would materially change size, security, and maintenance costs.

The plugin also does not own Harness sessions or workspace registration. It consumes the workspace/session model already provided by Harness and disappears cleanly when disabled or removed.
