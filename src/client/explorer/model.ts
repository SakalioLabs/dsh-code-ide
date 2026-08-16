import type { FileEntry } from '../contracts.ts'

export const MAX_EXPLORER_VISIBLE_ROWS = 20_000
export const MAX_EXPLORER_TREE_DEPTH = 128

export interface ExplorerDirectoryView {
  readonly entries?: readonly FileEntry[]
}

export interface ExplorerTreeSource {
  readonly expanded: ReadonlySet<string>
  readonly directories: ReadonlyMap<string, ExplorerDirectoryView>
}

/** A real ARIA treeitem. Loading and error messages are presentation-only. */
export interface ExplorerVisibleRow {
  readonly entry: FileEntry
  readonly path: string
  readonly parentPath: string
  /** Zero-based visual depth; consumers expose this as aria-level + 1. */
  readonly depth: number
  readonly indexInParent: number
  readonly setSize: number
  readonly expanded: boolean
}

export type ExplorerTreeKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowRight'
  | 'ArrowLeft'
  | 'Home'
  | 'End'
  | 'Enter'
  | ' '
  | '*'

export interface ExplorerTreeIntent {
  readonly focusPath?: string
  readonly togglePath?: string
  readonly expandPaths?: readonly string[]
  readonly selectPath?: string
  readonly activatePath?: string
}

function isDirectChild(entry: FileEntry, parentPath: string): boolean {
  return entry.path === (parentPath === '' ? entry.name : `${parentPath}/${entry.name}`)
}

/**
 * Derive a bounded, deterministic projection from the authoritative cache.
 * Malformed/non-direct entries are ignored defensively even though fileApi
 * already rejects such protocol payloads.
 */
export function deriveVisibleExplorerRows(source: ExplorerTreeSource): readonly ExplorerVisibleRow[] {
  const rows: ExplorerVisibleRow[] = []
  const visitedDirectories = new Set<string>()

  const visit = (parentPath: string, depth: number): void => {
    if (depth >= MAX_EXPLORER_TREE_DEPTH || rows.length >= MAX_EXPLORER_VISIBLE_ROWS
      || visitedDirectories.has(parentPath)) return
    visitedDirectories.add(parentPath)

    const entries = source.directories.get(parentPath)?.entries ?? []
    const directEntries: FileEntry[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (rows.length + directEntries.length >= MAX_EXPLORER_VISIBLE_ROWS) break
      if (!isDirectChild(entry, parentPath) || seen.has(entry.path)) continue
      seen.add(entry.path)
      directEntries.push(entry)
    }

    const setSize = directEntries.length
    for (let index = 0; index < directEntries.length; index += 1) {
      if (rows.length >= MAX_EXPLORER_VISIBLE_ROWS) return
      const entry = directEntries[index]
      if (entry === undefined) continue
      const expanded = entry.type === 'directory' && source.expanded.has(entry.path)
      rows.push({
        entry,
        path: entry.path,
        parentPath,
        depth,
        indexInParent: index + 1,
        setSize,
        expanded,
      })
      if (expanded) visit(entry.path, depth + 1)
    }
  }

  visit('', 0)
  return rows
}

function currentIndex(rows: readonly ExplorerVisibleRow[], focusedPath: string | undefined): number {
  return focusedPath === undefined ? -1 : rows.findIndex(row => row.path === focusedPath)
}

/** Pure APG tree-key reducer; callers own effects and async directory loads. */
export function reduceExplorerTreeKey(
  rows: readonly ExplorerVisibleRow[],
  focusedPath: string | undefined,
  key: ExplorerTreeKey,
): ExplorerTreeIntent | undefined {
  if (rows.length === 0) return undefined
  const index = currentIndex(rows, focusedPath)
  const row = rows[index < 0 ? 0 : index]
  if (row === undefined) return undefined

  switch (key) {
    case 'ArrowDown': {
      const target = rows[Math.min(rows.length - 1, index < 0 ? 0 : index + 1)]
      return target === undefined ? undefined : { focusPath: target.path }
    }
    case 'ArrowUp': {
      const target = rows[Math.max(0, index < 0 ? 0 : index - 1)]
      return target === undefined ? undefined : { focusPath: target.path }
    }
    case 'Home': {
      const target = rows[0]
      return target === undefined ? undefined : { focusPath: target.path }
    }
    case 'End': {
      const target = rows.at(-1)
      return target === undefined ? undefined : { focusPath: target.path }
    }
    case 'ArrowRight': {
      if (row.entry.type !== 'directory') return { focusPath: row.path }
      if (!row.expanded) return { focusPath: row.path, togglePath: row.path }
      const child = rows[index + 1]
      return child !== undefined && child.parentPath === row.path
        ? { focusPath: child.path }
        : { focusPath: row.path }
    }
    case 'ArrowLeft':
      if (row.entry.type === 'directory' && row.expanded) {
        return { focusPath: row.path, togglePath: row.path }
      }
      if (row.parentPath === '') return { focusPath: row.path }
      return rows.some(candidate => candidate.path === row.parentPath)
        ? { focusPath: row.parentPath }
        : { focusPath: row.path }
    case 'Enter':
      return row.entry.type === 'directory'
        ? { focusPath: row.path, selectPath: row.path, togglePath: row.path }
        : { focusPath: row.path, selectPath: row.path, activatePath: row.path }
    case ' ':
      return { focusPath: row.path, selectPath: row.path }
    case '*': {
      const siblings = rows
        .filter(candidate => candidate.parentPath === row.parentPath
          && candidate.entry.type === 'directory' && !candidate.expanded)
        .map(candidate => candidate.path)
      return siblings.length === 0
        ? { focusPath: row.path }
        : { focusPath: row.path, expandPaths: siblings }
    }
  }
}

/** Prefix type-ahead with APG-style wrap, beginning after the current row. */
export function findTypeaheadPath(
  rows: readonly ExplorerVisibleRow[],
  query: string,
  focusedPath?: string,
): string | undefined {
  if (rows.length === 0 || query.length === 0) return undefined
  const needle = query.normalize('NFC').toLocaleLowerCase()
  const focusedIndex = currentIndex(rows, focusedPath)
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const index = (Math.max(-1, focusedIndex) + offset) % rows.length
    const row = rows[index]
    if (row?.entry.name.normalize('NFC').toLocaleLowerCase().startsWith(needle)) return row.path
  }
  return undefined
}
