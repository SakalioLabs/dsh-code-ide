import type { FileEntry } from '../contracts.ts'
import { decodeWorkspacePath } from '../workspace-path.ts'
import { deriveVisibleExplorerRows, MAX_EXPLORER_TREE_DEPTH } from './model.ts'

export const MAX_EXPLORER_CACHED_DIRECTORIES = 256
export const MAX_EXPLORER_EXPANDED_DIRECTORIES = 128
export const MAX_EXPLORER_CACHED_ENTRIES = 50_000

export type ExplorerDirectoryStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ExplorerDirectoryState {
  readonly status: ExplorerDirectoryStatus
  readonly entries?: readonly FileEntry[]
  readonly error?: string
}

export interface ExplorerPresentationIntent {
  readonly requestId: number
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly path: string
  readonly focus: boolean
}

export interface ExplorerWorkspaceSession {
  readonly expanded: ReadonlySet<string>
  readonly directories: ReadonlyMap<string, ExplorerDirectoryState>
  readonly focusedPath?: string
  readonly selectedPath?: string
  readonly pendingPresentation?: ExplorerPresentationIntent
}

export interface ExplorerSnapshot {
  readonly activeWorkspaceId?: string
  readonly activeWorkspaceEpoch: number
  readonly sessions: ReadonlyMap<string, ExplorerWorkspaceSession>
}

type Listener = () => void

const EMPTY_SESSION: ExplorerWorkspaceSession = {
  expanded: new Set(['']),
  directories: new Map(),
}

function newSession(): ExplorerWorkspaceSession {
  return { expanded: new Set(['']), directories: new Map() }
}

function canonical(path: string, allowRoot: boolean): string | undefined {
  const value = decodeWorkspacePath(path, { allowRoot })
  if (value === undefined || (value !== '' && value.split('/').length > MAX_EXPLORER_TREE_DEPTH)) return undefined
  return value
}

function isPathOrDescendant(candidate: string, parent: string): boolean {
  return parent === '' || candidate === parent || candidate.startsWith(`${parent}/`)
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

function basename(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? path : path.slice(separator + 1)
}

function rebasePath(path: string, source: string, destination: string): string {
  return path === source ? destination : `${destination}${path.slice(source.length)}`
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\u0000-\u001f\u007f]/g, '\ufffd').slice(0, 1_000)
}

function immutableEntries(entries: readonly FileEntry[]): readonly FileEntry[] {
  return Object.freeze(entries.map(entry => Object.freeze({ ...entry })))
}

function boundedDirectories(
  current: ReadonlyMap<string, ExplorerDirectoryState>,
  path: string,
  state: ExplorerDirectoryState,
  protectedPaths: ReadonlySet<string>,
): ReadonlyMap<string, ExplorerDirectoryState> | undefined {
  const directories = new Map(current)
  directories.delete(path)
  directories.set(path, state)
  let entryCount = [...directories.values()]
    .reduce((total, directory) => total + (directory.entries?.length ?? 0), 0)
  while (directories.size > MAX_EXPLORER_CACHED_DIRECTORIES || entryCount > MAX_EXPLORER_CACHED_ENTRIES) {
    const victim = [...directories.keys()].find(candidate => candidate !== ''
      && candidate !== path && !protectedPaths.has(candidate))
    if (victim === undefined) return undefined
    entryCount -= directories.get(victim)?.entries?.length ?? 0
    directories.delete(victim)
  }
  return directories
}

/** Framework-neutral useSyncExternalStore source for Explorer presentation. */
export class ExplorerStore {
  private snapshot: ExplorerSnapshot = { activeWorkspaceEpoch: 0, sessions: new Map() }
  private readonly listeners = new Set<Listener>()
  private presentationSequence = 0
  private disposed = false

  readonly getSnapshot = (): ExplorerSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  session(workspaceId: string | undefined = this.snapshot.activeWorkspaceId): ExplorerWorkspaceSession {
    return workspaceId === undefined ? EMPTY_SESSION : this.snapshot.sessions.get(workspaceId) ?? EMPTY_SESSION
  }

