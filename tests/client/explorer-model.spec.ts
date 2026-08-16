import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../src/client/contracts.ts'
import {
  deriveVisibleExplorerRows,
  findTypeaheadPath,
  MAX_EXPLORER_TREE_DEPTH,
  reduceExplorerTreeKey,
} from '../../src/client/explorer/model.ts'

const directory = (name: string, path = name): FileEntry => ({ name, path, type: 'directory' })
const file = (name: string, path = name): FileEntry => ({ name, path, type: 'file' })

describe('Explorer tree model', () => {
  it('derives only direct, expanded descendants with APG position metadata', () => {
    const rows = deriveVisibleExplorerRows({
      expanded: new Set(['', 'src']),
      directories: new Map([
        ['', { entries: [directory('src'), file('README.md'), file('bad', 'elsewhere/bad')] }],
        ['src', { entries: [file('a.ts', 'src/a.ts'), directory('deep', 'src/deep')] }],
        ['src/deep', { entries: [file('hidden.ts', 'src/deep/hidden.ts')] }],
      ]),
    })

    expect(rows.map(row => [row.path, row.depth, row.indexInParent, row.setSize, row.expanded])).toEqual([
      ['src', 0, 1, 2, true],
      ['src/a.ts', 1, 1, 2, false],
      ['src/deep', 1, 2, 2, false],
      ['README.md', 0, 2, 2, false],
    ])
  })

  it('bounds recursive projection depth even when every directory is expanded', () => {
    const expanded = new Set([''])
    const directories = new Map<string, { entries: FileEntry[] }>()
    let parent = ''
    for (let index = 0; index < MAX_EXPLORER_TREE_DEPTH + 10; index += 1) {
      const name = `d${index}`
      const path = parent === '' ? name : `${parent}/${name}`
      expanded.add(path)
      directories.set(parent, { entries: [directory(name, path)] })
      parent = path
    }
    expect(deriveVisibleExplorerRows({ expanded, directories })).toHaveLength(MAX_EXPLORER_TREE_DEPTH)
  })

  it('reduces APG movement, parent/child disclosure, activation, selection, and sibling expansion', () => {
    const rows = deriveVisibleExplorerRows({
      expanded: new Set(['', 'src']),
      directories: new Map([
        ['', { entries: [directory('src'), directory('test'), file('z.txt')] }],
        ['src', { entries: [file('a.ts', 'src/a.ts')] }],
      ]),
    })

    expect(reduceExplorerTreeKey(rows, 'src', 'ArrowRight')).toEqual({ focusPath: 'src/a.ts' })
    expect(reduceExplorerTreeKey(rows, 'src/a.ts', 'ArrowLeft')).toEqual({ focusPath: 'src' })
    expect(reduceExplorerTreeKey(rows, 'src', 'ArrowLeft')).toEqual({ focusPath: 'src', togglePath: 'src' })
    expect(reduceExplorerTreeKey(rows, 'test', 'ArrowRight')).toEqual({ focusPath: 'test', togglePath: 'test' })
    expect(reduceExplorerTreeKey(rows, 'test', 'Enter')).toEqual({
      focusPath: 'test', selectPath: 'test', togglePath: 'test',
    })
    expect(reduceExplorerTreeKey(rows, 'src/a.ts', 'Enter')).toEqual({
      focusPath: 'src/a.ts', selectPath: 'src/a.ts', activatePath: 'src/a.ts',
    })
    expect(reduceExplorerTreeKey(rows, 'z.txt', ' ')).toEqual({ focusPath: 'z.txt', selectPath: 'z.txt' })
    expect(reduceExplorerTreeKey(rows, 'src', '*')).toEqual({ focusPath: 'src', expandPaths: ['test'] })
    expect(reduceExplorerTreeKey(rows, undefined, 'End')).toEqual({ focusPath: 'z.txt' })
  })

  it('wraps prefix type-ahead after the logical focus', () => {
    const rows = deriveVisibleExplorerRows({
      expanded: new Set(['']),
      directories: new Map([['', { entries: [file('Alpha.ts'), file('Beta.ts'), file('Alpine.ts')] }]]),
    })
    expect(findTypeaheadPath(rows, 'al', 'Alpha.ts')).toBe('Alpine.ts')
    expect(findTypeaheadPath(rows, 'AL', 'Alpine.ts')).toBe('Alpha.ts')
    expect(findTypeaheadPath(rows, 'missing', 'Beta.ts')).toBeUndefined()
  })
})
