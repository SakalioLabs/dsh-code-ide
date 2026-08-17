import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutationReceipt, WorkspaceMutation } from '../../src/shared/workspace-mutations.js'
import { IdeHostError } from '../../src/host/errors.js'
import { WorkspaceFileService, versionOf } from '../../src/host/filesystem.js'
import type { NativeRenameAdapter } from '../../src/host/native-rename.js'
import { WorkspaceMutationService } from '../../src/host/workspace-mutations.js'
import { WorkspaceResources } from '../../src/host/workspace-resources.js'

const WORKSPACE_ID = 'workspace-fixture'
const TEST_BACKEND_CAPABILITIES = Object.freeze({
  createFile: true,
  createDirectory: true,
  rename: true,
  delete: true,
})

class TestNativeRename implements NativeRenameAdapter {
  readonly calls: Array<{ source: string; destination: string }> = []
  available = true

  async supported(): Promise<boolean> { return this.available }

  async moveNoReplace(source: string, destination: string): Promise<void> {
    this.calls.push({ source, destination })
    try {
      await lstat(destination)
      throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    } catch (error) {
      if (error instanceof IdeHostError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(source, destination)
  }

  async dispose(): Promise<void> {}
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise(done => { resolve = done }), resolve }
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<IdeHostError> {
  try {
    await operation
    expect.unreachable(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(IdeHostError)
    expect((error as IdeHostError).code).toBe(code)
    return error as IdeHostError
  }
}

describe('WorkspaceMutationService', () => {
  let root: string
  let resources: WorkspaceResources
  let native: TestNativeRename
  let service: WorkspaceMutationService
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }

  function createService(
    options: ConstructorParameters<typeof WorkspaceMutationService>[2] = {},
    internals: ConstructorParameters<typeof WorkspaceMutationService>[3] = {},
  ): WorkspaceMutationService {
    return new WorkspaceMutationService(resources, logger, options, {
      nativeRename: native,
      backendCapabilities: TEST_BACKEND_CAPABILITIES,
      ...internals,
    })
  }

  function body(mutation: WorkspaceMutation, operationId = randomUUID()) {
    return {
      op: 'mutate' as const,
      providerEpoch: service.providerEpoch,
      operationId,
      workspaceId: WORKSPACE_ID,
      mutation,
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-code-ide-mutations-'))
    resources = new WorkspaceResources({
      list: () => [{ id: WORKSPACE_ID, path: root, title: 'Fixture' }],
    }, { maxQueuedMutations: 8 })
    native = new TestNativeRename()
    service = createService()
  })

  afterEach(async () => {
    await service.dispose().catch(() => {})
    await resources.dispose().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  })

  it('publishes exact capabilities and rejects unknown DTO fields and hostile names', async () => {
    await expect(service.request({ op: 'provider' })).resolves.toEqual({
      providerEpoch: service.providerEpoch,
      capabilities: { createFile: true, createDirectory: true, rename: true, delete: true },
    })
    await expectCode(service.request({ op: 'provider', extra: true }), 'INVALID_REQUEST')
    await expectCode(service.request(body({ kind: 'createFile', path: 'safe.txt', extra: true } as never)), 'INVALID_REQUEST')
    await expectCode(service.request({
      op: 'status', providerEpoch: service.providerEpoch, operationId: randomUUID(), workspaceId: WORKSPACE_ID,
    }), 'INVALID_REQUEST')
    await expectCode(service.request(body({ kind: 'createFile', path: 'CON.txt' })), 'INVALID_PATH')
    await expectCode(service.request(body({ kind: 'createFile', path: 'stream:name' })), 'INVALID_PATH')
    await expectCode(service.request(body({ kind: 'createFile', path: 'tail. ' })), 'INVALID_PATH')
    await expectCode(service.request({
      ...body({ kind: 'createFile', path: 'safe.txt' }),
      operationId: 'not-a-uuid',
    }), 'INVALID_OPERATION_ID')
  })

  it('keeps the production backend all-false and rejects every mutation before side effects', async () => {
    await service.dispose()
    const list = vi.spyOn(resources.registry, 'list')
    const supported = vi.spyOn(native, 'supported')
    const moveNoReplace = vi.spyOn(native, 'moveNoReplace')
    service = new WorkspaceMutationService(resources, logger, {}, { nativeRename: native })
    expect(await service.request({ op: 'provider' })).toEqual({
      providerEpoch: service.providerEpoch,
      capabilities: { createFile: false, createDirectory: false, rename: false, delete: false },
    })

    const mutations: WorkspaceMutation[] = [
      { kind: 'createFile', path: 'file.txt' },
      { kind: 'createDirectory', path: 'folder' },
      {
        kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
        expected: { kind: 'file', version: 'opaque' },
      },
      { kind: 'delete', path: 'source.txt', expected: { kind: 'file', version: 'opaque' }, recursive: false },
    ]
    for (const mutation of mutations) {
      const operationId = randomUUID()
      await expectCode(
        service.request(body(mutation, operationId)),
        mutation.kind === 'rename' || mutation.kind === 'delete'
          ? 'ATOMIC_RENAME_UNSUPPORTED'
          : 'WORKSPACE_MUTATION_UNAVAILABLE',
      )
      expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId }))
        .toEqual({ providerEpoch: service.providerEpoch, operationId, state: 'expired' })
    }

    expect(list).not.toHaveBeenCalled()
    expect(supported).not.toHaveBeenCalled()
    expect(moveNoReplace).not.toHaveBeenCalled()
    expect((await readdir(root)).some(name => name.startsWith('.__dsh_code_ide_'))).toBe(false)
  })