  isActiveEpoch(workspaceId: string, epoch: number): boolean {
    return !this.disposed && this.snapshot.activeWorkspaceId === workspaceId
      && this.snapshot.activeWorkspaceEpoch === epoch
  }

  selectWorkspace(workspaceId: string | undefined): void {
    if (this.disposed || this.snapshot.activeWorkspaceId === workspaceId) return
    const sessions = new Map(this.snapshot.sessions)
    const previous = this.snapshot.activeWorkspaceId
    if (previous !== undefined) sessions.set(previous, this.withoutPresentation(this.session(previous)))
    if (workspaceId !== undefined) {
      sessions.set(workspaceId, this.withoutPresentation(sessions.get(workspaceId) ?? newSession()))
    }
    this.publish({
      ...(workspaceId === undefined ? {} : { activeWorkspaceId: workspaceId }),
      activeWorkspaceEpoch: this.snapshot.activeWorkspaceEpoch + 1,
      sessions,
    })
  }

  setDirectoryLoading(workspaceId: string, path: string): void {
    if (this.disposed || canonical(path, true) === undefined) return
    const session = this.ensureSession(workspaceId)
    const prior = session.directories.get(path)
    const directories = boundedDirectories(session.directories, path, {
      status: 'loading',
      ...(prior?.entries === undefined ? {} : { entries: prior.entries }),
    }, session.expanded)
    if (directories === undefined) return
    this.replaceSession(workspaceId, {
      ...session,
      directories,
    })
  }

  setDirectoryEntries(workspaceId: string, path: string, entries: readonly FileEntry[]): boolean {
    if (this.disposed || canonical(path, true) === undefined) return false
    const session = this.ensureSession(workspaceId)
    const prior = session.directories.get(path)
    const directories = boundedDirectories(session.directories, path, {
      status: 'ready', entries: immutableEntries(entries),
    }, session.expanded)
    if (directories === undefined) {
      const rejected = boundedDirectories(session.directories, path, {
        status: 'error', error: 'Directory cache limit exceeded.',
        ...(prior?.entries === undefined ? {} : { entries: prior.entries }),
      }, session.expanded)
      if (rejected !== undefined) this.replaceSession(workspaceId, { ...session, directories: rejected })
      return false
    }
    this.replaceSession(workspaceId, {
      ...session,
      directories,
    })
    return true
  }

  setDirectoryError(workspaceId: string, path: string, error: unknown): void {
    if (this.disposed || canonical(path, true) === undefined) return
    const session = this.ensureSession(workspaceId)
    const prior = session.directories.get(path)
    const directories = boundedDirectories(session.directories, path, {
      status: 'error', error: boundedError(error),
      ...(prior?.entries === undefined ? {} : { entries: prior.entries }),
    }, session.expanded)
    if (directories === undefined) return
    this.replaceSession(workspaceId, {
      ...session,
      directories,
    })
  }

  cancelDirectoryLoading(workspaceId: string, path: string): void {
    if (this.disposed) return
    const session = this.snapshot.sessions.get(workspaceId)
    const prior = session?.directories.get(path)
    if (session === undefined || prior?.status !== 'loading') return
    const directories = new Map(session.directories)
    if (prior.entries === undefined) directories.delete(path)
    else directories.set(path, { status: 'ready', entries: prior.entries })
    this.replaceSession(workspaceId, { ...session, directories })
  }

  setExpanded(workspaceId: string, path: string, expanded: boolean): boolean {
    if (this.disposed || canonical(path, true) === undefined) return false
    const session = this.ensureSession(workspaceId)
    if (path === '' && !expanded) return false
    if (session.expanded.has(path) === expanded) return true
    const next = new Set(session.expanded)
    if (expanded) {
      if (next.size >= MAX_EXPLORER_EXPANDED_DIRECTORIES) return false
      next.add(path)
    } else {
      next.delete(path)
    }
    next.add('')
    this.replaceSession(workspaceId, { ...session, expanded: next })
    return true
  }

