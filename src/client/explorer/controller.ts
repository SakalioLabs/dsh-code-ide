import type { FileEntry, ListFilesResponse } from '../contracts.ts'
import { decodeWorkspacePath } from '../workspace-path.ts'
import {
  deriveVisibleExplorerRows,
  findTypeaheadPath,
  MAX_EXPLORER_TREE_DEPTH,
  reduceExplorerTreeKey,
  type ExplorerTreeIntent,
  type ExplorerTreeKey,
} from './model.ts'
import { ExplorerStore } from './store.ts'

export interface ExplorerListPort {
  list(workspaceId: string, path: string, signal?: AbortSignal): Promise<ListFilesResponse>
}

export interface ExplorerRevealOptions {
  /** Editor-driven reveal normally scrolls without stealing keyboard focus. */
  readonly focus?: boolean
  readonly select?: boolean
}

export const MAX_EXPLORER_CONCURRENT_LOADS = 8

interface ActiveLoad {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly path: string
  readonly generation: number
  readonly controller: AbortController
  readonly revealGeneration?: number
  readonly promise: Promise<boolean>
}

function canonical(path: string, allowRoot: boolean): string | undefined {
  const value = decodeWorkspacePath(path, { allowRoot })
  if (value === undefined || (value !== '' && value.split('/').length > MAX_EXPLORER_TREE_DEPTH)) return undefined
  return value
}

function intersects(candidate: string, changed: string): boolean {
  return candidate === changed
    || candidate === '' || changed === ''
    || candidate.startsWith(`${changed}/`)
    || changed.startsWith(`${candidate}/`)
}

function directChild(parent: string, child: string): boolean {
  const separator = child.lastIndexOf('/')
  return (separator < 0 ? '' : child.slice(0, separator)) === parent
}

/**
 * The only owner of Explorer ListPort effects. Store mutations are admitted
 * only while workspace epoch, path generation and AbortSignal all agree.
 */
export class ExplorerController {
  private readonly generations = new Map<string, number>()
  private readonly activeLoads = new Map<string, ActiveLoad>()
  private revealGeneration = 0
  private revealController: AbortController | undefined
  private typeaheadBuffer = ''
  private typeaheadAt = -Infinity
  private disposed = false

  constructor(
    readonly store: ExplorerStore,
    private readonly files: ExplorerListPort,
  ) {}

  async selectWorkspace(workspaceId: string | undefined): Promise<void> {
    if (this.disposed) return
    if (this.store.getSnapshot().activeWorkspaceId === workspaceId) return
    this.abortAllLoads()
    this.cancelReveal()
    this.resetTypeahead()
    this.store.selectWorkspace(workspaceId)
    if (workspaceId !== undefined) await this.load('', true)
  }

  async load(path: string, force = false): Promise<void> {
    await this.loadDirectory(path, force)
  }

