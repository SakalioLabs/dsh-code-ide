import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostLogger,
  HostSubprocessHandle,
  HostSubprocessRuntime,
  HostSubprocessSpawnSpec,
} from '../../src/host/contracts.js'
import { IdeHostError } from '../../src/host/errors.js'
import {
  DEFAULT_SEARCH_LIMITS,
  WorkspaceSearchService,
  parseNulPathRecords,
  utf8ByteOffsetToUtf16,
  type WorkspaceSearchOptions,
} from '../../src/host/search.js'

const WORKSPACE_ID = 'search-fixture'

interface Script {
  stdout: string
  exitCode?: number | null
  lossy?: boolean
  waitForExit?: () => Promise<boolean>
  onSpawn?: (spec: HostSubprocessSpawnSpec) => void
}

class ScriptedSubprocess implements HostSubprocessRuntime {
  readonly specs: HostSubprocessSpawnSpec[] = []
  readonly commands: string[] = []

  constructor(private readonly scripts: Script[]) {}

  async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    this.commands.push(command)
    return command
  }

  spawn(spec: HostSubprocessSpawnSpec): HostSubprocessHandle {
    const script = this.scripts.shift()
    if (script === undefined) throw new Error('No scripted search process.')
    this.specs.push(spec)
    script.onSpawn?.(spec)
    const read = {
      text: script.stdout,
      nextOffset: Buffer.byteLength(script.stdout),
      lossy: script.lossy ?? false,
    }
    return {
      collected: {
        stdout: { readFrom: () => read },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: script.exitCode ?? 0, signal: null }),
      terminate() {},
      waitForExit: script.waitForExit ?? (async () => true),
    }
  }
}

class LocalTestSubprocess implements HostSubprocessRuntime {
  async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return command
  }

  spawn(spec: HostSubprocessSpawnSpec): HostSubprocessHandle {
    const child = spawn(spec.argv[0]!, [...spec.argv.slice(1)], {
      cwd: spec.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => { stdout.push(Buffer.from(chunk as Uint8Array)) })
    child.stderr.on('data', chunk => { stderr.push(Buffer.from(chunk as Uint8Array)) })
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
    })
    const terminate = (): void => { child.kill() }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    const reader = (chunks: Buffer[]) => ({
      readFrom: () => {
        const text = Buffer.concat(chunks).toString('utf8')
        return { text, nextOffset: Buffer.byteLength(text), lossy: false }
      },
    })
    return {
      collected: { stdout: reader(stdout), stderr: reader(stderr) },
      done,
      terminate,
      waitForExit: async () => { await done.catch(() => {}); return true },
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function logger(): HostLogger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}

function options(overrides: Partial<WorkspaceSearchOptions> = {}): WorkspaceSearchOptions {
  return {
    maxFileBytes: 4 * 1024 * 1024,
    ...DEFAULT_SEARCH_LIMITS,
    logger: logger(),
    ...overrides,
  }
}

function matchEvent(path: string, line: string, lineNumber: number, ranges: Array<[number, number]>): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      submatches: ranges.map(([start, end]) => ({
        match: { text: line.slice(start, end) },
        start: Buffer.byteLength(line.slice(0, start)),
        end: Buffer.byteLength(line.slice(0, end)),
      })),
    },
  }) + '\n'
}