  expandMany(workspaceId: string, paths: readonly string[]): readonly string[] {
    const accepted: string[] = []
    for (const path of paths) {
      if (this.setExpanded(workspaceId, path, true)) accepted.push(path)
    }
    return accepted
  }

  /** Collapse every non-root directory in one active-workspace publication. */
  collapseAll(workspaceId: string): boolean {
    if (this.disposed || this.snapshot.activeWorkspaceId !== workspaceId) return false
    const session = this.snapshot.sessions.get(workspaceId)
    if (session === undefined) return false
    const expanded = new Set([''])
    const rows = deriveVisibleExplorerRows({ expanded, directories: session.directories })
    const visible = new Set(rows.map(row => row.path))
    let focusedPath = session.focusedPath
    while (focusedPath !== undefined && !visible.has(focusedPath)) {
      const parent = parentPath(focusedPath)
      focusedPath = parent === focusedPath || parent === '' ? undefined : parent
    }
    focusedPath ??= rows[0]?.path
    const {
      focusedPath: _focusedPath,
      pendingPresentation: _pendingPresentation,
      ...retained
    } = session
    this.replaceSession(workspaceId, {
      ...retained,
      expanded,
      ...(focusedPath === undefined ? {} : { focusedPath }),
    })
    return true
  }

  setFocus(workspaceId: string, path: string | undefined): void {
    if (this.disposed || (path !== undefined && canonical(path, false) === undefined)) return
    const session = this.ensureSession(workspaceId)
    if (session.focusedPath === path) return
    const { focusedPath: _focusedPath, ...rest } = session
    this.replaceSession(workspaceId, { ...rest, ...(path === undefined ? {} : { focusedPath: path }) })
  }

  setSelected(workspaceId: string, path: string | undefined): void {
    if (this.disposed || (path !== undefined && canonical(path, false) === undefined)) return
    const session = this.ensureSession(workspaceId)
    if (session.selectedPath === path) return
    const { selectedPath: _selectedPath, ...rest } = session
    this.replaceSession(workspaceId, { ...rest, ...(path === undefined ? {} : { selectedPath: path }) })
  }

  requestPresentation(workspaceId: string, path: string, focus: boolean): ExplorerPresentationIntent | undefined {
    if (!this.isActiveEpoch(workspaceId, this.snapshot.activeWorkspaceEpoch) || canonical(path, false) === undefined) {
      return undefined
    }
    const intent: ExplorerPresentationIntent = {
      requestId: ++this.presentationSequence,
      workspaceId,
      workspaceEpoch: this.snapshot.activeWorkspaceEpoch,
      path,
      focus,
    }
    const session = this.ensureSession(workspaceId)
    this.replaceSession(workspaceId, { ...session, pendingPresentation: intent })
    return intent
  }

  acknowledgePresentation(requestId: number): boolean {
    const workspaceId = this.snapshot.activeWorkspaceId
    if (this.disposed || workspaceId === undefined) return false
    const session = this.session(workspaceId)
    const pending = session.pendingPresentation
    if (pending?.requestId !== requestId || pending.workspaceEpoch !== this.snapshot.activeWorkspaceEpoch) return false
    this.replaceSession(workspaceId, this.withoutPresentation(session))
    return true
  }

  clearPresentation(workspaceId: string): void {
    if (this.disposed) return
    const session = this.snapshot.sessions.get(workspaceId)
    if (session?.pendingPresentation === undefined) return
    this.replaceSession(workspaceId, this.withoutPresentation(session))
  }

