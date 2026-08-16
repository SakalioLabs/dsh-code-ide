import { describe, expect, it } from 'vitest'
import {
  matchesSearchPath,
  searchTextContent,
  textSearchPreview,
} from '../../src/shared/workspace-search.js'

describe('shared workspace text matcher', () => {
  it('preserves CRLF lines, emoji UTF-16 columns, and multiple line ranges', () => {
    const content = 'zero\r\n😀 Needle + needle\r\nlast'
    const items = searchTextContent('src/main.ts', content, {
      pattern: 'needle',
      mode: 'literal',
      caseSensitive: false,
      wholeWord: true,
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
    })

    expect(items).toEqual([{
      path: 'src/main.ts',
      lineNumber: 2,
      preview: '😀 Needle + needle',
      previewStart: 0,
      ranges: [{ start: 3, end: 9 }, { start: 12, end: 18 }],
    }])
  })

  it('applies the same include/exclude subset before matching dirty buffers', () => {
    const query = {
      pattern: 'x', mode: 'literal' as const, caseSensitive: true, wholeWord: false,
      include: ['src/**/*.ts'], exclude: ['src/generated/**'],
    }
    expect(matchesSearchPath('src/main.ts', query)).toBe(true)
    expect(matchesSearchPath('src/nested/main.ts', query)).toBe(true)
    expect(matchesSearchPath('src/generated/main.ts', query)).toBe(false)
    expect(matchesSearchPath('test/main.ts', query)).toBe(false)
    expect(searchTextContent('test/main.ts', 'x', query)).toEqual([])
  })

  it('builds a code-point-safe preview containing the first actual range', () => {
    const line = `${'前'.repeat(20)}😀needle${'后'.repeat(20)}`
    const start = line.indexOf('needle')
    const preview = textSearchPreview(line, { start, end: start + 6 }, 20)
    expect(preview).toBeDefined()
    expect(Buffer.byteLength(preview!.preview, 'utf8')).toBeLessThanOrEqual(20)
    expect(preview!.preview.slice(start - preview!.previewStart, start - preview!.previewStart + 6)).toBe('needle')
    expect(textSearchPreview('x'.repeat(30), { start: 0, end: 30 }, 8)).toBeUndefined()
  })

  it('advances zero-width regex matches at the end of a line', () => {
    expect(searchTextContent('end.txt', 'line', {
      pattern: '$', mode: 'regex', caseSensitive: true, wholeWord: false,
    })).toEqual([{
      path: 'end.txt', lineNumber: 1, preview: 'line', previewStart: 0,
      ranges: [{ start: 4, end: 4 }],
    }])
  })

  it('bounds total ranges rather than only matched lines', () => {
    const dense = searchTextContent('dense.txt', 'x'.repeat(50_000), {
      pattern: 'x', mode: 'literal', caseSensitive: true, wholeWord: false,
    }, { maxMatches: 17 })
    expect(dense).toHaveLength(1)
    expect(dense[0]?.ranges).toHaveLength(17)

    const empty = searchTextContent('dense.txt', '😀😀😀😀😀', {
      pattern: '(?:)', mode: 'regex', caseSensitive: true, wholeWord: false,
    }, { maxMatches: 3 })
    expect(empty.flatMap(item => item.ranges)).toHaveLength(3)
  })
})