function byteMatchEvent(
  path: string,
  line: string,
  lineNumber: number,
  ranges: Array<[number, number]>,
  lineEnding = '\n',
): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${line}${lineEnding}` },
      line_number: lineNumber,
      submatches: ranges.map(([start, end]) => ({ match: { text: '' }, start, end })),
    },
  }) + '\n'
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

describe('WorkspaceSearchService', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-code-ide-search-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  function service(runtime: HostSubprocessRuntime, overrides: Partial<WorkspaceSearchOptions> = {}): WorkspaceSearchService {
    return new WorkspaceSearchService({
      list: () => [{ id: WORKSPACE_ID, path: root, title: 'Fixture' }],
    }, runtime, options(overrides))
  }

  it('uses canonical cwd and pure bounded argv while preserving UTF-16 ranges', async () => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.ts'), 'placeholder')
    const line = '前😀needle and needle后'
    const first = line.indexOf('needle')
    const second = line.lastIndexOf('needle')
    const runtime = new ScriptedSubprocess([{
      stdout: matchEvent('./src/main.ts', line, 7, [
        [first, first + 'needle'.length],
        [second, second + 'needle'.length],
      ]),
    }])
    const search = service(runtime, { maxPreviewBytes: 18 })

    const result = await search.searchText(WORKSPACE_ID, {
      pattern: 'needle',
      mode: 'literal',
      caseSensitive: false,
      wholeWord: true,
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
    })

    expect(result).toMatchObject({ matchCount: 2, fileCount: 1, incomplete: false, limit: 500 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      path: 'src/main.ts',
      lineNumber: 7,
      ranges: [
        { start: first, end: first + 6 },
        { start: second, end: second + 6 },
      ],
    })
    const item = result.items[0]!
    expect(item.preview.slice(first - item.previewStart, first - item.previewStart + 6)).toBe('needle')
    const spec = runtime.specs[0]!
    expect(spec.cwd).toBe(root)
    expect(spec.argv[0]).toMatch(/rg(?:\.exe)?$/)
    expect(spec.argv.slice(1)).toEqual([
      '--no-config',
      '--json',
      '--crlf',
      '--max-filesize=4194304',
      '--fixed-strings',
      '--ignore-case',
      '--word-regexp',
      '--glob=src/**/*.ts',
      '--glob=!src/generated/**',
      '--regexp=needle',
      '--',
      '.',
    ])
    expect(spec.argv).not.toContain('--follow')
    expect(spec.argv).not.toContain('--hidden')
    expect(spec.argv).not.toContain('--no-ignore')
    expect(spec.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: 8 * 1024 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    })
  })

  it('maps a dense Unicode line once and converts only the remaining global range budget', async () => {
    await writeFile(join(root, 'dense.txt'), 'placeholder')
    const count = 20_000
    const line = '\u{1f600}x'.repeat(count)
    const byteRanges = Array.from({ length: count }, (_value, index): [number, number] => [
      index * 5 + 4,
      index * 5 + 5,
    ])
    const runtime = new ScriptedSubprocess([{
      stdout: byteMatchEvent('./dense.txt', line, 1, byteRanges),
    }])

    const result = await service(runtime, {
      maxTextResults: 7,
      maxLineBytes: 4 * 1024 * 1024,
    }).searchText(WORKSPACE_ID, {
      pattern: 'x', mode: 'literal', caseSensitive: true, wholeWord: false,
    })

    expect(result).toMatchObject({ matchCount: 7, fileCount: 1, incomplete: true, limit: 7 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.ranges).toEqual(Array.from({ length: 7 }, (_value, index) => ({
      start: index * 3 + 2,
      end: index * 3 + 3,
    })))
  })

  it('maps a simulated zero-width CRLF anchor after an astral code point', async () => {
    await writeFile(join(root, 'anchor.txt'), 'placeholder')
    const runtime = new ScriptedSubprocess([{
      stdout: byteMatchEvent('./anchor.txt', '\u{1f600}', 1, [[4, 4]], '\r\n'),
    }])

    const result = await service(runtime).searchText(WORKSPACE_ID, {
      pattern: '$', mode: 'regex', caseSensitive: true, wholeWord: false,
    })

    expect(result.items[0]).toMatchObject({
      preview: '\u{1f600}',
      previewStart: 0,
      ranges: [{ start: 2, end: 2 }],
    })
    expect(runtime.specs[0]?.argv).toContain('--crlf')
  })

  it('validates numeric ordering for ranges omitted by the global result limit', async () => {
    await writeFile(join(root, 'invalid.txt'), 'placeholder')
    const runtime = new ScriptedSubprocess([{
      stdout: byteMatchEvent('./invalid.txt', 'xx', 1, [[0, 1], [0, 1]]),
    }])

    await expectCode(service(runtime, { maxTextResults: 1 }).searchText(WORKSPACE_ID, {
      pattern: 'x', mode: 'literal', caseSensitive: true, wholeWord: false,
    }), 'SEARCH_FAILED')
  })

  it('uses NUL framing so newline-containing file names remain one result', async () => {
    expect(parseNulPathRecords('./line\nname.ts\0')).toEqual(['./line\nname.ts'])
    expect(parseNulPathRecords('\0'.repeat(100_000), 3)).toEqual(['', '', ''])
    const path = 'line-name.ts'
    await writeFile(join(root, path), 'content')
    const runtime = new ScriptedSubprocess([{ stdout: `./${path}\0` }])

    const result = await service(runtime).findFiles(WORKSPACE_ID, 'linename')

    expect(result).toEqual({ items: [{ path }], incomplete: false, limit: 200 })
    expect(runtime.specs[0]!.argv.slice(1)).toEqual([
      '--no-config', '--files', '--null', '--', '.',
    ])
  })

  it('stops decoding NUL path records after the candidate sentinel', async () => {
    const names = ['one.ts', 'two.ts', 'three.ts', 'four.ts']
    await Promise.all(names.map(async name => { await writeFile(join(root, name), 'content') }))
    const stdout = `${names.map(name => `./${name}\0`).join('')}${'ignored\0'.repeat(100_000)}`
    const result = await service(new ScriptedSubprocess([{ stdout }]), { maxCandidates: 3 })
      .findFiles(WORKSPACE_ID, '.ts')

    expect(result).toMatchObject({ incomplete: true })
    expect(result.items).toHaveLength(3)
  })

  it('rejects absolute and symlink output paths with a stable non-leaking error', async () => {
    await writeFile(join(root, 'target.ts'), 'needle')
    const absoluteRuntime = new ScriptedSubprocess([{
      stdout: matchEvent(join(root, 'target.ts'), 'needle', 1, [[0, 6]]),
    }])
    const absoluteError = await expectCode(service(absoluteRuntime).searchText(WORKSPACE_ID, {
      pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false,
    }), 'SEARCH_FAILED')
    expect(absoluteError.message).not.toContain(root)

    try {
      await symlink(join(root, 'target.ts'), join(root, 'link.ts'), 'file')
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
      if (code === 'EPERM' || code === 'EACCES') return
      throw error
    }
    const symlinkRuntime = new ScriptedSubprocess([{
      stdout: matchEvent('./link.ts', 'needle', 1, [[0, 6]]),
    }])
    const symlinkError = await expectCode(service(symlinkRuntime).searchText(WORKSPACE_ID, {
      pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false,
    }), 'SEARCH_FAILED')
    expect(symlinkError.message).not.toContain(root)
  })

  it('maps malformed regex and lossy raw output to stable bounded errors', async () => {
    await expectCode(service(new ScriptedSubprocess([{ stdout: '', exitCode: 2 }])).searchText(WORKSPACE_ID, {
      pattern: '[', mode: 'regex', caseSensitive: true, wholeWord: false,
    }), 'SEARCH_INVALID_PATTERN')

    const waitForExit = vi.fn(async () => true)
    const overflow = service(new ScriptedSubprocess([{
      stdout: 'discarded tail', lossy: true, waitForExit,
    }]))
    await expectCode(overflow.findFiles(WORKSPACE_ID, 'file'), 'SEARCH_OUTPUT_OVERFLOW')
    expect(waitForExit).toHaveBeenCalledOnce()

    const oversized = service(new ScriptedSubprocess([{
      stdout: 'x'.repeat(9), lossy: false,
    }]), { maxRawBytes: 8 })
    await expectCode(oversized.findFiles(WORKSPACE_ID, 'x'), 'SEARCH_OUTPUT_OVERFLOW')
  })

  it('iterates delimiter-heavy text output without materializing a record array', async () => {
    const result = await service(new ScriptedSubprocess([{
      stdout: '\n'.repeat(1_000_000),
    }])).searchText(WORKSPACE_ID, {
      pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false,
    })

    expect(result).toEqual({
      items: [], matchCount: 0, fileCount: 0, incomplete: false, limit: 500,
    })
  })

  it('stops parsing text records after the candidate sentinel', async () => {
    await writeFile(join(root, 'candidate.ts'), 'needle')
    const record = matchEvent('./candidate.ts', 'needle', 1, [[0, 6]])
    const result = await service(new ScriptedSubprocess([{
      stdout: record.repeat(50_000),
    }]), { maxCandidates: 3 }).searchText(WORKSPACE_ID, {
      pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false,
    })

    expect(result).toMatchObject({ matchCount: 3, fileCount: 1, incomplete: true })
  })

  it('keeps a missing platform ripgrep package behind SEARCH_UNAVAILABLE', async () => {
    const runtime = new ScriptedSubprocess([])
    const search = new WorkspaceSearchService({
      list: () => [{ id: WORKSPACE_ID, path: root, title: 'Fixture' }],
    }, runtime, options(), {
      resolveRipgrepPath: async () => { throw new Error('optional platform package missing') },
    })

    const error = await expectCode(search.findFiles(WORKSPACE_ID, 'file'), 'SEARCH_UNAVAILABLE')

    expect(error.status).toBe(503)
    expect(runtime.specs).toHaveLength(0)
    expect(error.message).not.toContain('platform package')
  })

  it('does not report success when process-tree settlement rejects', async () => {
    await writeFile(join(root, 'file.ts'), 'content')
    const search = service(new ScriptedSubprocess([{
      stdout: './file.ts\0',
      waitForExit: async () => { throw new Error('inspector unavailable') },
    }]), { maxConcurrent: 1 })

    const error = await expectCode(search.findFiles(WORKSPACE_ID, 'file'), 'SEARCH_FAILED')

    expect(error.message).toBe('Workspace search process cleanup could not be confirmed.')
    expect(error.message).not.toContain(root)
    await expectCode(search.findFiles(WORKSPACE_ID, 'again'), 'SEARCH_CAPACITY')
    await expect(search.dispose()).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
  })

  it('treats a false tree-settlement result as an unconfirmed cleanup', async () => {
    await writeFile(join(root, 'file.ts'), 'content')
    const search = service(new ScriptedSubprocess([{
      stdout: './file.ts\0', waitForExit: async () => false,
    }]), { maxConcurrent: 1 })

    await expectCode(search.findFiles(WORKSPACE_ID, 'file'), 'SEARCH_FAILED')
    await expectCode(search.findFiles(WORKSPACE_ID, 'again'), 'SEARCH_CAPACITY')
  })

  it('holds its capacity slot until an aborted process tree has settled', async () => {
    const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const tree = deferred<boolean>()
    const waiting = deferred<void>()
    const runtime = new ScriptedSubprocess([
      {
        stdout: '',
        onSpawn(spec) {
          spec.signal?.addEventListener('abort', () => {
            done.resolve({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })
        },
        waitForExit: async () => { waiting.resolve(); return await tree.promise },
      },
      { stdout: '' },
    ])
    // Replace the immediate outcome of only the first scripted handle.
    const originalSpawn = runtime.spawn.bind(runtime)
    let first = true
    runtime.spawn = (spec) => {
      const handle = originalSpawn(spec)
      if (!first) return handle
      first = false
      return { ...handle, done: done.promise }
    }
    const search = service(runtime, { maxConcurrent: 1 })
    const caller = new AbortController()
    const pending = search.findFiles(WORKSPACE_ID, 'file', caller.signal)
    await vi.waitFor(() => { expect(runtime.specs).toHaveLength(1) })
    caller.abort()
    await waiting.promise

    await expectCode(search.findFiles(WORKSPACE_ID, 'second'), 'SEARCH_CAPACITY')
    tree.resolve(true)
    await expectCode(pending, 'SEARCH_ABORTED')
    await expect(search.findFiles(WORKSPACE_ID, 'third')).resolves.toEqual({
      items: [], incomplete: false, limit: 200,
    })
  })

  it('does not project an abort followed by exit 1 as an empty success', async () => {
    const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const waitForExit = vi.fn(async () => true)
    const runtime = new ScriptedSubprocess([{ stdout: '', waitForExit }])
    const originalSpawn = runtime.spawn.bind(runtime)
    runtime.spawn = spec => ({ ...originalSpawn(spec), done: done.promise })
    const search = service(runtime)
    const caller = new AbortController()

    const pending = search.findFiles(WORKSPACE_ID, 'file', caller.signal)
    await vi.waitFor(() => { expect(runtime.specs).toHaveLength(1) })
    caller.abort()
    done.resolve({ exitCode: 1, signal: null })

    await expectCode(pending, 'SEARCH_ABORTED')
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it('does not project a deadline followed by exit 1 as an empty success', async () => {
    const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const waitForExit = vi.fn(async () => true)
    const runtime = new ScriptedSubprocess([{
      stdout: '',
      waitForExit,
    }])
    const originalSpawn = runtime.spawn.bind(runtime)
    runtime.spawn = (spec) => {
      const handle = originalSpawn(spec)
      spec.signal?.addEventListener('abort', () => {
        done.resolve({ exitCode: 1, signal: null })
      }, { once: true })
      return { ...handle, done: done.promise }
    }

    await expectCode(service(runtime, { timeoutMs: 5 }).findFiles(WORKSPACE_ID, 'file'), 'SEARCH_TIMEOUT')
    expect(waitForExit).toHaveBeenCalledOnce()
  })

  it('aborts and joins every active process tree during dispose', async () => {
    const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const tree = deferred<boolean>()
    const waiting = deferred<void>()
    const runtime = new ScriptedSubprocess([{
      stdout: '',
      onSpawn(spec) {
        spec.signal?.addEventListener('abort', () => {
          done.resolve({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
      },
      waitForExit: async () => { waiting.resolve(); return await tree.promise },
    }])
    const originalSpawn = runtime.spawn.bind(runtime)
    runtime.spawn = (spec) => ({ ...originalSpawn(spec), done: done.promise })
    const search = service(runtime)
    const pending = search.findFiles(WORKSPACE_ID, 'file')
    await vi.waitFor(() => { expect(runtime.specs).toHaveLength(1) })
    let disposed = false
    const disposal = search.dispose().then(() => { disposed = true })
    await waiting.promise
    expect(disposed).toBe(false)
    tree.resolve(true)

    await disposal
    await expectCode(pending, 'SEARCH_UNAVAILABLE')
    await expectCode(search.findFiles(WORKSPACE_ID, 'later'), 'SEARCH_UNAVAILABLE')
  })

  it('rejects provider disposal when an active process tree cannot be joined', async () => {
    const done = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const waiting = deferred<void>()
    const rejectTree = deferred<boolean>()
    const runtime = new ScriptedSubprocess([{
      stdout: '',
      onSpawn(spec) {
        spec.signal?.addEventListener('abort', () => {
          done.resolve({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
      },
      waitForExit: async () => {
        waiting.resolve()
        return await rejectTree.promise
      },
    }])
    const originalSpawn = runtime.spawn.bind(runtime)
    runtime.spawn = spec => ({ ...originalSpawn(spec), done: done.promise })
    const search = service(runtime)
    const pending = search.findFiles(WORKSPACE_ID, 'file')
    await vi.waitFor(() => { expect(runtime.specs).toHaveLength(1) })
    const disposal = search.dispose()
    await waiting.promise
    rejectTree.reject(new Error('tree inspection failed'))

    await expectCode(pending, 'SEARCH_FAILED')
    await expect(disposal).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
  })

  it('honors ripgrep default ignore and hidden-file behavior end to end', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.gitignore'), 'git-ignored.ts\n')
    await writeFile(join(root, '.ignore'), 'ignore-ignored.ts\n')
    await writeFile(join(root, '.rgignore'), 'rg-ignored.ts\n')
    await writeFile(join(root, 'visible.ts'), 'const value = "needle"\n')
    await writeFile(join(root, 'git-ignored.ts'), 'needle\n')
    await writeFile(join(root, 'ignore-ignored.ts'), 'needle\n')
    await writeFile(join(root, 'rg-ignored.ts'), 'needle\n')
    await writeFile(join(root, '.hidden.ts'), 'needle\n')
    const search = service(new LocalTestSubprocess())

    const files = await search.findFiles(WORKSPACE_ID, '.ts')
    const text = await search.searchText(WORKSPACE_ID, {
      pattern: 'needle', mode: 'literal', caseSensitive: true, wholeWord: false,
    })

    expect(files.items).toEqual([{ path: 'visible.ts' }])
    expect(text.items.map(item => item.path)).toEqual(['visible.ts'])
    expect(text).toMatchObject({ matchCount: 1, fileCount: 1, incomplete: false })
  })

  it('aligns real ripgrep CRLF anchors with logical UTF-16 line columns', async () => {
    await writeFile(join(root, 'crlf.txt'), '\u{1f600}\r\nx\r\n')
    const search = service(new LocalTestSubprocess())

    const result = await search.searchText(WORKSPACE_ID, {
      pattern: '$', mode: 'regex', caseSensitive: true, wholeWord: false,
    })

    expect(result.items).toEqual([
      expect.objectContaining({ lineNumber: 1, ranges: [{ start: 2, end: 2 }] }),
      expect.objectContaining({ lineNumber: 2, ranges: [{ start: 1, end: 1 }] }),
    ])
    expect(result).toMatchObject({ matchCount: 2, incomplete: false })
  })

  it('keeps a lone carriage return as searchable line content', async () => {
    await writeFile(join(root, 'lone-cr.txt'), 'one\rtarget here\r')
    const result = await service(new LocalTestSubprocess()).searchText(WORKSPACE_ID, {
      pattern: 'target', mode: 'literal', caseSensitive: true, wholeWord: false,
    })
    expect(result.items).toEqual([
      expect.objectContaining({
        lineNumber: 1, preview: 'one\rtarget here\r', previewStart: 0, ranges: [{ start: 4, end: 10 }],
      }),
    ])
  })

  it('accepts ripgrep regex syntax that is not JavaScript RegExp syntax', async () => {
    await writeFile(join(root, 'named.txt'), 'needle\n')
    const result = await service(new LocalTestSubprocess()).searchText(WORKSPACE_ID, {
      pattern: '(?P<word>needle)', mode: 'regex', caseSensitive: true, wholeWord: false,
    })
    expect(result).toMatchObject({ matchCount: 1, fileCount: 1, incomplete: false })
  })
})

describe('workspace-search byte/range helpers', () => {
  it('maps exact UTF-8 byte boundaries to UTF-16 columns', () => {
    expect(utf8ByteOffsetToUtf16('前😀x', 0)).toBe(0)
    expect(utf8ByteOffsetToUtf16('前😀x', 3)).toBe(1)
    expect(utf8ByteOffsetToUtf16('前😀x', 7)).toBe(3)
    expect(utf8ByteOffsetToUtf16('前😀x', 8)).toBe(4)
    expect(() => utf8ByteOffsetToUtf16('前😀x', 4)).toThrowError(IdeHostError)
  })
})