  pruneRemoved(workspaceId: string, removedPaths: readonly string[]): void {
    if (this.disposed) return
    const removed = [...new Set(removedPaths.flatMap(path => {
      const value = canonical(path, true)
      return value === undefined ? [] : [value]
    }))]
    if (removed.length === 0) return
    const session = this.ensureSession(workspaceId)
    const previousRows = deriveVisibleExplorerRows(session)
    const expanded = new Set([...session.expanded].filter(path => !removed.some(root => isPathOrDescendant(path, root))))
    expanded.add('')
    const directories = new Map<string, ExplorerDirectoryState>()
    for (const [path, directory] of session.directories) {
      if (removed.some(root => isPathOrDescendant(path, root))) continue
      const entries = directory.entries?.filter(entry => !removed.some(root => isPathOrDescendant(entry.path, root)))
      directories.set(path, entries === undefined || entries.length === directory.entries?.length
        ? directory
        : { ...directory, entries: immutableEntries(entries) })
    }
    const retainedView = { expanded, directories }
    const retainedRows = deriveVisibleExplorerRows(retainedView)
    const retainedPaths = new Set(retainedRows.map(row => row.path))
    let focusedPath = session.focusedPath !== undefined
      && retainedPaths.has(session.focusedPath) ? session.focusedPath : undefined
    if (focusedPath === undefined && session.focusedPath !== undefined && retainedRows.length > 0) {
      const oldIndex = previousRows.findIndex(row => row.path === session.focusedPath)
      if (oldIndex >= 0) {
        for (let index = oldIndex - 1; index >= 0 && focusedPath === undefined; index -= 1) {
          const candidate = previousRows[index]?.path
          if (candidate !== undefined && retainedPaths.has(candidate)) focusedPath = candidate
        }
        for (let index = oldIndex + 1; index < previousRows.length && focusedPath === undefined; index += 1) {
          const candidate = previousRows[index]?.path
          if (candidate !== undefined && retainedPaths.has(candidate)) focusedPath = candidate
        }
      }
      focusedPath ??= retainedRows[0]?.path
    }
    const selectedPath = session.selectedPath !== undefined
      && !removed.some(root => isPathOrDescendant(session.selectedPath!, root)) ? session.selectedPath : undefined
    const pending = session.pendingPresentation !== undefined
      && !removed.some(root => isPathOrDescendant(session.pendingPresentation!.path, root))
      ? session.pendingPresentation : undefined
    this.replaceSession(workspaceId, {
      expanded,
      directories,
      ...(focusedPath === undefined ? {} : { focusedPath }),
      ...(selectedPath === undefined ? {} : { selectedPath }),
      ...(pending === undefined ? {} : { pendingPresentation: pending }),
    })
  }

  /**
   * Drop cache owned by entries whose kind changed while keeping the exact
   * replacement row's focus identity. Descendant focus falls back to that row.
   */
  pruneReplaced(workspaceId: string, replacedPaths: readonly string[]): void {
    if (this.disposed) return
    const replaced = [...new Set(replacedPaths.flatMap(path => {
      const value = canonical(path, false)
      return value === undefined ? [] : [value]
    }))]
    if (replaced.length === 0) return
    const session = this.ensureSession(workspaceId)
    const owner = (path: string | undefined): string | undefined => path === undefined
      ? undefined
      : replaced
        .filter(root => isPathOrDescendant(path, root))
        .sort((left, right) => right.length - left.length)[0]
    const expanded = new Set([...session.expanded]
      .filter(path => !replaced.some(root => isPathOrDescendant(path, root))))
    expanded.add('')
    const directories = new Map([...session.directories]
      .filter(([path]) => !replaced.some(root => isPathOrDescendant(path, root))))
    const focusedOwner = owner(session.focusedPath)
    const focusedPath = focusedOwner ?? session.focusedPath
    const selectedOwner = owner(session.selectedPath)
    const selectedPath = selectedOwner === undefined || selectedOwner === session.selectedPath
      ? session.selectedPath : undefined
    const pendingOwner = owner(session.pendingPresentation?.path)
    const pending = pendingOwner === undefined || pendingOwner === session.pendingPresentation?.path
      ? session.pendingPresentation : undefined
    this.replaceSession(workspaceId, {
      expanded,
      directories,
      ...(focusedPath === undefined ? {} : { focusedPath }),
      ...(selectedPath === undefined ? {} : { selectedPath }),
      ...(pending === undefined ? {} : { pendingPresentation: pending }),
    })
  }

