import { describe, expect, it } from 'vitest'
import {
  decodeWorkspacePath,
  decodeWorkspacePathSegment,
  MAX_WORKSPACE_PATH_BYTES,
  MAX_WORKSPACE_PATH_SEGMENTS,
  parseWorkspacePath,
} from '../../src/client/workspace-path.ts'

describe('browser workspace path decoding', () => {
  it('accepts canonical slash-relative Unicode paths and root only when allowed', () => {
    expect(decodeWorkspacePath('src/\u5b9e\u73b0/line\nbreak.ts', { allowRoot: false }))
      .toBe('src/\u5b9e\u73b0/line\nbreak.ts')
    expect(decodeWorkspacePath('', { allowRoot: true })).toBe('')
    expect(decodeWorkspacePath('', { allowRoot: false })).toBeUndefined()
    expect(decodeWorkspacePathSegment('line\nbreak.ts')).toBe('line\nbreak.ts')
    expect(decodeWorkspacePathSegment('nested/file.ts')).toBeUndefined()
  })

  it('rejects absolute, drive-shaped, NUL, backslash and non-canonical segments', () => {
    for (const value of [
      '/etc/passwd', 'C:/secret', 'c:relative', 'src\\main.ts', 'src\0main.ts',
      'src//main.ts', './main.ts', 'src/./main.ts', '../main.ts', 'src/../main.ts', 'src/',
    ]) {
      expect(decodeWorkspacePath(value, { allowRoot: true }), value).toBeUndefined()
    }
  })

  it('applies the 16 KiB ceiling to UTF-8 bytes rather than UTF-16 length', () => {
    expect(decodeWorkspacePath('a'.repeat(MAX_WORKSPACE_PATH_BYTES), { allowRoot: false })).toBeDefined()
    expect(decodeWorkspacePath('a'.repeat(MAX_WORKSPACE_PATH_BYTES + 1), { allowRoot: false })).toBeUndefined()
    expect(decodeWorkspacePath('\u754c'.repeat(5_461), { allowRoot: false })).toBeDefined()
    expect(decodeWorkspacePath('\u754c'.repeat(5_462), { allowRoot: false })).toBeUndefined()
  })

  it('caps path traversal depth independently from the byte ceiling', () => {
    const atLimit = Array.from({ length: MAX_WORKSPACE_PATH_SEGMENTS }, () => 'a').join('/')
    expect(decodeWorkspacePath(atLimit, { allowRoot: false })).toBe(atLimit)
    expect(decodeWorkspacePath(`${atLimit}/a`, { allowRoot: false })).toBeUndefined()
  })

  it('offers an explicit throwing parse form without changing decoder semantics', () => {
    expect(parseWorkspacePath('src/main.ts', { allowRoot: false })).toBe('src/main.ts')
    expect(() => parseWorkspacePath('../outside', { allowRoot: false })).toThrow(TypeError)
  })
})
