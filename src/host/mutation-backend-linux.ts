import { randomUUID } from 'node:crypto'
import { close, fstat, open, type BigIntStats } from 'node:fs'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MUTATION_BUDGETS } from '../shared/workspace-mutations.js'
import { IdeHostError } from './errors.js'
import { sameFileIdentity, versionOf } from './filesystem.js'
import { isInternalWorkspaceName } from './path-policy.js'
import {
  MUTATION_BACKEND_ABI,
  createUnavailableMutationBackend,
  type MutationBackend,
  type MutationBackendDescriptor,
  type MutationBackendExecution,
  type MutationBackendIssue,
  type MutationBackendOperation,
  type MutationBackendOutcome,
  type MutationBackendWorkspace,
  type OpenMutationBackendWorkspace,
} from './mutation-backend.js'

type FfiRuntime = typeof import('ffi-rs')

const LINUX_DESCRIPTOR: Readonly<MutationBackendDescriptor> = Object.freeze({
  abi: MUTATION_BACKEND_ABI,
  implementation: 'linux-openat2-handles',
  confinement: 'trusted-local-dirfd-relative-v1',
  capabilities: Object.freeze({
    createFile: true,
    createDirectory: true,
    rename: false,
    delete: false,
  }),
})

const C = {
  AT_FDCWD: -100,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_CREAT: 0x40,
  O_EXCL: 0x80,
  O_DIRECTORY: 0x1_0000,
  O_NOFOLLOW: 0x2_0000,
  O_CLOEXEC: 0x8_0000,
  O_PATH: 0x20_0000,
  SYS_OPENAT2: 437,
  RESOLVE_NO_XDEV: 0x01,
  RESOLVE_NO_MAGICLINKS: 0x02,
  RESOLVE_NO_SYMLINKS: 0x04,
  RESOLVE_BENEATH: 0x08,
} as const

const RESOLVE_POLICY = C.RESOLVE_NO_XDEV
  | C.RESOLVE_NO_MAGICLINKS
  | C.RESOLVE_NO_SYMLINKS
  | C.RESOLVE_BENEATH
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const WINDOWS_FORBIDDEN_NAME = /[<>:"|?*]/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu

interface NativeResult {
  readonly value: number
  readonly errnoCode: number
}

function issue(code: string, message: string, httpStatus: number): MutationBackendIssue {
  return { code, message, httpStatus }
}

function notCommitted(error: MutationBackendIssue): MutationBackendOutcome {
  return { state: 'notCommitted', error }
}

function recovery(): MutationBackendOutcome {
  return {
    state: 'recoveryRequired',
    error: issue('MUTATION_RECOVERY_REQUIRED', 'The Host cannot prove the final mutation state.', 503),
  }
}

function nativeResult(value: unknown): NativeResult {
  if (typeof value !== 'object' || value === null || !('value' in value) || !('errnoCode' in value)) {
    throw new Error('The Linux native call did not return errno evidence.')
  }
  const result = value as { value: unknown, errnoCode: unknown }
  if (typeof result.value !== 'number' || !Number.isSafeInteger(result.value)
    || typeof result.errnoCode !== 'number' || !Number.isInteger(result.errnoCode)) {
    throw new Error('The Linux native call returned malformed errno evidence.')
  }
  return { value: result.value, errnoCode: result.errnoCode }
}

function pathSegments(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MUTATION_BUDGETS.maxPathSegments) {
    return undefined
  }
  const segments: string[] = []
  let bytes = value.length - 1
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    const nameBytes = Buffer.byteLength(item, 'utf8')
    bytes += nameBytes
    if (item === '' || item === '.' || item === '..'
      || item.includes('/') || item.includes('\\')
      || nameBytes > MUTATION_BUDGETS.maxNameBytes
      || CONTROL_CHARACTER.test(item)
      || WINDOWS_FORBIDDEN_NAME.test(item)
      || item.endsWith('.') || item.endsWith(' ')
      || WINDOWS_RESERVED_NAME.test(item)
      || isInternalWorkspaceName(item)) return undefined
    segments.push(item)
  }
  return bytes <= MUTATION_BUDGETS.maxPathBytes ? Object.freeze(segments) : undefined
}

