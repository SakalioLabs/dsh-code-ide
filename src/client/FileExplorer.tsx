import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { FileEntry, WorkspaceSummary } from './contracts.ts'
import {
  clampExplorerMenuPosition,
  ExplorerContextMenu,
  ExplorerDeleteDialog,
  ExplorerInlineMutationEditor,
  ExplorerMutationLiveStatus,
  ExplorerUnresolvedMutationDialog,
  explorerMutationShortcut,
  isDeleteMutationSnapshot,
  isExplorerEditableTarget,
  isManualMutationReconciliation,
  isNamedMutationSnapshot,
  mutationSnapshotError,
  mutationSnapshotImpact,
  type ExplorerContextMenuItem,
  type ExplorerMenuPosition,
  type ExplorerMutationController,
  type ExplorerMutationStore,
} from './ExplorerMutationUi.tsx'
import type { ExplorerController } from './explorer/controller.ts'
import {
  deriveVisibleExplorerRows,
  type ExplorerTreeKey,
  type ExplorerVisibleRow,
} from './explorer/model.ts'
import type { ExplorerStore, ExplorerWorkspaceSession } from './explorer/store.ts'
import type { MutationSource, WorkspaceMutationSnapshot } from './mutations/store.ts'
import css from './ide.module.css'
import { ExplorerFileIcon, IdeIcon } from './icons.tsx'
import { useIdeI18n, type IdeLocale } from './i18n.tsx'
import { decodeWorkspacePath } from './workspace-path.ts'

export interface FileExplorerProps {
  workspace: WorkspaceSummary | undefined
  store: ExplorerStore
  controller: ExplorerController
  onOpen: (entry: FileEntry) => void
  /** A changing value explicitly requests that keyboard focus enter the tree. */
  focusRequest?: number | undefined
  /** A changing value synchronously dismisses body-portaled Explorer menus. */
  portalDismissRequest?: number | undefined
  /** Receives unexpected adapter/controller failures, not expected directory errors. */
  onError?: (error: unknown) => void
  /** Browser-owned async clipboard writer; Explorer supplies only an exact relative entry path. */
  writeClipboard?: (value: string) => Promise<void>
  /** Page-owned status projection keeps clipboard permission failures out of Explorer's tree state. */
  onClipboardWriteResult?: (result: ExplorerClipboardWriteResult) => void
  /** Optional page-owned mutation workflow. Both mutation props are required to enable actions. */
  mutationStore?: ExplorerMutationStore
  mutationController?: ExplorerMutationController
  /** New intents require Host capability; an already-admitted recovery remains renderable when false. */
  mutationAdmissionEnabled?: boolean
  /** Operation capabilities are independent; omitted values preserve the legacy all-enabled adapter. */
  mutationCreateFileEnabled?: boolean
  mutationCreateDirectoryEnabled?: boolean
  mutationRenameEnabled?: boolean
  mutationDeleteEnabled?: boolean
  /** Only the page holding the recovery Web Lock may clear an unresolved checkpoint. */
  mutationRecoveryWritable?: boolean
  /** The portal is outside this component's DOM. Owners should inert only the app shell, never document.body. */
  onModalChange?: (open: boolean) => void
}

export type ExplorerClipboardWriteResult =
  | { readonly status: 'copied' }
  | { readonly status: 'failed'; readonly error: unknown }

export type ExplorerKeyboardAction =
  | { readonly kind: 'tree'; readonly key: ExplorerTreeKey }
  | { readonly kind: 'typeahead'; readonly character: string }

export interface ExplorerKeyboardInput {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isComposing?: boolean
  readonly editableTarget?: boolean
}

export interface ExplorerKeyboardController {
  handleTreeKey(key: ExplorerTreeKey): Promise<{ readonly focusPath?: string; readonly activatePath?: string } | undefined>
  typeahead(character: string, now?: number): string | undefined
}

export interface ExplorerRowController {
  setFocus(path: string | undefined): void
  setSelected(path: string | undefined): void
  toggle(path: string): Promise<void>
}

const EMPTY_MUTATION_SNAPSHOT: WorkspaceMutationSnapshot = { phase: 'idle', workspaceEpoch: 0 }

export function explorerMutationSource(entry: FileEntry | undefined): MutationSource | undefined {
  if (entry === undefined || entry.version === undefined
    || (entry.type !== 'file' && entry.type !== 'directory')) return undefined
  return { path: entry.path, type: entry.type, version: entry.version }
}

export interface ExplorerDragIdentity {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly source: MutationSource
}

function explorerEntryParentPath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

/** Only a canonical folder outside the source subtree can be an atomic rename destination. */
export function explorerMoveDestinationParent(
  source: MutationSource,
  target: FileEntry | undefined,
): string | undefined {
  if (target?.type !== 'directory'
    || decodeWorkspacePath(target.path, { allowRoot: false }) !== target.path
    || target.path === explorerEntryParentPath(source.path)
    || (source.type === 'directory'
      && (target.path === source.path || target.path.startsWith(`${source.path}/`)))) return undefined
  return target.path
}

