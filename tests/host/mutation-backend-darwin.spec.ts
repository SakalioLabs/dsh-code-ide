import { constants, fstat, open, openSync, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDarwinMutationBackend,
  createDarwinMutationBackendForTesting,
  createProbedDarwinMutationBackendForTesting,
  createDarwinMutationWorkspaceForTesting,
  darwinFstatfsSymbolForTesting,
  type DarwinMutationKernelPort,
  type DarwinNodeIoPort,
} from '../../src/host/mutation-backend-darwin.js'

describe('Darwin openat mutation backend', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it('selects the modern statfs symbol for each supported Darwin ABI', () => {
    expect(darwinFstatfsSymbolForTesting('x64')).toBe('fstatfs$INODE64')
    expect(darwinFstatfsSymbolForTesting('arm64')).toBe('fstatfs')
  })

  it.skipIf(process.platform === 'darwin')('is unavailable on other operating systems', async () => {
    const backend = await createDarwinMutationBackend()
    cleanups.push(async () => { await backend.dispose() })
    expect(backend.descriptor).toMatchObject({
      implementation: 'unavailable',
      capabilities: { createFile: false, createDirectory: false, rename: false, delete: false },
    })
  })

  it('returns recoveryRequired and poisons the workspace when reserved staging cleanup is uncertain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-darwin-backend-mock-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const rootFd = openSync(root, constants.O_RDONLY)
    const rootInfo = await new Promise<BigIntStats>((resolve, reject) => {
      fstat(rootFd, { bigint: true }, (error, info) => { error === null ? resolve(info) : reject(error) })
    })
    const openedByPath = new Map<string, number>()
    const fstatForTest = async (fd: number) => await new Promise<BigIntStats>((resolve, reject) => {
      fstat(fd, { bigint: true }, (error, info) => { error === null ? resolve(info) : reject(error) })
    })
    const openForTest = vi.fn(async (path: string, _flags: number, mode: number) => await new Promise<number>((resolve, reject) => {
        const portableFlags = mode === 0
          ? constants.O_RDONLY
          : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        open(path, portableFlags, mode, (error, fd) => {
          if (error !== null) {
            reject(error)
            return
          }
          openedByPath.set(path, fd)
          resolve(fd)
        })
      }))
    const io: DarwinNodeIoPort = {
      open: openForTest,
      fstat: async fd => fd === rootFd ? rootInfo : await fstatForTest(fd),
      lstat: async path => {
        if (path === root) return rootInfo
        const fd = openedByPath.get(path)
        return fd === undefined ? await lstat(path, { bigint: true }) : await fstatForTest(fd)
      },
      mkdir: async (path, mode) => { await mkdir(path, { mode }) },
    }
    let releasePublish!: () => void
    const publishGate = new Promise<void>(resolve => { releasePublish = resolve })
    const publishNoReplace = vi.fn(async () => {
        await publishGate
        return { value: -1, errnoCode: 17 }
      })
    const unlink = vi.fn(async () => ({ value: -1, errnoCode: 5 }))
    const kernel: DarwinMutationKernelPort = {
      publishNoReplace,
      // Simulate an indeterminate unlinkat result after the publication
      // failure. The reserved staging object therefore cannot be declared gone.
      unlink,
      assertLocalApfs: async () => {},
      dispose: () => {},
    }
    const workspace = createDarwinMutationWorkspaceForTesting({
      workspaceId: 'mock', canonicalRoot: root, rootFd,
      rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino }, kernel, io,
    })
    cleanups.push(async () => { await workspace.dispose() })
    const signal = new AbortController().signal

    const uncertain = workspace.execute({
      executionId: 'cleanup-uncertain',
      operation: { kind: 'createFile', path: { segments: ['collision.txt'] } },
      signal,
    })
    // Admit the second execution before the first poisons the workspace. It
    // must re-check poison state when its queue turn begins.
    const alreadyQueued = workspace.execute({
      executionId: 'already-queued',
      operation: { kind: 'createFile', path: { segments: ['must-not-run.txt'] } },
      signal,
    })
    releasePublish()
    await expect(uncertain).resolves.toMatchObject({
      state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' },
    })
    await expect(alreadyQueued).resolves.toMatchObject({
      state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' },
    })
    expect(openForTest).toHaveBeenCalledOnce()
    expect(publishNoReplace).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledOnce()
    await expect(lstat(join(root, 'must-not-run.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'darwin' || (process.arch !== 'x64' && process.arch !== 'arm64'))(
    'drains a pending workspace open before disposing the native kernel',
    async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-darwin-open-lifecycle-'))
      cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
      const identity = await lstat(root, { bigint: true })
      let releaseProbe!: () => void
      const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
      let markProbeStarted!: () => void
      const probeStarted = new Promise<void>(resolve => { markProbeStarted = resolve })
      const dispose = vi.fn()
      const kernel: DarwinMutationKernelPort = {
        publishNoReplace: async () => ({ value: -1, errnoCode: 17 }),
        unlink: async () => ({ value: 0, errnoCode: 0 }),
        assertLocalApfs: async () => {
          markProbeStarted()
          await probeGate
        },
        dispose,
      }
      const backend = createDarwinMutationBackendForTesting(kernel)
      const opening = backend.openWorkspace({
        workspaceId: 'pending-open', registeredRoot: root,
        expectedRootIdentity: { dev: identity.dev, ino: identity.ino },
        signal: new AbortController().signal,
      })
      await Promise.race([
        probeStarted,
        opening.then(
          () => { throw new Error('Workspace opening completed before the probe gate.') },
          error => { throw error },
        ),
      ])
      const disposing = backend.dispose()
      expect(dispose).not.toHaveBeenCalled()
      releaseProbe()
      await expect(opening).rejects.toMatchObject({ code: 'WORKSPACE_MUTATION_UNAVAILABLE' })
      await disposing
      expect(dispose).toHaveBeenCalledOnce()
    },
  )

  it.skipIf(process.platform !== 'darwin' || (process.arch !== 'x64' && process.arch !== 'arm64'))(
    'publishes files and directories without following workspace symlinks',
    async () => {
      // The production factory fails closed. The platform gate deliberately
      // uses the throwing witness so CI retains the exact native cause.
      const backend = await createProbedDarwinMutationBackendForTesting()
      cleanups.push(async () => { await backend.dispose() })
      expect(backend.descriptor).toMatchObject({
        implementation: 'darwin-openat-handles',
        confinement: 'trusted-local-dirfd-relative-v1',
        capabilities: { createFile: true, createDirectory: true, rename: false, delete: false },
      })

      const canonicalTmp = await realpath(tmpdir())
      const root = await mkdtemp(join(canonicalTmp, 'dsh-darwin-backend-test-'))
      const outside = await mkdtemp(join(canonicalTmp, 'dsh-darwin-backend-outside-'))
      cleanups.push(async () => { await rm(outside, { recursive: true, force: true }) })
      cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
      await mkdir(join(root, 'parent'))
      await symlink(outside, join(root, 'outside-link'))
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
        executionId: 'collision',
        operation: { kind: 'createFile', path: { segments: ['parent', 'created.txt'] } },
        signal,
      })).resolves.toMatchObject({ state: 'notCommitted', error: { code: 'DESTINATION_EXISTS' } })

      await expect(workspace.execute({
        executionId: 'directory',
        operation: { kind: 'createDirectory', path: { segments: ['parent', 'created-directory'] } },
        signal,
      })).resolves.toMatchObject({
        state: 'committed', evidence: { kind: 'createDirectory', resourceKind: 'directory' },
      })
      await expect(lstat(join(root, 'parent', 'created-directory'))).resolves.toMatchObject({})

      await expect(workspace.execute({
        executionId: 'symlink',
        operation: { kind: 'createFile', path: { segments: ['outside-link', 'escaped.txt'] } },
        signal,
      })).resolves.toMatchObject({ state: 'notCommitted' })
      await expect(lstat(join(outside, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      await expect(backend.openWorkspace({
        workspaceId: 'wrong-root',
        registeredRoot: root,
        expectedRootIdentity: { dev: identity.dev, ino: identity.ino + 1n },
        signal,
      })).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' })
    },
  )
})