function kindOf(snapshot: BigIntStats): 'file' | 'directory' | undefined {
  if (snapshot.isFile()) return 'file'
  if (snapshot.isDirectory()) return 'directory'
  return undefined
}

function fstatFd(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) => {
    fstat(fd, { bigint: true }, (error, stats) => { error === null ? resolve(stats) : reject(error) })
  })
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    close(fd, error => { error === null ? resolve() : reject(error) })
  })
}

function openFd(path: string, flags: number, mode: number): Promise<number> {
  return new Promise((resolve, reject) => {
    open(path, flags, mode, (error, fd) => { error === null ? resolve(fd) : reject(error) })
  })
}

function errnoIssue(errnoCode: number, phase: 'parent' | 'source' | 'create' | 'rename' | 'delete'): MutationBackendIssue {
  if ((phase === 'create' || phase === 'rename') && errnoCode === 17) {
    return issue('DESTINATION_EXISTS', 'The destination already exists.', 409)
  }
  if (errnoCode === 2) {
    return phase === 'source' || phase === 'delete'
      ? issue('NOT_FOUND', 'The source resource no longer exists.', 404)
      : issue('NOT_FOUND', 'A workspace parent directory no longer exists.', 404)
  }
  if (errnoCode === 20) return issue('NOT_DIRECTORY', 'A workspace parent path is not a directory.', 400)
  if (errnoCode === 40) return issue('SYMLINK_NOT_ALLOWED', 'Symbolic links are not available in the IDE.', 403)
  if (errnoCode === 18) return issue('CROSS_DEVICE_MUTATION', 'Cross-device workspace mutations are not allowed.', 409)
  if (errnoCode === 1 || errnoCode === 13 || errnoCode === 30) {
    return issue('PERMISSION_DENIED', 'The Host denied the workspace mutation.', 403)
  }
  if (errnoCode === 39 || errnoCode === 16) {
    return issue('DIRECTORY_NOT_EMPTY', 'Recursive confirmation is required for a non-empty directory.', 409)
  }
  if (errnoCode === 36) return issue('INVALID_PATH', 'The workspace path is too long.', 400)
  if (errnoCode === 22) return issue('INVALID_PATH', 'The workspace path is invalid.', 400)
  return issue('WORKSPACE_MUTATION_FAILED', 'The Host could not perform the workspace mutation.', 409)
}

function cancelled(): MutationBackendOutcome {
  return notCommitted(issue('MUTATION_CANCELLED', 'The workspace mutation was cancelled before commit.', 409))
}

class LinuxKernel {
  private disposed = false

  private constructor(
    private readonly ffi: FfiRuntime,
    private readonly library: string,
  ) {}

  static async create(): Promise<LinuxKernel> {
    const ffi = await import('ffi-rs')
    const library = `dsh-code-ide-linux-${randomUUID()}`
    ffi.open({ library, path: '' })
    const kernel = new LinuxKernel(ffi, library)
    let probeFd = -1
    let childFd = -1
    try {
      probeFd = await kernel.openRoot('/')
      childFd = await kernel.openAt2(probeFd, '.', C.O_PATH | C.O_DIRECTORY | C.O_CLOEXEC, 0)
      if (childFd < 0) throw new Error('openat2 is unavailable.')
      await kernel.snapshot(childFd)
      return kernel
    } catch (error) {
      await kernel.dispose()
      throw error
    } finally {
      await kernel.closeFd(childFd)
      await kernel.closeFd(probeFd)
    }
  }

  async openRoot(path: string): Promise<number> {
    return await openFd(path, C.O_PATH | C.O_DIRECTORY | C.O_NOFOLLOW | C.O_CLOEXEC, 0)
  }

  async openAt2(parentFd: number, relative: string, flags: number, mode: number): Promise<number> {
    const how = Buffer.alloc(24)
    how.writeBigUInt64LE(BigInt(flags), 0)
    how.writeBigUInt64LE(BigInt(mode), 8)
    how.writeBigUInt64LE(BigInt(RESOLVE_POLICY), 16)
    const result = await this.call('syscall', this.ffi.DataType.I64,
      [this.ffi.DataType.I64, this.ffi.DataType.I64, this.ffi.DataType.String,
        this.ffi.DataType.U8Array, this.ffi.DataType.U64],
      [C.SYS_OPENAT2, parentFd, relative, how, how.length])
    return result.value < 0 ? -result.errnoCode : result.value
  }

