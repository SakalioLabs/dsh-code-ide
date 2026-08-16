# Compatibility

## Supported Harness baseline

This alpha targets DeepSeek Harness source commit `47f9438`. The package relies on the conversation slot and Cordis bundle contracts present at that revision. Other Harness commits may work, but they are not a compatibility promise until verified and documented.

Runtime requirements:

| Component | Requirement |
| --- | --- |
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | `10.17.0` recommended; the repository pins this version |
| Harness profile | Web profile with a registered local workspace |
| Browser origin | The same loopback origin that serves Harness |

CI currently runs type checking, unit tests, builds, and package creation on `windows-latest` and `ubuntu-latest` with Node `22.19.0`.

## Host platform matrix

| Capability | Windows x64 + NTFS | Linux | macOS |
| --- | --- | --- | --- |
| Browse, inspect, and read | Yes | Yes | Expected, not in the current CI matrix |
| Edit and versioned save | Yes | Yes | Expected, not in the current CI matrix |
| File and text search | Yes | Yes | Expected when the bundled ripgrep package is available |
| Integrated terminal | Yes | Yes | Expected when `node-pty` builds and a shell is available |
| Create file/folder | Yes, after native probe | No | No |
| Rename/move/delete | Yes, after native probe | No | No |

Structural operations are deliberately fail-closed. The current production backend is enabled only on Windows x64 when the workspace volume reports NTFS and a startup runtime witness proves handle-relative create, no-replace rename, deletion, identity, and reparse-point behavior. Windows ARM64, non-NTFS workspaces, failed native loading, or a failed witness advertise all structural mutation capabilities as unavailable.

Linux and macOS currently use the all-false structural mutation backend. They can still browse, edit, save, search, and use terminals; Explorer create, move, rename, and delete controls must remain unavailable. A tested utility for native no-replace rename is not the production containment backend and does not change this matrix.

## Filesystem behavior

- The workspace root must be a real directory whose identity remains stable.
- Symbolic links and reparse points are not available through the IDE.
- Nested or cross-device mounts are rejected when the Host cannot prove containment.
- Editable files must be UTF-8 text and are limited to 4 MiB by default. Binary and oversized files use a read-only presentation.
- Directory listings are limited to 5,000 entries by default.
- Existing-file saves require the exact version returned by the read operation; external changes become conflicts.
- Search uses the packaged `@vscode/ripgrep` binary and bounded result, candidate, byte, concurrency, and timeout limits.

## Browser expectations

A current Chromium-based browser is the primary manually exercised target. The application uses standard modules, WebSocket, `postMessage`, `localStorage`, Clipboard API, Web Locks where available, and modern DOM APIs. There is not yet a committed cross-browser end-to-end matrix, so Firefox and Safari should be treated as unverified.

If exclusive Web Locks are unavailable, browser-local hot-exit recovery is disabled and keybinding persistence may become read-only. Core Host file operations are independent of that browser storage fallback.

## Not compatible

The project does not support:

- VS Code extensions or VSIX packages;
- the Visual Studio Marketplace protocol;
- remote or LAN exposure of the IDE routes;
- unauthenticated multi-user hosting;
- opening arbitrary directories that are not registered Harness workspaces;
- following symlinks from a workspace;
- editing binary files.
