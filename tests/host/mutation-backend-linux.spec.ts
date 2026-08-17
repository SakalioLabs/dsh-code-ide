import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { versionOf } from '../../src/host/filesystem.js'
import { createLinuxMutationBackend } from '../../src/host/mutation-backend-linux.js'

describe('Linux openat2 handle-relative mutation backend', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
    'creates files and directories while rename/delete remain explicitly fail-closed',
    async () => {
      const backend = await createLinuxMutationBackend()
      cleanups.push(async () => { await backend.dispose() })
      expect(backend.descriptor).toMatchObject({
        implementation: 'linux-openat2-handles',
        confinement: 'trusted-local-dirfd-relative-v1',
        capabilities: {
          createFile: true,
          createDirectory: true,
          rename: false,
          delete: false,
        },
      })

      const root = await mkdtemp(join(tmpdir(), 'dsh-linux-backend-'))
      const outside = await mkdtemp(join(tmpdir(), 'dsh-linux-backend-outside-'))
      cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
      cleanups.push(async () => { await rm(outside, { recursive: true, force: true }) })
      await mkdir(join(root, 'parent'))
      await writeFile(join(outside, 'sentinel.txt'), 'sentinel')
      await symlink(outside, join(root, 'linked-parent'))

      const identity = await lstat(root, { bigint: true })
      const workspace = await backend.openWorkspace({
        workspaceId: 'workspace',
        registeredRoot: root,
        expectedRootIdentity: { dev: identity.dev, ino: identity.ino },
        signal: new AbortController().signal,
      })
      cleanups.push(async () => { await workspace.dispose() })
      const signal = new AbortController().signal

      await expect(workspace.execute({
        executionId: 'file',
        operation: { kind: 'createFile', path: { segments: ['parent', 'created.txt'] } },
        signal,
      })).resolves.toMatchObject({
        state: 'committed', evidence: { kind: 'createFile', resourceKind: 'file' },
      })
      await expect(readFile(join(root, 'parent', 'created.txt'), 'utf8')).resolves.toBe('')

      await expect(workspace.execute({
        executionId: 'directory',
        operation: { kind: 'createDirectory', path: { segments: ['parent', 'created-directory'] } },
        signal,
      })).resolves.toMatchObject({
        state: 'committed', evidence: { kind: 'createDirectory', resourceKind: 'directory' },
      })

      await expect(workspace.execute({
        executionId: 'collision',
        operation: { kind: 'createFile', path: { segments: ['parent', 'created.txt'] } },
        signal,
      })).resolves.toMatchObject({ state: 'notCommitted', error: { code: 'DESTINATION_EXISTS' } })

      await expect(workspace.execute({
        executionId: 'symlink-parent',
        operation: { kind: 'createFile', path: { segments: ['linked-parent', 'escaped.txt'] } },
        signal,
      })).resolves.toMatchObject({ state: 'notCommitted', error: { code: 'SYMLINK_NOT_ALLOWED' } })
      await expect(readFile(join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('sentinel')
      await expect(lstat(join(outside, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      const created = await lstat(join(root, 'parent', 'created.txt'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'rename-disabled',
        operation: {
          kind: 'rename', path: { segments: ['parent', 'created.txt'] },
          destinationPath: { segments: ['parent', 'renamed.txt'] },
          expected: { kind: 'file', version: versionOf(created) },
        }, signal,
      })).resolves.toMatchObject({
        state: 'notCommitted', error: { code: 'WORKSPACE_MUTATION_UNAVAILABLE', httpStatus: 501 },
      })
      await expect(readFile(join(root, 'parent', 'created.txt'), 'utf8')).resolves.toBe('')

      await expect(workspace.execute({
        executionId: 'delete-disabled',
        operation: {
          kind: 'delete', path: { segments: ['parent', 'created.txt'] },
          expected: { kind: 'file', version: versionOf(created) }, recursive: false,
        }, signal,
      })).resolves.toMatchObject({
        state: 'notCommitted', error: { code: 'WORKSPACE_MUTATION_UNAVAILABLE', httpStatus: 501 },
      })
      await expect(readFile(join(root, 'parent', 'created.txt'), 'utf8')).resolves.toBe('')

      const aborted = new AbortController()
      aborted.abort()
      await expect(workspace.execute({
        executionId: 'cancelled',
        operation: { kind: 'createFile', path: { segments: ['parent', 'cancelled.txt'] } },
        signal: aborted.signal,
      })).resolves.toMatchObject({ state: 'notCommitted', error: { code: 'MUTATION_CANCELLED' } })
      await expect(lstat(join(root, 'parent', 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(backend.openWorkspace({
        workspaceId: 'wrong-root', registeredRoot: root,
        expectedRootIdentity: { dev: identity.dev, ino: identity.ino + 1n }, signal,
      })).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' })
    },
  )

  it.runIf(process.platform === 'linux' && process.arch !== 'x64')(
    'fails closed when no fixed-signature openat2 shim is available for the architecture',
    async () => {
      const backend = await createLinuxMutationBackend()
      cleanups.push(async () => { await backend.dispose() })
      expect(backend.descriptor).toMatchObject({
        implementation: 'unavailable',
        capabilities: { createFile: false, createDirectory: false, rename: false, delete: false },
      })
    },
  )
})