  async mkdirAt(parentFd: number, name: string): Promise<NativeResult> {
    return await this.call('mkdirat', this.ffi.DataType.I32,
      [this.ffi.DataType.I32, this.ffi.DataType.String, this.ffi.DataType.U32],
      [parentFd, name, 0o777])
  }

  async snapshot(fd: number): Promise<BigIntStats> {
    if (fd < 0) throw new Error('Cannot inspect an invalid Linux file descriptor.')
    return await fstatFd(fd)
  }

  async closeFd(fd: number): Promise<void> {
    if (fd < 0) return
    await closeFd(fd).catch(() => {})
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try { this.ffi.close(this.library) } catch { /* library teardown is best-effort */ }
  }

  private async call(funcName: string, retType: unknown, paramsType: unknown[], paramsValue: unknown[]): Promise<NativeResult> {
    if (this.disposed) throw new Error('The Linux native kernel is disposed.')
    const value = await this.ffi.load({
      library: this.library,
      funcName,
      retType: retType as never,
      paramsType: paramsType as never[],
      paramsValue,
      errno: true,
      runInNewThread: true,
    })
    return nativeResult(value)
  }
}

class LinuxMutationWorkspace implements MutationBackendWorkspace {
  private readonly executions = new Set<Promise<MutationBackendOutcome>>()
  private queue: Promise<void> = Promise.resolve()
  private disposePromise: Promise<void> | undefined
  private disposed = false
  private poisoned = false

  constructor(
    readonly workspaceId: string,
    private readonly registeredRoot: string,
    private readonly rootFd: number,
    private readonly rootSnapshot: BigIntStats,
    private readonly kernel: LinuxKernel,
    private readonly onDisposed: (workspace: LinuxMutationWorkspace) => void,
  ) {}

