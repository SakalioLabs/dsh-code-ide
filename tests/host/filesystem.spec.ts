import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdeHostError } from '../../src/host/errors.js'
import {
  WorkspaceFileService,
  type WorkspaceFileServiceInternals,
} from '../../src/host/filesystem.js'

const WORKSPACE_ID = 'workspace-fixture'
const FOUR_MIB = 4 * 1024 * 1024

async function expectErrorCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation
    expect.unreachable(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(IdeHostError)
    expect((error as IdeHostError).code).toBe(code)
  }
}

describe('WorkspaceFileService', () => {
  let workspaceRoot: string
  let files: WorkspaceFileService

  function createFiles(internals: WorkspaceFileServiceInternals = {}): WorkspaceFileService {
    return new WorkspaceFileService({
      list: () => [{ id: WORKSPACE_ID, path: workspaceRoot, title: 'Fixture' }],
    }, {
      maxFileBytes: FOUR_MIB,
      maxDirectoryEntries: 5_000,
    }, internals)
  }

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-code-ide-files-'))
    files = createFiles()
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3 })
  })

  it('lists, reads, updates, and creates workspace files', async () => {
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'export const answer = 42\n')

    const root = await files.list(WORKSPACE_ID, '')
    expect(root.entries).toHaveLength(1)
    expect(root.entries[0]).toMatchObject({ name: 'src', path: 'src', type: 'directory' })

    const directory = await files.list(WORKSPACE_ID, 'src')
    expect(directory.entries).toHaveLength(1)
    expect(directory.entries[0]).toMatchObject({
      name: 'main.ts',
      path: 'src/main.ts',
      type: 'file',
      size: Buffer.byteLength('export const answer = 42\n'),
    })

    const opened = await files.read(WORKSPACE_ID, 'src/main.ts')
    expect(opened.content).toBe('export const answer = 42\n')
    expect(opened.version).toBeTypeOf('string')

    const saved = await files.write(
      WORKSPACE_ID,
      'src/main.ts',
      'export const answer = 43\n// saved\n',
      opened.version,
    )
    expect(saved.version).not.toBe(opened.version)
    const reopened = await files.read(WORKSPACE_ID, 'src/main.ts')
    expect(reopened.content).toBe('export const answer = 43\n// saved\n')
    expect(reopened.version).toBe(saved.version)

    const created = await files.write(WORKSPACE_ID, 'src/new.ts', 'export {}\n', undefined)
    expect(created.path).toBe('src/new.ts')
    expect((await files.read(WORKSPACE_ID, 'src/new.ts')).content).toBe('export {}\n')
  })

  it('reports a version conflict without overwriting the external change', async () => {
    const absolutePath = join(workspaceRoot, 'conflict.txt')
    await writeFile(absolutePath, 'initial\n')
    const opened = await files.read(WORKSPACE_ID, 'conflict.txt')

    await writeFile(absolutePath, 'external writer won\n')
    await expectErrorCode(
      files.write(WORKSPACE_ID, 'conflict.txt', 'stale editor content\n', opened.version),
      'VERSION_CONFLICT',
    )
    expect(await readFile(absolutePath, 'utf8')).toBe('external writer won\n')
  })

  it('rejects a path replacement that races an opened-file read', async () => {
    const absolutePath = join(workspaceRoot, 'read-race.txt')
    const replacement = join(workspaceRoot, 'read-race-replacement.txt')
    await writeFile(absolutePath, 'content from the opened file\n')
    await writeFile(replacement, 'replacement content\n')
    files = createFiles({
      afterOpenedFileRead: async (path) => {
        expect(path).toBe(absolutePath)
        // Windows denies renaming over an opened file, which itself prevents
        // this replacement race; mutate the opened inode there to exercise
        // the equivalent snapshot-conflict path deterministically.
        if (process.platform === 'win32') await writeFile(path, 'replacement content\n')
        else await rename(replacement, absolutePath)
      },
    })

    await expectErrorCode(files.read(WORKSPACE_ID, 'read-race.txt'), 'VERSION_CONFLICT')
    expect(await readFile(absolutePath, 'utf8')).toBe('replacement content\n')
  })

  it('does not return an external replacement version after publication', async () => {
    const absolutePath = join(workspaceRoot, 'publish-race.txt')
    const replacement = join(workspaceRoot, 'publish-race-replacement.txt')
    await writeFile(absolutePath, 'initial\n')
    const opened = await files.read(WORKSPACE_ID, 'publish-race.txt')
    await writeFile(replacement, 'external replacement\n')
    files = createFiles({
      afterPublishCommit: async (path) => {
        expect(path).toBe(absolutePath)
        await rename(replacement, absolutePath)
      },
    })

    await expectErrorCode(
      files.write(WORKSPACE_ID, 'publish-race.txt', 'editor save\n', opened.version),
      'VERSION_CONFLICT',
    )
    expect(await readFile(absolutePath, 'utf8')).toBe('external replacement\n')
  })

  it('restores POSIX mode bits when atomically replacing a file', async () => {
    if (process.platform === 'win32') return
    const absolutePath = join(workspaceRoot, 'executable.sh')
    await writeFile(absolutePath, '#!/bin/sh\nexit 0\n')
    await chmod(absolutePath, 0o751)
    const opened = await files.read(WORKSPACE_ID, 'executable.sh')

    await files.write(
      WORKSPACE_ID,
      'executable.sh',
      '#!/bin/sh\necho saved\n',
      opened.version,
    )
    const info = await lstat(absolutePath, { bigint: true })
    expect(Number(info.mode & 0o777n)).toBe(0o751)
  })

  it('rejects symbolic links when the platform permits creating one', async () => {
    await writeFile(join(workspaceRoot, 'target.txt'), 'target\n')
    try {
      if (process.platform === 'win32') {
        await symlink('target.txt', join(workspaceRoot, 'linked.txt'), 'file')
      } else {
        await symlink('target.txt', join(workspaceRoot, 'linked.txt'))
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return
      throw error
    }

    const listing = await files.list(WORKSPACE_ID, '')
    expect(listing.entries.find(entry => entry.name === 'linked.txt')?.type).toBe('other')
    await expectErrorCode(files.read(WORKSPACE_ID, 'linked.txt'), 'SYMLINK_NOT_ALLOWED')
  })

  it('accepts exactly 4 MiB, projects larger reads, and rejects larger writes', async () => {
    const atLimit = 'x'.repeat(FOUR_MIB)
    const overLimit = `${atLimit}x`

    await files.write(WORKSPACE_ID, 'at-limit.txt', atLimit, undefined)
    expect((await files.read(WORKSPACE_ID, 'at-limit.txt')).content).toHaveLength(FOUR_MIB)

    await expectErrorCode(
      files.write(WORKSPACE_ID, 'write-too-large.txt', overLimit, undefined),
      'FILE_TOO_LARGE',
    )
    await writeFile(join(workspaceRoot, 'read-too-large.txt'), overLimit)
    const projected = await files.read(WORKSPACE_ID, 'read-too-large.txt')
    expect(projected.readOnlyPresentation).toEqual({
      reason: 'too-large',
      sizeBytes: FOUR_MIB + 1,
      limitBytes: FOUR_MIB,
      previewBytes: 64 * 1024,
      truncated: true,
    })
    expect(Buffer.byteLength(projected.content, 'utf8')).toBe(64 * 1024)
  })

  it('returns a versioned read-only placeholder for binary bytes', async () => {
    await writeFile(join(workspaceRoot, 'binary.dat'), Buffer.from([0x61, 0x00, 0x62]))
    const projected = await files.read(WORKSPACE_ID, 'binary.dat')
    expect(projected.content).toBe('')
    expect(projected.version).toBeTypeOf('string')
    expect(projected.readOnlyPresentation).toEqual({
      reason: 'binary', sizeBytes: 3, limitBytes: FOUR_MIB, previewBytes: 0, truncated: true,
    })
  })

  it('inspects files, de-duplicates exact targets, and treats missing resources as snapshots', async () => {
    await mkdir(join(workspaceRoot, 'src'))
    await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'export const value = 1\n')

    const result = await files.inspect(WORKSPACE_ID, [
      { kind: 'directory', path: '' },
      { kind: 'file', path: 'src/main.ts' },
      { kind: 'file', path: 'src/main.ts' },
      { kind: 'file', path: 'src/missing.ts' },
      { kind: 'directory', path: 'gone/nested' },
    ])

    expect(result.snapshots).toHaveLength(4)
    expect(result.snapshots[0]).toMatchObject({ kind: 'directory', path: '', state: 'present' })
    expect(result.snapshots[1]).toMatchObject({
      kind: 'file',
      path: 'src/main.ts',
      state: 'present',
      size: Buffer.byteLength('export const value = 1\n'),
    })
    expect(result.snapshots[2]).toEqual({ kind: 'file', path: 'src/missing.ts', state: 'missing' })
    expect(result.snapshots[3]).toEqual({ kind: 'directory', path: 'gone/nested', state: 'missing' })
  })

  it('uses non-recursive direct-child directory fingerprints', async () => {
    await mkdir(join(workspaceRoot, 'src', 'nested'), { recursive: true })
    await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'one\n')
    await writeFile(join(workspaceRoot, 'src', 'nested', 'deep.ts'), 'one\n')

    const version = async (): Promise<string> => {
      const result = await files.inspect(WORKSPACE_ID, [{ kind: 'directory', path: 'src' }])
      const snapshot = result.snapshots[0]
      expect(snapshot?.state).toBe('present')
      return snapshot?.state === 'present' ? snapshot.version : ''
    }

    const initial = await version()
    await writeFile(join(workspaceRoot, 'src', 'main.ts'), 'content changes do not alter child identity\n')
    expect(await version()).toBe(initial)
    await writeFile(join(workspaceRoot, 'src', 'nested', 'deep.ts'), 'nested content is not traversed\n')
    expect(await version()).toBe(initial)
    await writeFile(join(workspaceRoot, 'src', 'created.ts'), 'new child\n')
    const created = await version()
    expect(created).not.toBe(initial)
    await rm(join(workspaceRoot, 'src', 'created.ts'))
    expect(await version()).toBe(initial)
  })

  it('bounds raw inspect targets and the aggregate direct-child scan budget', async () => {
    files = new WorkspaceFileService({
      list: () => [{ id: WORKSPACE_ID, path: workspaceRoot, title: 'Fixture' }],
    }, {
      maxFileBytes: FOUR_MIB,
      maxDirectoryEntries: 5_000,
      maxInspectTargets: 2,
      maxInspectDirectoryEntries: 2,
    })
    await mkdir(join(workspaceRoot, 'first'))
    await mkdir(join(workspaceRoot, 'second'))
    await writeFile(join(workspaceRoot, 'first', 'a.txt'), 'a')
    await writeFile(join(workspaceRoot, 'second', 'b.txt'), 'b')
    await writeFile(join(workspaceRoot, 'second', 'c.txt'), 'c')

    await expectErrorCode(files.inspect(WORKSPACE_ID, [
      { kind: 'file', path: 'missing-a' },
      { kind: 'file', path: 'missing-a' },
      { kind: 'file', path: 'missing-a' },
    ]), 'TOO_MANY_INSPECT_TARGETS')
    await expectErrorCode(files.inspect(WORKSPACE_ID, [
      { kind: 'directory', path: 'first' },
      { kind: 'directory', path: 'second' },
    ]), 'INSPECT_DIRECTORY_BUDGET_EXCEEDED')
  })

  it('rejects an invalid wire path for the whole inspect batch', async () => {
    await expectErrorCode(files.inspect(WORKSPACE_ID, [
      { kind: 'file', path: 'missing.txt' },
      { kind: 'file', path: '../outside.txt' },
    ]), 'INVALID_PATH')
  })

  it('does not project Host-owned staging or quarantine names into Explorer observations', async () => {
    await writeFile(join(workspaceRoot, 'visible.txt'), 'visible')
    await writeFile(join(workspaceRoot, '.__dsh_code_ide_staging_fixture'), 'hidden')
    await mkdir(join(workspaceRoot, '.__dsh_code_ide_quarantine_fixture'))
    const listing = await files.list(WORKSPACE_ID, '')
    expect(listing.entries.map(entry => entry.name)).toEqual(['visible.txt'])

    const first = await files.inspect(WORKSPACE_ID, [{ kind: 'directory', path: '' }])
    await rm(join(workspaceRoot, '.__dsh_code_ide_staging_fixture'))
    await rm(join(workspaceRoot, '.__dsh_code_ide_quarantine_fixture'), { recursive: true })
    const second = await files.inspect(WORKSPACE_ID, [{ kind: 'directory', path: '' }])
    expect(first.snapshots).toEqual(second.snapshots)
  })
})
