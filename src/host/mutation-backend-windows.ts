import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsExternal } from 'ffi-rs'
import { MUTATION_BUDGETS } from '../shared/workspace-mutations.js'
import { IdeHostError } from './errors.js'
import { versionOf } from './filesystem.js'
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

const WINDOWS_DESCRIPTOR: Readonly<MutationBackendDescriptor> = Object.freeze({
  abi: MUTATION_BACKEND_ABI,
  implementation: 'windows-nt-handles',
  confinement: 'backend-owned-handle-relative-v1',
  capabilities: Object.freeze({
    createFile: true,
    createDirectory: true,
    rename: true,
    delete: true,
  }),
})

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const WINDOWS_FORBIDDEN_NAME = /[<>:"|?*]/u
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu
const INTERNAL_NAME_PREFIX = '.__dsh_code_ide_'

const C = {
  DELETE: 0x00010000,
  FILE_LIST_DIRECTORY: 0x00000001,
  FILE_TRAVERSE: 0x00000020,
  FILE_READ_ATTRIBUTES: 0x00000080,
  FILE_WRITE_ATTRIBUTES: 0x00000100,
  FILE_READ_DATA: 0x00000001,
  SYNCHRONIZE: 0x00100000,
  FILE_SHARE_READ: 0x00000001,
  FILE_SHARE_WRITE: 0x00000002,
  FILE_SHARE_DELETE: 0x00000004,
  OPEN_EXISTING: 3,
  FILE_ATTRIBUTE_DIRECTORY: 0x00000010,
  FILE_ATTRIBUTE_NORMAL: 0x00000080,
  FILE_ATTRIBUTE_REPARSE_POINT: 0x00000400,
  FILE_FLAG_BACKUP_SEMANTICS: 0x02000000,
  FILE_FLAG_OPEN_REPARSE_POINT: 0x00200000,
  FILE_TYPE_DISK: 1,
  OBJ_DONT_REPARSE: 0x00001000,
  FILE_OPEN: 1,
  FILE_CREATE: 2,
  FILE_DIRECTORY_FILE: 0x00000001,
  FILE_SYNCHRONOUS_IO_NONALERT: 0x00000020,
  FILE_NON_DIRECTORY_FILE: 0x00000040,
  FILE_OPEN_REPARSE_POINT: 0x00200000,
  FILE_CREATED: 2n,
  FILE_RENAME_INFORMATION_CLASS: 10,
  FILE_ATTRIBUTE_TAG_INFO_CLASS: 9,
  FILE_ID_INFO_CLASS: 18,
  FILE_ID_EXTD_DIRECTORY_INFO_CLASS: 19,
  FILE_ID_EXTD_DIRECTORY_RESTART_INFO_CLASS: 20,
  FILE_DISPOSITION_INFORMATION_EX_CLASS: 64,
  FILE_DISPOSITION_DELETE: 0x00000001,
  FILE_DISPOSITION_POSIX_SEMANTICS: 0x00000002,
  FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE: 0x00000010,
  ERROR_NO_MORE_FILES: 18,
} as const

const STATUS = {
  ACCESS_DENIED: 0xc0000022,
  OBJECT_NAME_INVALID: 0xc0000033,
  OBJECT_NAME_NOT_FOUND: 0xc0000034,
  OBJECT_NAME_COLLISION: 0xc0000035,
  OBJECT_PATH_NOT_FOUND: 0xc000003a,
  OBJECT_PATH_SYNTAX_BAD: 0xc000003b,
  SHARING_VIOLATION: 0xc0000043,
  DELETE_PENDING: 0xc0000056,
  FILE_IS_A_DIRECTORY: 0xc00000ba,
  NOT_A_DIRECTORY: 0xc0000103,
  NAME_TOO_LONG: 0xc0000106,
  REPARSE_POINT_ENCOUNTERED: 0xc000050b,
  STOPPED_ON_SYMLINK: 0x8000002d,
  NOT_SAME_DEVICE: 0xc00000d4,
  DIRECTORY_NOT_EMPTY: 0xc0000101,
  CANNOT_DELETE: 0xc0000121,
} as const

const DELETE_MAX_DEPTH = 128
const DELETE_MAX_ENTRIES = 100_000
const DELETE_MAX_QUERIES = 300_000
const DELETE_MAX_NAME_BYTES = 64 * 1024 * 1024
const DELETE_ENUM_BUFFER_BYTES = 64 * 1024
const DELETE_FIRST_ENUM_BUFFER_BYTES = 1024
const DELETE_TOMBSTONE_PREFIX = '.__dsh_code_ide_delete_'

interface NativeFileInformation {
  readonly attributes: number
  readonly volume: bigint
  readonly index: bigint
}

interface NativeFileIdInformation {
  readonly volume: bigint
  readonly id: Buffer
}

interface NativeAttributeTagInformation {
  readonly attributes: number
  readonly reparseTag: number
}

interface NativeDirectoryEntry {
  readonly name: Buffer
  readonly kind: 'file' | 'directory'
  readonly reparsePoint: boolean
  readonly reparseTag: number
  readonly fileId: Buffer
}

interface NativeDirectoryQuery {
  readonly entries: readonly NativeDirectoryEntry[]
  readonly noMoreFiles: boolean
}

interface DeleteBudget {
  entries: number
  queries: number
  nameBytes: number
}

class NativeCloseError extends Error {
  constructor(cause: unknown) {
    super('A native delete handle could not be closed.', { cause })
  }
}

class NativeDeleteAmbiguousError extends Error {}

function safeRawLeaf(name: Buffer): boolean {
  if (name.length === 0 || name.length > 510 || name.length % 2 !== 0) return false
  for (let offset = 0; offset < name.length; offset += 2) {
    const code = name.readUInt16LE(offset)
    if (code === 0 || code === 0x2f || code === 0x5c) return false
  }
  return !name.equals(Buffer.from('.', 'utf16le')) && !name.equals(Buffer.from('..', 'utf16le'))
}

interface NtOpenResult {
  readonly status: number
  readonly information: bigint
  /** A failing NTSTATUS accompanied by an owned output handle is uncertain. */
  readonly ambiguous: boolean
  readonly handle?: OwnedHandle
}

interface OwnedAllocation {
  readonly type: unknown
  readonly pointer: JsExternal[]
}

function issue(code: string, message: string, httpStatus: number): MutationBackendIssue {
  return { code, message, httpStatus }
}

function notCommitted(error: MutationBackendIssue): MutationBackendOutcome {
  return { state: 'notCommitted', error }
}

function recovery(error?: unknown): MutationBackendOutcome {
  return {
    state: 'recoveryRequired',
    error: issue(
      'MUTATION_RECOVERY_REQUIRED',
      'The Host cannot prove the final mutation state.',
      503,
    ),
  }
}

function unsignedStatus(status: number): number {
  return status >>> 0
}

function validSegments(operation: MutationBackendOperation): readonly string[] | undefined {
  return validPathSegments(operation.path.segments)
}

function validPathSegments(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > MUTATION_BUDGETS.maxPathSegments) {
    return undefined
  }
  const segments: string[] = []
  let pathBytes = Math.max(0, input.length - 1)
  for (let index = 0; index < input.length; index += 1) {
    const segment: unknown = input[index]
    if (typeof segment !== 'string') return undefined
    const nameBytes = Buffer.byteLength(segment, 'utf8')
    pathBytes += nameBytes
    if (segment === '' || segment === '.' || segment === '..'
      || segment.includes('/') || segment.includes('\\')
      || nameBytes > MUTATION_BUDGETS.maxNameBytes
      || Buffer.byteLength(segment, 'utf16le') > 0x7ffe
      || CONTROL_CHARACTER.test(segment)
      || WINDOWS_FORBIDDEN_NAME.test(segment)
      || segment.endsWith('.') || segment.endsWith(' ')
      || WINDOWS_RESERVED_NAME.test(segment)
      || segment.toLowerCase().startsWith(INTERNAL_NAME_PREFIX)) return undefined
    segments.push(segment)
  }
  return pathBytes <= MUTATION_BUDGETS.maxPathBytes ? Object.freeze(segments) : undefined
}

function validExpected(operation: Extract<MutationBackendOperation, { kind: 'rename' | 'delete' }>): boolean {
  return (operation.expected.kind === 'file' || operation.expected.kind === 'directory')
    && typeof operation.expected.version === 'string'
    && operation.expected.version.length > 0
    && Buffer.byteLength(operation.expected.version, 'utf8') <= MUTATION_BUDGETS.maxVersionBytes
}

function statusIssue(status: number, phase: 'parent' | 'source' | 'create' | 'rename' | 'delete'): MutationBackendIssue {
  const code = unsignedStatus(status)
  if ((phase === 'create' || phase === 'rename') && code === STATUS.OBJECT_NAME_COLLISION) {
    return issue('DESTINATION_EXISTS', 'The destination already exists.', 409)
  }
  if (code === STATUS.OBJECT_NAME_NOT_FOUND || code === STATUS.OBJECT_PATH_NOT_FOUND) {
    return phase === 'source' || phase === 'delete'
      ? issue('NOT_FOUND', 'The source resource no longer exists.', 404)
      : issue('NOT_FOUND', 'A workspace parent directory no longer exists.', 404)
  }
  if (code === STATUS.NOT_A_DIRECTORY || code === STATUS.FILE_IS_A_DIRECTORY) {
    return issue('NOT_DIRECTORY', 'A workspace parent path is not a directory.', 400)
  }
  if (code === STATUS.REPARSE_POINT_ENCOUNTERED || code === STATUS.STOPPED_ON_SYMLINK) {
    return issue('SYMLINK_NOT_ALLOWED', 'Reparse points are not available in the IDE.', 403)
  }
  if (code === STATUS.ACCESS_DENIED) {
    return issue('PERMISSION_DENIED', 'The Host denied the workspace mutation.', 403)
  }
  if (code === STATUS.DIRECTORY_NOT_EMPTY) {
    return issue('DIRECTORY_NOT_EMPTY', 'Recursive confirmation is required for a non-empty directory.', 409)
  }
  if (code === STATUS.CANNOT_DELETE) {
    return issue('CANNOT_DELETE', 'Windows refused to delete the resource.', 409)
  }
  if (code === STATUS.SHARING_VIOLATION || code === STATUS.DELETE_PENDING) {
    return phase === 'source' || phase === 'rename' || phase === 'delete'
      ? issue('SOURCE_IDENTITY_CHANGED', 'The source resource changed before commit.', 409)
      : issue('PARENT_IDENTITY_CHANGED', 'A workspace parent directory changed before commit.', 409)
  }
  if (code === STATUS.NOT_SAME_DEVICE) {
    return issue('MOUNT_NOT_ALLOWED', 'Cross-volume workspace mutations are not available.', 403)
  }
  if (code === STATUS.OBJECT_NAME_INVALID || code === STATUS.OBJECT_PATH_SYNTAX_BAD
    || code === STATUS.NAME_TOO_LONG) {
    return issue('INVALID_PATH', 'The workspace path is invalid on this Host.', 400)
  }
  return issue(
    'WORKSPACE_MUTATION_FAILED',
    `The Windows namespace operation failed (NTSTATUS 0x${code.toString(16).padStart(8, '0')}).`,
    409,
  )
}

