# Roadmap

This roadmap describes direction, not a compatibility promise. The project is currently `0.1.0-alpha.0`; correctness, containment, and integration quality take precedence over feature count.

## Current baseline

- Optional native Harness `IDE` conversation view; Chat remains the default.
- Same-origin theme and `zh`/`en` locale integration.
- Explorer, quick open, workspace search/replace preview, CodeMirror editing, and Seti-style file icons.
- Lazy syntax support for the documented mainstream languages.
- Up to four editor groups with tab reorder and top/right split gestures.
- xterm.js bottom panel with bounded Host PTYs.
- Version-aware saves, conflict UI, browser-local hot-exit recovery, and receipt-backed structural mutations.
- Windows x64 + NTFS handle-relative create, move/rename, and delete; fail-closed structural controls elsewhere.
- Git installation from the repository's checked-in, CI-verified prebuilt `dist/`, plus GitHub prerelease tarballs with SHA-256 checksums; npm publication remains out of scope for this alpha.

## Near term: stabilize the alpha

- Complete manual interaction passes for editor-group drag/drop, panel geometry, focus, keyboard-only operation, and dirty-close flows.
- Add browser-driven smoke coverage for the native Harness tab, composer suppression, theme/locale synchronization, terminal collapse, and reload recovery.
- Tighten accessibility labels, focus restoration, contrast, and reduced-motion behavior.
- Keep install, update, removal, compatibility, and troubleshooting documentation synchronized with the pinned Harness baseline.
- Exercise install, update, removal, and rollback smoke checks against each prerelease artifact before promoting compatibility claims.

## Platform work

- Design and prove containment backends for Linux and macOS before enabling Explorer structural mutations there.
- Expand CI and runtime witnesses across supported Node versions, filesystems, and host architectures.
- Establish a documented Chromium/Firefox/Safari browser matrix instead of inferred support.

## Lightweight editor evolution

Candidate additions must remain optional or lazy-loaded:

- diagnostics and formatting through small, explicit adapters;
- an opt-in Language Server Protocol bridge with bounded process and workspace authority;
- lightweight source-control status and diff views;
- additional language grammars where bundle cost and maintenance are justified;
- session/export tooling that does not leak workspace content by default.

## Non-goals

- Replacing Harness chat, sessions, or workspace ownership.
- Becoming a pixel-for-pixel VS Code clone.
- Hosting the VS Code extension runtime or claiming general VSIX compatibility.
- Bundling arbitrary compilers, SDKs, language servers, or debuggers by default.
- Supporting unauthenticated remote or multi-user access.
- Enabling a filesystem operation before its Host containment and recovery behavior are proven.

`v0.1.0-alpha.0` is the first GitHub prerelease. Its canonical assets are the prebuilt `dsh-code-ide-0.1.0-alpha.0.tgz` and matching SHA-256 file; it is not an npm release. Future tags remain separate from ordinary repository pushes and require artifact, checksum, and minimum smoke evidence before publication.