  /** Re-key committed rename identity without treating a fabricated draft as tree authority. */
  rebasePath(
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    freshVersion: string,
  ): boolean {
    const source = canonical(sourcePath, false)
    const destination = canonical(destinationPath, false)
    if (this.disposed || source === undefined || destination === undefined
      || source === destination || destination.startsWith(`${source}/`)) return false
    const session = this.ensureSession(workspaceId)
    const sourceEntry = [...session.directories.values()]
      .flatMap(directory => directory.entries ?? [])
      .find(entry => entry.path === source)

    const expanded = new Set<string>()
    for (const path of session.expanded) {
      if (isPathOrDescendant(path, destination) && !isPathOrDescendant(path, source)) continue
      expanded.add(isPathOrDescendant(path, source) ? rebasePath(path, source, destination) : path)
    }
    expanded.add('')

    const directories = new Map<string, ExplorerDirectoryState>()
    for (const [path, directory] of session.directories) {
      if (isPathOrDescendant(path, destination) && !isPathOrDescendant(path, source)) continue
      const nextPath = isPathOrDescendant(path, source) ? rebasePath(path, source, destination) : path
      const entries = directory.entries
        ?.filter(entry => !isPathOrDescendant(entry.path, destination) || isPathOrDescendant(entry.path, source))
        .map((entry): FileEntry => {
          if (!isPathOrDescendant(entry.path, source)) return entry
          const path = rebasePath(entry.path, source, destination)
          return {
            ...entry,
            path,
            name: basename(path),
            ...(entry.path === source ? { version: freshVersion } : {}),
          }
        })
        .filter(entry => parentPath(entry.path) === nextPath)
      directories.set(nextPath, entries === undefined ? directory : { ...directory, entries: immutableEntries(entries) })
    }

    if (sourceEntry !== undefined && parentPath(source) !== parentPath(destination)) {
      const destinationParent = directories.get(parentPath(destination))
      if (destinationParent?.entries !== undefined) {
        const moved: FileEntry = {
          ...sourceEntry,
          path: destination,
          name: basename(destination),
          version: freshVersion,
        }
        directories.set(parentPath(destination), {
          ...destinationParent,
          entries: immutableEntries([...destinationParent.entries, moved]),
        })
      }
    }

    const mapOptional = (path: string | undefined): string | undefined => path !== undefined
      && isPathOrDescendant(path, source) ? rebasePath(path, source, destination) : path
    const focusedPath = mapOptional(session.focusedPath)
    const selectedPath = mapOptional(session.selectedPath)
    const pending = session.pendingPresentation === undefined ? undefined : {
      ...session.pendingPresentation,
      path: mapOptional(session.pendingPresentation.path) ?? session.pendingPresentation.path,
    }
    this.replaceSession(workspaceId, {
      expanded,
      directories,
      ...(focusedPath === undefined ? {} : { focusedPath }),
      ...(selectedPath === undefined ? {} : { selectedPath }),
      ...(pending === undefined ? {} : { pendingPresentation: pending }),
    })
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  private withoutPresentation(session: ExplorerWorkspaceSession): ExplorerWorkspaceSession {
    const { pendingPresentation: _pending, ...rest } = session
    return rest
  }

  private ensureSession(workspaceId: string): ExplorerWorkspaceSession {
    return this.snapshot.sessions.get(workspaceId) ?? newSession()
  }

  private replaceSession(workspaceId: string, session: ExplorerWorkspaceSession): void {
    if (this.disposed) return
    const sessions = new Map(this.snapshot.sessions)
    sessions.set(workspaceId, session)
    this.publish({ ...this.snapshot, sessions })
  }

  private publish(snapshot: ExplorerSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    // A failing view cannot prevent other uSES consumers from observing the
    // already-committed immutable snapshot.
    for (const listener of this.listeners) {
      try { listener() } catch { /* presentation observers are isolated */ }
    }
  }
}
