# Development

## Repository setup

Use a supported Node.js version and the pinned pnpm release:

~~~bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
~~~

Useful commands:

| Command | Result |
| --- | --- |
| `pnpm dev` | Starts the standalone Vite client for UI development |
| `pnpm typecheck` | Checks Host and browser TypeScript projects |
| `pnpm test` | Runs the Vitest suite once |
| `pnpm test:watch` | Runs Vitest in watch mode |
| `pnpm build` | Rebuilds Host, standalone client, and Harness client injection |
| `pnpm build && pnpm pack` | Rebuilds all package outputs, then creates the installable `.tgz`; `pnpm pack` alone does not build |

The standalone Vite page does not invent Host capabilities. File, search, mutation, and terminal operations require the plugin to be loaded by Harness.

## Source layout

~~~text
src/
|-- harness-client/  # conversation.view contribution, composer, theme and locale bridge
|-- host/            # Cordis providers, routes, filesystem, search, terminal, mutation backend
|-- client/          # React/CodeMirror/xterm workbench
`-- shared/          # versioned JSON-safe Host/browser contracts
tests/
|-- host/
`-- client/
examples/           # reference bundle patch; installation applies the real patch automatically
~~~

`pnpm build` produces three relevant output surfaces:

- `dist/host/` - the Cordis Host plugin;
- `dist/client/` - the standalone/embedded workbench assets;
- `dist/harness-client/` - the native Harness view contribution.

The committed `dist/` tree is the Git-install surface. After changing source code, run `pnpm build` and include the refreshed output in the same change. CI rebuilds these targets and verifies that committed `dist/` is synchronized before accepting the change.

## Test against the validated Harness

Prepare the validated Harness checkout (`0.1.1-rc.2`, tag `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`):

~~~bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout dsh-v0.1.1-rc.2 # b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
pnpm install --frozen-lockfile
pnpm build
~~~

Build and pack this repository:

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm pack
~~~

Then, from the Harness checkout, install the generated archive with an absolute path:

~~~bash
pnpm dsh plugin --profile web add "/absolute/path/dsh-code-ide-0.1.0-alpha.0.tgz"
pnpm dsh plugin --profile web list --depth 0
pnpm dsh --profile web --dump-config
pnpm dsh web
~~~

Use the same `DSH_HOME` for installation, inspection, and startup. Installation applies the package's `dsh.bundle.patch` automatically; do not also copy the example patch into a user patch.

For a faster local loop, build this repository and install its absolute directory instead of an archive:

~~~bash
pnpm dsh plugin --profile web add "/absolute/path/dsh-code-ide"
~~~

Rebuild the plugin, re-add the same source, and restart Harness after changing Host or injected-client code.

## Change discipline

- Keep the default Harness chat path untouched; IDE behavior belongs behind the optional view.
- Keep shared wire contracts versioned and JSON-safe.
- Treat the browser as untrusted. Path, workspace, version, and size checks must remain on the Host.
- Do not advertise a structural operation unless a complete containment backend proves it.
- Add focused regression tests for lifecycle, conflict, cancellation, drag/drop, persistence, or security-boundary changes.
- Prefer lazy language chunks and bounded background work to keep the plugin lightweight.

CI repeats `install`, `typecheck`, `test`, `build`, and `pack` on Windows and Ubuntu, verifies the committed `dist/` against a clean build, and uploads the generated package as a workflow artifact.
