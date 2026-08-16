import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdeHostError } from '../../src/host/errors.js'
import {
  FfiNativeRenameAdapter,
  type FfiRuntime,
} from '../../src/host/native-rename.js'

function fakeFfi(value: { value: boolean | number; errnoCode: number }): FfiRuntime & { load: ReturnType<typeof vi.fn> } {
  return {
    DataType: { String: 0, WString: 15, I32: 1, U32: 20 },
    open: vi.fn(),
    close: vi.fn(),
    load: vi.fn(() => value),
  }
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation
    expect.unreachable(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(IdeHostError)
    expect((error as IdeHostError).code).toBe(code)
  }
}

describe('strict native no-replace rename adapter', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('calls Linux renameat2 with AT_FDCWD and RENAME_NOREPLACE only', async () => {
    const ffi = fakeFfi({ value: 0, errnoCode: 0 })
    ffi.load.mockReturnValueOnce({ value: -1, errnoCode: 2 })
    const adapter = new FfiNativeRenameAdapter({ platform: 'linux', loadFfi: async () => ffi })
    expect(await adapter.supported()).toBe(true)
    await adapter.moveNoReplace('/workspace/source', '/workspace/destination')

    const call = ffi.load.mock.calls.at(-1)?.[0] as { funcName: string; paramsValue: unknown[] }
    expect(call.funcName).toBe('renameat2')
    expect(call.paramsValue).toEqual([-100, '/workspace/source', -100, '/workspace/destination', 1])
    expect(call).toMatchObject({ retType: ffi.DataType.I32, errno: true, runInNewThread: true })
    await adapter.dispose()
  })

  it('calls macOS renamex_np with RENAME_EXCL only', async () => {
    const ffi = fakeFfi({ value: 0, errnoCode: 0 })
    ffi.load.mockReturnValueOnce({ value: -1, errnoCode: 2 })
    const adapter = new FfiNativeRenameAdapter({ platform: 'darwin', loadFfi: async () => ffi })
    expect(await adapter.supported()).toBe(true)
    await adapter.moveNoReplace('/workspace/source', '/workspace/destination')

    const call = ffi.load.mock.calls.at(-1)?.[0] as { funcName: string; paramsValue: unknown[] }
    expect(call.funcName).toBe('renamex_np')
    expect(call.paramsValue).toEqual(['/workspace/source', '/workspace/destination', 0x4])
    expect(call).toMatchObject({ retType: ffi.DataType.I32, errno: true, runInNewThread: true })
    await adapter.dispose()
  })

  it('fails closed for unsupported platforms and ENOSYS probes', async () => {
    const unsupported = new FfiNativeRenameAdapter({ platform: 'freebsd', loadFfi: vi.fn() })
    expect(await unsupported.supported()).toBe(false)
    await expectCode(unsupported.moveNoReplace('a', 'b'), 'ATOMIC_RENAME_UNSUPPORTED')

    const ffi = fakeFfi({ value: -1, errnoCode: 38 })
    const linux = new FfiNativeRenameAdapter({ platform: 'linux', loadFfi: async () => ffi })
    expect(await linux.supported()).toBe(false)
    await expectCode(linux.moveNoReplace('a', 'b'), 'ATOMIC_RENAME_UNSUPPORTED')
    await Promise.all([unsupported.dispose(), linux.dispose()])
  })

  it('projects no-replace, cross-device, unsupported, and unknown outcomes stably', async () => {
    for (const [errnoCode, code] of [[17, 'DESTINATION_EXISTS'], [18, 'CROSS_DEVICE_RENAME'], [22, 'ATOMIC_RENAME_UNSUPPORTED']] as const) {
      const ffi = fakeFfi({ value: -1, errnoCode })
      ffi.load.mockReturnValueOnce({ value: -1, errnoCode: 2 })
      const adapter = new FfiNativeRenameAdapter({ platform: 'linux', loadFfi: async () => ffi })
      expect(await adapter.supported()).toBe(true)
      await expectCode(adapter.moveNoReplace('/source', '/destination'), code)
      await adapter.dispose()
    }

    const ffi = fakeFfi({ value: -1, errnoCode: 2 })
    ffi.load.mockImplementationOnce(() => ({ value: -1, errnoCode: 2 }))
      .mockImplementationOnce(() => { throw new Error('ABI transport failed') })
    const unknown = new FfiNativeRenameAdapter({ platform: 'linux', loadFfi: async () => ffi })
    expect(await unknown.supported()).toBe(true)
    await expectCode(unknown.moveNoReplace('/source', '/destination'), 'ATOMIC_RENAME_OUTCOME_UNKNOWN')
    await unknown.dispose()
  })

  it('uses the exact 32-bit Win32 BOOL ABI and treats every non-zero result as success', async () => {
    const ffi = fakeFfi({ value: 256, errnoCode: 0 })
    ffi.load.mockReturnValueOnce({ value: 0, errnoCode: 2 })
    const adapter = new FfiNativeRenameAdapter({ platform: 'win32', loadFfi: async () => ffi })
    expect(await adapter.supported()).toBe(true)
    await adapter.moveNoReplace('C:\\workspace\\source', 'C:\\workspace\\destination')

    const call = ffi.load.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(call).toMatchObject({
      funcName: 'MoveFileExW',
      retType: ffi.DataType.I32,
      paramsValue: ['C:\\workspace\\source', 'C:\\workspace\\destination', 0],
      errno: true,
      runInNewThread: true,
    })
    await adapter.dispose()
  })

  it.runIf(process.platform === 'win32')('uses real MoveFileExW without replacing an existing target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-rename-'))
    roots.push(root)
    const first = join(root, 'first.txt')
    const moved = join(root, 'moved.txt')
    const second = join(root, 'second.txt')
    await writeFile(first, 'first')
    await writeFile(second, 'second')
    const firstIdentity = await lstat(first, { bigint: true })
    const secondIdentity = await lstat(second, { bigint: true })
    const adapter = new FfiNativeRenameAdapter()
    expect(await adapter.supported()).toBe(true)

    await adapter.moveNoReplace(first, moved)
    expect((await lstat(moved, { bigint: true })).ino).toBe(firstIdentity.ino)
    expect(await readFile(moved, 'utf8')).toBe('first')
    await expectCode(adapter.moveNoReplace(second, moved), 'DESTINATION_EXISTS')
    expect(await readFile(moved, 'utf8')).toBe('first')
    expect(await readFile(second, 'utf8')).toBe('second')
    expect((await lstat(second, { bigint: true })).ino).toBe(secondIdentity.ino)
    expect((await lstat(moved, { bigint: true })).ino).toBe(firstIdentity.ino)
    await adapter.dispose()
    expect(await adapter.supported()).toBe(false)

    const third = join(root, 'third.txt')
    const restarted = join(root, 'restarted.txt')
    await writeFile(third, 'third')
    const nextAdapter = new FfiNativeRenameAdapter()
    expect(await nextAdapter.supported()).toBe(true)
    await nextAdapter.moveNoReplace(third, restarted)
    expect(await readFile(restarted, 'utf8')).toBe('third')
    const unicodeSource = join(root, '源文件😀.txt')
    const unicodeDestination = join(root, '目标文件😀.txt')
    await writeFile(unicodeSource, 'unicode')
    await nextAdapter.moveNoReplace(unicodeSource, unicodeDestination)
    expect(await readFile(unicodeDestination, 'utf8')).toBe('unicode')
    await nextAdapter.dispose()
  })
})
