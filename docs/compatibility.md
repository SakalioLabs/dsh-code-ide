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

CI runs type checking, unit tests, builds, and package creation on Windows x64, Ubuntu x64/ARM64, and macOS 15 x64/ARM64 with Node `22.19.0`. Ubuntu x64 and both macOS architectures run their native creation witness directly. Ubuntu ARM64 instead verifies the explicit all-false fallback until a fixed-signature `openat2` shim is available.

## Host platform matrix

| Capability | Windows x64 + NTFS | Linux x64 | macOS x64/arm64 |
| --- | --- | --- | --- |
| Browse, inspect, and read | Yes | Yes | Yes |
| Edit and versioned save | Yes | Yes | Yes |
| File and text search | Yes | Yes | Yes, when the bundled ripgrep package is available |
| Integrated terminal | Yes | Yes | Yes, when `node-pty` and a shell are available |
| Create file/folder | Yes, after NTFS native probe | Yes, after `openat2` native probe | Yes, after local-APFS native probe |
| Rename/move/delete | Yes, after NTFS native probe | No | No |

Structural operations are deliberately fail-closed and each backend is enabled only after its native ABI and containment witness pass at runtime:

- Windows requires x64, NTFS, and the handle-relative NT runtime witness. Windows ARM64 and non-NTFS workspaces remain unavailable.
- Linux requires x64, the `openat2` containment flags, descriptor identity binding, the native FFI ABI, and its no-replace create witness. Linux ARM64 and other architectures remain all-false until a fixed-signature `openat2` shim replaces the unsupported variadic FFI call. Rename and delete remain unavailable until their complete commit and recursive-cleanup contracts are proven.
- macOS requires x64 or arm64, a local APFS workspace, fixed-signature root/reserved-staging descriptor acquisition, the libSystem ABI, root-descriptor-relative no-follow publication, and a no-replace create witness. Rename and delete remain unavailable until their complete commit and recursive-cleanup contracts are proven.

An unsupported platform, unsupported filesystem, failed native load, missing primitive, or failed witness returns the all-false backend. Browse, edit, versioned save, search, and terminal capabilities remain independent of this structural backend.

Windows uses the strong `backend-owned-handle-relative-v1` confinement tier. Linux and macOS use `trusted-local-dirfd-relative-v1`, which is designed for Harness' single trusted local user: it rejects browser path traversal, symlinks, and mount crossing, but it is not an OS sandbox and does not promise to defeat another process running as the same user that actively reparents directories during a mutation. Detected final-state uncertainty is reported as recovery-required and disables further structural operations for that workspace.

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