  async toggle(path: string): Promise<void> {
    if (this.disposed || canonical(path, false) === undefined) return
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined || this.entry(path)?.type !== 'directory') return
    const session = this.store.session(workspaceId)
    if (session.expanded.has(path)) {
      this.abortRelated([path], false)
      this.store.setExpanded(workspaceId, path, false)
      return
    }
    if (this.store.setExpanded(workspaceId, path, true)) await this.load(path, true)
  }

  setFocus(path: string | undefined): void {
    if (this.disposed) return
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return
    if (path !== undefined && !this.visibleRows().some(row => row.path === path)) return
    this.store.setFocus(workspaceId, path)
  }

  setSelected(path: string | undefined): void {
    if (this.disposed) return
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return
    if (path !== undefined && canonical(path, false) === undefined) return
    // An independent user/document selection withdraws any older async reveal.
    this.cancelReveal()
    this.store.clearPresentation(workspaceId)
    this.store.setSelected(workspaceId, path)
  }

  async handleTreeKey(key: ExplorerTreeKey): Promise<ExplorerTreeIntent | undefined> {
    if (this.disposed) return undefined
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return undefined
    const workspaceEpoch = this.store.getSnapshot().activeWorkspaceEpoch
    const session = this.store.session(workspaceId)
    const intent = reduceExplorerTreeKey(this.visibleRows(), session.focusedPath, key)
    if (intent === undefined) return undefined
    if (intent.focusPath !== undefined) this.setFocus(intent.focusPath)
    if (intent.selectPath !== undefined) this.setSelected(intent.selectPath)
    if (intent.expandPaths !== undefined) {
      const paths = this.store.expandMany(workspaceId, intent.expandPaths)
      await this.loadBounded(paths, workspaceId, workspaceEpoch)
    }
    if (intent.togglePath !== undefined) await this.toggle(intent.togglePath)
    return intent
  }

  /** APG prefix navigation with an 800ms composition window. */
  typeahead(character: string, now = Date.now()): string | undefined {
    if (this.disposed || character.length === 0 || [...character].length !== 1
      || /[\u0000-\u001f\u007f]/u.test(character)) return undefined
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return undefined
    if (!Number.isFinite(now) || now - this.typeaheadAt >= 800 || now < this.typeaheadAt) {
      this.typeaheadBuffer = character
    } else if ([...this.typeaheadBuffer].every(value => value.toLocaleLowerCase() === character.toLocaleLowerCase())) {
      // Repeated character cycles through same-prefix rows instead of building "aaa".
      this.typeaheadBuffer = character
    } else {
      this.typeaheadBuffer += character
    }
    this.typeaheadAt = now
    const session = this.store.session(workspaceId)
    const rows = this.visibleRows()
    let path = findTypeaheadPath(rows, this.typeaheadBuffer, session.focusedPath)
    if (path === undefined && this.typeaheadBuffer !== character) {
      this.typeaheadBuffer = character
      path = findTypeaheadPath(rows, character, session.focusedPath)
    }
    if (path !== undefined) this.store.setFocus(workspaceId, path)
    return path
  }

  async refreshExpanded(): Promise<void> {
    if (this.disposed) return
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return
    const workspaceEpoch = this.store.getSnapshot().activeWorkspaceEpoch
    const paths = [...this.store.session(workspaceId).expanded]
    await this.loadBounded(paths, workspaceId, workspaceEpoch)
  }

  async refreshDirectories(paths: readonly string[]): Promise<void> {
    if (this.disposed) return
    const snapshot = this.store.getSnapshot()
    const workspaceId = snapshot.activeWorkspaceId
    if (workspaceId === undefined) return
    const unique = [...new Set(paths.flatMap(path => {
      const value = canonical(path, true)
      return value === undefined ? [] : [value]
    }))]
    await this.loadBounded(unique, workspaceId, snapshot.activeWorkspaceEpoch)
  }

  /** A create receipt is authority to refresh/reveal, never to synthesize a row. */
  async commitCreateMutation(
    workspaceId: string,
    workspaceEpoch: number,
    path: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean> {
    if (this.disposed || !this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return false
    await this.refreshDirectories(refreshDirectories)
    if (!this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return false
    return await this.revealPath(path, { focus: true, select: true })
  }

  async commitRenameMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    freshVersion: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean> {
    if (this.disposed || !this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return false
    this.abortRelated([sourcePath, destinationPath], true)
    this.cancelReveal()
    if (!this.store.rebasePath(workspaceId, sourcePath, destinationPath, freshVersion)) return false
    await this.refreshDirectories(refreshDirectories)
    if (!this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return false
    return await this.revealPath(destinationPath, { focus: true, select: true })
  }

  async commitDeleteMutation(
    workspaceId: string,
    workspaceEpoch: number,
    path: string,
    refreshDirectories: readonly string[],
  ): Promise<boolean> {
    if (this.disposed || !this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return false
    this.pruneRemoved([path])
    await this.refreshDirectories(refreshDirectories)
    return this.store.isActiveEpoch(workspaceId, workspaceEpoch)
  }

  /** Abort/fence first, then synchronously withdraw removed presentation. */
  pruneRemoved(paths: readonly string[]): void {
    if (this.disposed) return
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (workspaceId === undefined) return
    const removed = [...new Set(paths.flatMap(path => {
      const value = canonical(path, true)
      return value === undefined ? [] : [value]
    }))]
    if (removed.length === 0) return
    this.abortRelated(removed, true)
    this.store.pruneRemoved(workspaceId, removed)
  }

  async revealPath(path: string, options: ExplorerRevealOptions = {}): Promise<boolean> {
    const target = canonical(path, false)
    const workspaceId = this.store.getSnapshot().activeWorkspaceId
    if (this.disposed || target === undefined || workspaceId === undefined) return false
    const segments = target.split('/')
    if (segments.length > MAX_EXPLORER_TREE_DEPTH) return false

    this.cancelReveal()
    const revealGeneration = ++this.revealGeneration
    const controller = new AbortController()
    this.revealController = controller
    const workspaceEpoch = this.store.getSnapshot().activeWorkspaceEpoch
    let parent = ''

    try {
      for (let index = 0; index < segments.length; index += 1) {
        if (!this.acceptsReveal(workspaceId, workspaceEpoch, revealGeneration, controller)) return false
        const loaded = await this.loadDirectory(parent, true, revealGeneration)
        if (!loaded || !this.acceptsReveal(workspaceId, workspaceEpoch, revealGeneration, controller)) return false

        const directory = this.store.session(workspaceId).directories.get(parent)
        if (directory?.status !== 'ready') return false
        const child = segments.slice(0, index + 1).join('/')
        const entry = directory.entries
          ?.find(candidate => candidate.path === child && directChild(parent, candidate.path))
        if (entry === undefined || (index < segments.length - 1 && entry.type !== 'directory')) return false
        if (index < segments.length - 1) {
          if (!this.store.setExpanded(workspaceId, child, true)) return false
          parent = child
        }
      }

      if (!this.acceptsReveal(workspaceId, workspaceEpoch, revealGeneration, controller)) return false
      if (options.select ?? true) this.store.setSelected(workspaceId, target)
      if (options.focus === true) this.store.setFocus(workspaceId, target)
      this.store.requestPresentation(workspaceId, target, options.focus === true)
      return true
    } finally {
      if (this.revealController === controller) this.revealController = undefined
    }
  }

  acknowledgePresentation(requestId: number): boolean {
    return !this.disposed && this.store.acknowledgePresentation(requestId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Fence subscribers before abort cleanup can touch presentation state.
    this.store.dispose()
    this.abortAllLoads()
    this.cancelReveal()
    this.generations.clear()
    this.resetTypeahead()
  }

  private visibleRows() {
    return deriveVisibleExplorerRows(this.store.session())
  }

  private entry(path: string): FileEntry | undefined {
    for (const directory of this.store.session().directories.values()) {
      const entry = directory.entries?.find(candidate => candidate.path === path)
      if (entry !== undefined) return entry
    }
    return undefined
  }

  private async loadDirectory(path: string, force: boolean, revealGeneration?: number): Promise<boolean> {
    const canonicalPath = canonical(path, true)
    const snapshot = this.store.getSnapshot()
    const workspaceId = snapshot.activeWorkspaceId
    if (this.disposed || canonicalPath === undefined || workspaceId === undefined) return false
    const session = this.store.session(workspaceId)
    const existing = this.activeLoads.get(canonicalPath)
    if (!force) {
      if (existing !== undefined) return existing.promise
      if (session.directories.get(canonicalPath)?.entries !== undefined) return true
    }
    existing?.controller.abort()

    const key = `${workspaceId}\u0000${canonicalPath}`
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    const controller = new AbortController()
    this.store.setDirectoryLoading(workspaceId, canonicalPath)
    let finish!: (accepted: boolean) => void
    const promise = new Promise<boolean>(resolve => { finish = resolve })
    const active: ActiveLoad = {
      workspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: canonicalPath,
      generation,
      controller,
      ...(revealGeneration === undefined ? {} : { revealGeneration }),
      promise,
    }
    this.activeLoads.set(canonicalPath, active)
    void (async () => {
      let accepted = false
      try {
        const response = await this.files.list(workspaceId, canonicalPath, controller.signal)
        if (this.acceptsLoad(active)) {
          const previousEntries = this.store.session(workspaceId).directories.get(canonicalPath)?.entries ?? []
          const nextEntries = new Map(response.entries.map(entry => [entry.path, entry.type] as const))
          const removed = previousEntries
            .filter(entry => !nextEntries.has(entry.path))
            .map(entry => entry.path)
          const replaced = previousEntries
            .filter(entry => nextEntries.has(entry.path) && nextEntries.get(entry.path) !== entry.type)
            .map(entry => entry.path)
          if (removed.length > 0 || replaced.length > 0) {
            // A refreshed direct-child list is authoritative. Fence loads below
            // removed/type-replaced children before pruning their cached view
            // identity; do not abort this parent directory's accepted load.
            this.abortRelated([...removed, ...replaced], false)
            if (removed.length > 0) this.store.pruneRemoved(workspaceId, removed)
          }
          accepted = this.store.setDirectoryEntries(workspaceId, canonicalPath, response.entries)
          if (accepted && replaced.length > 0) this.store.pruneReplaced(workspaceId, replaced)
        }
      } catch (error) {
        if (this.acceptsLoad(active)) this.store.setDirectoryError(workspaceId, canonicalPath, error)
      } finally {
        if (this.activeLoads.get(canonicalPath) === active) this.activeLoads.delete(canonicalPath)
        finish(accepted)
      }
    })()
    return await promise
  }

  private async loadBounded(paths: readonly string[], workspaceId: string, workspaceEpoch: number): Promise<void> {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        if (!this.store.isActiveEpoch(workspaceId, workspaceEpoch)) return
        const index = cursor
        cursor += 1
        const path = paths[index]
        if (path !== undefined) await this.load(path, true)
      }
    }
    const count = Math.min(MAX_EXPLORER_CONCURRENT_LOADS, paths.length)
    await Promise.all(Array.from({ length: count }, worker))
  }

  private acceptsLoad(load: ActiveLoad): boolean {
    const key = `${load.workspaceId}\u0000${load.path}`
    return !this.disposed && !load.controller.signal.aborted
      && this.store.isActiveEpoch(load.workspaceId, load.workspaceEpoch)
      && this.generations.get(key) === load.generation
      && this.activeLoads.get(load.path) === load
  }

  private acceptsReveal(
    workspaceId: string,
    workspaceEpoch: number,
    generation: number,
    controller: AbortController,
  ): boolean {
    return !this.disposed && !controller.signal.aborted
      && this.revealGeneration === generation && this.revealController === controller
      && this.store.isActiveEpoch(workspaceId, workspaceEpoch)
  }

  private abortRelated(paths: readonly string[], includeAncestors: boolean): void {
    for (const [path, load] of this.activeLoads) {
      const matches = paths.some(changed => includeAncestors
        ? intersects(path, changed)
        : path === changed || path.startsWith(`${changed}/`))
      if (!matches) continue
      load.controller.abort()
      this.activeLoads.delete(path)
      this.store.cancelDirectoryLoading(load.workspaceId, path)
      const key = `${load.workspaceId}\u0000${path}`
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    }
  }

  private abortAllLoads(): void {
    for (const load of this.activeLoads.values()) {
      load.controller.abort()
      this.store.cancelDirectoryLoading(load.workspaceId, load.path)
    }
    this.activeLoads.clear()
  }

  private cancelReveal(): void {
    this.revealGeneration += 1
    this.revealController?.abort()
    this.revealController = undefined
    for (const [path, load] of this.activeLoads) {
      if (load.revealGeneration === undefined) continue
      load.controller.abort()
      this.activeLoads.delete(path)
      this.store.cancelDirectoryLoading(load.workspaceId, path)
    }
  }

  private resetTypeahead(): void {
    this.typeaheadBuffer = ''
    this.typeaheadAt = -Infinity
  }
}
