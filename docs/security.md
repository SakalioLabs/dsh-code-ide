# Security model

`dsh-code-ide` is a privileged local development surface. It can read and save workspace files and can start a real shell. Its current threat model is a single trusted user running Harness on a loopback interface. It is not an authenticated remote IDE and must not be exposed to a LAN or the public internet.

## Request boundary

All IDE HTTP and WebSocket routes require:

- a canonical loopback `Host` (`localhost`, `[::1]`, or an IPv4 address in `127/8`);
- no `Sec-Fetch-Site: cross-site` request;
- when `Origin` is present, the exact same scheme/authority origin as the request host.

This is a DNS-rebinding and cross-site fence, not user authentication. Code already trusted on the Harness origin shares that origin's authority.

Static assets receive a restrictive Content Security Policy, same-origin resource policy, MIME sniffing protection, and `SAMEORIGIN` framing policy. Static path decoding rejects traversal and resolves files beneath the configured static root.

## Workspace containment

The Host never accepts a browser-supplied absolute filesystem path. It resolves an opaque `workspaceId` through the Harness workspace registry and then enforces:

- a real, non-symlink workspace root;
- canonical root identity (`dev`/`ino`) pinned for the provider epoch and revalidated on use;
- slash-separated relative paths only, with no empty, `.`, `..`, absolute, backslash, control-character, reserved-device, or Host-reserved segments;
- no symbolic links or reparse points in traversed workspace paths;
- no browser-selected path that resolves outside the registered root under the backend's documented threat model;
- no cross-device or nested mount traversal where containment cannot be proven.

Structural mutations are exposed only after a platform backend passes its runtime containment witness. The descriptor reports one of two confinement tiers:

- `backend-owned-handle-relative-v1` is the strong Windows tier. Authority-bearing traversal and namespace changes remain relative to backend-owned, identity-verified handles.
- `trusted-local-dirfd-relative-v1` is the POSIX tier for this project's single-trusted-local-user model. It rejects browser path traversal, existing or raced symbolic-link traversal, and cross-device/mount traversal, then verifies the resulting identity. On macOS it may create a Host-random reserved staging name directly beneath the verified canonical root, bind the open fd to that named object, and publish it relative to the pinned root fd; a browser-selected target is never opened by an ambient pathname. The tier does **not** claim to withstand a separate process running as the same OS user that actively reparents an already opened ancestor directory during the operation. Such an adversarial race can make the final location uncertain; the backend reports `recoveryRequired` and poisons that workspace when uncertainty is detected.

Platform implementations are deliberately asymmetric:

- Windows x64 uses the NTFS handle-relative backend and excludes reparse points.
- Linux x64 uses `openat2` with beneath, no-symlink, no-magic-link, and no-cross-device resolution constraints, plus descriptor-relative no-replace creation and post-commit identity verification. Linux ARM64 and other architectures remain fail-closed until a fixed-signature native `openat2` shim is available. Rename and delete capabilities remain false on Linux.
- macOS x64/arm64 uses a pinned root descriptor on a local APFS volume, fixed-signature Node filesystem calls for root and reserved-staging descriptor acquisition, and no-replace/no-follow `renameatx_np` publication with post-commit identity verification. Its rename and delete capabilities remain false.

The provider loads only the backend matching the Host platform. An unsupported filesystem or architecture, missing native primitive, dynamic-load failure, or failed witness installs the all-false backend; it never promotes an unproven operation.

## Reads and saves

File reads are bounded and UTF-8 validated. Binary or oversized content is presented read-only. Saves are serialized per workspace and require an `expectedVersion` for an existing file. The Host revalidates the root, parent, target, and version before publishing a unique `wx` staging file, then verifies the committed file's identity and bytes.

The save strategy preserves POSIX permission bits when replacing an existing file. It does not promise to preserve ACLs, extended attributes, alternate data streams, or other filesystem metadata.

Structural mutations use caller-generated operation IDs, provider epochs, bounded queues, and expiring receipts. Once a native commit may have occurred, an interruption is classified as `recoveryRequired` instead of being reported as a rollback. Recursive deletion is bounded and excludes reparse points/mount escape.

## Search

Search launches the packaged ripgrep executable directly, not through a shell. Queries, globs, candidates, results, previews, line sizes, total output, concurrency, and runtime are bounded. Search processes are tied to request cancellation and provider disposal.

## Terminal

The terminal is intentionally powerful:

- it starts the configured shell with the workspace root as its initial working directory;
- it runs with the same operating-system user privileges as Harness;
- it is not a container or filesystem sandbox, so shell commands can leave the workspace and access anything that user can access;
- inherited environment entries whose names contain `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, plus all `DSH_` entries, are removed, but this is only exposure reduction - not a secret-management boundary;
- session count, message, input, and output-buffer sizes are bounded;
- terminal process-tree termination is best effort on shutdown.

Do not enable the terminal for users you would not trust with a local shell account.

## Browser-local data

The workbench may store layout, keybindings, open-document metadata, dirty-buffer recovery data, and unresolved mutation recovery records in origin-scoped browser storage. Treat the browser profile and the Harness origin as sensitive. Web Locks are used where available to avoid concurrent writers; if they are unavailable, affected persistence features fail closed or become read-only.

The embedded frame is same-origin and receives only an allow-list of Harness theme tokens plus a `zh`/`en` locale message. Clipboard write access is requested for explicit IDE clipboard actions.

## Operational guidance

- Bind Harness only to loopback for this alpha.
- Register only workspaces the local user intends to expose to the IDE.
- Review `terminalShell` and `terminalArgs`; they are executable configuration.
- Keep file, request, search, terminal, and mutation limits bounded.
- Back up important repositories and use version control; permanent deletion is permanent.
- Restart Harness after changing plugin binaries or configuration.

When reporting a vulnerability, avoid including private workspace contents, terminal output, credentials, or recovery data in a public issue.
