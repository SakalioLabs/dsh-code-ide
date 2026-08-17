# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added fail-closed file and folder creation on Linux x64 Hosts that pass the runtime `openat2` probe.
- Added fail-closed file and folder creation for local APFS workspaces on macOS x64/arm64 Hosts that pass the runtime `libSystem` probe.
- Added source/safe-preview switching for `.md`, `.markdown`, and `.mdx`, rendering the current unsaved buffer without executing raw HTML or MDX.
- Added bounded, read-only image, audio, and video previews with an extension allow-list, native controls, same-origin media delivery, and HTTP Range streaming for audio/video.

### Changed

- Committed the prebuilt `dist/` output and removed install-time plugin builds so `github:SakalioLabs/dsh-code-ide` installs without a pnpm `allowBuilds` entry.
- Clarified platform capabilities and trust tiers: Windows x64 with local NTFS uses strong handle containment and retains full create, move/rename, and permanent-delete support. Linux x64 and macOS use a trusted-local `dirfd` tier for creation only; it rejects browser-request traversal, existing or racing symlinks, and mount crossing, but does not resist active same-UID rename/reparent races. Linux ARM64 and other architectures remain fail-closed until a fixed-signature `openat2` shim is shipped. Linux/macOS move, rename, and delete operations remain disabled. Failed runtime probes fail closed, and indeterminate post-commit results become `recoveryRequired` or fail closed, without affecting browsing, editing, saving, search, or terminals.
- Documented media as read-only and non-autoplaying, with a 512 MiB default `maxMediaBytes` limit (8 GiB hard maximum), no SVG support, and no change to the absence of VS Code extension compatibility.

## [0.1.0-alpha.0] - 2026-08-17

### Added

- Native optional `IDE` conversation view for DeepSeek Harness.
- Explorer, CodeMirror editor groups, workspace search/replace, Command Palette, configurable shortcuts, and multi-session terminal.
- English and Simplified Chinese UI with Harness theme and locale synchronization.
- Simplified Chinese, English, Japanese, and German documentation.

### Changed

- Prepared the project as a standalone GitHub repository with package metadata, CI, installation guidance, and security/compatibility documentation.
- Published the initial alpha as a GitHub prerelease with a prebuilt `.tgz` and SHA-256 checksum; this version is not published to npm.