  it('creates empty files and directories atomically without overwrite', async () => {
    const file = await service.request(body({ kind: 'createFile', path: 'new.txt' })) as MutationReceipt
    expect(file).toMatchObject({ state: 'committed', result: { kind: 'file', path: 'new.txt' } })
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('')
    await expectCode(service.request(body({ kind: 'createFile', path: 'new.txt' })), 'DESTINATION_EXISTS')

    const directory = await service.request(body({ kind: 'createDirectory', path: 'folder' })) as MutationReceipt
    expect(directory).toMatchObject({ state: 'committed', result: { kind: 'directory', path: 'folder' } })
    expect((await lstat(join(root, 'folder'))).isDirectory()).toBe(true)
    await expectCode(service.request(body({ kind: 'createDirectory', path: 'folder' })), 'DESTINATION_EXISTS')
  })

  it('renames files and directories with expected kind/version and never overwrites', async () => {
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const receipt = await service.request(body({
      kind: 'rename',
      path: 'source.txt',
      destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })) as MutationReceipt
    expect(receipt).toMatchObject({
      state: 'committed',
      result: { kind: 'file', path: 'source.txt', destinationPath: 'destination.txt', refreshDirectories: [''] },
    })
    expect(JSON.stringify(receipt)).not.toContain(root)
    expect(JSON.stringify(receipt)).not.toContain('__dsh_code_ide')
    expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('source')

    await mkdir(join(root, 'tree'))
    const tree = await lstat(join(root, 'tree'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'rename', path: 'tree', destinationPath: 'tree/nested',
      expected: { kind: 'directory', version: versionOf(tree) },
    })), 'INVALID_DESTINATION')

