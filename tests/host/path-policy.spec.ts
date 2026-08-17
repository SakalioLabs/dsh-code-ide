import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPathInside, parseWorkspacePath, resolveWorkspaceRoot } from '../../src/host/path-policy.js'

describe('workspace path policy', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('accepts canonical relative paths', () => {
    expect(parseWorkspacePath('', { allowRoot: true })).toBe('')
    expect(parseWorkspacePath('src/main.ts', { allowRoot: false })).toBe('src/main.ts')
  })

  it('rejects absolute, traversal, and Windows-shaped paths', () => {
    for (const value of ['/etc/passwd', '../secret', 'src/../secret', 'C:\\secret', 'src\\main.ts']) {
      expect(() => parseWorkspacePath(value, { allowRoot: true })).toThrow()
    }
  })

  it('enforces portable segment, depth, and Host-reserved name budgets', () => {
    expect(parseWorkspacePath(Array.from({ length: 128 }, () => 'a').join('/'), { allowRoot: false })).toBeTypeOf('string')
    expect(() => parseWorkspacePath(Array.from({ length: 129 }, () => 'a').join('/'), { allowRoot: false })).toThrow()
    expect(parseWorkspacePath('a'.repeat(255), { allowRoot: false })).toHaveLength(255)
    for (const value of [
      'a'.repeat(256), `bad${String.fromCharCode(1)}`,
      '.__dsh_code_ide_quarantine_owned',
      '.__DSH_CODE_IDE_QUARANTINE_OWNED',
    ]) {
      expect(() => parseWorkspacePath(value, { allowRoot: false })).toThrow()
    }
    const windowsNames = ['CON', 'nul.txt', 'COM1.log', 'name:stream', 'bad?', 'tail.', 'tail ']
    for (const value of windowsNames) {
      expect(() => parseWorkspacePath(value, { allowRoot: false })).toThrow()
    }
  })

  it('accepts exactly 16 KiB of wire path and rejects one byte more', () => {
    const segments = Array.from({ length: 128 }, () => 'a'.repeat(127))
    segments[0] = 'a'.repeat(128)
    const exact = segments.join('/')
    expect(Buffer.byteLength(exact)).toBe(16 * 1024)
    expect(parseWorkspacePath(exact, { allowRoot: false })).toBe(exact)
    segments[0] = 'a'.repeat(129)
    expect(() => parseWorkspacePath(segments.join('/'), { allowRoot: false })).toThrow()
  })

  it('checks lexical containment', () => {
    const root = process.platform === 'win32' ? 'C:\\work' : '/work'
    const child = process.platform === 'win32' ? 'C:\\work\\src\\a.ts' : '/work/src/a.ts'
    const sibling = process.platform === 'win32' ? 'C:\\work-other\\a.ts' : '/work-other/a.ts'
    expect(isPathInside(root, child)).toBe(true)
    expect(isPathInside(root, sibling)).toBe(false)
  })

  it('accepts an extended-length spelling of a Windows workspace root', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-code-ide-root-'))
    roots.push(root)
    const canonical = await realpath(root)

    if (process.platform !== 'win32') {
      await expect(resolveWorkspaceRoot(root)).resolves.toMatchObject({ realPath: canonical })
      return
    }

    const resolved = await resolveWorkspaceRoot(toNamespacedPath(root))
    expect(resolved.realPath).toBe(canonical)
    expect(resolved.identity.ino).toBeGreaterThan(0n)
  })

  it.runIf(process.platform === 'win32')('rejects a workspace reached through an ancestor junction', async () => {
    const container = await mkdtemp(join(await realpath(tmpdir()), 'dsh-code-ide-root-junction-'))
    roots.push(container)
    const target = join(container, 'target')
    const workspace = join(target, 'workspace')
    const junction = join(container, 'junction')
    await mkdir(workspace, { recursive: true })
    await symlink(target, junction, 'junction')

    await expect(resolveWorkspaceRoot(join(junction, 'workspace'))).rejects.toMatchObject({
      code: 'WORKSPACE_UNAVAILABLE',
    })
  })
})