function aborted(): MutationBackendOutcome {
  return notCommitted(issue('MUTATION_ABORTED', 'The mutation was cancelled before commit.', 409))
}

function unsupported(): MutationBackendOutcome {
  return notCommitted(issue(
    'WORKSPACE_MUTATION_UNAVAILABLE',
    'This workspace mutation is unavailable on the Windows backend.',
    501,
  ))
}

function sameNativeIdentity(left: NativeFileInformation, right: NativeFileInformation): boolean {
  return left.volume === right.volume && left.index === right.index
}

function matchesStat(info: NativeFileInformation, stat: BigIntStats): boolean {
  // Node reports dev=0 for local Windows files on supported Node releases.
  // The native handle is volume-fenced separately; keep the native file index
  // correlated with lstat and compare dev whenever Node supplies one.
  return info.index === stat.ino && (stat.dev === 0n || info.volume === stat.dev)
}

function statKind(stat: BigIntStats): 'file' | 'directory' | undefined {
  if (stat.isSymbolicLink()) return undefined
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  return undefined
}

function nativeKindMatches(info: NativeFileInformation, kind: 'file' | 'directory'): boolean {
  return ((info.attributes & C.FILE_ATTRIBUTE_DIRECTORY) !== 0) === (kind === 'directory')
}

function sameMovedSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && statKind(before) === statKind(after)
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.mode === after.mode
}

function sameExactPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function windowsNameEquivalent(left: string, right: string): boolean {
  return left === right
    || left.toLowerCase() === right.toLowerCase()
    || left.toUpperCase() === right.toUpperCase()
}

function destinationInsideSource(source: readonly string[], destination: readonly string[]): boolean {
  return destination.length > source.length
    && source.every((segment, index) => {
      const candidate = destination[index]
      return candidate !== undefined && windowsNameEquivalent(segment, candidate)
    })
}

class OwnedHandle {
  private closePromise: Promise<void> | undefined

  constructor(
    readonly generation: number,
    readonly value: JsExternal,
    private readonly closeNative: (handle: OwnedHandle) => void,
  ) {}

  close(): Promise<void> {
    this.closePromise ??= Promise.resolve().then(() => { this.closeNative(this) })
    return this.closePromise
  }
}

class WindowsKernel {
  private readonly handles = new Map<number, OwnedHandle>()
  private nextHandleGeneration = 1
  private disposePromise: Promise<void> | undefined
  private disposing = false

  private constructor(
    private readonly ffi: FfiRuntime,
    private readonly ntdllLibrary: string,
    private readonly kernelLibrary: string,
    private readonly nullPointer: JsExternal,
  ) {}

  static async create(): Promise<WindowsKernel> {
    const ffi = await import('ffi-rs')
    const suffix = randomUUID()
    const ntdllLibrary = `dsh-code-ide-ntdll-${suffix}`
    const kernelLibrary = `dsh-code-ide-kernel32-${suffix}`
    let ntdllOpened = false
    let kernelOpened = false
    try {
      ffi.open({ library: ntdllLibrary, path: 'ntdll.dll' })
      ntdllOpened = true
      ffi.open({ library: kernelLibrary, path: 'kernel32.dll' })
      kernelOpened = true
      const nullPointer = ffi.load({
        library: kernelLibrary,
        funcName: 'GetModuleHandleW',
        retType: ffi.DataType.External,
        paramsType: [ffi.DataType.WString],
        paramsValue: [`dsh-code-ide-not-loaded-${suffix}.dll`],
      })
      if (!ffi.isNullPointer(nullPointer)) throw new Error('Could not obtain a typed null pointer.')
      return new WindowsKernel(ffi, ntdllLibrary, kernelLibrary, nullPointer)
    } catch (error) {
      if (kernelOpened) try { ffi.close(kernelLibrary) } catch { /* best effort */ }
      if (ntdllOpened) try { ffi.close(ntdllLibrary) } catch { /* best effort */ }
      throw error
    }
  }