/** A long pointer gesture cannot carry an older workspace epoch or entry version into a mutation. */
export function explorerDragIdentityIsCurrent(
  identity: ExplorerDragIdentity,
  currentWorkspaceId: string | undefined,
  currentWorkspaceEpoch: number,
  rows: readonly ExplorerVisibleRow[],
): boolean {
  return identity.workspaceId === currentWorkspaceId
    && identity.workspaceEpoch === currentWorkspaceEpoch
    && rows.some(row => row.path === identity.source.path
      && row.entry.type === identity.source.type
      && row.entry.version === identity.source.version)
}

/** The controller owns impact inspection and the exact-once confirmation transition. */
export function beginExplorerDeleteMutation(
  controller: Pick<ExplorerMutationController, 'beginDelete'>,
  source: MutationSource,
): unknown {
  return controller.beginDelete(source)
}

/** A file creates beside itself; a directory creates inside itself; no anchor means workspace root. */
export function explorerCreateParentPath(
  rows: readonly ExplorerVisibleRow[],
  anchorPath: string | undefined,
): string {
  const row = anchorPath === undefined ? undefined : rows.find(candidate => candidate.path === anchorPath)
  if (row === undefined) return ''
  return row.entry.type === 'directory' ? row.path : row.parentPath
}

interface ExplorerContextState {
  readonly anchorPath?: string
  readonly position: ExplorerMenuPosition
  readonly focusedPathAtOpen: string | undefined
  readonly selectedPathAtOpen: string | undefined
}

const TREE_KEYS = new Set<string>([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
  'Enter',
  ' ',
  '*',
] satisfies readonly ExplorerTreeKey[])

/** Normalize browser key events without coupling the APG reducer to React. */
export function explorerKeyboardAction(input: ExplorerKeyboardInput): ExplorerKeyboardAction | undefined {
  if (input.editableTarget === true || input.isComposing === true
    || input.altKey || input.ctrlKey || input.metaKey) return undefined
  if (TREE_KEYS.has(input.key)) return { kind: 'tree', key: input.key as ExplorerTreeKey }
  if ([...input.key].length !== 1 || /[\u0000-\u001f\u007f]/u.test(input.key)) return undefined
  return { kind: 'typeahead', character: input.key }
}

/** Exactly one visible row participates in the tree's roving tab stop. */
export function explorerRovingPath(
  rows: readonly ExplorerVisibleRow[],
  focusedPath: string | undefined,
  selectedPath: string | undefined,
): string | undefined {
  const visible = new Set(rows.map(row => row.path))
  if (focusedPath !== undefined && visible.has(focusedPath)) return focusedPath
  if (selectedPath !== undefined && visible.has(selectedPath)) return selectedPath
  return rows[0]?.path
}

/**
 * Deferred directory loads may finish after keyboard focus has left Explorer.
 * Commit their focus intent only while the originating tree still owns focus
 * and no newer tree operation has superseded the request.
 */
export function explorerOwnsDeferredFocus(
  expectedGeneration: number,
  currentGeneration: number,
  focusWithinTree: boolean,
): boolean {
  return expectedGeneration === currentGeneration && focusWithinTree
}

/** A removed focused row may recover focus only while the page still owns it. */
export function explorerOwnsRemovedFocusRecovery(input: {
  readonly expectedGeneration: number
  readonly currentGeneration: number
  readonly documentHasFocus: boolean
  readonly activeElementIsBody: boolean
  readonly removedRowStillVisible: boolean
  readonly fallbackExists: boolean
}): boolean {
  return input.expectedGeneration === input.currentGeneration
    && input.documentHasFocus && input.activeElementIsBody
    && !input.removedRowStillVisible && input.fallbackExists
}

export async function applyExplorerKeyboardAction(
  controller: ExplorerKeyboardController,
  action: ExplorerKeyboardAction,
  rows: readonly ExplorerVisibleRow[],
  onOpen: (entry: FileEntry) => void,
): Promise<string | undefined> {
  if (action.kind === 'typeahead') return controller.typeahead(action.character)
  const intent = await controller.handleTreeKey(action.key)
  if (intent?.activatePath !== undefined) {
    const entry = rows.find(row => row.path === intent.activatePath)?.entry
    if (entry !== undefined && entry.type !== 'directory') onOpen(entry)
  }
  return intent?.focusPath
}

/** Click activation remains transport-free and is directly unit-testable. */
export async function applyExplorerRowClick(
  controller: ExplorerRowController,
  entry: FileEntry,
  onOpen: (entry: FileEntry) => void,
): Promise<void> {
  controller.setFocus(entry.path)
  controller.setSelected(entry.path)
  if (entry.type === 'directory') await controller.toggle(entry.path)
  else onOpen(entry)
}

/** Bind one visible context entry to an injected write-only clipboard port. */
export function explorerRelativePathClipboardAction(
  entry: FileEntry | undefined,
  writeClipboard: ((value: string) => Promise<void>) | undefined,
): (() => Promise<void>) | undefined {
  if (entry === undefined || writeClipboard === undefined) return undefined
  return async () => { await writeClipboard(entry.path) }
}

function disclosureIcon(entry: FileEntry, expanded: boolean): string {
  return entry.type === 'directory' ? expanded ? '\u25be' : '\u25b8' : ''
}