  execute(request: MutationBackendExecution): Promise<MutationBackendOutcome> {
    if (this.disposed) return Promise.resolve(notCommitted(issue(
      'WORKSPACE_MUTATION_UNAVAILABLE', 'The Linux workspace mutation backend is disposed.', 501,
    )))
    if (this.poisoned) return Promise.resolve(recovery())
    const admitted = this.queue.then(async () => await this.executeSerial(request), async () => await this.executeSerial(request))
    this.queue = admitted.then(() => {}, () => {})
    this.executions.add(admitted)
    void admitted.finally(() => { this.executions.delete(admitted) }).catch(() => {})
    return admitted
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      await Promise.allSettled([...this.executions])
      await this.kernel.closeFd(this.rootFd)
      this.onDisposed(this)
    })()
    return this.disposePromise
  }

  private async executeSerial(request: MutationBackendExecution): Promise<MutationBackendOutcome> {
    if (this.poisoned) return recovery()
    if (request.signal.aborted || this.disposed) return cancelled()
    try {
      const currentRoot = await this.kernel.snapshot(this.rootFd)
      if (!sameFileIdentity(currentRoot, this.rootSnapshot)) {
        return notCommitted(issue('WORKSPACE_IDENTITY_CHANGED', 'The workspace root identity has changed.', 409))
      }
      if (request.operation.kind === 'createFile' || request.operation.kind === 'createDirectory') {
        const outcome = await this.create(request.operation, request.signal)
        if (outcome.state === 'recoveryRequired') this.poisoned = true
        return outcome
      }
      // Linux has strong handle-relative lookup and exclusive creation, but
      // renameat2()/unlinkat() still select their source by parent fd + name.
      // They cannot atomically bind the commit to an already-open source fd,
      // so v1 deliberately advertises and executes neither operation.
      return notCommitted(issue(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'Containment-safe rename and delete are unavailable on this Linux Host.',
        501,
      ))
    } catch {
      this.poisoned = true
      return recovery()
    }
  }

  private async create(
    operation: Extract<MutationBackendOperation, { kind: 'createFile' | 'createDirectory' }>,
    signal: AbortSignal,
  ): Promise<MutationBackendOutcome> {
    const segments = pathSegments(operation.path.segments)
    if (segments === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
    const parent = await this.openParent(segments)
    if ('outcome' in parent) return parent.outcome
    let createdFd = -1
    try {
      if (signal.aborted || this.disposed) return cancelled()
      const leaf = segments.at(-1)!
      if (operation.kind === 'createFile') {
        // Resolve the complete destination from the pinned workspace root in
        // the same openat2 call that performs O_EXCL creation. The parent fd
        // opened above remains useful for directory creation, whose POSIX ABI
        // has no mkdirat2 equivalent.
        createdFd = await this.kernel.openAt2(
          this.rootFd,
          segments.join('/'),
          C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW | C.O_CLOEXEC,
          0o666,
        )
        if (createdFd < 0) return notCommitted(errnoIssue(-createdFd, 'create'))
      } else {
        const result = await this.kernel.mkdirAt(parent.fd, leaf)
        if (result.value !== 0) return notCommitted(errnoIssue(result.errnoCode, 'create'))
        createdFd = await this.kernel.openAt2(parent.fd, leaf, C.O_PATH | C.O_DIRECTORY | C.O_CLOEXEC, 0)
        if (createdFd < 0) return recovery()
      }
      const snapshot = await this.kernel.snapshot(createdFd)
      const expectedKind = operation.kind === 'createFile' ? 'file' : 'directory'
      if (kindOf(snapshot) !== expectedKind) return recovery()
      const observed = await lstat(join(this.registeredRoot, ...segments), { bigint: true })
      if (!sameFileIdentity(snapshot, observed) || kindOf(observed) !== expectedKind) return recovery()
      return {
        state: 'committed',
        evidence: operation.kind === 'createFile'
          ? { kind: 'createFile', resourceKind: 'file', version: versionOf(observed) }
          : { kind: 'createDirectory', resourceKind: 'directory', version: versionOf(observed) },
      }
    } finally {
      await this.kernel.closeFd(createdFd)
      await this.kernel.closeFd(parent.fd)
    }
  }

  private async openParent(segments: readonly string[]): Promise<{ fd: number } | { outcome: MutationBackendOutcome }> {
    const parentPath = segments.length === 1 ? '.' : segments.slice(0, -1).join('/')
    const fd = await this.kernel.openAt2(this.rootFd, parentPath, C.O_PATH | C.O_DIRECTORY | C.O_CLOEXEC, 0)
    if (fd < 0) return { outcome: notCommitted(errnoIssue(-fd, 'parent')) }
    try {
      const snapshot = await this.kernel.snapshot(fd)
      if (!snapshot.isDirectory() || snapshot.dev !== this.rootSnapshot.dev) {
        await this.kernel.closeFd(fd)
        return { outcome: notCommitted(issue(
          'PARENT_IDENTITY_CHANGED', 'A workspace parent directory changed before commit.', 409,
        )) }
      }
      return { fd }
    } catch {
      await this.kernel.closeFd(fd)
      return { outcome: recovery() }
    }
  }
}

class LinuxMutationBackend implements MutationBackend {
  readonly descriptor = LINUX_DESCRIPTOR
  private readonly workspaces = new Set<LinuxMutationWorkspace>()
  private readonly opens = new Set<Promise<MutationBackendWorkspace>>()
  private disposePromise: Promise<void> | undefined
  private disposed = false

  constructor(private readonly kernel: LinuxKernel) {}