  openRoot(path: string): OwnedHandle {
    if (this.disposing) throw new Error('The native kernel is disposing.')
    const t = this.ffi.DataType
    const handle = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'CreateFileW',
      retType: t.External,
      paramsType: [t.WString, t.U32, t.U32, t.External, t.U32, t.U32, t.External],
      paramsValue: [
        path,
        C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
        C.FILE_SHARE_READ | C.FILE_SHARE_WRITE,
        this.nullPointer,
        C.OPEN_EXISTING,
        C.FILE_FLAG_BACKUP_SEMANTICS | C.FILE_FLAG_OPEN_REPARSE_POINT,
        this.nullPointer,
      ],
    })
    const fileType = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFileType',
      retType: t.U32,
      paramsType: [t.External],
      paramsValue: [handle],
    })
    if (fileType !== C.FILE_TYPE_DISK) throw new Error('CreateFileW did not return a disk handle.')
    return this.adopt(handle)
  }

  information(handle: OwnedHandle): NativeFileInformation {
    const t = this.ffi.DataType
    const fileTime = { low: t.U32, high: t.U32 }
    const structure = {
      fileAttributes: t.U32,
      creationTime: fileTime,
      lastAccessTime: fileTime,
      lastWriteTime: fileTime,
      volumeSerialNumber: t.U32,
      fileSizeHigh: t.U32,
      fileSizeLow: t.U32,
      numberOfLinks: t.U32,
      fileIndexHigh: t.U32,
      fileIndexLow: t.U32,
    }
    const pointer = this.ffi.createPointer({
      paramsType: [structure],
      paramsValue: [{
        fileAttributes: 0,
        creationTime: { low: 0, high: 0 },
        lastAccessTime: { low: 0, high: 0 },
        lastWriteTime: { low: 0, high: 0 },
        volumeSerialNumber: 0,
        fileSizeHigh: 0,
        fileSizeLow: 0,
        numberOfLinks: 0,
        fileIndexHigh: 0,
        fileIndexLow: 0,
      }],
    })
    try {
      const nativePointer = this.ffi.unwrapPointer(pointer)[0]
      if (nativePointer === undefined) throw new Error('Missing file-information pointer.')
      const succeeded = this.ffi.load({
        library: this.kernelLibrary,
        funcName: 'GetFileInformationByHandle',
        retType: t.I32,
        paramsType: [t.External, t.External],
        paramsValue: [handle.value, nativePointer],
      })
      if (succeeded === 0) throw new Error('GetFileInformationByHandle failed.')
      const buffer = this.ffi.createExternalBuffer(nativePointer, 52)
      return {
        attributes: buffer.readUInt32LE(0),
        volume: BigInt(buffer.readUInt32LE(28)),
        index: (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48)),
      }
    } finally {
      this.ffi.freePointer({
        paramsType: [structure],
        paramsValue: pointer,
        pointerType: this.ffi.PointerType.RsPointer,
      })
    }
  }

  fileSystemName(handle: OwnedHandle): string {
    const t = this.ffi.DataType
    // GetVolumeInformationByHandleW measures this output in WCHARs. A Node
    // Buffer is passed directly as ffi-rs U8Array storage, remains strongly
    // referenced for the synchronous call, and is reclaimed by the JS owner.
    const nameCharacters = 64
    const nameBuffer = Buffer.alloc(nameCharacters * 2)
    let succeeded: number
    try {
      succeeded = this.ffi.load({
        library: this.kernelLibrary,
        funcName: 'GetVolumeInformationByHandleW',
        retType: t.I32,
        paramsType: [t.External, t.External, t.U32, t.External, t.External, t.External, t.U8Array, t.U32],
        paramsValue: [
          handle.value,
          this.nullPointer,
          0,
          this.nullPointer,
          this.nullPointer,
          this.nullPointer,
          nameBuffer,
          nameCharacters,
        ],
      })
    } catch (error) {
      throw new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'The Host cannot verify an NTFS workspace volume.',
        501,
        { cause: error },
      )
    }
    if (succeeded === 0) {
      // This also rejects SMB: Microsoft documents that SMB does not support
      // this volume-management function.
      throw new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'The Host cannot verify an NTFS workspace volume.',
        501,
      )
    }
    let end = 0
    while (end < nameBuffer.length && nameBuffer.readUInt16LE(end) !== 0) end += 2
    if (end === 0 || end === nameBuffer.length) {
      throw new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'The Host returned an invalid workspace filesystem name.',
        501,
      )
    }
    return nameBuffer.subarray(0, end).toString('utf16le')
  }

  normalizedLeafBytes(handle: OwnedHandle): Buffer {
    const t = this.ffi.DataType
    const required = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFinalPathNameByHandleW',
      retType: t.U32,
      paramsType: [t.External, t.External, t.U32, t.U32],
      // Zero selects FILE_NAME_NORMALIZED | VOLUME_NAME_DOS. The first call
      // asks Windows for the exact WCHAR capacity, including the terminator.
      paramsValue: [handle.value, this.nullPointer, 0, 0],
    })
    if (!Number.isInteger(required) || required <= 1 || required > 65_536) {
      throw new Error('GetFinalPathNameByHandleW returned an invalid path size.')
    }
    const pathBuffer = Buffer.alloc(required * 2)
    const written = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFinalPathNameByHandleW',
      retType: t.U32,
      paramsType: [t.External, t.U8Array, t.U32, t.U32],
      paramsValue: [handle.value, pathBuffer, required, 0],
    })
    // Success excludes the terminator. A value at least as large as the
    // supplied capacity means the path changed or the buffer was insufficient.
    if (!Number.isInteger(written) || written <= 0 || written >= required) {
      throw new Error('GetFinalPathNameByHandleW could not return a stable normalized path.')
    }
    const normalized = pathBuffer.subarray(0, written * 2)
    let leafOffset = 0
    for (let offset = normalized.length - 2; offset >= 0; offset -= 2) {
      const codeUnit = normalized.readUInt16LE(offset)
      if (codeUnit === 0x5c || codeUnit === 0x2f) {
        leafOffset = offset + 2
        break
      }
    }
    const leaf = Buffer.from(normalized.subarray(leafOffset))
    if (leaf.length === 0 || leaf.length > 510 || leaf.length % 2 !== 0) {
      throw new Error('GetFinalPathNameByHandleW returned an invalid leaf name.')
    }
    return leaf
  }

  normalizedLeafName(handle: OwnedHandle): string {
    return this.normalizedLeafBytes(handle).toString('utf16le')
  }

  fileIdInformation(handle: OwnedHandle): NativeFileIdInformation {
    const buffer = Buffer.alloc(24)
    const succeeded = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFileInformationByHandleEx',
      retType: this.ffi.DataType.I32,
      paramsType: [this.ffi.DataType.External, this.ffi.DataType.I32, this.ffi.DataType.U8Array, this.ffi.DataType.U32],
      paramsValue: [handle.value, C.FILE_ID_INFO_CLASS, buffer, buffer.length],
    })
    if (succeeded === 0) throw new Error('FileIdInfo failed.')
    return { volume: buffer.readBigUInt64LE(0), id: Buffer.from(buffer.subarray(8, 24)) }
  }

  attributeTagInformation(handle: OwnedHandle): NativeAttributeTagInformation {
    const buffer = Buffer.alloc(8)
    const succeeded = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFileInformationByHandleEx',
      retType: this.ffi.DataType.I32,
      paramsType: [this.ffi.DataType.External, this.ffi.DataType.I32, this.ffi.DataType.U8Array, this.ffi.DataType.U32],
      paramsValue: [handle.value, C.FILE_ATTRIBUTE_TAG_INFO_CLASS, buffer, buffer.length],
    })
    if (succeeded === 0) throw new Error('FileAttributeTagInfo failed.')
    return { attributes: buffer.readUInt32LE(0), reparseTag: buffer.readUInt32LE(4) }
  }

  ntOpenDirectory(parent: OwnedHandle, segment: string): NtOpenResult {
    return this.ntOpen(
      parent,
      segment,
      C.FILE_OPEN,
      C.FILE_ATTRIBUTE_DIRECTORY,
      C.FILE_DIRECTORY_FILE | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
    )
  }

  ntOpenDeleteDirectory(parent: OwnedHandle, segment: string): NtOpenResult {
    return this.ntOpen(
      parent,
      segment,
      C.FILE_OPEN,
      C.FILE_ATTRIBUTE_DIRECTORY,
      C.FILE_DIRECTORY_FILE | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
      C.FILE_SHARE_READ,
    )
  }

  ntCreateLeaf(parent: OwnedHandle, segment: string, kind: 'file' | 'directory'): NtOpenResult {
    const directory = kind === 'directory'
    return this.ntOpen(
      parent,
      segment,
      C.FILE_CREATE,
      directory ? C.FILE_ATTRIBUTE_DIRECTORY : C.FILE_ATTRIBUTE_NORMAL,
      directory
        ? C.FILE_DIRECTORY_FILE | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT
        : C.FILE_NON_DIRECTORY_FILE | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      (directory ? C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE : 0)
        | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
    )
  }

  ntOpenRenameSource(
    parent: OwnedHandle,
    segment: string,
    kind: 'file' | 'directory',
  ): NtOpenResult {
    const directory = kind === 'directory'
    return this.ntOpen(
      parent,
      segment,
      C.FILE_OPEN,
      directory ? C.FILE_ATTRIBUTE_DIRECTORY : C.FILE_ATTRIBUTE_NORMAL,
      (directory ? C.FILE_DIRECTORY_FILE : C.FILE_NON_DIRECTORY_FILE)
        | C.FILE_OPEN_REPARSE_POINT
        | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.DELETE | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
    )
  }

  ntOpenDeleteSource(parent: OwnedHandle, segment: string, kind: 'file' | 'directory'): NtOpenResult {
    const directory = kind === 'directory'
    return this.ntOpen(
      parent,
      segment,
      C.FILE_OPEN,
      directory ? C.FILE_ATTRIBUTE_DIRECTORY : C.FILE_ATTRIBUTE_NORMAL,
      (directory ? C.FILE_DIRECTORY_FILE : C.FILE_NON_DIRECTORY_FILE)
        | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.DELETE | C.FILE_READ_ATTRIBUTES | C.FILE_WRITE_ATTRIBUTES | C.SYNCHRONIZE
        | (directory ? C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE : 0),
      C.FILE_SHARE_READ,
    )
  }

  ntOpenDeleteRaw(parent: OwnedHandle, name: Buffer, kind: 'file' | 'directory'): NtOpenResult {
    const directory = kind === 'directory'
    return this.ntOpenBytes(
      parent,
      name,
      C.FILE_OPEN,
      directory ? C.FILE_ATTRIBUTE_DIRECTORY : C.FILE_ATTRIBUTE_NORMAL,
      (directory ? C.FILE_DIRECTORY_FILE : C.FILE_NON_DIRECTORY_FILE)
        | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.DELETE | C.FILE_READ_ATTRIBUTES | C.FILE_WRITE_ATTRIBUTES | C.SYNCHRONIZE
        | (directory ? C.FILE_LIST_DIRECTORY | C.FILE_TRAVERSE : 0),
      C.FILE_SHARE_READ,
    )
  }

  ntProbeAbsentRaw(parent: OwnedHandle, name: Buffer, kind: 'file' | 'directory'): NtOpenResult {
    return this.ntOpenBytes(
      parent,
      name,
      C.FILE_OPEN,
      kind === 'directory' ? C.FILE_ATTRIBUTE_DIRECTORY : C.FILE_ATTRIBUTE_NORMAL,
      (kind === 'directory' ? C.FILE_DIRECTORY_FILE : C.FILE_NON_DIRECTORY_FILE)
        | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
      C.FILE_SHARE_READ,
    )
  }

  ntOpenProbeReader(parent: OwnedHandle, segment: string): NtOpenResult {
    return this.ntOpen(
      parent,
      segment,
      C.FILE_OPEN,
      C.FILE_ATTRIBUTE_NORMAL,
      C.FILE_NON_DIRECTORY_FILE | C.FILE_OPEN_REPARSE_POINT | C.FILE_SYNCHRONOUS_IO_NONALERT,
      C.FILE_READ_DATA | C.FILE_READ_ATTRIBUTES | C.SYNCHRONIZE,
      C.FILE_SHARE_READ | C.FILE_SHARE_WRITE | C.FILE_SHARE_DELETE,
    )
  }

  readProbe(handle: OwnedHandle, length: number): Buffer {
    const t = this.ffi.DataType
    const countType = { Value: t.U32 }
    const count = this.ffi.createPointer({ paramsType: [countType], paramsValue: [{ Value: 0 }] })
    try {
      const countNative = this.ffi.unwrapPointer(count)[0]
      if (countNative === undefined) throw new Error('Missing ReadFile count pointer.')
      const buffer = Buffer.alloc(length)
      const succeeded = this.ffi.load({
        library: this.kernelLibrary,
        funcName: 'ReadFile',
        retType: t.I32,
        paramsType: [t.External, t.U8Array, t.U32, t.External, t.External],
        paramsValue: [handle.value, buffer, buffer.length, countNative, this.nullPointer],
      })
      if (succeeded === 0) throw new Error('ReadFile failed for the POSIX-delete witness.')
      const restored = this.ffi.restorePointer({ retType: [countType], paramsValue: count }) as unknown as Array<{ Value: number }>
      return Buffer.from(buffer.subarray(0, restored[0]?.Value ?? 0))
    } finally {
      this.ffi.freePointer({ paramsType: [countType], paramsValue: count, pointerType: this.ffi.PointerType.RsPointer })
    }
  }

  ntDeletePosix(handle: OwnedHandle): number {
    if (this.disposing) throw new Error('The native kernel is disposing.')
    const t = this.ffi.DataType
    const informationType = { Flags: t.U32 }
    const ioStatusType = { Status: t.I64, Information: t.U64 }
    const information = this.ffi.createPointer({
      paramsType: [informationType],
      paramsValue: [{
        Flags: C.FILE_DISPOSITION_DELETE
          | C.FILE_DISPOSITION_POSIX_SEMANTICS
          | C.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
      }],
    })
    const ioStatus = this.ffi.createPointer({
      paramsType: [ioStatusType],
      paramsValue: [{ Status: 0, Information: 0 }],
    })
    try {
      const informationNative = this.ffi.unwrapPointer(information)[0]
      const ioNative = this.ffi.unwrapPointer(ioStatus)[0]
      if (informationNative === undefined || ioNative === undefined) throw new Error('Missing delete parameters.')
      return this.ffi.load({
        library: this.ntdllLibrary,
        funcName: 'NtSetInformationFile',
        retType: t.I32,
        paramsType: [t.External, t.External, t.External, t.U32, t.I32],
        paramsValue: [handle.value, ioNative, informationNative, 4, C.FILE_DISPOSITION_INFORMATION_EX_CLASS],
      })
    } finally {
      this.ffi.freePointer({ paramsType: [ioStatusType], paramsValue: ioStatus, pointerType: this.ffi.PointerType.RsPointer })
      this.ffi.freePointer({ paramsType: [informationType], paramsValue: information, pointerType: this.ffi.PointerType.RsPointer })
    }
  }

  queryDirectory(handle: OwnedHandle, restart: boolean, firstOnly = false): NativeDirectoryQuery {
    const buffer = Buffer.alloc(firstOnly ? DELETE_FIRST_ENUM_BUFFER_BYTES : DELETE_ENUM_BUFFER_BYTES)
    const succeeded = this.ffi.load({
      library: this.kernelLibrary,
      funcName: 'GetFileInformationByHandleEx',
      retType: this.ffi.DataType.I32,
      paramsType: [this.ffi.DataType.External, this.ffi.DataType.I32, this.ffi.DataType.U8Array, this.ffi.DataType.U32],
      paramsValue: [
        handle.value,
        restart ? C.FILE_ID_EXTD_DIRECTORY_RESTART_INFO_CLASS : C.FILE_ID_EXTD_DIRECTORY_INFO_CLASS,
        buffer,
        buffer.length,
      ],
    })
    if (succeeded === 0) {
      const error = this.ffi.load({
        library: this.kernelLibrary,
        funcName: 'GetLastError',
        retType: this.ffi.DataType.U32,
        paramsType: [],
        paramsValue: [],
      })
      if (error === C.ERROR_NO_MORE_FILES) return { entries: [], noMoreFiles: true }
      throw new Error(`Directory enumeration failed with Win32 error ${error}.`)
    }
    const entries: NativeDirectoryEntry[] = []
    let offset = 0
    for (let guard = 0; guard < 65_536; guard += 1) {
      if (offset + 88 > buffer.length) throw new Error('Truncated directory record.')
      const next = buffer.readUInt32LE(offset)
      const attributes = buffer.readUInt32LE(offset + 56)
      const nameLength = buffer.readUInt32LE(offset + 60)
      const tag = buffer.readUInt32LE(offset + 68)
      const limit = next === 0 ? buffer.length : offset + next
      const end = offset + 88 + nameLength
      if (nameLength === 0 || nameLength > 510 || nameLength % 2 !== 0 || end > limit
        || limit > buffer.length || (next !== 0 && (next % 8 !== 0 || next < 88 + nameLength))) {
        throw new Error('Invalid directory record.')
      }
      const name = Buffer.from(buffer.subarray(offset + 88, end))
      const dot = name.equals(Buffer.from('.', 'utf16le')) || name.equals(Buffer.from('..', 'utf16le'))
      if (!dot) {
        entries.push({
          name,
          kind: (attributes & C.FILE_ATTRIBUTE_DIRECTORY) !== 0 ? 'directory' : 'file',
          reparsePoint: (attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
          reparseTag: (attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0 ? tag : 0,
          fileId: Buffer.from(buffer.subarray(offset + 72, offset + 88)),
        })
        if (firstOnly) break
      }
      if (next === 0) break
      offset += next
    }
    return { entries, noMoreFiles: false }
  }

  ntRenameNoReplace(
    source: OwnedHandle,
    destinationParent: OwnedHandle,
    destinationLeaf: string,
  ): number {
    if (this.disposing) throw new Error('The native kernel is disposing.')
    const t = this.ffi.DataType
    const name = Buffer.from(destinationLeaf, 'utf16le')
    const fileName = this.ffi.arrayConstructor({
      type: t.U8Array,
      length: name.length,
      ffiTypeTag: this.ffi.FFITypeTag.StackArray,
    })
    const renameInformation = {
      ReplaceIfExists: t.U8,
      RootDirectory: t.External,
      FileNameLength: t.U32,
      FileName: fileName,
    }
    const ioStatusBlock = { Status: t.I64, Information: t.U64 }
    const allocations: OwnedAllocation[] = []
    try {
      const renamePointer = this.ffi.createPointer({
        paramsType: [renameInformation],
        paramsValue: [{
          ReplaceIfExists: 0,
          RootDirectory: destinationParent.value,
          FileNameLength: name.length,
          FileName: name,
        }],
      })
      allocations.push({ type: renameInformation, pointer: renamePointer })
      const renameNative = this.ffi.unwrapPointer(renamePointer)[0]
      if (renameNative === undefined) throw new Error('Missing FILE_RENAME_INFORMATION pointer.')
      // FILE_RENAME_INFORMATION has seven alignment bytes after its BOOLEAN.
      // ffi-rs owns the allocation; explicitly clear that padding before the
      // synchronous syscall so no uninitialised bytes cross the ABI boundary.
      this.ffi.createExternalBuffer(renameNative, 20 + name.length).fill(0, 1, 8)

      const ioPointer = this.ffi.createPointer({
        paramsType: [ioStatusBlock],
        paramsValue: [{ Status: 0, Information: 0 }],
      })
      allocations.push({ type: ioStatusBlock, pointer: ioPointer })
      const ioNative = this.ffi.unwrapPointer(ioPointer)[0]
      if (ioNative === undefined) throw new Error('Missing rename IO_STATUS_BLOCK pointer.')

      return this.ffi.load({
        library: this.ntdllLibrary,
        funcName: 'NtSetInformationFile',
        retType: t.I32,
        paramsType: [t.External, t.External, t.External, t.U32, t.I32],
        paramsValue: [
          source.value,
          ioNative,
          renameNative,
          20 + name.length,
          C.FILE_RENAME_INFORMATION_CLASS,
        ],
      })
    } finally {
      const errors: unknown[] = []
      for (let index = allocations.length - 1; index >= 0; index -= 1) {
        const allocation = allocations[index]
        if (allocation === undefined) continue
        try {
          this.ffi.freePointer({
            paramsType: [allocation.type as never],
            paramsValue: allocation.pointer,
            pointerType: this.ffi.PointerType.RsPointer,
          })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Could not free native rename parameters.')
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposing = true
      const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.close()))
      try { this.ffi.close(this.ntdllLibrary) } catch { /* best effort after handles drain */ }
      try { this.ffi.close(this.kernelLibrary) } catch { /* best effort after handles drain */ }
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return this.disposePromise
  }

  private adopt(value: JsExternal): OwnedHandle {
    if (this.disposing) throw new Error('The native kernel is disposing.')
    const generation = this.nextHandleGeneration++
    const owned = new OwnedHandle(generation, value, handle => {
      const current = this.handles.get(handle.generation)
      if (current !== handle) return
      const succeeded = this.ffi.load({
        library: this.kernelLibrary,
        funcName: 'CloseHandle',
        retType: this.ffi.DataType.I32,
        paramsType: [this.ffi.DataType.External],
        paramsValue: [handle.value],
      })
      if (succeeded === 0) throw new Error('CloseHandle failed.')
      this.handles.delete(handle.generation)
    })
    this.handles.set(generation, owned)
    return owned
  }

  private ntOpen(
    parent: OwnedHandle,
    segment: string,
    disposition: number,
    attributes: number,
    options: number,
    desiredAccess: number,
    shareAccess = C.FILE_SHARE_READ | C.FILE_SHARE_WRITE,
  ): NtOpenResult {
    return this.ntOpenBytes(
      parent,
      Buffer.from(segment, 'utf16le'),
      disposition,
      attributes,
      options,
      desiredAccess,
      shareAccess,
    )
  }

  private ntOpenBytes(
    parent: OwnedHandle,
    name: Buffer,
    disposition: number,
    attributes: number,
    options: number,
    desiredAccess: number,
    shareAccess: number,
  ): NtOpenResult {
    if (this.disposing) throw new Error('The native kernel is disposing.')
    if (name.length === 0 || name.length > 510 || name.length % 2 !== 0) {
      throw new Error('The raw relative name is invalid.')
    }
    const t = this.ffi.DataType
    const unicodeString = { Length: t.I16, MaximumLength: t.I16, Buffer: t.External }
    const objectAttributes = {
      Length: t.U32,
      RootDirectory: t.External,
      ObjectName: t.External,
      Attributes: t.U32,
      SecurityDescriptor: t.External,
      SecurityQualityOfService: t.External,
    }
    const ioStatusBlock = { Status: t.I64, Information: t.U64 }
    const allocations: OwnedAllocation[] = []
    try {
      const terminatedName = Buffer.alloc(name.length + 2)
      name.copy(terminatedName)
      const nameType = this.ffi.arrayConstructor({
        type: t.U8Array,
        length: terminatedName.length,
        ffiTypeTag: this.ffi.FFITypeTag.StackArray,
      })
      const namePointer = this.ffi.createPointer({ paramsType: [nameType], paramsValue: [terminatedName] })
      allocations.push({ type: nameType, pointer: namePointer })
      const nameBuffer = this.ffi.unwrapPointer(namePointer)[0]
      if (nameBuffer === undefined) throw new Error('Missing relative-name pointer.')
      const unicodePointer = this.ffi.createPointer({
        paramsType: [unicodeString],
        paramsValue: [{ Length: name.length, MaximumLength: terminatedName.length, Buffer: nameBuffer }],
      })
      allocations.push({ type: unicodeString, pointer: unicodePointer })
      const unicodeNative = this.ffi.unwrapPointer(unicodePointer)[0]
      if (unicodeNative === undefined) throw new Error('Missing UNICODE_STRING pointer.')
      const attributesPointer = this.ffi.createPointer({
        paramsType: [objectAttributes],
        paramsValue: [{
          Length: 48,
          RootDirectory: parent.value,
          ObjectName: unicodeNative,
          // Preserve the exact wire spelling. OBJ_CASE_INSENSITIVE can select
          // the wrong entry in an NTFS directory with case sensitivity enabled.
          Attributes: C.OBJ_DONT_REPARSE,
          SecurityDescriptor: this.nullPointer,
          SecurityQualityOfService: this.nullPointer,
        }],
      })
      allocations.push({ type: objectAttributes, pointer: attributesPointer })
      const attributesNative = this.ffi.unwrapPointer(attributesPointer)[0]
      if (attributesNative === undefined) throw new Error('Missing OBJECT_ATTRIBUTES pointer.')
      const handleSlot = this.ffi.createPointer({
        paramsType: [t.External],
        paramsValue: [this.nullPointer],
      })
      allocations.push({ type: t.External, pointer: handleSlot })
      const ioPointer = this.ffi.createPointer({
        paramsType: [ioStatusBlock],
        paramsValue: [{ Status: 0, Information: 0 }],
      })
      allocations.push({ type: ioStatusBlock, pointer: ioPointer })
      const ioNative = this.ffi.unwrapPointer(ioPointer)[0]
      if (ioNative === undefined) throw new Error('Missing IO_STATUS_BLOCK pointer.')
      const status = this.ffi.load({
        library: this.ntdllLibrary,
        funcName: 'NtCreateFile',
        retType: t.I32,
        paramsType: [t.External, t.U32, t.External, t.External, t.External, t.U32, t.U32, t.U32, t.U32, t.External, t.U32],
        paramsValue: [
          handleSlot[0],
          desiredAccess,
          attributesNative,
          ioNative,
          this.nullPointer,
          attributes,
          shareAccess,
          disposition,
          options,
          this.nullPointer,
          0,
        ],
      })
      const information = this.ffi.createExternalBuffer(ioNative, 16).readBigUInt64LE(8)
      const restored = this.ffi.restorePointer({
        retType: [t.External],
        paramsValue: handleSlot,
      }) as unknown as JsExternal[]
      const value = restored[0]
      if (value === undefined) {
        throw new Error('NtCreateFile did not return a readable handle slot.')
      }
      if (this.ffi.isNullPointer(value)) {
        if (status < 0) return { status, information, ambiguous: false }
        throw new Error('NtCreateFile succeeded without returning a handle.')
      }
      return {
        status,
        information,
        ambiguous: status < 0,
        handle: this.adopt(value),
      }
    } finally {
      const errors: unknown[] = []
      for (let index = allocations.length - 1; index >= 0; index -= 1) {
        const allocation = allocations[index]
        if (allocation === undefined) continue
        try {
          this.ffi.freePointer({
            paramsType: [allocation.type as never],
            paramsValue: allocation.pointer,
            pointerType: this.ffi.PointerType.RsPointer,
          })
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Could not free native FFI parameters.')
    }
  }
}

class WindowsMutationWorkspace implements MutationBackendWorkspace {
  private readonly executions = new Set<Promise<MutationBackendOutcome>>()
  private disposePromise: Promise<void> | undefined
  private disposed = false

  constructor(
    readonly workspaceId: string,
    private readonly registeredRoot: string,
    private readonly root: OwnedHandle,
    private readonly rootInformation: NativeFileInformation,
    private readonly rootFileIdInformation: NativeFileIdInformation,
    private readonly kernel: WindowsKernel,
    private readonly onDispose: (workspace: WindowsMutationWorkspace) => void,
  ) {}

  execute(request: MutationBackendExecution): Promise<MutationBackendOutcome> {
    if (this.disposed) return Promise.resolve(unsupported())
    const execution = this.executeAdmitted(request)
    this.executions.add(execution)
    void execution.finally(() => { this.executions.delete(execution) }).catch(() => {})
    return execution
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      await Promise.allSettled([...this.executions])
      await this.root.close()
      this.onDispose(this)
    })()
    return this.disposePromise
  }

  private async executeAdmitted(request: MutationBackendExecution): Promise<MutationBackendOutcome> {
    if (request.operation.kind === 'rename') {
      return this.rename(request.operation, request.signal)
    }
    if (request.operation.kind === 'delete') {
      return this.delete(request.operation, request.signal)
    }
    if (request.operation.kind !== 'createFile' && request.operation.kind !== 'createDirectory') return unsupported()
    const segments = validSegments(request.operation)
    if (segments === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
    if (request.signal.aborted) return aborted()

    const held: OwnedHandle[] = []
    let parent = this.root
    let commitEntered = false
    try {
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (request.signal.aborted) return aborted()
        const segment = segments[index]
        if (segment === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
        const opened = this.kernel.ntOpenDirectory(parent, segment)
        if (opened.handle !== undefined) held.push(opened.handle)
        if (opened.ambiguous) return recovery()
        if (opened.status < 0 || opened.handle === undefined) {
          return notCommitted(statusIssue(opened.status, 'parent'))
        }
        const info = this.kernel.information(opened.handle)
        if ((info.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
          return notCommitted(issue('SYMLINK_NOT_ALLOWED', 'Reparse points are not available in the IDE.', 403))
        }
        if ((info.attributes & C.FILE_ATTRIBUTE_DIRECTORY) === 0) {
          return notCommitted(issue('NOT_DIRECTORY', 'A workspace parent path is not a directory.', 400))
        }
        if (info.volume !== this.rootInformation.volume) {
          return notCommitted(issue('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403))
        }
        if (this.kernel.normalizedLeafName(opened.handle) !== segment) {
          return notCommitted(issue(
            'PATH_IDENTITY_CHANGED',
            'A workspace parent resolved to a different normalized name.',
            409,
          ))
        }
        parent = opened.handle
      }

      if (request.signal.aborted) return aborted()
      const leafName = segments[segments.length - 1]
      if (leafName === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
      commitEntered = true
      const kind = request.operation.kind === 'createFile' ? 'file' : 'directory'
      const created = this.kernel.ntCreateLeaf(parent, leafName, kind)
      if (created.handle !== undefined) held.push(created.handle)
      if (created.ambiguous) return recovery()
      if (created.status < 0 || created.handle === undefined) {
        commitEntered = false
        return notCommitted(statusIssue(created.status, 'create'))
      }
      if (created.information !== C.FILE_CREATED) return recovery()
      if (this.kernel.normalizedLeafName(created.handle) !== leafName) return recovery()

      const firstInfo = this.kernel.information(created.handle)
      if (firstInfo.volume !== this.rootInformation.volume
        || (firstInfo.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        || ((firstInfo.attributes & C.FILE_ATTRIBUTE_DIRECTORY) !== 0) !== (kind === 'directory')) {
        return recovery()
      }

      const observed = await lstat(join(this.registeredRoot, ...segments), { bigint: true })
      const finalInfo = this.kernel.information(created.handle)
      if (!sameNativeIdentity(firstInfo, finalInfo)
        || !matchesStat(finalInfo, observed)
        || observed.isSymbolicLink()
        || ((finalInfo.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0)
        || observed.isDirectory() !== (kind === 'directory')
        || observed.isFile() !== (kind === 'file')) return recovery()

      return {
        state: 'committed',
        evidence: kind === 'file'
          ? { kind: 'createFile', resourceKind: 'file', version: versionOf(observed) }
          : { kind: 'createDirectory', resourceKind: 'directory', version: versionOf(observed) },
      }
    } catch (error) {
      return commitEntered
        ? recovery(error)
        : notCommitted(issue('WORKSPACE_MUTATION_FAILED', 'The Host could not prepare the workspace mutation.', 409))
    } finally {
      const closeErrors: unknown[] = []
      for (let index = held.length - 1; index >= 0; index -= 1) {
        try { await held[index]?.close() } catch (error) { closeErrors.push(error) }
      }
      if (closeErrors.length > 0) throw new AggregateError(closeErrors, 'Could not close native mutation handles.')
    }
  }

  private consumeDeleteQuery(budget: DeleteBudget): void {
    budget.queries += 1
    if (budget.queries > DELETE_MAX_QUERIES) throw new Error('The recursive-delete scan budget was exceeded.')
  }

  private consumeDeleteEntry(budget: DeleteBudget, entry: NativeDirectoryEntry): void {
    if (!safeRawLeaf(entry.name)) throw new Error('A directory returned an unsafe raw leaf name.')
    budget.entries += 1
    budget.nameBytes += entry.name.length
    if (budget.entries > DELETE_MAX_ENTRIES || budget.nameBytes > DELETE_MAX_NAME_BYTES) {
      throw new Error('The recursive-delete entry budget was exceeded.')
    }
  }

  private readAllDeleteEntries(directory: OwnedHandle, budget: DeleteBudget): readonly NativeDirectoryEntry[] {
    const entries: NativeDirectoryEntry[] = []
    let restart = true
    for (;;) {
      this.consumeDeleteQuery(budget)
      const query = this.kernel.queryDirectory(directory, restart)
      restart = false
      if (query.noMoreFiles) return entries
      for (const entry of query.entries) {
        this.consumeDeleteEntry(budget, entry)
        entries.push(entry)
      }
    }
  }

  private readFirstDeleteEntry(directory: OwnedHandle, budget: DeleteBudget): NativeDirectoryEntry | undefined {
    let restart = true
    for (;;) {
      this.consumeDeleteQuery(budget)
      const query = this.kernel.queryDirectory(directory, restart, true)
      restart = false
      if (query.noMoreFiles) return undefined
      const entry = query.entries[0]
      if (entry !== undefined) {
        this.consumeDeleteEntry(budget, entry)
        return entry
      }
    }
  }

  private async openVerifiedDeleteEntry(
    parent: OwnedHandle,
    entry: NativeDirectoryEntry,
  ): Promise<{ readonly handle: OwnedHandle; readonly information: NativeFileInformation }> {
    const opened = this.kernel.ntOpenDeleteRaw(parent, entry.name, entry.kind)
    if (opened.ambiguous || opened.status !== 0 || opened.handle === undefined) {
      if (opened.handle !== undefined) {
        try { await opened.handle.close() } catch (error) { throw new NativeCloseError(error) }
      }
      if (opened.ambiguous) throw new NativeDeleteAmbiguousError('A recursive child open was ambiguous.')
      throw new Error(`A recursive child could not be opened safely (0x${unsignedStatus(opened.status).toString(16)}).`)
    }
    const handle = opened.handle
    try {
      if (!this.kernel.normalizedLeafBytes(handle).equals(entry.name)) {
        throw new Error('A recursive child resolved to a different raw leaf.')
      }
      const information = this.kernel.information(handle)
      const fileId = this.kernel.fileIdInformation(handle)
      const attributeTag = this.kernel.attributeTagInformation(handle)
      const directory = (attributeTag.attributes & C.FILE_ATTRIBUTE_DIRECTORY) !== 0
      const reparse = (attributeTag.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
      if (information.volume !== this.rootInformation.volume
        || fileId.volume !== this.rootFileIdInformation.volume
        || information.index !== fileId.id.readBigUInt64LE(0)
        || !fileId.id.equals(entry.fileId)
        || directory !== (entry.kind === 'directory')
        || reparse !== entry.reparsePoint
        || (reparse && attributeTag.reparseTag !== entry.reparseTag)) {
        throw new Error(`A recursive child changed identity, kind, volume, or reparse tag: ${JSON.stringify({
          name: entry.name.toString('utf16le'),
          informationVolume: information.volume.toString(),
          rootVolume: this.rootInformation.volume.toString(),
          fileIdVolume: fileId.volume.toString(),
          informationIndex: information.index.toString(),
          fileIdLow: fileId.id.readBigUInt64LE(0).toString(),
          enumeratedId: entry.fileId.toString('hex'),
          openedId: fileId.id.toString('hex'),
          directory, expectedDirectory: entry.kind === 'directory',
          reparse, expectedReparse: entry.reparsePoint,
          tag: attributeTag.reparseTag, expectedTag: entry.reparseTag,
        })}`)
      }
      return { handle, information }
    } catch (error) {
      try { await handle.close() } catch (closeError) { throw new NativeCloseError(closeError) }
      throw error
    }
  }

  private async preflightDeleteTree(
    directory: OwnedHandle,
    depth: number,
    budget: DeleteBudget,
    signal: AbortSignal,
  ): Promise<void> {
    if (depth > DELETE_MAX_DEPTH) throw new Error('The recursive-delete depth budget was exceeded.')
    if (signal.aborted) throw new Error('The recursive delete was aborted during preflight.')
    for (const entry of this.readAllDeleteEntries(directory, budget)) {
      const opened = await this.openVerifiedDeleteEntry(directory, entry)
      if (entry.kind === 'directory' && !entry.reparsePoint) {
        try {
          await this.preflightDeleteTree(opened.handle, depth + 1, budget, signal)
        } finally {
          try { await opened.handle.close() } catch (error) { throw new NativeCloseError(error) }
        }
      } else {
        try { await opened.handle.close() } catch (error) { throw new NativeCloseError(error) }
      }
    }
  }

  private async assertDeleteNameAbsent(
    parent: OwnedHandle,
    rawName: Buffer,
    kind: 'file' | 'directory',
  ): Promise<void> {
    const probe = this.kernel.ntProbeAbsentRaw(parent, rawName, kind)
    if (probe.handle !== undefined) {
      try { await probe.handle.close() } catch (error) { throw new NativeCloseError(error) }
    }
    if (probe.ambiguous || unsignedStatus(probe.status) !== STATUS.OBJECT_NAME_NOT_FOUND) {
      throw new Error('A deleted name remained reachable from its held parent.')
    }
  }

  private async purgeDeleteTree(
    directory: OwnedHandle,
    depth: number,
    budget: DeleteBudget,
  ): Promise<void> {
    if (depth > DELETE_MAX_DEPTH) throw new Error('The recursive-delete depth budget was exceeded.')
    for (;;) {
      const entry = this.readFirstDeleteEntry(directory, budget)
      if (entry === undefined) return
      const opened = await this.openVerifiedDeleteEntry(directory, entry)
      let closed = false
      try {
        let status: number
        for (;;) {
          if (entry.kind === 'directory' && !entry.reparsePoint) {
            await this.purgeDeleteTree(opened.handle, depth + 1, budget)
          }
          status = this.kernel.ntDeletePosix(opened.handle)
          if (unsignedStatus(status) === STATUS.DIRECTORY_NOT_EMPTY
            && entry.kind === 'directory' && !entry.reparsePoint) continue
          break
        }
        if (status !== 0) throw new Error(`Recursive disposition failed (0x${unsignedStatus(status).toString(16)}).`)
        try { await opened.handle.close() } catch (error) { throw new NativeCloseError(error) }
        closed = true
        await this.assertDeleteNameAbsent(directory, entry.name, entry.kind)
      } catch (error) {
        if (!closed) {
          try { await opened.handle.close() } catch (closeError) { throw new NativeCloseError(closeError) }
        }
        throw error
      }
    }
  }

  private async delete(
    operation: Extract<MutationBackendOperation, { kind: 'delete' }>,
    signal: AbortSignal,
  ): Promise<MutationBackendOutcome> {
    const segments = validPathSegments(operation.path.segments)
    if (segments === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
    if (!validExpected(operation)) {
      return notCommitted(issue('INVALID_EXPECTATION', 'The expected resource version is invalid.', 400))
    }
    if (signal.aborted) return aborted()

    const held: OwnedHandle[] = []
    let commitEntered = false
    let outcome: MutationBackendOutcome | undefined
    try {
      outcome = await (async (): Promise<MutationBackendOutcome> => {
        const parentResult = this.openDeleteParent(segments, signal, held)
        if ('outcome' in parentResult) return parentResult.outcome
        const sourceLeaf = segments[segments.length - 1]
        if (sourceLeaf === undefined) return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
        const sourceRaw = Buffer.from(sourceLeaf, 'utf16le')
        const opened = this.kernel.ntOpenDeleteSource(parentResult.parent, sourceLeaf, operation.expected.kind)
        if (opened.handle !== undefined) held.push(opened.handle)
        if (opened.ambiguous) return recovery()
        if (opened.status !== 0 || opened.handle === undefined) {
          return notCommitted(statusIssue(opened.status, 'source'))
        }
        const source = opened.handle
        const firstInformation = this.kernel.information(source)
        if (firstInformation.volume !== this.rootInformation.volume
          || (firstInformation.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
          || !nativeKindMatches(firstInformation, operation.expected.kind)) {
          return notCommitted(issue('SOURCE_IDENTITY_CHANGED', 'The source resource changed before commit.', 409))
        }
        if (!this.kernel.normalizedLeafBytes(source).equals(sourceRaw)) {
          return notCommitted(issue('PATH_IDENTITY_CHANGED', 'The source resolved to a different raw name.', 409))
        }

        const sourcePath = join(this.registeredRoot, ...segments)
        let firstSnapshot: BigIntStats
        try { firstSnapshot = await lstat(sourcePath, { bigint: true }) } catch {
          return notCommitted(issue('SOURCE_IDENTITY_CHANGED', 'The source resource changed before commit.', 409))
        }
        if (statKind(firstSnapshot) !== operation.expected.kind
          || !matchesStat(firstInformation, firstSnapshot)
          || versionOf(firstSnapshot) !== operation.expected.version) {
          return notCommitted(issue('VERSION_CONFLICT', 'The resource changed before the mutation.', 409))
        }

        if (operation.recursive && operation.expected.kind === 'directory') {
          await this.preflightDeleteTree(
            source,
            0,
            { entries: 0, queries: 0, nameBytes: 0 },
            signal,
          )
        }

        const fenceInformation = this.kernel.information(source)
        let fenceSnapshot: BigIntStats
        try { fenceSnapshot = await lstat(sourcePath, { bigint: true }) } catch {
          return notCommitted(issue('SOURCE_IDENTITY_CHANGED', 'The source resource changed before commit.', 409))
        }
        if (!sameNativeIdentity(firstInformation, fenceInformation)
          || firstInformation.attributes !== fenceInformation.attributes
          || !matchesStat(fenceInformation, fenceSnapshot)
          || statKind(fenceSnapshot) !== operation.expected.kind
          || versionOf(fenceSnapshot) !== operation.expected.version
          || versionOf(firstSnapshot) !== versionOf(fenceSnapshot)) {
          return notCommitted(issue('VERSION_CONFLICT', 'The resource changed before the mutation.', 409))
        }
        if (signal.aborted) return aborted()

        if (operation.recursive && operation.expected.kind === 'directory') {
          const tombstone = `${DELETE_TOMBSTONE_PREFIX}${randomUUID()}`
          const tombstoneRaw = Buffer.from(tombstone, 'utf16le')
          commitEntered = true
          const renameStatus = this.kernel.ntRenameNoReplace(source, parentResult.parent, tombstone)
          if (renameStatus !== 0) {
            if (renameStatus < 0) {
              commitEntered = false
              return notCommitted(statusIssue(renameStatus, 'rename'))
            }
            return recovery()
          }
          if (!this.kernel.normalizedLeafBytes(source).equals(tombstoneRaw)) return recovery()
          const movedInformation = this.kernel.information(source)
          if (!sameNativeIdentity(firstInformation, movedInformation)
            || movedInformation.attributes !== firstInformation.attributes) return recovery()
          await this.assertDeleteNameAbsent(parentResult.parent, sourceRaw, 'directory')

          const purgeBudget: DeleteBudget = { entries: 0, queries: 0, nameBytes: 0 }
          let rootStatus: number
          for (;;) {
            await this.purgeDeleteTree(source, 0, purgeBudget)
            rootStatus = this.kernel.ntDeletePosix(source)
            if (unsignedStatus(rootStatus) !== STATUS.DIRECTORY_NOT_EMPTY) break
          }
          if (rootStatus !== 0) throw new Error(`Root disposition failed (0x${unsignedStatus(rootStatus).toString(16)}).`)
          try { await source.close() } catch (error) { throw new NativeCloseError(error) }
          await this.assertDeleteNameAbsent(parentResult.parent, tombstoneRaw, 'directory')
          await this.assertDeleteNameAbsent(parentResult.parent, sourceRaw, 'directory')
        } else {
          commitEntered = true
          const status = this.kernel.ntDeletePosix(source)
          if (status !== 0) {
            if (status < 0) {
              commitEntered = false
              return notCommitted(statusIssue(status, 'delete'))
            }
            return recovery()
          }
          try { await source.close() } catch (error) { throw new NativeCloseError(error) }
          await this.assertDeleteNameAbsent(parentResult.parent, sourceRaw, operation.expected.kind)
        }

        return {
          state: 'committed',
          evidence: {
            kind: 'delete',
            resourceKind: operation.expected.kind,
            recursive: operation.recursive,
          },
        }
      })()
    } catch (error) {
      outcome = commitEntered || error instanceof NativeCloseError || error instanceof NativeDeleteAmbiguousError
        ? recovery(error)
        : notCommitted(issue('WORKSPACE_MUTATION_FAILED', 'The Host could not prepare the workspace deletion.', 409))
    }

    const closeErrors: unknown[] = []
    for (let index = held.length - 1; index >= 0; index -= 1) {
      try { await held[index]?.close() } catch (error) { closeErrors.push(error) }
    }
    if (closeErrors.length > 0) return recovery(new AggregateError(closeErrors, 'Could not close native delete handles.'))
    return outcome ?? recovery()
  }

  private openDeleteParent(
    segments: readonly string[],
    signal: AbortSignal,
    held: OwnedHandle[],
  ): { readonly parent: OwnedHandle } | { readonly outcome: MutationBackendOutcome } {
    let parent = this.root
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (signal.aborted) return { outcome: aborted() }
      const segment = segments[index]
      if (segment === undefined) return { outcome: notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400)) }
      // Ancestor traversal is not part of the delete lock: keeping normal
      // read/write sharing lets the ambient lstat fences inspect nested paths.
      // The source and every enumerated child remain opened with share-read only.
      const opened = this.kernel.ntOpenDirectory(parent, segment)
      if (opened.handle !== undefined) held.push(opened.handle)
      if (opened.ambiguous) return { outcome: recovery() }
      if (opened.status !== 0 || opened.handle === undefined) {
        return { outcome: notCommitted(statusIssue(opened.status, 'parent')) }
      }
      const information = this.kernel.information(opened.handle)
      if (information.volume !== this.rootInformation.volume
        || (information.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        || (information.attributes & C.FILE_ATTRIBUTE_DIRECTORY) === 0
        || this.kernel.normalizedLeafName(opened.handle) !== segment) {
        return { outcome: notCommitted(issue('PARENT_IDENTITY_CHANGED', 'A workspace parent changed.', 409)) }
      }
      parent = opened.handle
    }
    return { parent }
  }

  private async rename(
    operation: Extract<MutationBackendOperation, { kind: 'rename' }>,
    signal: AbortSignal,
  ): Promise<MutationBackendOutcome> {
    const sourceSegments = validPathSegments(operation.path.segments)
    const destinationSegments = validPathSegments(operation.destinationPath.segments)
    if (sourceSegments === undefined || destinationSegments === undefined) {
      return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
    }
    if (sameExactPath(sourceSegments, destinationSegments)) {
      return notCommitted(issue('INVALID_DESTINATION', 'The destination must differ from the source.', 400))
    }
    if ((operation.expected.kind !== 'file' && operation.expected.kind !== 'directory')
      || typeof operation.expected.version !== 'string'
      || operation.expected.version.length === 0
      || Buffer.byteLength(operation.expected.version, 'utf8') > MUTATION_BUDGETS.maxVersionBytes) {
      return notCommitted(issue('INVALID_EXPECTATION', 'The expected resource version is invalid.', 400))
    }
    if (operation.expected.kind === 'directory'
      && destinationInsideSource(sourceSegments, destinationSegments)) {
      return notCommitted(issue(
        'INVALID_DESTINATION',
        'A directory cannot be renamed into its own subtree.',
        400,
      ))
    }
    if (signal.aborted) return aborted()

    const held: OwnedHandle[] = []
    let commitEntered = false
    try {
      const sourceParentResult = this.openRenameParent(sourceSegments, signal, held)
      if ('outcome' in sourceParentResult) return sourceParentResult.outcome
      const destinationParentResult = this.openRenameParent(destinationSegments, signal, held)
      if ('outcome' in destinationParentResult) return destinationParentResult.outcome
      if (signal.aborted) return aborted()

      const sourceLeaf = sourceSegments[sourceSegments.length - 1]
      const destinationLeaf = destinationSegments[destinationSegments.length - 1]
      if (sourceLeaf === undefined || destinationLeaf === undefined) {
        return notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400))
      }
      const openedSource = this.kernel.ntOpenRenameSource(
        sourceParentResult.parent,
        sourceLeaf,
        operation.expected.kind,
      )
      if (openedSource.handle !== undefined) held.push(openedSource.handle)
      if (openedSource.ambiguous) return recovery()
      if (openedSource.status < 0 || openedSource.handle === undefined) {
        return notCommitted(statusIssue(openedSource.status, 'source'))
      }

      const sourceInformation = this.kernel.information(openedSource.handle)
      if ((sourceInformation.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        return notCommitted(issue('SYMLINK_NOT_ALLOWED', 'Reparse points are not available in the IDE.', 403))
      }
      if (sourceInformation.volume !== this.rootInformation.volume) {
        return notCommitted(issue('MOUNT_NOT_ALLOWED', 'Mounted workspace paths are not available in the IDE.', 403))
      }
      if (!nativeKindMatches(sourceInformation, operation.expected.kind)) {
        return notCommitted(issue('RESOURCE_KIND_CONFLICT', 'The resource kind changed.', 409))
      }
      if (this.kernel.normalizedLeafName(openedSource.handle) !== sourceLeaf) {
        return notCommitted(issue(
          'PATH_IDENTITY_CHANGED',
          'The source resolved to a different normalized name.',
          409,
        ))
      }

      const sourcePath = join(this.registeredRoot, ...sourceSegments)
      let sourceSnapshot: BigIntStats
      try {
        sourceSnapshot = await lstat(sourcePath, { bigint: true })
      } catch (error) {
        return notCommitted(issue(
          'SOURCE_IDENTITY_CHANGED',
          'The source resource changed before commit.',
          409,
        ))
      }
      const observedKind = statKind(sourceSnapshot)
      if (observedKind === undefined) {
        return notCommitted(issue(
          'RESOURCE_TYPE_UNSUPPORTED',
          'Only regular files and directories can be renamed.',
          409,
        ))
      }
      if (observedKind !== operation.expected.kind) {
        return notCommitted(issue('RESOURCE_KIND_CONFLICT', 'The resource kind changed.', 409))
      }
      if (!matchesStat(sourceInformation, sourceSnapshot)
        || sourceInformation.volume !== this.rootInformation.volume) {
        return notCommitted(issue(
          'SOURCE_IDENTITY_CHANGED',
          'The source resource changed before commit.',
          409,
        ))
      }
      if (versionOf(sourceSnapshot) !== operation.expected.version) {
        return notCommitted(issue('VERSION_CONFLICT', 'The resource changed before the mutation.', 409))
      }
      const sourceFence = this.kernel.information(openedSource.handle)
      if (!sameNativeIdentity(sourceInformation, sourceFence)
        || sourceFence.attributes !== sourceInformation.attributes) {
        return notCommitted(issue(
          'SOURCE_IDENTITY_CHANGED',
          'The source resource changed before commit.',
          409,
        ))
      }
      if (signal.aborted) return aborted()

      commitEntered = true
      const status = this.kernel.ntRenameNoReplace(
        openedSource.handle,
        destinationParentResult.parent,
        destinationLeaf,
      )
      if (status !== 0) {
        if (status < 0) {
          commitEntered = false
          return notCommitted(statusIssue(status, 'rename'))
        }
        return recovery()
      }

      if (this.kernel.normalizedLeafName(openedSource.handle) !== destinationLeaf) return recovery()
      const committedInformation = this.kernel.information(openedSource.handle)
      if (!sameNativeIdentity(sourceInformation, committedInformation)
        || committedInformation.volume !== this.rootInformation.volume
        || (committedInformation.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        || !nativeKindMatches(committedInformation, operation.expected.kind)) return recovery()

      const destinationPath = join(this.registeredRoot, ...destinationSegments)
      const destinationSnapshot = await lstat(destinationPath, { bigint: true })
      const finalInformation = this.kernel.information(openedSource.handle)
      if (!sameNativeIdentity(committedInformation, finalInformation)
        || finalInformation.attributes !== committedInformation.attributes
        || !matchesStat(finalInformation, destinationSnapshot)
        || statKind(destinationSnapshot) !== operation.expected.kind
        || !sameMovedSnapshot(sourceSnapshot, destinationSnapshot)) return recovery()

      return {
        state: 'committed',
        evidence: {
          kind: 'rename',
          resourceKind: operation.expected.kind,
          version: versionOf(destinationSnapshot),
        },
      }
    } catch (error) {
      return commitEntered
        ? recovery(error)
        : notCommitted(issue(
          'WORKSPACE_MUTATION_FAILED',
          'The Host could not prepare the workspace rename.',
          409,
        ))
    } finally {
      const closeErrors: unknown[] = []
      for (let index = held.length - 1; index >= 0; index -= 1) {
        try { await held[index]?.close() } catch (error) { closeErrors.push(error) }
      }
      if (closeErrors.length > 0) throw new AggregateError(closeErrors, 'Could not close native rename handles.')
    }
  }

  private openRenameParent(
    segments: readonly string[],
    signal: AbortSignal,
    held: OwnedHandle[],
  ): { readonly parent: OwnedHandle } | { readonly outcome: MutationBackendOutcome } {
    let parent = this.root
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (signal.aborted) return { outcome: aborted() }
      const segment = segments[index]
      if (segment === undefined) {
        return { outcome: notCommitted(issue('INVALID_PATH', 'The workspace path is invalid.', 400)) }
      }
      const opened = this.kernel.ntOpenDirectory(parent, segment)
      if (opened.handle !== undefined) held.push(opened.handle)
      if (opened.ambiguous) return { outcome: recovery() }
      if (opened.status < 0 || opened.handle === undefined) {
        return { outcome: notCommitted(statusIssue(opened.status, 'parent')) }
      }
      const information = this.kernel.information(opened.handle)
      if ((information.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        return { outcome: notCommitted(issue(
          'SYMLINK_NOT_ALLOWED',
          'Reparse points are not available in the IDE.',
          403,
        )) }
      }
      if ((information.attributes & C.FILE_ATTRIBUTE_DIRECTORY) === 0) {
        return { outcome: notCommitted(issue(
          'NOT_DIRECTORY',
          'A workspace parent path is not a directory.',
          400,
        )) }
      }
      if (information.volume !== this.rootInformation.volume) {
        return { outcome: notCommitted(issue(
          'MOUNT_NOT_ALLOWED',
          'Mounted workspace paths are not available in the IDE.',
          403,
        )) }
      }
      if (this.kernel.normalizedLeafName(opened.handle) !== segment) {
        return { outcome: notCommitted(issue(
          'PATH_IDENTITY_CHANGED',
          'A workspace parent resolved to a different normalized name.',
          409,
        )) }
      }
      parent = opened.handle
    }
    return { parent }
  }
}

class WindowsMutationBackend implements MutationBackend {
  readonly descriptor = WINDOWS_DESCRIPTOR
  private readonly workspaces = new Set<WindowsMutationWorkspace>()
  private readonly opens = new Set<Promise<MutationBackendWorkspace>>()
  private disposePromise: Promise<void> | undefined
  private disposed = false

  constructor(private readonly kernel: WindowsKernel) {}

  openWorkspace(request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace> {
    if (this.disposed) {
      return Promise.reject(new IdeHostError(
        'WORKSPACE_MUTATION_UNAVAILABLE',
        'The Windows workspace mutation backend is disposed.',
        501,
      ))
    }
    const admitted = this.openWorkspaceAdmitted(request)
    this.opens.add(admitted)
    void admitted.finally(() => { this.opens.delete(admitted) }).catch(() => {})
    return admitted
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true
      await Promise.allSettled([...this.opens])
      await Promise.allSettled([...this.workspaces].map(workspace => workspace.dispose()))
      await this.kernel.dispose()
    })()
    return this.disposePromise
  }

  private async openWorkspaceAdmitted(request: OpenMutationBackendWorkspace): Promise<MutationBackendWorkspace> {
    if (request.signal.aborted) throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'Workspace opening was cancelled.', 409)
    let root: OwnedHandle | undefined
    try {
      root = this.kernel.openRoot(request.registeredRoot)
      if (this.kernel.fileSystemName(root) !== 'NTFS') {
        throw new IdeHostError(
          'WORKSPACE_MUTATION_UNAVAILABLE',
          'Containment-safe workspace mutations currently require a local NTFS volume.',
          501,
        )
      }
      const information = this.kernel.information(root)
      if ((information.attributes & C.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
        || (information.attributes & C.FILE_ATTRIBUTE_DIRECTORY) === 0) {
        throw new IdeHostError('WORKSPACE_UNAVAILABLE', 'The workspace root is not a real directory.', 409)
      }
      if (information.volume !== request.expectedRootIdentity.dev
        || information.index !== request.expectedRootIdentity.ino) {
        throw new IdeHostError('WORKSPACE_IDENTITY_CHANGED', 'The workspace root identity has changed.', 409)
      }
      if (request.signal.aborted || this.disposed) {
        throw new IdeHostError('WORKSPACE_MUTATION_UNAVAILABLE', 'Workspace opening was cancelled.', 409)
      }
      const workspace = new WindowsMutationWorkspace(
        request.workspaceId,
        request.registeredRoot,
        root,
        information,
        this.kernel.fileIdInformation(root),
        this.kernel,
        disposed => { this.workspaces.delete(disposed) },
      )
      this.workspaces.add(workspace)
      root = undefined
      return workspace
    } finally {
      await root?.close()
    }
  }
}

async function probe(kernel: WindowsKernel): Promise<void> {
  const rootPath = await mkdtemp(join(tmpdir(), 'dsh-code-ide-nt-probe-'))
  let workspace: WindowsMutationWorkspace | undefined
  let probeRoot: OwnedHandle | undefined
  let witnessRoot: OwnedHandle | undefined
  let witnessReader: OwnedHandle | undefined
  try {
    const rootStat = await lstat(rootPath, { bigint: true })
    probeRoot = kernel.openRoot(rootPath)
    if (kernel.fileSystemName(probeRoot) !== 'NTFS') {
      throw new Error('The Windows mutation backend requires a local NTFS volume.')
    }
    const information = kernel.information(probeRoot)
    if (!matchesStat(information, rootStat)) {
      throw new Error('The native root identity does not match Node BigIntStats.')
    }
    workspace = new WindowsMutationWorkspace(
      'probe', rootPath, probeRoot, information, kernel.fileIdInformation(probeRoot), kernel, () => {},
    )
    probeRoot = undefined
    const signal = new AbortController().signal
    const createDirectory = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createDirectory', path: { segments: ['directory'] } },
      signal,
    })
    const createFile = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createFile', path: { segments: ['directory', 'file'] } },
      signal,
    })
    const collide = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createFile', path: { segments: ['directory', 'file'] } },
      signal,
    })
    const createDestinationDirectory = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createDirectory', path: { segments: ['destination'] } },
      signal,
    })
    const sourceFile = await lstat(join(rootPath, 'directory', 'file'), { bigint: true })
    const renameFile = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'rename',
        path: { segments: ['directory', 'file'] },
        destinationPath: { segments: ['destination', 'moved-file'] },
        expected: { kind: 'file', version: versionOf(sourceFile) },
      },
      signal,
    })
    const createCollisionSource = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createFile', path: { segments: ['directory', 'collision-source'] } },
      signal,
    })
    const createCollisionTarget = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createFile', path: { segments: ['destination', 'collision-target'] } },
      signal,
    })
    const collisionSource = await lstat(join(rootPath, 'directory', 'collision-source'), { bigint: true })
    const renameCollision = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'rename',
        path: { segments: ['directory', 'collision-source'] },
        destinationPath: { segments: ['destination', 'collision-target'] },
        expected: { kind: 'file', version: versionOf(collisionSource) },
      },
      signal,
    })
    const createRenameDirectory = await workspace.execute({
      executionId: randomUUID(),
      operation: { kind: 'createDirectory', path: { segments: ['directory-to-rename'] } },
      signal,
    })
    const sourceDirectory = await lstat(join(rootPath, 'directory-to-rename'), { bigint: true })
    const renameDirectory = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'rename',
        path: { segments: ['directory-to-rename'] },
        destinationPath: { segments: ['renamed-directory'] },
        expected: { kind: 'directory', version: versionOf(sourceDirectory) },
      },
      signal,
    })

    const sharedPath = join(rootPath, 'posix-shared-reader.txt')
    const sharedContents = 'reader survives namespace unlink'
    await writeFile(sharedPath, sharedContents)
    witnessRoot = kernel.openRoot(rootPath)
    const readerOpen = kernel.ntOpenProbeReader(witnessRoot, 'posix-shared-reader.txt')
    if (readerOpen.status !== 0 || readerOpen.handle === undefined || readerOpen.ambiguous) {
      throw new Error('The POSIX-delete shared-reader witness could not open.')
    }
    witnessReader = readerOpen.handle
    const sharedInfo = await lstat(sharedPath, { bigint: true })
    const deleteShared = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['posix-shared-reader.txt'] },
        expected: { kind: 'file', version: versionOf(sharedInfo) }, recursive: false,
      },
      signal,
    })
    const sharedRead = kernel.readProbe(witnessReader, Buffer.byteLength(sharedContents)).toString('utf8')
    await witnessReader.close()
    witnessReader = undefined

    const readonlyPath = join(rootPath, 'readonly.txt')
    await writeFile(readonlyPath, 'readonly')
    await chmod(readonlyPath, 0o444)
    const readonlyInfo = await lstat(readonlyPath, { bigint: true })
    const deleteReadonly = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['readonly.txt'] },
        expected: { kind: 'file', version: versionOf(readonlyInfo) }, recursive: false,
      },
      signal,
    })

    const hardSourcePath = join(rootPath, 'hard-source.txt')
    const hardOtherPath = join(rootPath, 'hard-other.txt')
    await writeFile(hardSourcePath, 'hardlink-survives')
    await link(hardSourcePath, hardOtherPath)
    const hardInfo = await lstat(hardSourcePath, { bigint: true })
    const deleteHardLink = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['hard-source.txt'] },
        expected: { kind: 'file', version: versionOf(hardInfo) }, recursive: false,
      },
      signal,
    })
    const hardOtherContents = await readFile(hardOtherPath, 'utf8')

    const emptyPath = join(rootPath, 'empty-delete-directory')
    await mkdir(emptyPath)
    const emptyInfo = await lstat(emptyPath, { bigint: true })
    const deleteEmpty = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['empty-delete-directory'] },
        expected: { kind: 'directory', version: versionOf(emptyInfo) }, recursive: false,
      },
      signal,
    })

    const nonemptyPath = join(rootPath, 'nonempty-delete-directory')
    await mkdir(nonemptyPath)
    await writeFile(join(nonemptyPath, 'child.txt'), 'child')
    const nonemptyInfo = await lstat(nonemptyPath, { bigint: true })
    const rejectNonempty = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['nonempty-delete-directory'] },
        expected: { kind: 'directory', version: versionOf(nonemptyInfo) }, recursive: false,
      },
      signal,
    })

    const recursivePath = join(rootPath, 'recursive-delete-directory')
    const outsidePath = join(rootPath, 'outside-delete-sentinel')
    await mkdir(join(recursivePath, 'nested', 'deep'), { recursive: true })
    await writeFile(join(recursivePath, 'nested', 'deep', 'leaf.txt'), 'leaf')
    await mkdir(outsidePath)
    await writeFile(join(outsidePath, 'must-survive.txt'), 'sentinel')
    await symlink(outsidePath, join(recursivePath, 'outside-junction'), 'junction')
    const recursiveInfo = await lstat(recursivePath, { bigint: true })
    const deleteRecursive = await workspace.execute({
      executionId: randomUUID(),
      operation: {
        kind: 'delete', path: { segments: ['recursive-delete-directory'] },
        expected: { kind: 'directory', version: versionOf(recursiveInfo) }, recursive: true,
      },
      signal,
    })
    const sentinelContents = await readFile(join(outsidePath, 'must-survive.txt'), 'utf8')
    const deletedPathsAbsent = await Promise.all([
      sharedPath, readonlyPath, hardSourcePath, emptyPath, recursivePath,
    ].map(async path => {
      try { await lstat(path); return false } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    }))
    if (createFile.state !== 'committed'
      || createDirectory.state !== 'committed'
      || createDestinationDirectory.state !== 'committed'
      || collide.state !== 'notCommitted'
      || collide.error.code !== 'DESTINATION_EXISTS'
      || renameFile.state !== 'committed'
      || createCollisionSource.state !== 'committed'
      || createCollisionTarget.state !== 'committed'
      || renameCollision.state !== 'notCommitted'
      || renameCollision.error.code !== 'DESTINATION_EXISTS'
      || createRenameDirectory.state !== 'committed'
      || renameDirectory.state !== 'committed'
      || deleteShared.state !== 'committed'
      || sharedRead !== sharedContents
      || deleteReadonly.state !== 'committed'
      || deleteHardLink.state !== 'committed'
      || hardOtherContents !== 'hardlink-survives'
      || deleteEmpty.state !== 'committed'
      || rejectNonempty.state !== 'notCommitted'
      || rejectNonempty.error.code !== 'DIRECTORY_NOT_EMPTY'
      || deleteRecursive.state !== 'committed'
      || sentinelContents !== 'sentinel'
      || deletedPathsAbsent.some(absent => !absent)) {
      throw new Error('The Windows mutation primitive failed its runtime witness.')
    }
  } finally {
    await witnessReader?.close()
    await witnessRoot?.close()
    await workspace?.dispose()
    await probeRoot?.close()
    await rm(rootPath, { recursive: true, force: true })
  }
}

/**
 * Create the x64 Windows handle-relative backend only after its native ABI,
 * identity mapping, no-replace create and rename semantics all succeed.
 * Every unsupported platform or failed probe remains deliberately all-false.
 */
export async function createWindowsMutationBackend(): Promise<MutationBackend> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return createUnavailableMutationBackend()
  let kernel: WindowsKernel | undefined
  try {
    kernel = await WindowsKernel.create()
    await probe(kernel)
    return new WindowsMutationBackend(kernel)
  } catch {
    await kernel?.dispose().catch(() => {})
    return createUnavailableMutationBackend()
  }
}