function statusText(
  workspace: WorkspaceSummary,
  session: ExplorerWorkspaceSession,
  locale: IdeLocale,
): { message?: string; error?: string; busy: boolean } {
  const visibleDirectories = [...session.directories]
    .filter(([path]) => path === '' || session.expanded.has(path))
  const loading = visibleDirectories.filter(([, state]) => state.status === 'loading')
  const failed = visibleDirectories.filter(([, state]) => state.status === 'error' && state.error !== undefined)
  const root = session.directories.get('')

  if (failed.length > 0) {
    const [path, state] = failed[0]!
    const label = path === '' ? workspace.title : path
    const more = failed.length > 1
      ? locale === 'zh' ? `（另有 ${failed.length - 1} 个文件夹加载失败）` : ` (${failed.length - 1} more folders failed)`
      : ''
    return { error: locale === 'zh' ? `无法加载 ${label}：${state.error}${more}` : `Could not load ${label}: ${state.error}${more}`, busy: loading.length > 0 }
  }
  if (loading.length > 0) {
    const [path] = loading[0]!
    return {
      message: path === '' ? locale === 'zh' ? '正在加载文件…' : 'Loading files…' : locale === 'zh' ? `正在加载 ${path}…` : `Loading ${path}…`,
      busy: true,
    }
  }
  if (root?.status === 'ready' && (root.entries?.length ?? 0) === 0) {
    return { message: locale === 'zh' ? '工作区为空' : 'Workspace is empty', busy: false }
  }
  return { busy: false }
}

function reportUnexpected(error: unknown, onError: ((error: unknown) => void) | undefined): void {
  onError?.(error)
}

