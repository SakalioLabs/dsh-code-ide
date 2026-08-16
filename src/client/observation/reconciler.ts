import type { EditorTab } from '../documents/session.ts'
import type { WorkspaceInvalidation } from './source.ts'

export interface DocumentReload {
  path: string
  expectedVersion: string
  observedVersion: string
}

export interface DocumentReloadResult {
  path: string
  expectedVersion: string
  content: string
  version: string
}

export interface DocumentReconciliationPlan {
  tabs: EditorTab[]
  reloads: DocumentReload[]
}

export interface DirectoryReconciliationPlan {
  refreshPaths: string[]
  removedPaths: string[]
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** Decide document effects without performing reads or mutating dirty content. */
export function reconcileDocuments(
  tabs: readonly EditorTab[],
  invalidations: readonly WorkspaceInvalidation[],
): DocumentReconciliationPlan {
  const byPath = new Map(
    invalidations
      .filter(invalidation => invalidation.target.kind === 'file')
      .map(invalidation => [invalidation.target.path, invalidation]),
  )
  const reloads: DocumentReload[] = []
  const nextTabs = tabs.map((tab): EditorTab => {
    const invalidation = byPath.get(tab.path)
    if (invalidation === undefined) return tab
    if (invalidation.current.state === 'missing' || invalidation.current.kind !== 'file') {
      return tab.externalState === 'deleted' ? tab : { ...tab, externalState: 'deleted' }
    }
    if (invalidation.current.version === tab.version) {
      if (tab.externalState === undefined) return tab
      const { externalState: _externalState, ...cleanTab } = tab
      return cleanTab
    }
    if (tab.dirty) {
      return tab.externalState === 'modified' ? tab : { ...tab, externalState: 'modified' }
    }
    reloads.push({
      path: tab.path,
      expectedVersion: tab.version,
      observedVersion: invalidation.current.version,
    })
    return { ...tab, externalState: 'modified' }
  })
  return { tabs: nextTabs, reloads }
}

/** Apply one authoritative read only if its originating clean version is still current. */
export function applyDocumentReload(
  tabs: readonly EditorTab[],
  result: DocumentReloadResult,
): EditorTab[] {
  return tabs.map((tab): EditorTab => {
    if (tab.path !== result.path) return tab
    if (tab.dirty) {
      return tab.externalState === 'modified' ? tab : { ...tab, externalState: 'modified' }
    }
    if (tab.version !== result.expectedVersion) return tab
    const { externalState: _externalState, loadError: _loadError, ...current } = tab
    return {
      ...current,
      content: result.content,
      baselineContent: result.content,
      version: result.version,
      dirty: false,
      historyEpoch: tab.historyEpoch + 1,
    }
  })
}

/** Decide which directly visible directory caches need authoritative list() calls. */
export function reconcileDirectories(
  invalidations: readonly WorkspaceInvalidation[],
): DirectoryReconciliationPlan {
  const refresh = new Set<string>()
  const removed = new Set<string>()
  for (const invalidation of invalidations) {
    if (invalidation.target.kind !== 'directory') continue
    if (invalidation.current.state === 'present') {
      refresh.add(invalidation.target.path)
      continue
    }
    if (invalidation.target.path === '') refresh.add('')
    else {
      removed.add(invalidation.target.path)
      refresh.add(parentPath(invalidation.target.path))
    }
  }
  return {
    refreshPaths: [...refresh].sort(),
    removedPaths: [...removed].sort(),
  }
}
