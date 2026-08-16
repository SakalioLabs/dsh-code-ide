import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { versionOf } from '../../src/host/filesystem.js'
import { createWindowsMutationBackend } from '../../src/host/mutation-backend-windows.js'

describe('Windows handle-relative mutation backend', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
    'creates, renames, and deletes files and directories through held Windows handles',
    async () => {
      const backend = await createWindowsMutationBackend()
      cleanups.push(async () => { await backend.dispose() })
      expect(backend.descriptor).toMatchObject({
        implementation: 'windows-nt-handles',
        confinement: 'backend-owned-handle-relative-v1',
        capabilities: {
          createFile: true,
          createDirectory: true,
          rename: true,
          delete: true,
        },
      })

      const root = await mkdtemp(join(tmpdir(), 'dsh-windows-backend-'))
      cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
      await mkdir(join(root, 'parent'))
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
        state: 'committed',
        evidence: { kind: 'createFile', resourceKind: 'file' },
      })
      await expect(readFile(join(root, 'parent', 'created.txt'), 'utf8')).resolves.toBe('')

      await expect(workspace.execute({
        executionId: 'collision',
        operation: { kind: 'createFile', path: { segments: ['parent', 'created.txt'] } },
        signal,
      })).resolves.toEqual({
        state: 'notCommitted',
        error: { code: 'DESTINATION_EXISTS', message: 'The destination already exists.', httpStatus: 409 },
      })

      await expect(workspace.execute({
        executionId: 'directory',
        operation: { kind: 'createDirectory', path: { segments: ['parent', 'created-directory'] } },
        signal,
      })).resolves.toMatchObject({
        state: 'committed',
        evidence: { kind: 'createDirectory', resourceKind: 'directory' },
      })
      await expect(lstat(join(root, 'parent', 'created-directory'))).resolves.toMatchObject({})

      const createdFile = await lstat(join(root, 'parent', 'created.txt'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'rename',
        operation: {
          kind: 'rename',
          path: { segments: ['parent', 'created.txt'] },
          destinationPath: { segments: ['parent', 'renamed.txt'] },
          expected: { kind: 'file', version: versionOf(createdFile) },
        },
        signal,
      })).resolves.toMatchObject({
        state: 'committed',
        evidence: { kind: 'rename', resourceKind: 'file' },
      })
      await expect(lstat(join(root, 'parent', 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(root, 'parent', 'renamed.txt'), 'utf8')).resolves.toBe('')

      await workspace.execute({
        executionId: 'collision-source',
        operation: { kind: 'createFile', path: { segments: ['parent', 'collision-source.txt'] } },
        signal,
      })
      await workspace.execute({
        executionId: 'collision-target',
        operation: { kind: 'createFile', path: { segments: ['parent', 'collision-target.txt'] } },
        signal,
      })
      const collisionSource = await lstat(join(root, 'parent', 'collision-source.txt'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'rename-collision',
        operation: {
          kind: 'rename',
          path: { segments: ['parent', 'collision-source.txt'] },
          destinationPath: { segments: ['parent', 'collision-target.txt'] },
          expected: { kind: 'file', version: versionOf(collisionSource) },
        },
        signal,
      })).resolves.toEqual({
        state: 'notCommitted',
        error: { code: 'DESTINATION_EXISTS', message: 'The destination already exists.', httpStatus: 409 },
      })
      await expect(readFile(join(root, 'parent', 'collision-source.txt'), 'utf8')).resolves.toBe('')
      await expect(readFile(join(root, 'parent', 'collision-target.txt'), 'utf8')).resolves.toBe('')

      const createdDirectory = await lstat(join(root, 'parent', 'created-directory'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'rename-directory',
        operation: {
          kind: 'rename',
          path: { segments: ['parent', 'created-directory'] },
          destinationPath: { segments: ['parent', 'renamed-directory'] },
          expected: { kind: 'directory', version: versionOf(createdDirectory) },
        },
        signal,
      })).resolves.toMatchObject({
        state: 'committed',
        evidence: { kind: 'rename', resourceKind: 'directory' },
      })
      await expect(lstat(join(root, 'parent', 'renamed-directory'))).resolves.toMatchObject({})

      const renamedFile = await lstat(join(root, 'parent', 'renamed.txt'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'delete',
        operation: {
          kind: 'delete',
          path: { segments: ['parent', 'renamed.txt'] },
          expected: { kind: 'file', version: versionOf(renamedFile) },
          recursive: false,
        },
        signal,
      })).resolves.toMatchObject({
        state: 'committed',
        evidence: { kind: 'delete', resourceKind: 'file', recursive: false },
      })
      await expect(lstat(join(root, 'parent', 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      const emptyDirectory = await lstat(join(root, 'parent', 'renamed-directory'), { bigint: true })
      await expect(workspace.execute({
        executionId: 'delete-empty-directory',
        operation: {
          kind: 'delete',
          path: { segments: ['parent', 'renamed-directory'] },
          expected: { kind: 'directory', version: versionOf(emptyDirectory) },
          recursive: false,
        },
        signal,
      })).resolves.toMatchObject({ state: 'committed', evidence: { kind: 'delete', recursive: false } })

      const tree = join(root, 'parent', 'tree')
      const outside = join(root, 'parent', 'outside')
      await mkdir(join(tree, 'nested'), { recursive: true })
      await writeFile(join(tree, 'nested', 'leaf.txt'), 'leaf')
      await mkdir(outside)
      await writeFile(join(outside, 'sentinel.txt'), 'sentinel')
      await symlink(outside, join(tree, 'outside-junction'), 'junction')
      let treeInfo = await lstat(tree, { bigint: true })
      await expect(workspace.execute({
        executionId: 'reject-nonrecursive-tree',
        operation: {
          kind: 'delete', path: { segments: ['parent', 'tree'] },
          expected: { kind: 'directory', version: versionOf(treeInfo) }, recursive: false,
        },
        signal,
      })).resolves.toMatchObject({ state: 'notCommitted', error: { code: 'DIRECTORY_NOT_EMPTY' } })
      treeInfo = await lstat(tree, { bigint: true })
      const recursiveOutcome = await workspace.execute({
        executionId: 'delete-recursive-tree',
        operation: {
          kind: 'delete', path: { segments: ['parent', 'tree'] },
          expected: { kind: 'directory', version: versionOf(treeInfo) }, recursive: true,
        },
        signal,
      })
      expect(recursiveOutcome).toMatchObject({
        state: 'committed', evidence: { kind: 'delete', resourceKind: 'directory', recursive: true },
      })
      await expect(lstat(tree)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('sentinel')

      await expect(backend.openWorkspace({
        workspaceId: 'wrong-root',
        registeredRoot: root,
        expectedRootIdentity: { dev: identity.dev, ino: identity.ino + 1n },
        signal,
      })).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' })
    },
  )
})