export function FileExplorer({
  workspace,
  store,
  controller,
  onOpen,
  focusRequest,
  portalDismissRequest,
  onError,
  writeClipboard,
  onClipboardWriteResult,
  mutationStore,
  mutationController,
  mutationAdmissionEnabled = true,
  mutationCreateFileEnabled = true,
  mutationCreateDirectoryEnabled = true,
  mutationRenameEnabled = true,
  mutationDeleteEnabled = true,
  mutationRecoveryWritable = false,
  onModalChange,
}: FileExplorerProps) {
  const { locale, t } = useIdeI18n()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const subscribeMutation = useCallback(
    (listener: () => void) => mutationStore?.subscribe(listener) ?? (() => {}),
    [mutationStore],
  )
  const getMutationSnapshot = useCallback(
    () => mutationStore?.getSnapshot() ?? EMPTY_MUTATION_SNAPSHOT,
    [mutationStore],
  )
  const mutationSnapshot = useSyncExternalStore(
    subscribeMutation,
    getMutationSnapshot,
    getMutationSnapshot,
  )
  const workspaceId = workspace?.workspaceId
  const session = store.session(workspaceId)
  const isCurrentWorkspace = workspaceId !== undefined && snapshot.activeWorkspaceId === workspaceId
  const rows = useMemo(
    () => isCurrentWorkspace ? deriveVisibleExplorerRows(session) : [],
    [isCurrentWorkspace, session.directories, session.expanded],
  )
  const rovingPath = explorerRovingPath(rows, session.focusedPath, session.selectedPath)
  const [contextMenu, setContextMenu] = useState<ExplorerContextState>()
  const [dropTargetPath, setDropTargetPath] = useState<string>()
  const explorerDrag = useRef<ExplorerDragIdentity>()
  const rowElements = useRef(new Map<string, HTMLDivElement>())
  const treeElement = useRef<HTMLDivElement>(null)
  const emptyElement = useRef<HTMLDivElement>(null)
  const handledFocusRequest = useRef<number>()
  const keyboardFocusGeneration = useRef(0)
  const focusRecoveryGeneration = useRef(0)
  const focusRecoveryFrame = useRef<number>()
  const domFocusedPath = useRef<string>()
  const rovingPathRef = useRef(rovingPath)
  const deleteRestorePath = useRef<string>()
  const deleteWasOpen = useRef(false)
  const unresolvedRestorePath = useRef<string>()
  const unresolvedWasOpen = useRef(false)
  const mutationEnabled = mutationStore !== undefined && mutationController !== undefined
  const mutationIsCurrent = mutationSnapshot.phase === 'idle'
    || mutationSnapshot.workspaceId === workspaceId
  const namedMutation = mutationEnabled && mutationIsCurrent && isNamedMutationSnapshot(mutationSnapshot)
    ? mutationSnapshot
    : undefined
  const deleteMutation = mutationEnabled && mutationIsCurrent && isDeleteMutationSnapshot(mutationSnapshot)
    ? mutationSnapshot
    : undefined
  const unresolvedNamedOpen = namedMutation !== undefined && isManualMutationReconciliation(namedMutation)
  const inlineEditing = namedMutation !== undefined
  rovingPathRef.current = rovingPath

  useEffect(() => {
    explorerDrag.current = undefined
    setDropTargetPath(undefined)
  }, [snapshot.activeWorkspaceEpoch, workspaceId])

  useLayoutEffect(() => () => {
    focusRecoveryGeneration.current += 1
    if (focusRecoveryFrame.current !== undefined) window.cancelAnimationFrame(focusRecoveryFrame.current)
  }, [])

  useLayoutEffect(() => {
    // Removing a focused DOM node does not consistently dispatch `blur` in
    // every browser. Ref callbacks have settled before layout effects, so use
    // the last real focused row to recover synchronously when it disappeared.
    const lostPath = domFocusedPath.current
    if (lostPath === undefined || rowElements.current.has(lostPath)) return
    const fallback = rovingPath === undefined ? undefined : rowElements.current.get(rovingPath)
    if (document.hasFocus() && document.activeElement === document.body
      && fallback !== undefined && treeElement.current?.isConnected === true) {
      fallback.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      fallback.focus()
      return
    }
    domFocusedPath.current = undefined
  }, [rows, rovingPath])

  useEffect(() => {
    const selectedPath = session.selectedPath
    if (selectedPath === undefined) return
    rowElements.current.get(selectedPath)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [rows, session.selectedPath])

  useEffect(() => {
    const pending = session.pendingPresentation
    if (pending === undefined || pending.workspaceId !== workspaceId
      || pending.workspaceEpoch !== snapshot.activeWorkspaceEpoch) return
    const element = rowElements.current.get(pending.path)
    if (element === undefined) return
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (pending.focus) element.focus()
    controller.acknowledgePresentation(pending.requestId)
  }, [controller, rows, session.pendingPresentation, snapshot.activeWorkspaceEpoch, workspaceId])

  useEffect(() => {
    if (focusRequest === undefined || handledFocusRequest.current === focusRequest) return
    handledFocusRequest.current = focusRequest
    if (inlineEditing) return
    const path = explorerRovingPath(rows, session.focusedPath, session.selectedPath)
    if (path === undefined) {
      ;(treeElement.current ?? emptyElement.current)?.focus()
      return
    }
    controller.setFocus(path)
    const element = rowElements.current.get(path)
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    element?.focus()
  }, [controller, focusRequest, inlineEditing, rows, session.focusedPath, session.selectedPath])

  useEffect(() => {
    if (deleteWasOpen.current && deleteMutation === undefined) {
      const path = deleteRestorePath.current
      queueMicrotask(() => {
        const fallbackPath = path !== undefined && rowElements.current.has(path)
          ? path
          : rovingPathRef.current
        const fallback = fallbackPath === undefined ? undefined : rowElements.current.get(fallbackPath)
        fallback?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        fallback?.focus()
      })
    }
    deleteWasOpen.current = deleteMutation !== undefined
  }, [deleteMutation])

  useEffect(() => {
    if (!unresolvedWasOpen.current && unresolvedNamedOpen) {
      unresolvedRestorePath.current = session.focusedPath ?? session.selectedPath ?? rovingPathRef.current
    } else if (unresolvedWasOpen.current && !unresolvedNamedOpen) {
      const path = unresolvedRestorePath.current
      queueMicrotask(() => {
        const fallbackPath = path !== undefined && rowElements.current.has(path)
          ? path
          : rovingPathRef.current
        const fallback = fallbackPath === undefined ? undefined : rowElements.current.get(fallbackPath)
        if (fallback !== undefined) {
          fallback.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          fallback.focus()
        } else {
          ;(treeElement.current ?? emptyElement.current)?.focus()
        }
      })
    }
    unresolvedWasOpen.current = unresolvedNamedOpen
  }, [session.focusedPath, session.selectedPath, unresolvedNamedOpen])

  useLayoutEffect(() => {
    setContextMenu(current => current === undefined ? current : undefined)
  }, [portalDismissRequest, workspaceId])

  useLayoutEffect(() => {
    setContextMenu(current => current === undefined
      || current.focusedPathAtOpen === session.focusedPath
        && current.selectedPathAtOpen === session.selectedPath
      ? current
      : undefined)
  }, [session.focusedPath, session.selectedPath])

  if (workspace === undefined) {
    return (
      <div ref={emptyElement} className={css.empty} tabIndex={-1} data-workbench-focus="explorer">
        {t('noWorkspaceSelected')}
      </div>
    )
  }

  const status = statusText(workspace, session, locale)
  const focusRow = (path: string | undefined): void => {
    if (path === undefined) return
    const element = rowElements.current.get(path)
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    element?.focus()
  }

  const mutationReady = mutationEnabled && mutationAdmissionEnabled && mutationSnapshot.phase === 'idle'
  const createFileReady = mutationReady && mutationCreateFileEnabled
  const createDirectoryReady = mutationReady && mutationCreateDirectoryEnabled
  const renameReady = mutationReady && mutationRenameEnabled
  const deleteReady = mutationReady && mutationDeleteEnabled
  const activeAnchorPath = session.focusedPath ?? session.selectedPath ?? rovingPath

  const runMutationAction = (action: () => unknown): unknown => {
    try {
      return action()
    } catch (error) {
      reportUnexpected(error, onError)
      return undefined
    }
  }

  const beginCreate = (type: 'file' | 'directory', anchorPath = activeAnchorPath): void => {
    if (!(type === 'file' ? createFileReady : createDirectoryReady) || mutationController === undefined) return
    runMutationAction(() => mutationController.beginCreate(explorerCreateParentPath(rows, anchorPath), type))
  }

  const beginRename = (entry: FileEntry | undefined): void => {
    const source = explorerMutationSource(entry)
    if (!renameReady || mutationController === undefined || source === undefined) return
    controller.setFocus(source.path)
    controller.setSelected(source.path)
    runMutationAction(() => mutationController.beginRename(source))
  }

  const finishExplorerDrag = (): void => {
    explorerDrag.current = undefined
    setDropTargetPath(undefined)
  }

  const submitMove = (identity: ExplorerDragIdentity, target: FileEntry): void => {
    if (!renameReady || mutationController?.beginMove === undefined
      || !explorerDragIdentityIsCurrent(identity, workspaceId, snapshot.activeWorkspaceEpoch, rows)) return
    const destinationParentPath = explorerMoveDestinationParent(identity.source, target)
    if (destinationParentPath === undefined) return
    const started = runMutationAction(() => mutationController.beginMove?.(
      identity.source,
      destinationParentPath,
    ))
    if (started !== true) return
    const confirmed = runMutationAction(() => mutationController.requestConfirmation())
    if (confirmed !== true) {
      runMutationAction(() => mutationController.cancel())
      return
    }
    try {
      void mutationController.submit().catch(error => { reportUnexpected(error, onError) })
    } catch (error) {
      reportUnexpected(error, onError)
    }
  }

  const beginDelete = (entry: FileEntry | undefined): void => {
    const source = explorerMutationSource(entry)
    if (!deleteReady || mutationController === undefined || source === undefined) return
    controller.setFocus(source.path)
    controller.setSelected(source.path)
    deleteRestorePath.current = source.path
    // The controller owns the exact-once impact inspection + confirmation transition.
    runMutationAction(() => beginExplorerDeleteMutation(mutationController, source))
  }

  const openContextMenu = (anchorPath: string | undefined, x: number, y: number): void => {
    const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
    const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight
    const currentSession = store.session(workspaceId)
    setContextMenu({
      ...(anchorPath === undefined ? {} : { anchorPath }),
      position: clampExplorerMenuPosition(x, y, viewportWidth, viewportHeight),
      focusedPathAtOpen: currentSession.focusedPath,
      selectedPathAtOpen: currentSession.selectedPath,
    })
  }

  const closeContextMenu = (restoreFocus: boolean): void => {
    const restorePath = contextMenu?.anchorPath ?? rovingPath
    setContextMenu(undefined)
    if (restoreFocus) queueMicrotask(() => { focusRow(restorePath) })
  }

  const submitNamedMutation = (): void => {
    if (mutationController === undefined) return
    const confirmation = runMutationAction(() => mutationController.requestConfirmation())
    if (confirmation === false) return
    try {
      void mutationController.submit().catch(error => { reportUnexpected(error, onError) })
    } catch (error) {
      reportUnexpected(error, onError)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const editableTarget = isExplorerEditableTarget(event.target)
    // Inline inputs own arrows, Home/End, Space, and selection. Their handled
    // Enter/Escape/F2 events stop propagation in the editor component.
    if (editableTarget) return
    const shortcut = explorerMutationShortcut({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      editableTarget,
    })
    if (shortcut === 'context-menu') {
      event.preventDefault()
      event.stopPropagation()
      const anchorPath = session.focusedPath ?? rovingPath
      const anchor = anchorPath === undefined ? treeElement.current : rowElements.current.get(anchorPath)
      const bounds = anchor?.getBoundingClientRect()
      openContextMenu(anchorPath, bounds?.left ?? 8, bounds?.bottom ?? 8)
      return
    }
    if (shortcut === 'rename' || shortcut === 'delete') {
      setContextMenu(undefined)
      const row = rows.find(candidate => candidate.path === (session.focusedPath ?? rovingPath))
      const shortcutReady = shortcut === 'rename' ? renameReady : deleteReady
      if (explorerMutationSource(row?.entry) !== undefined && shortcutReady) {
        event.preventDefault()
        event.stopPropagation()
        if (shortcut === 'rename') beginRename(row?.entry)
        else beginDelete(row?.entry)
      }
      return
    }
    const action = explorerKeyboardAction(event)
    if (action === undefined) return
    setContextMenu(undefined)
    event.preventDefault()
    const tree = treeElement.current
    const generation = ++keyboardFocusGeneration.current
    void applyExplorerKeyboardAction(controller, action, rows, onOpen)
      .then(path => {
        const focusWithinTree = tree !== null && tree.contains(document.activeElement)
        if (!explorerOwnsDeferredFocus(generation, keyboardFocusGeneration.current, focusWithinTree)) return
        focusRow(path)
      })
      .catch(error => { reportUnexpected(error, onError) })
  }

  const contextRow = contextMenu?.anchorPath === undefined
    ? undefined
    : rows.find(row => row.path === contextMenu.anchorPath)
  const copyRelativePath = explorerRelativePathClipboardAction(contextRow?.entry, writeClipboard)
  const mutableContextSource = explorerMutationSource(contextRow?.entry)
  const contextItems: readonly ExplorerContextMenuItem[] = [
    {
      id: 'new-file',
      label: t('newFile'),
      disabled: !createFileReady,
      onSelect: () => { beginCreate('file', contextMenu?.anchorPath) },
    },
    {
      id: 'new-folder',
      label: t('newFolder'),
      disabled: !createDirectoryReady,
      onSelect: () => { beginCreate('directory', contextMenu?.anchorPath) },
    },
    {
      id: 'copy-relative-path',
      label: t('copyRelativePath'),
      separatorBefore: true,
      disabled: copyRelativePath === undefined,
      onSelect: () => {
        if (copyRelativePath === undefined) return
        void copyRelativePath().then(
          () => { onClipboardWriteResult?.({ status: 'copied' }) },
          error => {
            if (onClipboardWriteResult !== undefined) onClipboardWriteResult({ status: 'failed', error })
            else reportUnexpected(error, onError)
          },
        )
      },
    },
    {
      id: 'rename',
      label: t('rename'),
      shortcut: 'F2',
      separatorBefore: true,
      disabled: !renameReady || mutableContextSource === undefined,
      onSelect: () => { beginRename(contextRow?.entry) },
    },
    {
      id: 'delete',
      label: t('deletePermanently'),
      shortcut: 'Delete',
      disabled: !deleteReady || mutableContextSource === undefined,
      onSelect: () => { beginDelete(contextRow?.entry) },
    },
  ]

  const inlineError = namedMutation === undefined
    ? undefined
    : mutationSnapshotError(namedMutation) ?? mutationSnapshotImpact(namedMutation)?.blockers[0]?.message
  const inlineFocusRequest = namedMutation !== undefined && 'focusRequest' in namedMutation
    ? namedMutation.focusRequest
    : undefined
  const inlineEditor = namedMutation === undefined || mutationStore === undefined || mutationController === undefined
    ? undefined
    : (
      <ExplorerInlineMutationEditor
        draft={namedMutation.draft}
        phase={namedMutation.phase}
        errorMessage={inlineError}
        focusRequest={inlineFocusRequest}
        onAcknowledgeFocus={requestId => { mutationStore.acknowledgeFocus(requestId) }}
        onUpdateName={name => { runMutationAction(() => mutationController.updateName(name)) }}
        onSubmit={submitNamedMutation}
        onCancel={() => { runMutationAction(() => mutationController.cancel()) }}
      />
    )
  const createDraft = namedMutation?.draft.kind === 'create' ? namedMutation.draft : undefined
  const renameDraft = namedMutation?.draft.kind === 'rename' ? namedMutation.draft : undefined
  const createParentRow = createDraft === undefined
    ? undefined
    : rows.find(row => row.path === createDraft.parentPath)
  const createDraftAtTop = createDraft !== undefined
    && (createDraft.parentPath === '' || createParentRow === undefined)
  const renameRowVisible = renameDraft === undefined
    || rows.some(row => row.path === renameDraft.source.path)

  const draftRow = (depth: number, key: string) => (
    <div
      key={key}
      role="treeitem"
      aria-selected="true"
      aria-level={depth + 1}
      tabIndex={-1}
      className={`${css.fileRow} ${css.fileRowSelected} ${css.explorerDraftRow}`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <span className={css.fileChevron} aria-hidden="true">
        {createDraft?.resourceKind === 'directory' ? '\u25b8' : ''}
      </span>
      <ExplorerFileIcon name={createDraft?.name ?? ''} type={createDraft?.resourceKind ?? 'file'} />
      {inlineEditor}
    </div>
  )

  return (
    <div className={css.fileExplorer}>
      <div className={css.explorerToolbar} title={workspace.path}>
        <span className={css.explorerToolbarTitle}>{workspace.title}</span>
        <span className={css.explorerToolbarActions}>
          <button
            type="button"
            disabled={!createFileReady}
            onClick={() => { beginCreate('file') }}
            aria-label={t('newFile')}
            title={t('newFile')}
          ><IdeIcon name="new-file" /></button>
          <button
            type="button"
            disabled={!createDirectoryReady}
            onClick={() => { beginCreate('directory') }}
            aria-label={t('newFolder')}
            title={t('newFolder')}
          ><IdeIcon name="new-folder" /></button>
          <button
            type="button"
            disabled={!isCurrentWorkspace || ![...session.expanded].some(path => path !== '')}
            onClick={() => {
              setContextMenu(undefined)
              if (workspaceId !== undefined) store.collapseAll(workspaceId)
            }}
            aria-label={t('collapseFolders')}
            title={t('collapseFolders')}
          ><IdeIcon name="collapse-all" /></button>
          <button
            type="button"
            onClick={() => {
              void controller.refreshExpanded().catch(error => { reportUnexpected(error, onError) })
            }}
            aria-label={t('refreshExplorer')}
            title={t('refreshExplorer')}
          ><IdeIcon name="refresh" /></button>
        </span>
      </div>
      {status.error !== undefined && (
        <div className={css.fileTreeError} role="alert">{status.error}</div>
      )}
      {status.error === undefined && status.message !== undefined && (
        <div className={css.fileTreeStatus} role="status">{status.message}</div>
      )}
      {mutationSnapshot.phase === 'idle' && mutationSnapshot.error !== undefined && (
        <div className={css.fileTreeError} role="alert">{mutationSnapshot.error.message}</div>
      )}
      {namedMutation?.phase === 'unknown' && !isManualMutationReconciliation(namedMutation) && (
        <div className={css.explorerMutationNotice} role="alert">
          <span>{mutationSnapshotError(namedMutation) ?? 'The operation outcome is unknown.'}</span>
          <button
            type="button"
            onClick={() => {
              try {
                void mutationController?.reconcileUnknown().catch(error => { reportUnexpected(error, onError) })
              } catch (error) { reportUnexpected(error, onError) }
            }}
          >Check Status</button>
        </div>
      )}
      {namedMutation?.phase === 'reconciling' && (
        <div className={css.fileTreeStatus} role="status">Checking mutation status…</div>
      )}
      {namedMutation?.phase === 'applying' && (
        <div className={mutationSnapshotError(namedMutation) === undefined ? css.fileTreeStatus : css.fileTreeError}
          role={mutationSnapshotError(namedMutation) === undefined ? 'status' : 'alert'}>
          <span>{mutationSnapshotError(namedMutation) ?? 'Finishing the committed file operation in the workbench…'}</span>
          {mutationSnapshotError(namedMutation) !== undefined && (
            <button
              type="button"
              onClick={() => {
                try {
                  void mutationController?.retryCommitted().catch(error => { reportUnexpected(error, onError) })
                } catch (error) { reportUnexpected(error, onError) }
              }}
            >Retry Workbench Recovery</button>
          )}
        </div>
      )}
      <ExplorerMutationLiveStatus>
        {namedMutation?.phase === 'submitting'
          ? locale === 'zh' ? '正在应用文件操作…' : 'Applying file operation…'
          : dropTargetPath === undefined ? undefined : locale === 'zh' ? '释放以移动到文件夹。' : 'Release to move into folder.'}
      </ExplorerMutationLiveStatus>
      <div
        ref={treeElement}
        className={css.fileRows}
        role="tree"
        aria-label={t('filesIn', { name: workspace.title })}
        aria-busy={status.busy}
        aria-multiselectable="false"
        tabIndex={!inlineEditing && rows.length === 0 ? 0 : -1}
        data-workbench-focus={!inlineEditing && rows.length === 0 ? 'explorer' : undefined}
        onKeyDown={handleKeyDown}
        onDragOverCapture={(event: ReactDragEvent<HTMLDivElement>) => {
          const externalFiles = explorerDrag.current === undefined
            && Array.from(event.dataTransfer.types).includes('Files')
          if (explorerDrag.current === undefined && !externalFiles) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'none'
        }}
        onDropCapture={(event: ReactDragEvent<HTMLDivElement>) => {
          if (explorerDrag.current !== undefined
            || !Array.from(event.dataTransfer.types).includes('Files')) return
          // This tree has no upload surface. Also prevent the browser from navigating to a local file.
          event.preventDefault()
          event.stopPropagation()
          setDropTargetPath(undefined)
        }}
        onContextMenu={event => {
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          openContextMenu(undefined, event.clientX, event.clientY)
        }}
        onFocusCapture={() => {
          // A pointer or programmatic focus move to another row supersedes any
          // slower directory action that began from the previously focused row.
          keyboardFocusGeneration.current += 1
          focusRecoveryGeneration.current += 1
        }}
        onBlur={event => {
          const next = event.relatedTarget
          if (next instanceof Node && event.currentTarget.contains(next)) return
          keyboardFocusGeneration.current += 1
          const lostPath = domFocusedPath.current
          const canBeRemoval = next === null || next === document.body
          if (lostPath === undefined || !canBeRemoval) {
            domFocusedPath.current = undefined
            focusRecoveryGeneration.current += 1
            return
          }

          const expectedGeneration = ++focusRecoveryGeneration.current
          const tree = event.currentTarget
          if (focusRecoveryFrame.current !== undefined) window.cancelAnimationFrame(focusRecoveryFrame.current)
          focusRecoveryFrame.current = window.requestAnimationFrame(() => {
            focusRecoveryFrame.current = undefined
            const fallbackPath = rovingPathRef.current
            const fallback = fallbackPath === undefined ? undefined : rowElements.current.get(fallbackPath)
            const shouldRecover = explorerOwnsRemovedFocusRecovery({
              expectedGeneration,
              currentGeneration: focusRecoveryGeneration.current,
              documentHasFocus: document.hasFocus(),
              activeElementIsBody: document.activeElement === document.body,
              removedRowStillVisible: rowElements.current.has(lostPath),
              fallbackExists: fallback !== undefined && tree.isConnected,
            })
            if (!shouldRecover || fallback === undefined) {
              if (domFocusedPath.current === lostPath) domFocusedPath.current = undefined
              return
            }
            fallback.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            fallback.focus()
          })
        }}
      >
        {createDraftAtTop && draftRow(createParentRow === undefined ? 0 : createParentRow.depth + 1, 'create-draft')}
        {!renameRowVisible && draftRow(0, 'rename-draft-fallback')}
        {rows.map(row => {
          const renamingThisRow = renameDraft?.source.path === row.path
          const rowSource = explorerMutationSource(row.entry)
          const rowDraggable = !inlineEditing && renameReady
            && mutationController?.beginMove !== undefined && rowSource !== undefined
          const rowIsDropTarget = dropTargetPath === row.path
          return (
          <Fragment key={row.path}>
          <div
            ref={element => {
              if (element === null) rowElements.current.delete(row.path)
              else rowElements.current.set(row.path, element)
            }}
            role="treeitem"
            aria-selected={row.path === session.selectedPath}
            aria-expanded={row.entry.type === 'directory' ? row.expanded : undefined}
            aria-level={row.depth + 1}
            aria-posinset={row.indexInParent}
            aria-setsize={row.setSize}
            aria-label={rowIsDropTarget
              ? locale === 'zh' ? `${row.entry.name}，释放以移动到此文件夹` : `${row.entry.name}, release to move here`
              : undefined}
            tabIndex={!inlineEditing && row.path === rovingPath ? 0 : -1}
            data-workbench-focus={!inlineEditing && row.path === rovingPath ? 'explorer' : undefined}
            data-explorer-path={row.path}
            data-explorer-drop-target={rowIsDropTarget ? 'true' : undefined}
            draggable={rowDraggable}
            className={`${css.fileRow} ${row.path === session.selectedPath ? css.fileRowSelected : ''}`}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            onFocus={() => {
              domFocusedPath.current = row.path
              controller.setFocus(row.path)
            }}
            onClick={event => {
              if (renamingThisRow || isExplorerEditableTarget(event.target)) return
              // Clicking an already focused row does not emit another focus
              // event, but it still represents a newer user intent.
              keyboardFocusGeneration.current += 1
              event.currentTarget.focus()
              void applyExplorerRowClick(controller, row.entry, onOpen)
                .catch(error => { reportUnexpected(error, onError) })
            }}
            onDragStart={event => {
              if (!rowDraggable || rowSource === undefined || workspaceId === undefined) {
                event.preventDefault()
                return
              }
              setContextMenu(undefined)
              const identity: ExplorerDragIdentity = {
                workspaceId,
                workspaceEpoch: snapshot.activeWorkspaceEpoch,
                source: rowSource,
              }
              explorerDrag.current = identity
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-dsh-code-ide-explorer-entry', row.path)
            }}
            onDragOver={event => {
              const identity = explorerDrag.current
              const valid = identity !== undefined
                && explorerDragIdentityIsCurrent(identity, workspaceId, snapshot.activeWorkspaceEpoch, rows)
                && explorerMoveDestinationParent(identity.source, row.entry) !== undefined
              if (!valid) return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              setDropTargetPath(row.path)
            }}
            onDragLeave={event => {
              const next = event.relatedTarget
              if (next instanceof Node && event.currentTarget.contains(next)) return
              setDropTargetPath(current => current === row.path ? undefined : current)
            }}
            onDrop={event => {
              const identity = explorerDrag.current
              if (identity === undefined) return
              event.preventDefault()
              event.stopPropagation()
              finishExplorerDrag()
              submitMove(identity, row.entry)
            }}
            onDragEnd={() => { finishExplorerDrag() }}
            onContextMenu={event => {
              if (isExplorerEditableTarget(event.target)) return
              event.preventDefault()
              event.stopPropagation()
              keyboardFocusGeneration.current += 1
              controller.setFocus(row.path)
              controller.setSelected(row.path)
              event.currentTarget.focus()
              openContextMenu(row.path, event.clientX, event.clientY)
            }}
            title={row.path}
          >
            <span className={css.fileChevron} aria-hidden="true">
              {disclosureIcon(row.entry, row.expanded)}
            </span>
            <ExplorerFileIcon name={row.entry.name} type={row.entry.type} expanded={row.expanded} />
            {renamingThisRow ? inlineEditor : <span className={css.fileName}>{row.entry.name}</span>}
          </div>
          {createDraft?.parentPath === row.path && draftRow(row.depth + 1, `create-draft:${row.path}`)}
          </Fragment>
          )
        })}
      </div>
      {contextMenu !== undefined && (
        <ExplorerContextMenu
          label={contextRow === undefined ? t('explorerActions') : t('actionsFor', { name: contextRow.entry.name })}
          position={contextMenu.position}
          items={contextItems}
          onClose={closeContextMenu}
        />
      )}
      {deleteMutation !== undefined && mutationStore !== undefined && mutationController !== undefined && (
        <ExplorerDeleteDialog
          snapshot={deleteMutation}
          store={mutationStore}
          controller={mutationController}
          onModalChange={onModalChange}
          onUnexpectedError={onError}
          canAcknowledge={mutationRecoveryWritable}
        />
      )}
      {namedMutation !== undefined && mutationController !== undefined && (
        <ExplorerUnresolvedMutationDialog
          snapshot={namedMutation}
          controller={mutationController}
          onUnexpectedError={onError}
          canAcknowledge={mutationRecoveryWritable}
        />
      )}
    </div>
  )
}