  openWorkspace(request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace> {
    if (this.disposed) return Promise.reject(new IdeHostError(
      'WORKSPACE_MUTATION_UNAVAILABLE', 'The Linux workspace mutation backend is disposed.', 501,
    ))
    const admitted = this.openWorkspaceAdmitted(request)
    this.opens.add(admitted)
    void admitted.finally(() => { this.opens.delete(admitted) }).catch(() => {})
    return admitted
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      await Promise.allSettled([...this.opens])
      await Promise.allSettled([...this.workspaces].map(async workspace => await workspace.dispose()))
      await this.kernel.dispose()
    })()
    return this.disposePromise
  }

  private async openWorkspaceAdmitted(request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace> {
    if (request.signal.aborted) throw new IdeHostError(
      'WORKSPACE_MUTATION_UNAVAILABLE', 'Workspace opening was cancelled.', 409,
    )
    let rootFd = -1
    try {
      rootFd = await this.kernel.openRoot(request.registeredRoot)
      const rootSnapshot = await this.kernel.snapshot(rootFd)
      if (!rootSnapshot.isDirectory()) {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root is not a real directory.', 409)
      }
      if (rootSnapshot.dev !== request.expectedRootIdentity.dev
        || rootSnapshot.ino !== request.expectedRootIdentity.ino) {
        throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root identity has changed.', 409)
      }
      if (request.signal.aborted || this.disposed) throw new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE', 'Workspace opening was cancelled.', 409,
      )
      const workspace = new LinuxMutationWorkspace(
        request.workspaceId, request.registeredRoot, rootFd, rootSnapshot, this.kernel,
        disposed => { this.workspaces.delete(disposed) },
      )
      this.workspaces.add(workspace)
      rootFd = -1
      return workspace
    } finally {
      await this.kernel.closeFd(rootFd)
    }
  }
}

async function probe(kernel: LinuxKernel): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-ide-linux-probe-'))
  let workspace: MutationBackendWorkspace | undefined
  try {
    const identity = await lstat(root, { bigint: true })
    const backend = new LinuxMutationBackend(kernel)
    workspace = await backend.openWorkspace({
      workspaceId: 'probe', registeredRoot: root,
      expectedRootIdentity: { dev: identity.dev, ino: identity.ino },
      signal: new AbortController().signal,
    })
    const signal = new AbortController().signal
    const directory = await workspace.execute({
      executionId: randomUUID(), operation: { kind: 'createDirectory', path: { segments: ['directory'] } }, signal,
    })
    const file = await workspace.execute({
      executionId: randomUUID(), operation: { kind: 'createFile', path: { segments: ['directory', 'file'] } }, signal,
    })
    const collision = await workspace.execute({
      executionId: randomUUID(), operation: { kind: 'createFile', path: { segments: ['directory', 'file'] } }, signal,
    })
    const fileInfo = await lstat(join(root, 'directory', 'file'), { bigint: true })
    const directoryInfo = await lstat(join(root, 'directory'), { bigint: true })
    const rename = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'rename', path: { segments: ['directory', 'file'] },
        destinationPath: { segments: ['moved'] }, expected: { kind: 'file', version: versionOf(fileInfo) },
      }, signal,
    })
    const deleted = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['directory'] },
        expected: { kind: 'directory', version: versionOf(directoryInfo) }, recursive: true,
      }, signal,
    })
    const contents = await readFile(join(root, 'directory', 'file'), 'utf8')
    if (directory.state !== 'committed' || file.state !== 'committed'
      || collision.state !== 'notCommitted' || collision.error.code !== 'DESTINATION_EXISTS'
      || rename.state !== 'notCommitted' || rename.error.code !== 'WORKSPACE_MUTATION_UNAVAILABLE'
      || deleted.state !== 'notCommitted' || deleted.error.code !== 'WORKSPACE_MUTATION_UNAVAILABLE'
      || contents !== '') {
      throw new Error('The Linux mutation primitive failed its runtime witness.')
    }
    await workspace.dispose()
    workspace = undefined
  } finally {
    await workspace?.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Create the Linux handle-relative backend only after openat2, descriptor
 * identity evidence, and exclusive file/directory creation pass a real
 * runtime witness. Rename and delete remain fail-closed because their POSIX
 * commit syscalls cannot bind the selected name atomically to an open fd.
 */
export async function createLinuxMutationBackend(): Promise<MutationBackend> {
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    return createUnavailableMutationBackend()
  }
  let kernel: LinuxKernel | undefined
  try {
    kernel = await LinuxKernel.create()
    await probe(kernel)
    return new LinuxMutationBackend(kernel)
  } catch {
    await kernel?.dispose().catch(() => {})
    return createUnavailableMutationBackend()
  }
}