    await writeFile(join(root, 'existing.txt'), 'winner')
    const destination = await lstat(join(root, 'destination.txt'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'rename', path: 'destination.txt', destinationPath: 'existing.txt',
      expected: { kind: 'file', version: versionOf(destination) },
    })), 'DESTINATION_EXISTS')
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('winner')
  })

  it('logically deletes through a protected quarantine and purges it on disposal', async () => {
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'nested.txt'), 'nested')
    const info = await lstat(join(root, 'folder'), { bigint: true })
    const operationId = randomUUID()
    const receipt = await service.request(body({
      kind: 'delete', path: 'folder', expected: { kind: 'directory', version: versionOf(info) }, recursive: true,
    }, operationId)) as MutationReceipt
    expect(receipt).toMatchObject({
      state: 'committed',
      result: { kind: 'directory', path: 'folder', recursive: true, refreshDirectories: [''] },
    })
    await expect(lstat(join(root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).some(name => name.startsWith('.__dsh_code_ide_quarantine_'))).toBe(true)
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId })).toEqual(receipt)

    await service.dispose()
    expect((await readdir(root)).some(name => name.startsWith('.__dsh_code_ide_quarantine_'))).toBe(false)
  })

  it('requires recursive confirmation before moving a non-empty directory', async () => {
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'nested.txt'), 'nested')
    const info = await lstat(join(root, 'folder'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'delete', path: 'folder', expected: { kind: 'directory', version: versionOf(info) }, recursive: false,
    })), 'DIRECTORY_NOT_EMPTY')
    expect(await readFile(join(root, 'folder', 'nested.txt'), 'utf8')).toBe('nested')
    expect((await readdir(root)).some(name => name.startsWith('.__dsh_code_ide_quarantine_'))).toBe(false)
  })

  it('executes one operationId once and rejects a different body with the same id', async () => {
    await writeFile(join(root, 'one.txt'), 'one')
    const info = await lstat(join(root, 'one.txt'), { bigint: true })
    const operationId = randomUUID()
    const request = body({
      kind: 'rename', path: 'one.txt', destinationPath: 'two.txt',
      expected: { kind: 'file', version: versionOf(info) },
    }, operationId)
    const first = await service.request(request)
    const replay = await service.request(request)
    expect(replay).toEqual(first)
    expect(native.calls).toHaveLength(1)
    await expectCode(service.request(body({ kind: 'createFile', path: 'another.txt' }, operationId)), 'OPERATION_ID_CONFLICT')
  })

  it('reports queued/running status and turns precommit transport abort into stable notCommitted', async () => {
    const gate = deferred()
    const entered = deferred()
    const original = native.moveNoReplace.bind(native)
    native.moveNoReplace = async (source, destination) => {
      entered.resolve()
      await gate.promise
      await original(source, destination)
    }
    await writeFile(join(root, 'blocking.txt'), 'blocking')
    const info = await lstat(join(root, 'blocking.txt'), { bigint: true })
    const first = service.request(body({
      kind: 'rename', path: 'blocking.txt', destinationPath: 'blocked.txt',
      expected: { kind: 'file', version: versionOf(info) },
    }))
    await entered.promise

    const controller = new AbortController()
    const operationId = randomUUID()
    const second = service.request(body({ kind: 'createFile', path: 'cancelled.txt' }, operationId), controller.signal)
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId })).toMatchObject({ state: 'queued' })
    controller.abort()
    await expectCode(second, 'MUTATION_CANCELLED')
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId })).toMatchObject({
      state: 'notCommitted', error: { code: 'MUTATION_CANCELLED' },
    })
    gate.resolve()
    await first
    await expect(lstat(join(root, 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds receipts, expires them, and never reuses an expired id', async () => {
    await service.dispose()
    let now = 10
    service = createService({ maxReceipts: 1, receiptTtlMs: 1 }, { now: () => now })
    const firstId = randomUUID()
    await service.request(body({ kind: 'createFile', path: 'one.txt' }, firstId))
    await expectCode(service.request(body({ kind: 'createFile', path: 'two.txt' })), 'MUTATION_RECEIPT_CAPACITY')
    now = 12
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId: firstId })).toMatchObject({ state: 'expired' })
    await service.request(body({ kind: 'createFile', path: 'two.txt' }))
    await expectCode(service.request(body({ kind: 'createFile', path: 'three.txt' }, firstId)), 'OPERATION_EXPIRED')
  })

  it('uses exact bounded epoch tombstones and reports deterministic idempotency exhaustion', async () => {
    await service.dispose()
    let now = 0
    service = createService(
      { receiptTtlMs: 1, maxReceipts: 1, maxOperationIds: 2 },
      { now: () => now },
    )
    const firstId = randomUUID()
    const secondId = randomUUID()
    await service.request(body({ kind: 'createFile', path: 'exact-one.txt' }, firstId))
    now = 2
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId: firstId }))
      .toMatchObject({ state: 'expired' })
    await service.request(body({ kind: 'createFile', path: 'exact-two.txt' }, secondId))
    now = 4
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId: secondId }))
      .toMatchObject({ state: 'expired' })

    await expectCode(
      service.request(body({ kind: 'createFile', path: 'must-not-run.txt' })),
      'MUTATION_IDEMPOTENCY_CAPACITY',
    )
  })

  it('returns recoveryRequired when verification fails after the native commit', async () => {
    await service.dispose()
    service = createService({}, {
      afterNativeCommit: async (kind, destination) => {
        if (kind === 'rename') await writeFile(destination, 'changed after commit')
      },
    })
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const receipt = await service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })) as MutationReceipt
    expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
  })

  it('detects same-size content replacement even when mtime and mode are restored', async () => {
    await service.dispose()
    const stamp = new Date('2024-01-02T03:04:05.000Z')
    service = createService({}, {
      afterNativeCommit: async (kind, destination) => {
        if (kind !== 'rename') return
        const committed = await lstat(destination, { bigint: true })
        const replacement = join(dirname(destination), `replacement-${randomUUID()}`)
        await writeFile(replacement, 'BBBB')
        await chmod(replacement, Number(committed.mode & 0o7777n))
        await utimes(replacement, stamp, stamp)
        await rename(replacement, destination)
      },
    })
    await writeFile(join(root, 'source.txt'), 'AAAA')
    await utimes(join(root, 'source.txt'), stamp, stamp)
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const receipt = await service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })) as MutationReceipt
    expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
    expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('BBBB')
    const replacement = await lstat(join(root, 'destination.txt'), { bigint: true })
    expect(replacement).toMatchObject({ size: info.size, mtimeNs: info.mtimeNs, mode: info.mode })
  })

  it('pins the directory created by mkdir before reporting a commit', async () => {
    await service.dispose()
    service = createService({}, {
      afterCreateCommit: async (kind, destination) => {
        if (kind !== 'directory') return
        await rename(destination, `${destination}.displaced`)
        await mkdir(destination)
      },
    })
    const receipt = await service.request(body({ kind: 'createDirectory', path: 'folder' })) as MutationReceipt
    expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
    expect((await lstat(join(root, 'folder.displaced'))).isDirectory()).toBe(true)
  })

  it('does not commit when a destination parent is rebound through a symlink at the native seam', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-code-ide-parent-fence-'))
    const original = native.moveNoReplace.bind(native)
    let rebound: string | undefined
    native.moveNoReplace = async (source, destination) => {
      const parent = dirname(destination)
      const displaced = join(outside, 'displaced-parent')
      await rename(parent, displaced)
      await symlink(displaced, parent, process.platform === 'win32' ? 'junction' : 'dir')
      rebound = parent
      await original(source, destination)
    }
    await mkdir(join(root, 'destination-parent'))
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    try {
      const receipt = await service.request(body({
        kind: 'rename', path: 'source.txt', destinationPath: 'destination-parent/destination.txt',
        expected: { kind: 'file', version: versionOf(info) },
      })) as MutationReceipt
      expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
      expect(await readFile(join(outside, 'displaced-parent', 'destination.txt'), 'utf8')).toBe('source')
    } finally {
      if (rebound !== undefined) await unlink(rebound).catch(() => {})
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not commit when the quarantine container is rebound through a symlink', async () => {
    await service.dispose()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-code-ide-quarantine-fence-'))
    let rebound: string | undefined
    service = createService({}, {
      afterNativeCommit: async (kind, payload) => {
        if (kind !== 'delete') return
        const quarantine = dirname(payload)
        const displaced = join(outside, 'displaced-quarantine')
        await rename(quarantine, displaced)
        await symlink(displaced, quarantine, process.platform === 'win32' ? 'junction' : 'dir')
        rebound = quarantine
      },
    })
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    try {
      const receipt = await service.request(body({
        kind: 'delete', path: 'source.txt', expected: { kind: 'file', version: versionOf(info) }, recursive: false,
      })) as MutationReceipt
      expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
      expect(await readFile(join(outside, 'displaced-quarantine', 'payload'), 'utf8')).toBe('source')
    } finally {
      if (rebound !== undefined) await unlink(rebound).catch(() => {})
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not report success when the source identity is swapped at the native-call seam', async () => {
    const original = native.moveNoReplace.bind(native)
    native.moveNoReplace = async (source, destination) => {
      await rename(source, `${source}.displaced`)
      await writeFile(source, 'attacker replacement')
      await original(source, destination)
    }
    await writeFile(join(root, 'source.txt'), 'original')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const receipt = await service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })) as MutationReceipt
    expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
    expect(await readFile(join(root, 'source.txt.displaced'), 'utf8')).toBe('original')
  })

  it('preserves the source when an external destination wins the no-replace race', async () => {
    const original = native.moveNoReplace.bind(native)
    native.moveNoReplace = async (source, destination) => {
      await writeFile(destination, 'external winner')
      await original(source, destination)
    }
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })), 'DESTINATION_EXISTS')
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source')
    expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('external winner')
  })

  it('requires recovery if an owned quarantine is unexpectedly populated before commit', async () => {
    native.moveNoReplace = async (_source, destination) => {
      await writeFile(destination, 'unexpected')
      throw new IdeHostError('DESTINATION_EXISTS', 'The destination already exists.', 409)
    }
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const receipt = await service.request(body({
      kind: 'delete', path: 'source.txt', expected: { kind: 'file', version: versionOf(info) }, recursive: false,
    })) as MutationReceipt
    expect(receipt).toMatchObject({ state: 'recoveryRequired', error: { code: 'MUTATION_RECOVERY_REQUIRED' } })
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source')
  })

  it('serializes file writes and mutations through the same workspace queue', async () => {
    const published = deferred()
    const release = deferred()
    const files = new WorkspaceFileService(resources.registry, {
      maxFileBytes: 1024,
      maxDirectoryEntries: 100,
    }, {
      afterPublishCommit: async () => { published.resolve(); await release.promise },
    }, resources)
    const write = files.write(WORKSPACE_ID, 'written.txt', 'content', undefined)
    await published.promise
    const operationId = randomUUID()
    const mutation = service.request(body({ kind: 'createFile', path: 'after.txt' }, operationId))
    expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId })).toMatchObject({ state: 'queued' })
    await expect(lstat(join(root, 'after.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve()
    await Promise.all([write, mutation])
    expect(await readFile(join(root, 'after.txt'), 'utf8')).toBe('')
  })

  it('pins workspace root identity across path replacement', async () => {
    await service.request(body({ kind: 'createFile', path: 'pin.txt' }))
    const oldRoot = `${root}-old`
    await rename(root, oldRoot)
    await mkdir(root)
    try {
      await expectCode(service.request(body({ kind: 'createFile', path: 'must-not-land.txt' })), 'WORKSPACE_IDENTITY_CHANGED')
      await expect(lstat(join(root, 'must-not-land.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rename(oldRoot, root)
    }
  })

  it('uses provider epoch mismatch as the explicit restart reconciliation boundary', async () => {
    const oldEpoch = service.providerEpoch
    await service.dispose()
    service = createService()
    expect(service.providerEpoch).not.toBe(oldEpoch)
    await expectCode(service.request({
      op: 'status',
      providerEpoch: oldEpoch,
      operationId: randomUUID(),
    }), 'PROVIDER_EPOCH_MISMATCH')
  })

  it('advertises and enforces unsupported native rename/delete without fallback', async () => {
    native.available = false
    expect(await service.request({ op: 'provider' })).toMatchObject({
      capabilities: { createFile: true, createDirectory: true, rename: false, delete: false },
    })
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    })), 'ATOMIC_RENAME_UNSUPPORTED')
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source')
  })

  it('drains a commit-boundary operation and cancels queued work on service disposal', async () => {
    const gate = deferred()
    const entered = deferred()
    const original = native.moveNoReplace.bind(native)
    native.moveNoReplace = async (source, destination) => {
      entered.resolve()
      await gate.promise
      await original(source, destination)
    }
    await writeFile(join(root, 'source.txt'), 'source')
    const info = await lstat(join(root, 'source.txt'), { bigint: true })
    const active = service.request(body({
      kind: 'rename', path: 'source.txt', destinationPath: 'destination.txt',
      expected: { kind: 'file', version: versionOf(info) },
    }))
    await entered.promise
    const queued = service.request(body({ kind: 'createFile', path: 'queued.txt' }))
    let disposed = false
    const disposing = service.dispose().then(() => { disposed = true })
    await expectCode(queued, 'MUTATION_CANCELLED')
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect(await active).toMatchObject({ state: 'committed' })
    await disposing
    expect(await readFile(join(root, 'destination.txt'), 'utf8')).toBe('source')
    await expect(lstat(join(root, 'queued.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a committed receipt and adds a warning when deferred purge fails', async () => {
    await service.dispose()
    let now = 0
    service = createService({ receiptTtlMs: 50, maxPurgeJobs: 1 }, { now: () => now })
    await writeFile(join(root, 'deleted.txt'), 'deleted')
    const info = await lstat(join(root, 'deleted.txt'), { bigint: true })
    const operationId = randomUUID()
    expect(await service.request(body({
      kind: 'delete', path: 'deleted.txt', expected: { kind: 'file', version: versionOf(info) }, recursive: false,
    }, operationId))).toMatchObject({ state: 'committed' })
    const quarantine = (await readdir(root)).find(name => name.startsWith('.__dsh_code_ide_quarantine_'))
    expect(quarantine).toBeTypeOf('string')
    await rm(join(root, quarantine!), { recursive: true, force: true })
    now = 50
    await vi.waitFor(async () => {
      expect(await service.request({ op: 'status', providerEpoch: service.providerEpoch, operationId })).toMatchObject({
        state: 'committed', warning: { code: 'PURGE_DEFERRED' },
      })
    }, { timeout: 2_000 })
    await writeFile(join(root, 'capacity.txt'), 'retained')
    const retained = await lstat(join(root, 'capacity.txt'), { bigint: true })
    await expectCode(service.request(body({
      kind: 'delete', path: 'capacity.txt', expected: { kind: 'file', version: versionOf(retained) }, recursive: false,
    })), 'PURGE_QUEUE_FULL')
    expect(await readFile(join(root, 'capacity.txt'), 'utf8')).toBe('retained')
  })

  it('unlinks quarantined symlinks without following them during deferred purge', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-code-ide-purge-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await mkdir(join(root, 'folder'))
    try {
      await symlink(outside, join(root, 'folder', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      await rm(outside, { recursive: true, force: true })
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    try {
      const info = await lstat(join(root, 'folder'), { bigint: true })
      expect(await service.request(body({
        kind: 'delete', path: 'folder', expected: { kind: 'directory', version: versionOf(info) }, recursive: true,
      }))).toMatchObject({ state: 'committed' })
      await service.dispose()
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
