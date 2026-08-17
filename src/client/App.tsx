import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useLayoutEffect,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { KnownObservationTarget } from '../shared/workspace-observation.ts'
import type { MutationProviderResponse } from '../shared/workspace-mutations.ts'
import { mediaPreviewDescriptor } from '../shared/media-preview.ts'
import { fileApi, mutationApi } from './api.ts'
import { CodeEditor, type EditorHistoryPort } from './CodeEditor.tsx'
import { DocumentConflictDialog } from './DocumentConflictDialog.tsx'
import { EditorCloseDialog } from './EditorCloseDialog.tsx'
import {
  EDITOR_TAB_DRAG_MIME,
  EditorTabs,
  editorTabDomId,
  resolveEditorTabDrag,
  type EditorTabDragSession,
  type EditorTabFocusRequest,
} from './EditorTabs.tsx'
import { EditorLineEndingStatus } from './EditorLineEndingStatus.tsx'
import type { FileEntry, WorkspaceSummary } from './contracts.ts'
import { DocumentController, type RevertResult, type SaveResult } from './documents/controller.ts'
import {
  DocumentConflictController,
  DocumentConflictStore,
  type DocumentConflictResolveResult,
} from './documents/conflict.ts'
import {
  DocumentSessionStore,
  type DocumentIdentity,
} from './documents/session.ts'
import type { DocumentLineEnding } from './documents/text-content.ts'
import { useDocumentSessions } from './documents/useDocumentSessions.ts'
import {
  EditorCloseController,
  EditorCloseStore,
  type EditorCloseContext,
  type EditorCloseOrigin,
  type EditorCloseOutcome,
} from './editor/close.ts'
import {
  EditorCloseBatchCoordinator,
  type EditorCloseBatchResult,
  type EditorCloseBatchWorkspace,
} from './editor/close-batch.ts'
import { ClosedEditorHistoryStore } from './editor/closed-history.ts'
import { EditorSessionRegistry } from './editor/session-registry.ts'
import {
  EditorGroupsStore,
  type EditorGroupLayout,
} from './editor/groups.ts'
import {
  EDITOR_LANGUAGE_OPTIONS,
  type EditorLanguageId,
} from './language.ts'
import {
  FileExplorer,
  beginExplorerDeleteMutation,
  explorerCreateParentPath,
  explorerMutationSource,
} from './FileExplorer.tsx'
import { InvalidMutationRecoveryDialog } from './ExplorerMutationUi.tsx'
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog.tsx'
import { WorkbenchRecoveryDialog } from './WorkbenchRecoveryDialog.tsx'
import { ExplorerController } from './explorer/controller.ts'
import { deriveVisibleExplorerRows } from './explorer/model.ts'
import { ExplorerStore } from './explorer/store.ts'
import {
  MUTATION_MANUAL_RECONCILIATION_REQUIRED,
  WorkspaceMutationController,
} from './mutations/controller.ts'
import {
  createDurableMutationRecoveryPort,
  MutationRecoveryPersistence,
  rebindMutationRecoveryRecord,
  type MutationRecoveryLoadResult,
} from './mutations/recovery.ts'
import { WorkspaceMutationStore } from './mutations/store.ts'
import {
  EditorNavigationController,
  parseEditorLocation,
  type EditorLocation,
} from './navigation/editor-navigation.ts'
import { reconcileDirectories } from './observation/reconciler.ts'
import type { WorkspaceInvalidation } from './observation/source.ts'
import { useWorkspaceCoherence } from './observation/useWorkspaceCoherence.ts'
import {
  hydratePersistedWorkspace,
  SessionPersistence,
  type PersistenceStatus,
  type PersistedWorkspaceV1,
} from './session/persistence.ts'
import {
  TerminalPane,
  type TerminalCommandPort,
  type TerminalCommandTarget,
  type TerminalFocusRequest,
} from './TerminalPane.tsx'
import { QuickInputDialog, type QuickInputOption, type QuickOpenOption } from './QuickOpenDialog.tsx'
import { ReadOnlyFileView } from './ReadOnlyFileView.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { MediaPreview } from './MediaPreview.tsx'
import { mediaPreviewUrl } from './media-preview-url.ts'
import { PreviewModeRegistry } from './preview/mode-registry.ts'
import { SearchView, type WorkspaceSearchFileGroup, type WorkspaceSearchMatchView } from './SearchView.tsx'
import { parseQuickOpenQuery, QuickOpenController, QuickOpenStore } from './search/quick-open.ts'
import {
  WorkspaceSearchController,
  WorkspaceSearchStore,
  type WorkspaceSearchItem,
} from './search/workspace-search.ts'
import { WorkspaceReplaceController, WorkspaceReplaceStore } from './search/workspace-replace.ts'
import { validateSearchGlobs, type WorkspaceTextSearchQuery } from '../shared/workspace-search.ts'
import { dispatchTerminalPaletteShortcut, dispatchWorkbenchShortcut } from './commands/dispatcher.ts'
import { WorkbenchCommandRuntime } from './commands/runtime.ts'
import { formatKeybinding } from './commands/shortcuts.ts'
import type { KeybindingPlatform, ShortcutDecision } from './commands/keybindings.ts'
import type { CommandExecutionOutcome } from './commands/types.ts'
import type { QuickInputMode, WorkbenchCommandContext } from './commands/workbench.ts'
import { coordinateWorkbenchWorkspaceSelection } from './workspace-selection.ts'
import {
  hiddenCompactFocusTarget,
  isComposedFocusTarget,
  prepareEditorFocusCommand,
  quickInputRestoreDisposition,
  type QuickInputRestoreTarget,
} from './compact-focus.ts'
import {
  EXPLORER_MAX,
  EXPLORER_MIN,
  HARNESS_MAX,
  HARNESS_MIN,
  TERMINAL_MIN,
  readLayoutGeometry,
  writeLayoutGeometry,
  type LayoutGeometry,
} from './layout/geometry.ts'
import css from './ide.module.css'
import { useIdeI18n } from './i18n.tsx'
import type { IdeColorScheme } from './theme.ts'

type MutationCapabilities = Readonly<MutationProviderResponse['capabilities']>

function unsupportedMutationNotice(capabilities: MutationCapabilities | undefined): string | undefined {
  if (capabilities === undefined) return undefined
  const unsupported = [
    capabilities.createFile ? undefined : 'file creation',
    capabilities.createDirectory ? undefined : 'folder creation',
    capabilities.rename ? undefined : 'rename',
    capabilities.delete ? undefined : 'delete',
  ].filter((operation): operation is string => operation !== undefined)
  return unsupported.length === 0 ? undefined : `Unsupported by this Host: ${unsupported.join(', ')}.`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sameTerminalCommandTarget(
  left: TerminalCommandTarget | undefined,
  right: TerminalCommandTarget | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && left.workspaceId === right.workspaceId
    && left.workspaceEpoch === right.workspaceEpoch
    && left.id === right.id
    && left.lifecycleId === right.lifecycleId
}

function fitSidePanes(explorer: number, harness: number, available: number): readonly [number, number] {
  const nextExplorer = clamp(explorer, EXPLORER_MIN, EXPLORER_MAX)
  const nextHarness = clamp(harness, HARNESS_MIN, HARNESS_MAX)
  const sideBudget = Math.floor(available) - 10 - 320
  if (sideBudget < EXPLORER_MIN + HARNESS_MIN) return [EXPLORER_MIN, HARNESS_MIN]
  if (nextExplorer + nextHarness <= sideBudget) return [nextExplorer, nextHarness]
  const fittedHarness = clamp(sideBudget - nextExplorer, HARNESS_MIN, HARNESS_MAX)
  const fittedExplorer = clamp(sideBudget - fittedHarness, EXPLORER_MIN, EXPLORER_MAX)
  return [fittedExplorer, fittedHarness]
}

function fitExplorerPane(explorer: number, available: number): number {
  const maximum = Math.max(
    EXPLORER_MIN,
    Math.min(EXPLORER_MAX, Math.floor(available) - 5 - 320),
  )
  return clamp(explorer, EXPLORER_MIN, maximum)
}

export interface AppLaunchOptions {
  readonly embedded: boolean
  readonly requestedWorkspaceId?: string
}

export function readAppLaunchOptions(search: string): AppLaunchOptions {
  const query = new URLSearchParams(search)
  const requestedWorkspaceId = query.get('workspaceId')?.trim()
  return {
    embedded: query.get('embedded') === '1',
    ...(requestedWorkspaceId === undefined || requestedWorkspaceId.length === 0
      ? {}
      : { requestedWorkspaceId }),
  }
}

export interface InitialWorkspaceCandidates {
  readonly registeredWorkspaceIds: ReadonlySet<string>
  readonly mutationRecoveryWorkspace?: string
  readonly requestedWorkspaceId?: string
  readonly persistedActiveWorkspace?: string
  readonly currentWorkspaceId?: string
  readonly firstWorkspaceId?: string
}

export function selectInitialWorkspace(candidates: InitialWorkspaceCandidates): string | undefined {
  const registered = (workspaceId: string | undefined): string | undefined => (
    workspaceId !== undefined && candidates.registeredWorkspaceIds.has(workspaceId)
      ? workspaceId
      : undefined
  )
  // An interrupted mutation remains the strongest safety fence. Once that is
  // satisfied, an explicit request is authoritative: an unavailable request
  // must not silently drift to a different persisted or ambient workspace.
  const recoveryWorkspace = registered(candidates.mutationRecoveryWorkspace)
  if (recoveryWorkspace !== undefined) return recoveryWorkspace
  if (candidates.requestedWorkspaceId !== undefined) {
    return registered(candidates.requestedWorkspaceId)
  }
  return registered(candidates.persistedActiveWorkspace)
    ?? registered(candidates.currentWorkspaceId)
    ?? registered(candidates.firstWorkspaceId)
}

function basename(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? path
}

function trapModalFocus(event: ReactKeyboardEvent<HTMLElement>, onDismiss: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    onDismiss()
    return
  }
  if (event.key !== 'Tab') return
  const candidates = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.hidden && element.getClientRects().length > 0)
  if (candidates.length === 0) return
  const first = candidates[0]
  const last = candidates.at(-1)
  if (first === undefined || last === undefined) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

type WorkbenchQuickInputOption = QuickInputOption & (
  | { readonly kind: 'file'; readonly file: QuickOpenOption }
  | { readonly kind: 'command'; readonly commandId: string }
  | { readonly kind: 'line'; readonly location: EditorLocation }
  | { readonly kind: 'eol'; readonly lineEnding: DocumentLineEnding }
  | { readonly kind: 'language'; readonly languageId: EditorLanguageId }
  | { readonly kind: 'indentation'; readonly size: number }
)

const SHORTCUT_PLATFORM: KeybindingPlatform = /Mac|iPhone|iPad/u.test(navigator.platform)
  ? 'mac'
  : /Win/u.test(navigator.platform)
    ? 'windows'
    : 'linux'

const ZH_COMMAND_CATEGORIES: Readonly<Record<string, string>> = {
  View: '视图', Preferences: '首选项', File: '文件', Search: '搜索',
  Explorer: '资源管理器', Go: '转到', Edit: '编辑', Terminal: '终端',
}
const ZH_COMMAND_TITLES: Readonly<Record<string, string>> = {
  'workbench.action.showCommands': '显示所有命令',
  'workbench.action.openGlobalKeybindings': '打开键盘快捷方式',
  'workbench.action.quickOpen': '快速打开',
  'workbench.action.files.save': '保存', 'workbench.action.files.saveAll': '全部保存',
  'workbench.action.files.revert': '还原文件',
  'workbench.action.files.checkSaveOutcome': '检查保存结果',
  'workbench.action.files.recreateDeleted': '重建已删除文件',
  'workbench.view.explorer': '显示资源管理器', 'workbench.view.search': '显示搜索',
  'search.action.focusNextSearchResult': '聚焦下一个搜索结果',
  'search.action.focusPreviousSearchResult': '聚焦上一个搜索结果',
  'workbench.action.explorer.refresh': '刷新资源管理器',
  'explorer.newFile': '新建文件', 'explorer.newFolder': '新建文件夹',
  renameFile: '重命名文件', deleteFile: '删除文件',
  'workbench.files.action.showActiveFileInExplorer': '在资源管理器中显示当前文件',
  copyRelativeFilePath: '复制当前文件的相对路径',
  'workbench.action.nextEditorInGroup': '打开下一个编辑器',
  'workbench.action.previousEditorInGroup': '打开上一个编辑器',
  'workbench.action.navigateBack': '后退', 'workbench.action.navigateForward': '前进',
  'workbench.action.gotoLine': '转到行/列…', undo: '撤销', redo: '重做',
  'editor.action.commentLine': '切换行注释',
  'editor.action.trimTrailingWhitespace': '删除行尾空格',
  'editor.action.indentationToSpaces': '将缩进转换为空格',
  'editor.action.indentationToTabs': '将缩进转换为制表符',
  'editor.action.changeIndentationSize': '更改缩进大小…',
  'workbench.action.editor.changeEOL': '更改行尾序列…',
  'workbench.action.editor.changeLanguageMode': '更改语言模式…',
  'editor.action.toggleWordWrap': '切换自动换行',
  'workbench.action.closeActiveEditor': '关闭编辑器',
  'workbench.action.closeAllEditors': '关闭所有编辑器',
  'workbench.action.reopenClosedEditor': '重新打开已关闭的编辑器',
  'workbench.action.focusActiveEditorGroup': '聚焦当前编辑器',
  'workbench.action.terminal.new': '新建终端',
  'workbench.action.terminal.focusNext': '聚焦下一个终端',
  'workbench.action.terminal.focusPrevious': '聚焦上一个终端',
  'workbench.action.terminal.clear': '清空终端',
  'workbench.action.terminal.toggle': '切换终端面板',
  'workbench.action.harness.focus': '聚焦 DeepSeek Harness',
}

interface QuickInputPresentation {
  readonly title: string
  readonly inputLabel: string
  readonly placeholder: string
  readonly listLabel: string
}
interface EditorHistoryBinding {
  readonly token: object
  readonly port: EditorHistoryPort
  readonly unsubscribe: () => void
}


function quickInputPresentation(locale: 'en' | 'zh', mode: QuickInputMode): QuickInputPresentation {
  const effectiveMode = mode === 'none' ? 'files' : mode
  const copy = locale === 'zh' ? {
    commands: { title: '命令面板', inputLabel: '搜索命令', placeholder: '输入命令', listLabel: '可用命令' },
    line: { title: '转到行/列', inputLabel: '行号和可选列号', placeholder: '输入行号，可用 :列号', listLabel: '编辑器位置' },
    eol: { title: '更改行尾序列', inputLabel: '筛选行尾序列', placeholder: '选择 LF 或 CRLF', listLabel: '行尾序列' },
    language: { title: '更改语言模式', inputLabel: '筛选语言模式', placeholder: '选择语言模式', listLabel: '语言模式' },
    indentation: { title: '更改缩进大小', inputLabel: '筛选缩进大小', placeholder: '选择 1 到 8', listLabel: '缩进大小' },
    files: { title: '快速打开', inputLabel: '按名称搜索文件', placeholder: '输入文件名', listLabel: '匹配的文件' },
  } : {
    commands: { title: 'Command Palette', inputLabel: 'Search commands', placeholder: 'Type a command', listLabel: 'Available commands' },
    line: { title: 'Go to Line/Column', inputLabel: 'Line and optional column', placeholder: 'Type a line, optionally followed by :column', listLabel: 'Editor location' },
    eol: { title: 'Change End of Line Sequence', inputLabel: 'Filter end of line choices', placeholder: 'Choose LF or CRLF', listLabel: 'End of line sequences' },
    language: { title: 'Change Language Mode', inputLabel: 'Filter language modes', placeholder: 'Choose a language mode', listLabel: 'Language modes' },
    indentation: { title: 'Change Indentation Size', inputLabel: 'Filter indentation sizes', placeholder: 'Choose a size from 1 to 8', listLabel: 'Indentation sizes' },
    files: { title: 'Quick Open', inputLabel: 'Search files by name', placeholder: 'Search files by name', listLabel: 'Matching files' },
  }
  switch (effectiveMode) {
    case 'commands': return copy.commands
    case 'line': return copy.line
    case 'eol': return copy.eol
    case 'language': return copy.language
    case 'indentation': return copy.indentation
    default: return copy.files
  }
}

function supportsMarkdownPreview(path: string): boolean {
  const lower = path.toLocaleLowerCase('en-US')
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')
}

export function App() {
  const { locale, t } = useIdeI18n()
  const [launchOptions] = useState(() => readAppLaunchOptions(window.location.search))
  const embeddedMode = launchOptions.embedded
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [maxTerminalSessions, setMaxTerminalSessions] = useState<number>()
  const [workspaceError, setWorkspaceError] = useState<string>()
  const [openError, setOpenError] = useState<string>()
  const [coherenceError, setCoherenceError] = useState<string>()
  const [recoveryError, setRecoveryError] = useState<string>()
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>({ kind: 'idle' })
  const persistenceStatusSink = useRef(setPersistenceStatus)
  persistenceStatusSink.current = setPersistenceStatus
  const [documents] = useState(() => new DocumentSessionStore())
  const [documentController] = useState(() => new DocumentController(documents, fileApi))
  const [editorSessions] = useState(() => new EditorSessionRegistry(identity => (
    documents.session(identity.workspaceId).tabs.some(tab => (
      tab.path === identity.path && tab.lifecycleId === identity.lifecycleId
    ))
  )))
  const [editorGroups] = useState(() => new EditorGroupsStore())
  const [previewModes] = useState(() => new PreviewModeRegistry())
  const [editorCloseStore] = useState(() => new EditorCloseStore())
  const [editorCloseController] = useState(() => new EditorCloseController(
    editorCloseStore,
    documents,
    documentController,
    editorSessions,
  ))
  const [editorCloseBatch] = useState(() => new EditorCloseBatchCoordinator(
    editorCloseController,
    () => {
      const snapshot = documents.getSnapshot()
      return {
        activeWorkspaceId: snapshot.activeWorkspaceId,
        activeWorkspaceEpoch: snapshot.activeWorkspaceEpoch,
      }
    },
  ))
  const [closedEditorHistory] = useState(() => new ClosedEditorHistoryStore())
  const [documentConflictStore] = useState(() => new DocumentConflictStore())
  const [documentConflictController] = useState(() => new DocumentConflictController(
    documentConflictStore,
    documents,
    fileApi,
  ))
  const [quickOpenStore] = useState(() => new QuickOpenStore())
  const [quickOpenController] = useState(() => new QuickOpenController(quickOpenStore, fileApi))
  const [workspaceSearchStore] = useState(() => new WorkspaceSearchStore())
  const [workspaceSearchController] = useState(() => new WorkspaceSearchController(workspaceSearchStore, fileApi, documents))
  const [workspaceReplaceStore] = useState(() => new WorkspaceReplaceStore())
  const [workspaceReplaceController] = useState(() => new WorkspaceReplaceController(
    workspaceReplaceStore,
    workspaceSearchStore,
    documents,
    fileApi,
  ))
  const [navigation] = useState(() => new EditorNavigationController(documentController))
  const [explorerStore] = useState(() => new ExplorerStore())
  const [explorerController] = useState(() => new ExplorerController(explorerStore, fileApi))
  const [mutationRecovery] = useState(() => new MutationRecoveryPersistence())
  const [loadedMutationRecovery] = useState<MutationRecoveryLoadResult>(() => mutationRecovery.load())
  const [persistence] = useState(() => new SessionPersistence({
    onStatus: status => { persistenceStatusSink.current(status) },
  }))
  const [loadedRecovery] = useState(() => persistence.load())
  const mutationAppliedFlush = useRef<() => boolean>(() => false)
  const [mutationRecoveryPort] = useState(() => createDurableMutationRecoveryPort(
    mutationRecovery,
    () => mutationAppliedFlush.current(),
  ))
  const [mutationStore] = useState(() => new WorkspaceMutationStore())
  const [mutationController] = useState(() => new WorkspaceMutationController(mutationStore, mutationApi, {
    documents: documentController,
    editorSessions,
    explorer: explorerController,
    navigation: {
      openCreatedFile: async (operationId, selectedWorkspace, selectedEpoch, path) => {
        const current = documents.getSnapshot()
        if (current.activeWorkspaceId !== selectedWorkspace || current.activeWorkspaceEpoch !== selectedEpoch) return false
        return await documentController.openCommittedCreate(operationId, selectedWorkspace, path, basename(path))
      },
    },
    recovery: mutationRecoveryPort,
  }))
  const [commands] = useState(() => new WorkbenchCommandRuntime(SHORTCUT_PLATFORM))
  const documentSnapshot = useDocumentSessions(documents)
  const editorGroupsSnapshot = useSyncExternalStore(
    editorGroups.subscribe,
    editorGroups.getSnapshot,
    editorGroups.getSnapshot,
  )
  const previewModeSnapshot = useSyncExternalStore(
    previewModes.subscribe,
    previewModes.getSnapshot,
    previewModes.getSnapshot,
  )
  void previewModeSnapshot
  const editorCloseSnapshot = useSyncExternalStore(
    editorCloseStore.subscribe,
    editorCloseStore.getSnapshot,
    editorCloseStore.getSnapshot,
  )
  const closedEditorHistorySnapshot = useSyncExternalStore(
    closedEditorHistory.subscribe,
    closedEditorHistory.getSnapshot,
    closedEditorHistory.getSnapshot,
  )
  const documentConflictSnapshot = useSyncExternalStore(
    documentConflictStore.subscribe,
    documentConflictStore.getSnapshot,
    documentConflictStore.getSnapshot,
  )
  const quickOpenSnapshot = useSyncExternalStore(quickOpenStore.subscribe, quickOpenStore.getSnapshot, quickOpenStore.getSnapshot)
  const workspaceSearchSnapshot = useSyncExternalStore(
    workspaceSearchStore.subscribe,
    workspaceSearchStore.getSnapshot,
    workspaceSearchStore.getSnapshot,
  )
  const workspaceReplaceSnapshot = useSyncExternalStore(
    workspaceReplaceStore.subscribe,
    workspaceReplaceStore.getSnapshot,
    workspaceReplaceStore.getSnapshot,
  )
  const explorerSnapshot = useSyncExternalStore(
    explorerStore.subscribe,
    explorerStore.getSnapshot,
    explorerStore.getSnapshot,
  )
  const mutationSnapshot = useSyncExternalStore(
    mutationStore.subscribe,
    mutationStore.getSnapshot,
    mutationStore.getSnapshot,
  )
  const commandPaletteSnapshot = useSyncExternalStore(
    commands.palette.store.subscribe,
    commands.palette.store.getSnapshot,
    commands.palette.store.getSnapshot,
  )
  const keybindingSnapshot = useSyncExternalStore(
    commands.shortcuts.store.subscribe,
    commands.shortcuts.store.getSnapshot,
    commands.shortcuts.store.getSnapshot,
  )
  const revealRequest = useSyncExternalStore(navigation.subscribe, navigation.getRevealRequest, navigation.getRevealRequest)
  const navigationHistorySnapshot = useSyncExternalStore(
    navigation.subscribe,
    navigation.getHistorySnapshot,
    navigation.getHistorySnapshot,
  )
  const workspaceId = documentSnapshot.activeWorkspaceId
  const documentSession = documents.session(workspaceId)
  const tabs = documentSession.tabs
  const activePath = documentSession.activePath
  const activeTab = tabs.find(tab => tab.path === activePath)
  useLayoutEffect(() => {
    editorGroups.synchronize({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
      tabs,
      ...(activePath === undefined ? {} : { activePath }),
    })
  }, [activePath, documentSnapshot.activeWorkspaceEpoch, editorGroups, tabs, workspaceId])
  useLayoutEffect(() => {
    previewModes.synchronize(workspaceId === undefined ? [] : tabs.map(tab => ({
      workspaceId,
      workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    })))
  }, [documentSnapshot.activeWorkspaceEpoch, previewModes, tabs, workspaceId])
  const activePreviewIdentity: DocumentIdentity | undefined = workspaceId === undefined || activeTab === undefined
    ? undefined
    : {
        workspaceId,
        workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
        path: activeTab.path,
        lifecycleId: activeTab.lifecycleId,
      }
  const activeMarkdownPreview = activeTab !== undefined
    && activePreviewIdentity !== undefined
    && supportsMarkdownPreview(activeTab.path)
    && previewModes.get(activePreviewIdentity) === 'preview'
  const activeEditorMutationLeased = workspaceId !== undefined && activeTab !== undefined
    && documents.isPathMutationLeased(workspaceId, activeTab.path)
  const [workspaceBaselineReady, setWorkspaceBaselineReady] = useState(false)
  const [bootReady, setBootReady] = useState(false)
  const activeTextEditorVisible = bootReady && activeTab !== undefined
    && activeTab.readOnlyPresentation === undefined
    && !activeMarkdownPreview
  const activeMediaDescriptor = activeTab?.readOnlyPresentation === undefined
    ? undefined
    : mediaPreviewDescriptor(activeTab.path)
  const [mutationWriterOwned, setMutationWriterOwned] = useState(false)
  const [mutationWriter, setMutationWriter] = useState(false)
  const mutationWriterRef = useRef(mutationWriter)
  mutationWriterRef.current = mutationWriter
  const [invalidMutationRecoveryDialogOpen, setInvalidMutationRecoveryDialogOpen] = useState(false)
  const [invalidMutationRecoveryResetBusy, setInvalidMutationRecoveryResetBusy] = useState(false)
  const [invalidMutationRecoveryResetError, setInvalidMutationRecoveryResetError] = useState<string>()
  const [workbenchRecoveryDialogOpen, setWorkbenchRecoveryDialogOpen] = useState(false)
  const [workbenchRecoveryBusy, setWorkbenchRecoveryBusy] = useState(false)
  const [workbenchRecoveryExported, setWorkbenchRecoveryExported] = useState(false)
  const [workbenchRecoveryDialogError, setWorkbenchRecoveryDialogError] = useState<string>()
  const workbenchRecoveryExportRaw = useRef<string>()
  const [mutationCapabilities, setMutationCapabilities] = useState<MutationCapabilities>()
  const mutationCapabilitiesRef = useRef(mutationCapabilities)
  mutationCapabilitiesRef.current = mutationCapabilities
  const [mutationAvailabilityError, setMutationAvailabilityError] = useState<string>()
  const [mutationRecoveryError, setMutationRecoveryError] = useState<string>()
  const [retainedRecovery, setRetainedRecovery] = useState<readonly PersistedWorkspaceV1[]>([])
  mutationAppliedFlush.current = () => {
    persistence.schedule(documents.getSnapshot(), retainedRecovery)
    return persistence.flush()
  }
  const [explorerFocusRequest, setExplorerFocusRequest] = useState<number>()
  const [editorTabFocusRequest, setEditorTabFocusRequest] = useState<EditorTabFocusRequest>()
  const [editorFocusRequest, setEditorFocusRequest] = useState<number>()
  const [editorTabDragSession, setEditorTabDragSession] = useState<EditorTabDragSession>()
  const [editorGroupDropTarget, setEditorGroupDropTarget] = useState<{
    readonly groupId: string
    readonly edge: 'top' | 'right'
  }>()
  useEffect(() => {
    const session = editorTabDragSession
    if (session === undefined) return
    const finishUncommittedDrag = (): void => {
      editorGroups.cancelTabDrag(session.source)
      setEditorGroupDropTarget(undefined)
      setEditorTabDragSession(current => current?.token === session.token ? undefined : current)
    }
    // The source pane may collapse during the preview, unmounting the native
    // drag source before its React dragend handler can run. Window-level
    // cleanup guarantees rollback for rejected and out-of-window drops.
    window.addEventListener('dragend', finishUncommittedDrag, true)
    window.addEventListener('drop', finishUncommittedDrag)
    window.addEventListener('blur', finishUncommittedDrag)
    return () => {
      window.removeEventListener('dragend', finishUncommittedDrag, true)
      window.removeEventListener('drop', finishUncommittedDrag)
      window.removeEventListener('blur', finishUncommittedDrag)
    }
  }, [editorGroups, editorTabDragSession])
  const editorHistoryBinding = useRef<EditorHistoryBinding>()
  const editorHistoryBindings = useRef(new Map<string, EditorHistoryBinding>())
  const [editorHistoryRevision, setEditorHistoryRevision] = useState(0)
  const activeEditorGroupId = editorGroupsSnapshot.workspaceId === workspaceId
    && editorGroupsSnapshot.workspaceEpoch === documentSnapshot.activeWorkspaceEpoch
    ? editorGroupsSnapshot.activeGroupId
    : undefined
  useLayoutEffect(() => {
    const next = activeEditorGroupId === undefined
      ? undefined
      : editorHistoryBindings.current.get(activeEditorGroupId)
    if (editorHistoryBinding.current === next) return
    editorHistoryBinding.current = next
    setEditorHistoryRevision(value => value + 1)
  }, [activeEditorGroupId])
  const terminalCommandBinding = useRef<{
    readonly token: object
    readonly port: TerminalCommandPort
    readonly unsubscribe: () => void
  }>()
  const [terminalCommandRevision, setTerminalCommandRevision] = useState(0)
  const [editorCursorReport, setEditorCursorReport] = useState<EditorLocation & {
    readonly workspaceId: string
    readonly workspaceEpoch: number
    readonly path: string
    readonly lifecycleId: number
  }>()
  const [terminalFocusRequest, setTerminalFocusRequest] = useState<TerminalFocusRequest>()
  const editorPresentationSequence = useRef(0)
  const [explorerPortalDismissRequest, setExplorerPortalDismissRequest] = useState(0)
  const [initialLayoutGeometry] = useState(() => readLayoutGeometry())
  const desiredLayoutGeometry = useRef<LayoutGeometry>(initialLayoutGeometry)
  const [explorerWidth, setExplorerWidth] = useState(initialLayoutGeometry.explorerWidth)
  const [harnessWidth, setHarnessWidth] = useState(initialLayoutGeometry.harnessWidth)
  const [terminalHeight, setTerminalHeight] = useState(initialLayoutGeometry.terminalHeight)
  const [quickInputMode, setQuickInputMode] = useState<QuickInputMode>('none')
  const [lineQuery, setLineQuery] = useState('')
  const [eolQuery, setEolQuery] = useState('')
  const [eolActiveIndex, setEolActiveIndex] = useState(0)
  const [languageQuery, setLanguageQuery] = useState('')
  const [languageActiveIndex, setLanguageActiveIndex] = useState(0)
  const [indentationQuery, setIndentationQuery] = useState('')
  const [indentationActiveIndex, setIndentationActiveIndex] = useState(0)
  const [wordWrap, setWordWrap] = useState(false)
  void editorHistoryRevision
  void terminalCommandRevision
  const boundEditorHistory = editorHistoryBinding.current?.port
  const activeEditorHistory = workspaceId !== undefined && activeTab !== undefined
    && boundEditorHistory?.workspaceId === workspaceId
    && boundEditorHistory.path === activeTab.path
    && boundEditorHistory.lifecycleId === activeTab.lifecycleId
    && boundEditorHistory.historyEpoch === activeTab.historyEpoch
    ? boundEditorHistory.getSnapshot()
    : undefined
  const activeEditorLanguage = activeEditorHistory === undefined
    ? undefined
    : EDITOR_LANGUAGE_OPTIONS.find(option => option.id === activeEditorHistory.languageId)
  const activeEditorIndentation = activeEditorHistory?.indentation
  const activeCursorPosition = workspaceId !== undefined && activeTab !== undefined
    && activeTab.readOnlyPresentation === undefined
    && !activeMarkdownPreview
    && editorCursorReport?.workspaceId === workspaceId
    && editorCursorReport.workspaceEpoch === documentSnapshot.activeWorkspaceEpoch
    && editorCursorReport.path === activeTab.path
    && editorCursorReport.lifecycleId === activeTab.lifecycleId
    ? editorCursorReport
    : undefined
  const resolveMarkdownImageSrc = useCallback((path: string): string | undefined => {
    if (workspaceId === undefined || mediaPreviewDescriptor(path)?.kind !== 'image') return undefined
    return mediaPreviewUrl(workspaceId, path)
  }, [workspaceId])
  const openMarkdownPath = useCallback((path: string): void => {
    if (workspaceId === undefined) return
    setOpenError(undefined)
    void navigation.openPath(workspaceId, path).catch(error => {
      setOpenError(error instanceof Error ? error.message : String(error))
    })
  }, [navigation, workspaceId])
  const terminalCommandSnapshot = terminalCommandBinding.current?.port.getSnapshot()
  const terminalCommandState = workspaceId !== undefined
    && terminalCommandSnapshot?.workspaceId === workspaceId
    && terminalCommandSnapshot.workspaceEpoch === documentSnapshot.activeWorkspaceEpoch
    ? terminalCommandSnapshot
    : undefined
  const terminalCanCreate = workspaceId !== undefined
    && terminalCommandState?.canCreate === true
  const terminalCanNavigate = workspaceId !== undefined
    && terminalCommandState?.canNavigate === true
  const terminalCanClear = workspaceId !== undefined
    && terminalCommandState?.active !== undefined
  const activeNavigationHistory = workspaceId === undefined
    ? undefined
    : navigationHistorySnapshot.workspaces.get(workspaceId)
  const quickInputModeRef = useRef<QuickInputMode>('none')
  quickInputModeRef.current = quickInputMode
  const quickInputInvoker = useRef<HTMLElement>()
  const quickInputOriginPanel = useRef<'rail' | 'harness'>()
  const quickInputRestoreTarget = useRef<QuickInputRestoreTarget>('default')
  const pendingQuickInputTerminalFocus = useRef<TerminalCommandTarget>()
  const pendingEolTarget = useRef<DocumentIdentity & {
    readonly lineEnding: DocumentLineEnding
    readonly localRevision: number
    readonly historyEpoch: number
    readonly version: string
  }>()
  const pendingLanguageTarget = useRef<{
    readonly port: EditorHistoryPort
    readonly workspaceId: string
    readonly workspaceEpoch: number
    readonly path: string
    readonly lifecycleId: number
    readonly historyEpoch: number
    readonly languageId: EditorLanguageId
  }>()
  const pendingIndentationTarget = useRef<{
    readonly port: EditorHistoryPort
    readonly workspaceId: string
    readonly workspaceEpoch: number
    readonly path: string
    readonly lifecycleId: number
    readonly historyEpoch: number
    readonly style: 'spaces' | 'tabs'
    readonly size: number
  }>()
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false)
  const keyboardShortcutsOpenRef = useRef(false)
  keyboardShortcutsOpenRef.current = keyboardShortcutsOpen
  const documentConflictOpenRef = useRef(false)
  const keyboardShortcutsInvoker = useRef<HTMLElement>()
  const keyboardShortcutsOriginPanel = useRef<'rail' | 'harness'>()
  const invalidMutationRecoveryInvoker = useRef<HTMLElement>()
  const workbenchRecoveryInvoker = useRef<HTMLElement>()
  const [railView, setRailView] = useState<'explorer' | 'search'>('explorer')
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)
  const [searchIncludeDraft, setSearchIncludeDraft] = useState('')
  const [searchExcludeDraft, setSearchExcludeDraft] = useState('')
  const searchFilterDrafts = useRef(new Map<string, { include: string; exclude: string }>())
  const [searchDraftError, setSearchDraftError] = useState<string>()
  const [searchReplaceDraft, setSearchReplaceDraft] = useState('')
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [compactPanel, setCompactPanel] = useState<'none' | 'rail' | 'harness'>('none')
  const [compactTerminalOpen, setCompactTerminalOpen] = useState(false)
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(true)
  const [terminalPanelMaximized, setTerminalPanelMaximized] = useState(false)
  const [colorScheme, setColorScheme] = useState<IdeColorScheme>(() => (
    embeddedMode && !document.body.hasAttribute('data-ds-dark-theme') ? 'light' : 'dark'
  ))
  const [commandNotice, setCommandNotice] = useState<{ kind: 'status' | 'error'; message: string }>()
  const frame = useRef<HTMLDivElement>(null)
  const workbench = useRef<HTMLElement>(null)
  const explorerPanel = useRef<HTMLElement>(null)
  const harnessPanel = useRef<HTMLElement>(null)
  const harnessFrame = useRef<HTMLIFrameElement>(null)
  const compactFilesButton = useRef<HTMLButtonElement>(null)
  const compactHarnessButton = useRef<HTMLButtonElement>(null)
  const explorerClose = useRef<HTMLButtonElement>(null)
  const harnessClose = useRef<HTMLButtonElement>(null)
  const compactPanelInvoker = useRef<HTMLElement>()
  const pendingCompactFocusTarget = useRef<'files' | 'harness'>()
  const compactRef = useRef(compact)
  compactRef.current = compact
  const compactPanelRef = useRef(compactPanel)
  compactPanelRef.current = compactPanel
  const terminalPanelOpenRef = useRef(terminalPanelOpen)
  terminalPanelOpenRef.current = terminalPanelOpen
  const bootGeneration = useRef(0)
  const quickOpenGeneration = useRef(0)
  const explorerOpenGeneration = useRef(0)
  const searchOpenGeneration = useRef(0)
  const deferredControllerDispose = useRef<{ cancelled: boolean }>()
  const deferredCommandDispose = useRef<{ cancelled: boolean }>()

  useLayoutEffect(() => {
    if (!embeddedMode) {
      setColorScheme('dark')
      return
    }
    const readColorScheme = (): void => {
      setColorScheme(document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
    }
    readColorScheme()
    const observer = new MutationObserver(readColorScheme)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => { observer.disconnect() }
  }, [embeddedMode])

  const workspace = useMemo(
    () => workspaces.find(item => item.workspaceId === workspaceId),
    [workspaceId, workspaces],
  )
  const workspaceSearchSession = workspaceSearchStore.session(workspaceId)
  const explorerSession = explorerStore.session(workspaceId)
  const invalidMutationRecoveryModalOpen = invalidMutationRecoveryDialogOpen && mutationSnapshot.phase === 'idle'
  const mutationModalOpen = invalidMutationRecoveryModalOpen || mutationSnapshot.phase !== 'idle' && (
    mutationSnapshot.draft.kind === 'delete'
    || mutationSnapshot.phase === 'unknown'
      && mutationSnapshot.error.code === MUTATION_MANUAL_RECONCILIATION_REQUIRED
  )
  const editorCloseModalOpen = editorCloseSnapshot.phase !== 'idle'
  const documentConflictModalOpen = documentConflictSnapshot.phase !== 'idle'
  const workbenchRecoveryModalOpen = workbenchRecoveryDialogOpen
    && !mutationModalOpen && !editorCloseModalOpen && !documentConflictModalOpen
  const safetyModalOpen = mutationModalOpen || workbenchRecoveryModalOpen
  documentConflictOpenRef.current = documentConflictModalOpen
  const editorPanelId = useId()
  const anyMutationCapability = mutationCapabilities !== undefined && (
    mutationCapabilities.createFile || mutationCapabilities.createDirectory
    || mutationCapabilities.rename || mutationCapabilities.delete
  )
  const mutationsEnabled = mutationWriter && anyMutationCapability
  const mutationUiEnabled = anyMutationCapability || mutationSnapshot.phase !== 'idle'
  const mutationStatusNotice = mutationAvailabilityError ?? unsupportedMutationNotice(mutationCapabilities)
  const invalidMutationRecoveryResetAvailable = mutationWriterOwned && mutationRecovery.canResetInvalid()
  const workbenchRecoveryResetAvailable = mutationWriterOwned
    && mutationSnapshot.phase === 'idle' && persistence.canRecoverInvalid()

  const searchView = useMemo(() => {
    const groups = new Map<string, WorkspaceSearchMatchView[]>()
    const occurrences = new Map<string, number>()
    const items = new Map<string, { readonly index: number; readonly item: WorkspaceSearchItem }>()
    workspaceSearchSession.items.forEach((item, index) => {
      const range = item.ranges[0]
      if (range === undefined) return
      const id = `${item.path}\u0000${String(item.lineNumber)}\u0000${String(range.start)}\u0000${String(index)}`
      items.set(id, { index, item })
      const highlights = item.ranges.flatMap(candidate => {
        const start = Math.max(0, candidate.start - item.previewStart)
        const end = Math.min(item.preview.length, candidate.end - item.previewStart)
        return end > start ? [{ start, end }] : []
      })
      const view: WorkspaceSearchMatchView = {
        id,
        path: item.path,
        line: item.lineNumber,
        column: range.start + 1,
        preview: item.preview,
        highlights,
      }
      const current = groups.get(item.path)
      if (current === undefined) groups.set(item.path, [view])
      else current.push(view)
      occurrences.set(item.path, (occurrences.get(item.path) ?? 0) + item.ranges.length)
    })
    return {
      groups: [...groups].map(([path, matches]): WorkspaceSearchFileGroup => ({
        path, matches, occurrenceCount: occurrences.get(path) ?? matches.length,
      })),
      items,
    }
  }, [workspaceSearchSession.items])

  const quickOpenOptions = useMemo<QuickOpenOption[]>(() => {
    if (quickOpenSnapshot.query.trim().length === 0) {
      return tabs.map(tab => ({ id: tab.path, path: tab.path, label: tab.name, detail: tab.path }))
    }
    const location = parseQuickOpenQuery(quickOpenSnapshot.query).location
    return quickOpenSnapshot.items.map(item => ({
      id: item.path,
      path: item.path,
      ...(location === undefined ? {} : { location }),
    }))
  }, [quickOpenSnapshot.items, quickOpenSnapshot.query, tabs])
  const quickInputOptions = useMemo<WorkbenchQuickInputOption[]>(() => {
    if (quickInputMode === 'commands') {
      return commandPaletteSnapshot.items.map(item => {
        const title = locale === 'zh' ? ZH_COMMAND_TITLES[item.id] ?? item.title : item.title
        const category = locale === 'zh' && item.category !== undefined
          ? ZH_COMMAND_CATEGORIES[item.category] ?? item.category
          : item.category
        const label = category === undefined ? title : `${category}: ${title}`
        const shortcut = item.shortcut?.state === 'conflict'
          ? locale === 'zh' ? '快捷键冲突' : 'Shortcut conflict'
          : item.shortcut?.state === 'unbound'
            ? locale === 'zh' ? '未绑定' : 'Unbound'
            : item.shortcut?.labels[0] === undefined
              ? item.keybindings[0] === undefined
                ? undefined
                : formatKeybinding(item.keybindings[0], SHORTCUT_PLATFORM)
              : item.shortcut.customized
                ? `${item.shortcut.labels[0]} · ${locale === 'zh' ? '已自定义' : 'Customized'}`
                : item.shortcut.labels[0]
        return {
          kind: 'command', commandId: item.id, id: item.id, label,
          ...(shortcut === undefined ? {} : { shortcut }),
          disabled: !item.enabled || item.running,
          ...(!item.enabled || item.running
            ? { disabledReason: locale === 'zh' ? item.running ? '命令正在运行' : '当前不可用' : item.running ? 'Command is running.' : item.disabledReason }
            : {}),
          compact: true,
        }
      })
    }
    if (quickInputMode === 'line') {
      const location = parseEditorLocation(lineQuery)
      if (location === undefined) return []
      return [{
        kind: 'line',
        location,
        id: `line:${String(location.lineNumber)}:${String(location.columnNumber)}`,
        label: `Go to Line ${String(location.lineNumber)}`,
        detail: `Column ${String(location.columnNumber)}`,
      }]
    }
    if (quickInputMode === 'eol') {
      const target = pendingEolTarget.current
      if (target === undefined) return []
      const currentLineEnding = documentSnapshot.activeWorkspaceId === target.workspaceId
        && documentSnapshot.activeWorkspaceEpoch === target.workspaceEpoch
        && activeTab?.path === target.path && activeTab.lifecycleId === target.lifecycleId
        ? activeTab.lineEnding ?? '\n'
        : target.lineEnding
      const query = eolQuery.trim().toLocaleLowerCase()
      return ([
        {
          kind: 'eol', lineEnding: '\n', id: 'eol:lf', label: 'LF', detail: 'Line Feed (\\n)',
          disabled: currentLineEnding === '\n',
          ...(currentLineEnding === '\n' ? { disabledReason: 'Current' } : {}),
        },
        {
          kind: 'eol', lineEnding: '\r\n', id: 'eol:crlf', label: 'CRLF',
          detail: 'Carriage Return + Line Feed (\\r\\n)',
          disabled: currentLineEnding === '\r\n',
          ...(currentLineEnding === '\r\n' ? { disabledReason: 'Current' } : {}),
        },
      ] satisfies WorkbenchQuickInputOption[]).filter(option => query.length === 0
        || option.label.toLocaleLowerCase().includes(query)
        || option.detail.toLocaleLowerCase().includes(query))
    }
    if (quickInputMode === 'language') {
      const target = pendingLanguageTarget.current
      if (target === undefined) return []
      const binding = editorHistoryBinding.current?.port
      const currentLanguage = documentSnapshot.activeWorkspaceId === target.workspaceId
        && documentSnapshot.activeWorkspaceEpoch === target.workspaceEpoch
        && activeTab?.path === target.path && activeTab.lifecycleId === target.lifecycleId
        && activeTab.historyEpoch === target.historyEpoch && binding === target.port
        ? target.port.getSnapshot().languageId
        : target.languageId
      const query = languageQuery.trim().toLocaleLowerCase()
      return EDITOR_LANGUAGE_OPTIONS.map(option => ({
        kind: 'language' as const,
        languageId: option.id,
        id: `language:${option.id}`,
        label: option.label,
        detail: option.id === currentLanguage ? `${option.detail} - Current` : option.detail,
      })).filter(option => query.length === 0
        || option.label.toLocaleLowerCase().includes(query)
        || option.detail.toLocaleLowerCase().includes(query)
        || option.languageId.includes(query))
    }
    if (quickInputMode === 'indentation') {
      const target = pendingIndentationTarget.current
      if (target === undefined) return []
      const binding = editorHistoryBinding.current?.port
      const currentIndentation = documentSnapshot.activeWorkspaceId === target.workspaceId
        && documentSnapshot.activeWorkspaceEpoch === target.workspaceEpoch
        && activeTab?.path === target.path && activeTab.lifecycleId === target.lifecycleId
        && activeTab.historyEpoch === target.historyEpoch && binding === target.port
        ? target.port.getSnapshot().indentation
        : { style: target.style, size: target.size }
      const query = indentationQuery.trim().toLocaleLowerCase()
      return Array.from({ length: 8 }, (_, index): WorkbenchQuickInputOption => {
        const size = index + 1
        const label = String(size)
        const detail = `${currentIndentation.style === 'spaces' ? 'Spaces' : 'Tab Size'}: ${String(size)}`
        return {
          kind: 'indentation', size, id: `indentation:${String(size)}`, label,
          detail: size === currentIndentation.size ? `${detail} - Current` : detail,
        }
      }).filter(option => query.length === 0
        || option.label.toLocaleLowerCase().includes(query)
        || (option.detail ?? '').toLocaleLowerCase().includes(query))
    }
    return quickOpenOptions.map(file => {
      const label = file.label ?? basename(file.path)
      return {
        kind: 'file', file, id: file.id, label,
        detail: file.detail ?? (label === file.path ? '' : file.path),
      }
    })
  }, [
    activeTab?.lifecycleId,
    activeTab?.historyEpoch,
    activeTab?.lineEnding,
    activeTab?.path,
    commandPaletteSnapshot.items,
    documentSnapshot.activeWorkspaceEpoch,
    documentSnapshot.activeWorkspaceId,
    eolQuery,
    activeEditorHistory?.languageId,
    activeEditorHistory?.indentation.style,
    activeEditorHistory?.indentation.size,
    languageQuery,
    indentationQuery,
    lineQuery,
    locale,
    quickInputMode,
    quickOpenOptions,
  ])
  // The registry owns contribution lifetime; catalog() is a bounded immutable
  // projection and includes commands hidden by the current live context.
  const commandCatalog = commands.registry.catalog()
  const observationTargets = useMemo<KnownObservationTarget[]>(() => [
    ...tabs.map(tab => ({ kind: 'file' as const, path: tab.path, knownVersion: tab.version })),
    ...[...explorerSession.expanded].map(path => ({ kind: 'directory' as const, path })),
  ], [explorerSession.expanded, explorerSnapshot, tabs])

  /**
   * The single workspace-selection admission point. Each domain observes every
   * intermediate transition synchronously, even when React batches W1 -> W2 ->
   * W1 into one render; DocumentSessionStore's epoch then keys observation.
   */
  const coordinateWorkspaceSelection = useCallback((next: string | undefined): boolean => {
    const mutation = mutationStore.getSnapshot()
    if (mutation.phase === 'submitting' || mutation.phase === 'unknown'
      || mutation.phase === 'reconciling' || mutation.phase === 'applying') {
      setMutationRecoveryError('Check the active file operation outcome before switching workspaces.')
      return false
    }
    mutationController.cancel()
    documentConflictOpenRef.current = false
    setEditorTabFocusRequest(undefined)
    setEditorFocusRequest(undefined)
    pendingQuickInputTerminalFocus.current = undefined
    setTerminalFocusRequest(undefined)
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = undefined
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    if (quickInputModeRef.current === 'eol' || quickInputModeRef.current === 'language'
      || quickInputModeRef.current === 'indentation') {
      quickInputRestoreTarget.current = 'default'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
      setQuickInputMode('none')
    }
    void coordinateWorkbenchWorkspaceSelection(next, {
      explorer: explorerController,
      quickOpen: quickOpenController,
      workspaceSearch: workspaceSearchController,
      workspaceReplace: workspaceReplaceController,
      documents,
      editorClose: editorCloseController,
      documentConflict: documentConflictController,
    }).catch(error => { setCoherenceError(error instanceof Error ? error.message : String(error)) })
    const identity = documents.getSnapshot()
    editorCloseBatch.selectWorkspace(identity.activeWorkspaceId, identity.activeWorkspaceEpoch)
    if (!mutationController.selectWorkspace(identity.activeWorkspaceId, identity.activeWorkspaceEpoch)) {
      setMutationRecoveryError('The file operation workspace could not be changed safely.')
      return false
    }
    setCoherenceError(undefined)
    setOpenError(undefined)
    return true
  }, [documentConflictController, documents, editorCloseBatch, editorCloseController, explorerController, mutationController, mutationStore, quickOpenController, workspaceReplaceController, workspaceSearchController])

  const restoreMutationRecovery = useCallback(async (): Promise<boolean> => {
    const loaded = mutationRecovery.load()
    if (loaded.kind === 'empty') {
      setMutationRecoveryError(undefined)
      return true
    }
    if (loaded.kind === 'invalid' || loaded.kind === 'future') {
      setMutationRecoveryError(loaded.message)
      return false
    }
    const persisted = loaded.value
    if (!workspaces.some(candidate => candidate.workspaceId === persisted.record.workspaceId)) {
      setMutationRecoveryError(
        'A file operation recovery record belongs to a workspace that is not registered. It was preserved and new file operations remain disabled.',
      )
      return false
    }
    if (documents.getSnapshot().activeWorkspaceId !== persisted.record.workspaceId
      && !coordinateWorkspaceSelection(persisted.record.workspaceId)) return false
    const identity = documents.getSnapshot()
    if (identity.activeWorkspaceId !== persisted.record.workspaceId) return false
    const record = rebindMutationRecoveryRecord(persisted.record, identity.activeWorkspaceEpoch)
    setRailView('explorer')

    if (persisted.phase === 'committed') {
      const current = mutationStore.getSnapshot()
      const resumed = current.phase === 'applying' && current.operationId === record.operationId
        ? await mutationController.retryCommitted()
        : await mutationController.resumeCommitted(record, persisted.result)
      const remaining = mutationRecovery.load()
      if (resumed !== 'committed' || remaining.kind !== 'empty') {
        setMutationRecoveryError(
          'The Host committed a file operation, but its local workbench presentation still needs recovery. Retry recovery; do not submit another operation.',
        )
        return false
      }
      setMutationRecoveryError(undefined)
      return true
    }

    const current = mutationStore.getSnapshot()
    if (current.phase === 'unknown' && current.operationId === record.operationId
      && current.providerEpoch === record.providerEpoch) return true
    const restored = mutationController.resumeUnknown(
      record,
      persisted.phase === 'unknown' ? persisted.error : undefined,
    )
    if (!restored) {
      setMutationRecoveryError(
        'The interrupted file operation could not be fenced against the current document state. Its recovery record was preserved.',
      )
      return false
    }
    setMutationRecoveryError(undefined)
    return true
  }, [coordinateWorkspaceSelection, documents, mutationController, mutationRecovery, mutationStore, workspaces])

  useEffect(() => {
    const generation = ++bootGeneration.current
    let disposed = false
    void (async () => {
      try {
        const result = await fileApi.workspaces()
        if (disposed || generation !== bootGeneration.current) return
        setWorkspaces(result.workspaces)
        setMaxTerminalSessions(result.maxTerminalSessions)
        const registered = new Set(result.workspaces.map(item => item.workspaceId))
        if (loadedRecovery.kind === 'invalid' || loadedRecovery.kind === 'future') {
          setRecoveryError(loadedRecovery.message)
        }
        if (loadedRecovery.kind === 'ready') {
          setRetainedRecovery(loadedRecovery.workbench.workspaces.filter(persisted => !registered.has(persisted.workspaceId)))
          const restorable = loadedRecovery.workbench.workspaces.filter(persisted => registered.has(persisted.workspaceId))
          const activeIndex = loadedRecovery.workbench.activeWorkspaceId === undefined
            ? -1
            : restorable.findIndex(persisted => persisted.workspaceId === loadedRecovery.workbench.activeWorkspaceId)
          if (activeIndex > 0) restorable.unshift(...restorable.splice(activeIndex, 1))
          for (const persisted of restorable) {
            const restored = await hydratePersistedWorkspace(persisted, fileApi.read)
            if (disposed || generation !== bootGeneration.current) return
            editorSessions.clearWorkspace(persisted.workspaceId)
            documents.restoreWorkspace(persisted.workspaceId, restored.documents, restored.activePath)
          }
        }
        const mutationRecoveryWorkspace = loadedMutationRecovery.kind === 'ready'
          && registered.has(loadedMutationRecovery.value.record.workspaceId)
          ? loadedMutationRecovery.value.record.workspaceId
          : undefined
        if (loadedMutationRecovery.kind === 'invalid' || loadedMutationRecovery.kind === 'future') {
          setMutationRecoveryError(loadedMutationRecovery.message)
        }
        const persistedActive = loadedRecovery.kind === 'ready'
          && loadedRecovery.workbench.activeWorkspaceId !== undefined
          && registered.has(loadedRecovery.workbench.activeWorkspaceId)
          ? loadedRecovery.workbench.activeWorkspaceId
          : undefined
        const recoveryOverridesRequested = mutationRecoveryWorkspace !== undefined
          && launchOptions.requestedWorkspaceId !== undefined
          && mutationRecoveryWorkspace !== launchOptions.requestedWorkspaceId
        if (recoveryOverridesRequested) setCommandNotice({
          kind: 'status',
          message: 'An interrupted file operation must be recovered before the requested workspace can be opened.',
        })
        const requestedWorkspaceUnavailable = mutationRecoveryWorkspace === undefined
          && launchOptions.requestedWorkspaceId !== undefined
          && !registered.has(launchOptions.requestedWorkspaceId)
        setWorkspaceError(requestedWorkspaceUnavailable
          ? 'The workspace selected by the surrounding Harness session is not available to the IDE.'
          : undefined)
        coordinateWorkspaceSelection(selectInitialWorkspace({
          registeredWorkspaceIds: registered,
          ...(mutationRecoveryWorkspace === undefined ? {} : { mutationRecoveryWorkspace }),
          ...(launchOptions.requestedWorkspaceId === undefined
            ? {}
            : { requestedWorkspaceId: launchOptions.requestedWorkspaceId }),
          ...(persistedActive === undefined ? {} : { persistedActiveWorkspace: persistedActive }),
          ...(result.currentWorkspaceId === undefined ? {} : { currentWorkspaceId: result.currentWorkspaceId }),
          ...(result.workspaces[0]?.workspaceId === undefined
            ? {}
            : { firstWorkspaceId: result.workspaces[0].workspaceId }),
        }))
        setWorkspaceBaselineReady(true)
      } catch (error) {
        if (disposed || generation !== bootGeneration.current) return
        setWorkspaceError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { disposed = true }
  }, [coordinateWorkspaceSelection, documents, editorSessions, launchOptions.requestedWorkspaceId, loadedMutationRecovery, loadedRecovery])

  useEffect(() => {
    if (!workspaceBaselineReady) return
    const controller = new AbortController()
    void mutationApi.provider(controller.signal).then(provider => {
      if (controller.signal.aborted) return
      setMutationCapabilities(provider.capabilities)
      setMutationAvailabilityError(undefined)
    }).catch(error => {
      if (controller.signal.aborted) return
      setMutationCapabilities(undefined)
      setMutationAvailabilityError(error instanceof Error ? error.message : String(error))
    })
    return () => { controller.abort() }
  }, [workspaceBaselineReady])

  useEffect(() => {
    if (!workspaceBaselineReady) return
    let active = true
    let acquiring = false
    let retryHandle: number | undefined
    let stop: (() => void) | undefined
    const schedule = (): void => { persistence.schedule(documents.getSnapshot(), retainedRecovery) }
    const flush = (): void => { persistence.flush() }
    const warnDirty = (event: BeforeUnloadEvent): void => {
      persistence.flush()
      const mutation = mutationStore.getSnapshot()
      if (!documents.hasDirtyDocuments() && mutation.phase !== 'submitting'
        && mutation.phase !== 'unknown' && mutation.phase !== 'reconciling'
        && mutation.phase !== 'applying') return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', warnDirty)
    const attemptWriter = (allowReleaseRaceRetry = true): void => {
      if (!active || acquiring || stop !== undefined) return
      acquiring = true
      void persistence.startExclusiveWriter().then(async (acquired) => {
        acquiring = false
        if (!active || stop !== undefined) return
        if (!acquired) {
          setMutationWriterOwned(false)
          setMutationWriter(false)
          setBootReady(true)
          // A hard reload can run the new document's ifAvailable request just
          // before the browser finishes releasing this origin's previous
          // document lock. Retry that narrow hand-off once; later ownership
          // changes are still driven by focus/pageshow/visibility events.
          if (allowReleaseRaceRetry && document.visibilityState !== 'hidden' && retryHandle === undefined) {
            retryHandle = window.setTimeout(() => {
              retryHandle = undefined
              attemptWriter(false)
            }, 300)
          }
          return
        }
        if (retryHandle !== undefined) {
          window.clearTimeout(retryHandle)
          retryHandle = undefined
        }
        mutationRecovery.setWritable(true)
        let recoveryReady = false
        try { recoveryReady = await restoreMutationRecovery() } catch (error) {
          setMutationRecoveryError(error instanceof Error ? error.message : String(error))
        }
        if (!active || stop !== undefined) return
        setMutationWriterOwned(true)
        setMutationWriter(recoveryReady)
        setBootReady(true)
        stop = documents.subscribe(schedule)
        schedule()
      }).catch(error => {
        acquiring = false
        if (!active) return
        setMutationWriterOwned(false)
        setMutationWriter(false)
        setMutationRecoveryError(error instanceof Error ? error.message : String(error))
        setBootReady(true)
      })
    }
    const retryWriterWhenVisible = (): void => {
      if (document.visibilityState !== 'hidden') attemptWriter()
    }
    const retryWriter = (): void => { attemptWriter() }
    window.addEventListener('focus', retryWriter)
    window.addEventListener('pageshow', retryWriter)
    document.addEventListener('visibilitychange', retryWriterWhenVisible)
    attemptWriter()
    return () => {
      active = false
      setMutationWriterOwned(false)
      setMutationWriter(false)
      mutationRecovery.setWritable(false)
      stop?.()
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', warnDirty)
      window.removeEventListener('focus', retryWriter)
      window.removeEventListener('pageshow', retryWriter)
      document.removeEventListener('visibilitychange', retryWriterWhenVisible)
      if (retryHandle !== undefined) window.clearTimeout(retryHandle)
      persistence.flush()
      persistence.dispose()
    }
  }, [documents, mutationRecovery, mutationStore, persistence, restoreMutationRecovery, retainedRecovery, workspaceBaselineReady])

  useEffect(() => {
    if (persistenceStatus.kind === 'saved') setRecoveryError(undefined)
  }, [persistenceStatus.kind])

  useEffect(() => {
    if (!mutationWriterOwned || mutationSnapshot.phase !== 'idle') return
    const recovery = mutationRecovery.load()
    if (recovery.kind === 'empty') {
      setMutationRecoveryError(undefined)
      setMutationWriter(true)
      return
    }
    setMutationWriter(false)
    setMutationRecoveryError(recovery.kind === 'ready'
      ? 'A committed file operation still needs local workbench recovery. Retry recovery before starting another operation.'
      : recovery.message)
  }, [mutationRecovery, mutationSnapshot.phase, mutationWriterOwned])

  useEffect(() => {
    const query = workspaceSearchStore.session(workspaceId).query
    const drafts = workspaceId === undefined ? undefined : searchFilterDrafts.current.get(workspaceId)
    setSearchIncludeDraft(drafts?.include ?? query.include?.join(', ') ?? '')
    setSearchExcludeDraft(drafts?.exclude ?? query.exclude?.join(', ') ?? '')
  }, [workspaceId, workspaceSearchStore])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = (): void => {
      setExplorerPortalDismissRequest(value => value + 1)
      setCompact(media.matches)
      if (!media.matches) setCompactPanel('none')
      else {
        pendingQuickInputTerminalFocus.current = undefined
        setTerminalFocusRequest(undefined)
        setCompactTerminalOpen(false)
      }
    }
    update()
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update) }
  }, [])

  useEffect(() => {
    const pending = deferredControllerDispose.current
    if (pending !== undefined) pending.cancelled = true
    deferredControllerDispose.current = undefined
    return () => {
      const token = { cancelled: false }
      deferredControllerDispose.current = token
      queueMicrotask(() => {
        if (token.cancelled || deferredControllerDispose.current !== token) return
        deferredControllerDispose.current = undefined
        quickOpenController.dispose()
        workspaceSearchController.dispose()
        explorerController.dispose()
        documentConflictController.dispose()
        workspaceReplaceController.dispose()
        editorCloseBatch.dispose()
        editorCloseController.dispose()
        mutationController.dispose()
      })
    }
  }, [documentConflictController, editorCloseBatch, editorCloseController, explorerController, mutationController, quickOpenController, workspaceReplaceController, workspaceSearchController])

  useEffect(() => {
    // Browser storage listeners are attached only after React commits the
    // retained runtime. This keeps StrictMode's discarded initializer pure.
    commands.shortcuts.startPersistenceSync()
  }, [commands])

  useEffect(() => {
    const pending = deferredCommandDispose.current
    if (pending !== undefined) {
      pending.cancelled = true
      deferredCommandDispose.current = undefined
    }
    return () => {
      const token = { cancelled: false }
      deferredCommandDispose.current = token
      queueMicrotask(() => {
        if (token.cancelled || deferredCommandDispose.current !== token) return
        deferredCommandDispose.current = undefined
        void commands.dispose()
      })
    }
  }, [commands])

  const leaveMutationSurface = useCallback((): boolean => {
    const mutation = mutationStore.getSnapshot()
    if (mutation.phase === 'idle') return true
    if (mutation.phase === 'editing' || mutation.phase === 'confirming') return mutationController.cancel()
    setMutationRecoveryError('Check the active file operation outcome before leaving Explorer.')
    return false
  }, [mutationController, mutationStore])

  const showQuickOpen = useCallback((): void => {
    if (keyboardShortcutsOpenRef.current || documentConflictOpenRef.current) return
    if (!leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = undefined
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    quickOpenController.setQuery('')
    setQuickInputMode('files')
  }, [commands, leaveMutationSurface, quickOpenController])

  const showCommands = useCallback((): void => {
    if (keyboardShortcutsOpenRef.current || documentConflictOpenRef.current) return
    if (!leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = undefined
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    commands.palette.setQuery('')
    setQuickInputMode('commands')
  }, [commands, leaveMutationSurface])

  const showGoToLine = useCallback((): void => {
    const tab = documents.activeTab()
    if (keyboardShortcutsOpenRef.current || documentConflictOpenRef.current
      || tab === undefined || tab.readOnlyPresentation !== undefined) return
    if (!leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    setCommandNotice(undefined)
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = undefined
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    setLineQuery('')
    setQuickInputMode('line')
  }, [commands, documents, leaveMutationSurface])

  const showChangeEndOfLine = useCallback((): void => {
    const capture = (): NonNullable<typeof pendingEolTarget.current> => {
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      if (snapshot.activeWorkspaceId === undefined || tab === undefined) throw new Error('No active editor.')
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(snapshot.activeWorkspaceId, tab.path)) {
        throw new Error('The active editor is read-only.')
      }
      if (tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
        || tab.pendingConflictId !== undefined) {
        throw new Error('Another document operation is in progress.')
      }
      if (tab.saveOutcome === 'unknown') throw new Error('Check the uncertain save outcome first.')
      if (tab.externalState === 'deleted') throw new Error('The active file was deleted outside the IDE.')
      return {
        workspaceId: snapshot.activeWorkspaceId,
        workspaceEpoch: snapshot.activeWorkspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
        lineEnding: tab.lineEnding ?? '\n',
        localRevision: tab.localRevision,
        historyEpoch: tab.historyEpoch,
        version: tab.version,
      }
    }

    capture()
    if (keyboardShortcutsOpenRef.current || documentConflictOpenRef.current) return
    if (!leaveMutationSurface()) return
    const target = capture()
    commands.shortcuts.cancelPendingChord()
    setCommandNotice(undefined)
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = target
    pendingLanguageTarget.current = undefined
    setEolQuery('')
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    setEolActiveIndex(target.lineEnding === '\n' ? 1 : 0)
    setQuickInputMode('eol')
  }, [commands, documents, leaveMutationSurface])

  const showChangeLanguageMode = useCallback((): void => {
    const capture = (
      expected?: NonNullable<typeof pendingLanguageTarget.current>,
    ): NonNullable<typeof pendingLanguageTarget.current> => {
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (snapshot.activeWorkspaceId === undefined || tab === undefined) {
        throw new Error('No active editor.')
      }
      if (tab.readOnlyPresentation !== undefined) {
        throw new Error('The active file is a read-only preview.')
      }
      if (port === undefined
        || port.workspaceId !== snapshot.activeWorkspaceId
        || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId
        || port.historyEpoch !== tab.historyEpoch
        || expected !== undefined && (
          port !== expected.port
          || snapshot.activeWorkspaceId !== expected.workspaceId
          || snapshot.activeWorkspaceEpoch !== expected.workspaceEpoch
          || tab.path !== expected.path
          || tab.lifecycleId !== expected.lifecycleId
          || tab.historyEpoch !== expected.historyEpoch
        )) {
        throw new Error('The active editor changed before its language mode could be selected.')
      }
      return {
        port,
        workspaceId: snapshot.activeWorkspaceId,
        workspaceEpoch: snapshot.activeWorkspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
        historyEpoch: tab.historyEpoch,
        languageId: port.getSnapshot().languageId,
      }
    }

    const initial = capture()
    if (keyboardShortcutsOpenRef.current
      || editorCloseStore.getSnapshot().phase !== 'idle'
      || documentConflictStore.getSnapshot().phase !== 'idle') return
    if (!leaveMutationSurface()) return
    const target = capture(initial)
    commands.shortcuts.cancelPendingChord()
    setCommandNotice(undefined)
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = target
    setLanguageQuery('')
    pendingIndentationTarget.current = undefined
    setIndentationQuery('')
    setLanguageActiveIndex(Math.max(
      0,
      EDITOR_LANGUAGE_OPTIONS.findIndex(option => option.id === target.languageId),
    ))
    setQuickInputMode('language')
  }, [commands, documentConflictStore, documents, editorCloseStore, leaveMutationSurface])

  const showChangeIndentationSize = useCallback((): void => {
    const capture = (
      expected?: NonNullable<typeof pendingIndentationTarget.current>,
    ): NonNullable<typeof pendingIndentationTarget.current> => {
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (snapshot.activeWorkspaceId === undefined || tab === undefined || port === undefined
        || port.workspaceId !== snapshot.activeWorkspaceId
        || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId
        || port.historyEpoch !== tab.historyEpoch
        || expected !== undefined && (
          port !== expected.port
          || snapshot.activeWorkspaceId !== expected.workspaceId
          || snapshot.activeWorkspaceEpoch !== expected.workspaceEpoch
          || tab.path !== expected.path
          || tab.lifecycleId !== expected.lifecycleId
          || tab.historyEpoch !== expected.historyEpoch
        )) {
        throw new Error('The active editor changed before its indentation size could be selected.')
      }
      const current = port.getSnapshot().indentation
      return {
        port,
        workspaceId: snapshot.activeWorkspaceId,
        workspaceEpoch: snapshot.activeWorkspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
        historyEpoch: tab.historyEpoch,
        style: current.style,
        size: current.size,
      }
    }

    const initial = capture()
    if (keyboardShortcutsOpenRef.current
      || editorCloseStore.getSnapshot().phase !== 'idle'
      || documentConflictStore.getSnapshot().phase !== 'idle') return
    if (!leaveMutationSurface()) return
    const target = capture(initial)
    commands.shortcuts.cancelPendingChord()
    setCommandNotice(undefined)
    setExplorerPortalDismissRequest(value => value + 1)
    if (quickInputModeRef.current === 'none' && document.activeElement instanceof HTMLElement) {
      quickInputInvoker.current = document.activeElement
      quickInputOriginPanel.current = compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    }
    pendingEolTarget.current = undefined
    setEolQuery('')
    pendingLanguageTarget.current = undefined
    setLanguageQuery('')
    pendingIndentationTarget.current = target
    setIndentationQuery('')
    setIndentationActiveIndex(target.size - 1)
    setQuickInputMode('indentation')
  }, [commands, documentConflictStore, documents, editorCloseStore, leaveMutationSurface])

  const showKeyboardShortcuts = useCallback((): void => {
    if (keyboardShortcutsOpenRef.current || documentConflictOpenRef.current || !leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    setCommandNotice(undefined)
    setExplorerPortalDismissRequest(value => value + 1)
    const quickInputActive = quickInputModeRef.current !== 'none'
    const invoker = quickInputActive
      ? quickInputInvoker.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (invoker !== undefined) keyboardShortcutsInvoker.current = invoker
    keyboardShortcutsOriginPanel.current = quickInputActive
      ? quickInputOriginPanel.current
      : compactRef.current && compactPanelRef.current !== 'none'
        ? compactPanelRef.current
        : undefined
    // Fence QuickInput's deferred restore before closing it. The shortcuts
    // dialog owns the original invoker until its own final dismissal.
    keyboardShortcutsOpenRef.current = true
    setKeyboardShortcutsOpen(true)
    setQuickInputMode('none')
    quickOpenController.setQuery('')
    commands.palette.setQuery('')
    setLineQuery('')
    setEolQuery('')
    pendingEolTarget.current = undefined
    setLanguageQuery('')
    pendingLanguageTarget.current = undefined
    setIndentationQuery('')
    pendingIndentationTarget.current = undefined
    pendingCompactFocusTarget.current = undefined
    compactPanelInvoker.current = undefined
    if (compactPanelRef.current !== 'none') setCompactPanel('none')
  }, [commands, leaveMutationSurface, quickOpenController])

  const openCompactPanel = useCallback((panel: 'rail' | 'harness'): void => {
    if (!compact) return
    setExplorerPortalDismissRequest(value => value + 1)
    if (compactPanelRef.current === 'none') {
      const invoker = quickInputModeRef.current === 'none'
        ? document.activeElement instanceof HTMLElement ? document.activeElement : undefined
        : quickInputInvoker.current
      if (invoker !== undefined) compactPanelInvoker.current = invoker
    }
    setCompactPanel(panel)
  }, [compact])

  const commitLayoutGeometry = useCallback((update: Partial<LayoutGeometry>): void => {
    const next = { ...desiredLayoutGeometry.current, ...update }
    desiredLayoutGeometry.current = next
    writeLayoutGeometry(next)
  }, [])

  useEffect(() => {
    if (compact) return
    const fit = (): void => {
      const bounds = frame.current?.getBoundingClientRect()
      const desired = desiredLayoutGeometry.current
      if (embeddedMode) {
        setExplorerWidth(fitExplorerPane(
          desired.explorerWidth,
          bounds?.width ?? window.innerWidth,
        ))
      } else {
        const [nextExplorer, nextHarness] = fitSidePanes(
          desired.explorerWidth,
          desired.harnessWidth,
          bounds?.width ?? window.innerWidth,
        )
        setExplorerWidth(nextExplorer)
        setHarnessWidth(nextHarness)
      }
      setTerminalHeight(clamp(
        desired.terminalHeight,
        TERMINAL_MIN,
        Math.max(TERMINAL_MIN, (bounds?.height ?? window.innerHeight) - 180),
      ))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit) }
  }, [compact, embeddedMode])

  const compactFocusDestination = useCallback((target: 'files' | 'harness'): HTMLElement | null => (
    target === 'harness' ? compactHarnessButton.current : compactFilesButton.current
  ), [])

  const focusAvailableTarget = useCallback((target: HTMLElement | null | undefined): boolean => {
    if (target === document.body || target === document.documentElement || !isComposedFocusTarget(target)) return false
    target.focus()
    return document.activeElement === target || target.contains(document.activeElement)
  }, [])

  const restoreHiddenCompactFocus = useCallback((): void => {
    const active = document.activeElement
    if (compactRef.current && active instanceof Element) {
      const panel = compactPanelRef.current
      const openDrawerTarget = panel === 'rail' && harnessPanel.current?.contains(active) === true
        ? explorerClose.current
        : panel === 'harness' && explorerPanel.current?.contains(active) === true
          ? harnessClose.current
          : undefined
      if (focusAvailableTarget(openDrawerTarget)) {
        pendingCompactFocusTarget.current = undefined
        return
      }
    }
    const target = pendingCompactFocusTarget.current ?? hiddenCompactFocusTarget(
      compactRef.current,
      compactPanelRef.current,
      active,
      explorerPanel.current,
      harnessPanel.current,
    )
    if (target !== undefined && focusAvailableTarget(compactFocusDestination(target))) {
      pendingCompactFocusTarget.current = undefined
    }
  }, [compactFocusDestination, focusAvailableTarget])

  const scheduleHiddenCompactFocusRestore = useCallback((): void => {
    restoreHiddenCompactFocus()
    queueMicrotask(restoreHiddenCompactFocus)
    window.requestAnimationFrame(restoreHiddenCompactFocus)
    window.setTimeout(restoreHiddenCompactFocus, 100)
    window.setTimeout(restoreHiddenCompactFocus, 500)
  }, [restoreHiddenCompactFocus])

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent): void => {
      if (!compactRef.current || !(event.target instanceof Element)) return
      const panel = compactPanelRef.current
      const hiddenRailFocused = panel !== 'rail' && explorerPanel.current?.contains(event.target) === true
      const hiddenHarnessFocused = panel !== 'harness' && harnessPanel.current?.contains(event.target) === true
      if (!hiddenRailFocused && !hiddenHarnessFocused) return
      if (panel === 'none') pendingCompactFocusTarget.current = hiddenHarnessFocused ? 'harness' : 'files'
      scheduleHiddenCompactFocusRestore()
    }
    document.addEventListener('focusin', handleFocusIn, true)
    return () => { document.removeEventListener('focusin', handleFocusIn, true) }
  }, [scheduleHiddenCompactFocusRestore])

  useLayoutEffect(() => {
    const frameInert = !bootReady || quickInputMode !== 'none' || keyboardShortcutsOpen
      || safetyModalOpen || editorCloseModalOpen || documentConflictModalOpen
    const workbenchInert = safetyModalOpen || editorCloseModalOpen || documentConflictModalOpen
      || compact && compactPanel !== 'none'
    const railHidden = compact && compactPanel !== 'rail'
    const harnessHidden = compact && compactPanel !== 'harness'
    // Mutation dialogs are body portals owned by Explorer. If responsive
    // layout hides the rail while the portal owns focus, retain an explicit
    // visible handoff until the modal closes and the frame becomes focusable.
    if (!compact) {
      pendingCompactFocusTarget.current = undefined
    } else if (safetyModalOpen && compactPanel === 'none') {
      pendingCompactFocusTarget.current = 'files'
    }
    const active = document.activeElement
    const handoff = pendingCompactFocusTarget.current ?? hiddenCompactFocusTarget(
      compact,
      compactPanel,
      active,
      explorerPanel.current,
      harnessPanel.current,
    )
    const drawerHandoff = compact && active instanceof Element
      ? compactPanel === 'rail' && harnessPanel.current?.contains(active) === true
        ? explorerClose.current
        : compactPanel === 'harness' && explorerPanel.current?.contains(active) === true
          ? harnessClose.current
          : undefined
      : undefined

    // Make the destination's complete ancestor chain focusable first. Only
    // then move focus and hide the closing drawer. This ordering avoids both
    // inert focus rejection and aria-hidden-with-focused-descendant warnings.
    if (!frameInert) frame.current?.removeAttribute('inert')
    if (!workbenchInert) workbench.current?.removeAttribute('inert')
    if (!railHidden) {
      explorerPanel.current?.removeAttribute('inert')
      explorerPanel.current?.removeAttribute('aria-hidden')
    }
    if (!harnessHidden) {
      harnessPanel.current?.removeAttribute('inert')
      harnessPanel.current?.removeAttribute('aria-hidden')
    }
    if (!frameInert) {
      if (focusAvailableTarget(drawerHandoff)) {
        pendingCompactFocusTarget.current = undefined
      } else if (!workbenchInert && handoff !== undefined
        && focusAvailableTarget(compactFocusDestination(handoff))) {
        pendingCompactFocusTarget.current = undefined
      }
    }
    explorerPanel.current?.toggleAttribute('inert', railHidden)
    harnessPanel.current?.toggleAttribute('inert', harnessHidden)
    if (railHidden) explorerPanel.current?.setAttribute('aria-hidden', 'true')
    else explorerPanel.current?.removeAttribute('aria-hidden')
    if (harnessHidden) harnessPanel.current?.setAttribute('aria-hidden', 'true')
    else harnessPanel.current?.removeAttribute('aria-hidden')
    workbench.current?.toggleAttribute('inert', workbenchInert)
    frame.current?.toggleAttribute('inert', frameInert)
  }, [bootReady, compact, compactFocusDestination, compactPanel, documentConflictModalOpen, editorCloseModalOpen, focusAvailableTarget, keyboardShortcutsOpen, quickInputMode, safetyModalOpen])

  useLayoutEffect(() => {
    if (!compact || compactPanel !== 'none') return
    restoreHiddenCompactFocus()
    const handle = window.requestAnimationFrame(restoreHiddenCompactFocus)
    return () => { window.cancelAnimationFrame(handle) }
  }, [compact, compactPanel, restoreHiddenCompactFocus])

  const closeCompactPanel = useCallback((): void => {
    if (compactPanelRef.current === 'none') return
    if (!leaveMutationSurface()) return
    setExplorerPortalDismissRequest(value => value + 1)
    pendingCompactFocusTarget.current = compactPanelRef.current === 'harness' ? 'harness' : 'files'
    setCompactPanel('none')
    const invoker = compactPanelInvoker.current
    compactPanelInvoker.current = undefined
    window.requestAnimationFrame(() => {
      if (!focusAvailableTarget(invoker)) restoreHiddenCompactFocus()
    })
  }, [focusAvailableTarget, leaveMutationSurface, restoreHiddenCompactFocus])

  const showExplorer = useCallback((requestTreeFocus = true): void => {
    if (quickInputModeRef.current !== 'none') quickInputRestoreTarget.current = 'explorer'
    setRailView('explorer')
    if (compact) openCompactPanel('rail')
    if (requestTreeFocus) setExplorerFocusRequest(value => (value ?? 0) + 1)
  }, [compact, openCompactPanel])

  const showSearch = useCallback((): void => {
    if (!leaveMutationSurface()) return
    if (quickInputModeRef.current !== 'none') quickInputRestoreTarget.current = 'search'
    setRailView('search')
    if (compact) openCompactPanel('rail')
    setSearchFocusRequest(value => value + 1)
  }, [compact, leaveMutationSurface, openCompactPanel])

  const focusHarness = useCallback((): void => {
    if (embeddedMode) {
      setCommandNotice({
        kind: 'status',
        message: 'Harness remains available in the surrounding conversation view.',
      })
      return
    }
    if (!leaveMutationSurface()) return
    if (quickInputModeRef.current !== 'none') quickInputRestoreTarget.current = 'harness'
    if (compact) openCompactPanel('harness')
    else harnessFrame.current?.focus()
  }, [compact, embeddedMode, leaveMutationSurface, openCompactPanel])

  const requestEditorSurfaceFocus = useCallback((): void => {
    setEditorFocusRequest(++editorPresentationSequence.current)
  }, [])

  const currentTerminalCommandTarget = useCallback((): TerminalCommandTarget | undefined => {
    const selected = documents.getSnapshot()
    const command = terminalCommandBinding.current?.port.getSnapshot()
    if (selected.activeWorkspaceId === undefined
      || command?.workspaceId !== selected.activeWorkspaceId
      || command.workspaceEpoch !== selected.activeWorkspaceEpoch) return undefined
    return command.active
  }, [documents])

  const requestTerminalSurfaceFocus = useCallback((expected?: TerminalCommandTarget): boolean => {
    const target = currentTerminalCommandTarget()
    if (target === undefined || expected !== undefined && !sameTerminalCommandTarget(target, expected)) return false
    setTerminalFocusRequest({
      ...target,
      requestId: ++editorPresentationSequence.current,
    })
    return true
  }, [currentTerminalCommandTarget])

  const defaultWorkbenchFocusTarget = useCallback((): HTMLElement | null | undefined => {
    if (compactRef.current) {
      if (compactPanelRef.current === 'harness') return harnessFrame.current ?? harnessClose.current
      if (compactPanelRef.current === 'rail') {
        return railView === 'search'
          ? document.querySelector<HTMLInputElement>('[data-workbench-focus="search-query"]') ?? explorerClose.current
          : document.querySelector<HTMLElement>('[data-workbench-focus="explorer-edit"]')
            ?? document.querySelector<HTMLElement>('[data-workbench-focus="explorer"]')
            ?? explorerClose.current
      }
      return compactFilesButton.current
    }
    return railView === 'search'
      ? document.querySelector<HTMLInputElement>('[data-workbench-focus="search-query"]')
        ?? document.querySelector<HTMLElement>('[data-workbench-focus="explorer"]')
        ?? harnessFrame.current
      : document.querySelector<HTMLElement>('[data-workbench-focus="explorer-edit"]')
        ?? document.querySelector<HTMLElement>('[data-workbench-focus="explorer"]')
        ?? harnessFrame.current
  }, [railView])

  const restoreQuickInputFocus = useCallback((): void => {
    const target = quickInputRestoreTarget.current
    const disposition = quickInputRestoreDisposition(
      target,
      keyboardShortcutsOpenRef.current,
      editorCloseStore.getSnapshot().phase === 'idle'
        && documentConflictStore.getSnapshot().phase === 'idle',
    )
    if (disposition === 'clear') {
      pendingQuickInputTerminalFocus.current = undefined
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      quickInputRestoreTarget.current = 'default'
      return
    }
    quickInputRestoreTarget.current = 'default'
    const pendingTerminal = pendingQuickInputTerminalFocus.current
    if (pendingTerminal !== undefined) {
      pendingQuickInputTerminalFocus.current = undefined
      if (requestTerminalSurfaceFocus(pendingTerminal)) {
        quickInputInvoker.current = undefined
        quickInputOriginPanel.current = undefined
        return
      }
    }
    if (disposition === 'editor') {
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      requestEditorSurfaceFocus()
      return
    }
    let destination: HTMLElement | null | undefined
    if (target === 'harness' || compactPanelRef.current === 'harness') {
      destination = harnessFrame.current
    } else if (target === 'search' || compactPanelRef.current === 'rail' && railView === 'search') {
      destination = document.querySelector<HTMLInputElement>('[data-workbench-focus="search-query"]')
    } else if (target === 'explorer' || compactPanelRef.current === 'rail') {
      destination = document.querySelector<HTMLElement>('[data-workbench-focus="explorer-edit"]')
        ?? document.querySelector<HTMLElement>('[data-workbench-focus="explorer"]')
        ?? (compactPanelRef.current === 'rail' ? explorerClose.current : undefined)
    }
    const invoker = quickInputInvoker.current
    const origin = quickInputOriginPanel.current
    let restored = focusAvailableTarget(destination) || focusAvailableTarget(invoker)
    if (!restored && compactRef.current) {
      const originFallback = origin === 'harness' ? 'harness' : origin === 'rail' ? 'files' : undefined
      if (originFallback !== undefined) restored = focusAvailableTarget(compactFocusDestination(originFallback))
    }
    if (!restored) focusAvailableTarget(defaultWorkbenchFocusTarget())
    quickInputInvoker.current = undefined
    quickInputOriginPanel.current = undefined
  }, [compactFocusDestination, defaultWorkbenchFocusTarget, documentConflictStore, documents, editorCloseStore, focusAvailableTarget, railView, requestEditorSurfaceFocus, requestTerminalSurfaceFocus])

  const restoreKeyboardShortcutsFocus = useCallback((): void => {
    if (keyboardShortcutsOpenRef.current) return
    const invoker = keyboardShortcutsInvoker.current
    const origin = keyboardShortcutsOriginPanel.current
    let restored = focusAvailableTarget(invoker)
    if (!restored && compactRef.current && origin !== undefined) {
      restored = focusAvailableTarget(compactFocusDestination(origin === 'harness' ? 'harness' : 'files'))
    }
    if (!restored) focusAvailableTarget(defaultWorkbenchFocusTarget())
    keyboardShortcutsInvoker.current = undefined
    keyboardShortcutsOriginPanel.current = undefined
  }, [compactFocusDestination, defaultWorkbenchFocusTarget, focusAvailableTarget])

  const restoreInvalidMutationRecoveryFocus = useCallback((): void => {
    const invoker = invalidMutationRecoveryInvoker.current
    if (!focusAvailableTarget(invoker)) focusAvailableTarget(defaultWorkbenchFocusTarget())
    invalidMutationRecoveryInvoker.current = undefined
  }, [defaultWorkbenchFocusTarget, focusAvailableTarget])

  const restoreWorkbenchRecoveryFocus = useCallback((): void => {
    const invoker = workbenchRecoveryInvoker.current
    if (!focusAvailableTarget(invoker)) focusAvailableTarget(defaultWorkbenchFocusTarget())
    workbenchRecoveryInvoker.current = undefined
  }, [defaultWorkbenchFocusTarget, focusAvailableTarget])

  useEffect(() => {
    if (!compact || compactPanel === 'none') return
    const handle = window.requestAnimationFrame(() => {
      if (compactPanel === 'harness') harnessFrame.current?.focus()
      else if (railView === 'explorer') {
        const target = document.querySelector<HTMLElement>('[data-workbench-focus="explorer-edit"]')
          ?? document.querySelector<HTMLElement>('[data-workbench-focus="explorer"]')
        if (target?.isConnected === true) target.focus()
        else explorerClose.current?.focus()
      } else {
        const target = document.querySelector<HTMLInputElement>('[data-workbench-focus="search-query"]')
        if (target?.isConnected === true) target.focus()
        else explorerClose.current?.focus()
      }
    })
    return () => { window.cancelAnimationFrame(handle) }
  }, [compact, compactPanel, railView])

  useEffect(() => {
    if (compact || compactPanelInvoker.current === undefined) return
    const invoker = compactPanelInvoker.current
    compactPanelInvoker.current = undefined
    const handle = window.requestAnimationFrame(() => { focusAvailableTarget(invoker) })
    return () => { window.cancelAnimationFrame(handle) }
  }, [compact, focusAvailableTarget])

  const handleInvalidations = useCallback((
    observedWorkspace: string,
    observedEpoch: number,
    invalidations: readonly WorkspaceInvalidation[],
  ) => {
    const documentIdentity = documents.getSnapshot()
    const explorerIdentity = explorerStore.getSnapshot()
    if (documentIdentity.activeWorkspaceId !== observedWorkspace
      || documentIdentity.activeWorkspaceEpoch !== observedEpoch
      || explorerIdentity.activeWorkspaceId !== observedWorkspace
      || explorerIdentity.activeWorkspaceEpoch !== observedEpoch) return
    void documentController.reconcileFileInvalidations(observedWorkspace, invalidations)

    const directories = reconcileDirectories(invalidations)
    if (directories.removedPaths.length > 0) explorerController.pruneRemoved(directories.removedPaths)
    if (directories.refreshPaths.length > 0) void explorerController.refreshDirectories(directories.refreshPaths)
  }, [documentController, documents, explorerController, explorerStore])

  useWorkspaceCoherence({
    workspaceId: bootReady ? workspaceId : undefined,
    workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
    targets: observationTargets,
    onInvalidations: handleInvalidations,
    onObserved: (observedWorkspace, observedEpoch) => {
      const current = documents.getSnapshot()
      if (current.activeWorkspaceId === observedWorkspace && current.activeWorkspaceEpoch === observedEpoch) {
        setCoherenceError(undefined)
      }
    },
    onError: (observedWorkspace, observedEpoch, error) => {
      const current = documents.getSnapshot()
      if (current.activeWorkspaceId === observedWorkspace && current.activeWorkspaceEpoch === observedEpoch) {
        setCoherenceError(error instanceof Error ? error.message : String(error))
      }
    },
  })

  const openFile = useCallback(async (entry: FileEntry) => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined || entry.type !== 'file') return
    const generation = ++explorerOpenGeneration.current
    setOpenError(undefined)
    try {
      await navigation.openPath(selectedWorkspace, entry.path)
    } catch (error) {
      if (generation === explorerOpenGeneration.current
        && documents.getSnapshot().activeWorkspaceId === selectedWorkspace) {
        setOpenError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [documents, navigation])

  const openQuickOption = useCallback(async (option: QuickOpenOption) => {
    const documentBefore = documents.getSnapshot()
    const quickBefore = quickOpenStore.getSnapshot()
    const selectedWorkspace = documentBefore.activeWorkspaceId
    if (selectedWorkspace === undefined || quickBefore.workspaceId !== selectedWorkspace) return
    const documentWorkspaceEpoch = documentBefore.activeWorkspaceEpoch
    const quickWorkspaceEpoch = quickBefore.workspaceEpoch
    const requestGeneration = quickBefore.requestGeneration
    const generation = ++quickOpenGeneration.current
    setOpenError(undefined)
    setCommandNotice(undefined)
    const acceptsCompletion = (): boolean => {
      const documentCurrent = documents.getSnapshot()
      const quickCurrent = quickOpenStore.getSnapshot()
      return generation === quickOpenGeneration.current
        && quickInputModeRef.current === 'files'
        && documentCurrent.activeWorkspaceId === selectedWorkspace
        && documentCurrent.activeWorkspaceEpoch === documentWorkspaceEpoch
        && quickCurrent.workspaceId === selectedWorkspace
        && quickCurrent.workspaceEpoch === quickWorkspaceEpoch
        && quickCurrent.requestGeneration === requestGeneration
    }
    try {
      if (option.location === undefined) {
        if (!await navigation.openPath(selectedWorkspace, option.path)) return
      } else {
        const result = await navigation.openPathAtLocation(
          selectedWorkspace,
          option.path,
          option.location,
          acceptsCompletion,
        )
        if (!acceptsCompletion() || result === 'stale') return
        if (result !== 'revealed') {
          setCommandNotice({
            kind: 'error',
            message: result === 'invalid'
              ? 'That line does not exist in the selected file.'
              : 'The selected file changed. Search for it again.',
          })
          return
        }
      }
      if (!acceptsCompletion()) return
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      setQuickInputMode('none')
      quickOpenController.setQuery('')
      if (compact) setCompactPanel('none')
    } catch (error) {
      if (acceptsCompletion()) {
        const message = error instanceof Error ? error.message : String(error)
        setOpenError(message)
        setCommandNotice({ kind: 'error', message })
      }
    }
  }, [compact, documents, navigation, quickOpenController, quickOpenStore])

  const openWorkspaceSearchItem = useCallback(async (
    item: WorkspaceSearchItem,
    itemIndex: number,
  ): Promise<boolean> => {
    const documentBefore = documents.getSnapshot()
    const searchBefore = workspaceSearchStore.getSnapshot()
    const selectedWorkspace = documentBefore.activeWorkspaceId
    if (selectedWorkspace === undefined || searchBefore.activeWorkspaceId !== selectedWorkspace) return false
    const sessionBefore = workspaceSearchStore.session(selectedWorkspace)
    if (sessionBefore.status !== 'complete' || sessionBefore.items[itemIndex] !== item) return false
    const documentWorkspaceEpoch = documentBefore.activeWorkspaceEpoch
    const searchWorkspaceEpoch = searchBefore.activeWorkspaceEpoch
    const requestGeneration = sessionBefore.requestGeneration
    const generation = ++searchOpenGeneration.current
    const acceptsCompletion = (): boolean => {
      const documentCurrent = documents.getSnapshot()
      const searchCurrent = workspaceSearchStore.getSnapshot()
      const sessionCurrent = workspaceSearchStore.session(selectedWorkspace)
      return generation === searchOpenGeneration.current
        && documentCurrent.activeWorkspaceId === selectedWorkspace
        && documentCurrent.activeWorkspaceEpoch === documentWorkspaceEpoch
        && searchCurrent.activeWorkspaceId === selectedWorkspace
        && searchCurrent.activeWorkspaceEpoch === searchWorkspaceEpoch
        && sessionCurrent.status === 'complete'
        && sessionCurrent.requestGeneration === requestGeneration
        && sessionCurrent.items[itemIndex] === item
    }
    setOpenError(undefined)
    try {
      const result = await navigation.openSearchMatch(selectedWorkspace, item, acceptsCompletion)
      if (!acceptsCompletion()) return false
      if (result === 'stale') return false
      if (result === 'failed') {
        setOpenError('The search result is stale. Refresh the search and try again.')
        return false
      }
      if (workspaceSearchStore.selectIndex(itemIndex, selectedWorkspace) !== item) return false
      if (compact) {
        if (compactPanelRef.current !== 'none') {
          pendingCompactFocusTarget.current = compactPanelRef.current === 'harness' ? 'harness' : 'files'
        }
        setCompactPanel('none')
      }
      return true
    } catch (error) {
      if (acceptsCompletion()) {
        setOpenError(error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }, [compact, documents, navigation, workspaceSearchStore])

  const openSearchResult = useCallback(async (view: WorkspaceSearchMatchView) => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    const indexed = searchView.items.get(view.id)
    if (selectedWorkspace === undefined || indexed === undefined) return
    const searchSnapshot = workspaceSearchStore.getSnapshot()
    const searchSession = workspaceSearchStore.session(selectedWorkspace)
    if (searchSnapshot.activeWorkspaceId !== selectedWorkspace
      || searchSession.status !== 'complete'
      || searchSession.items[indexed.index] !== indexed.item) return
    await openWorkspaceSearchItem(indexed.item, indexed.index)
  }, [documents, openWorkspaceSearchItem, searchView.items, workspaceSearchStore])

  const updateSearchQuery = useCallback((update: Partial<WorkspaceTextSearchQuery>) => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined) return
    searchOpenGeneration.current += 1
    workspaceSearchController.cancel()
    workspaceReplaceController.cancel()
    setSearchDraftError(undefined)
    workspaceSearchStore.setDraft(selectedWorkspace, { ...workspaceSearchStore.session(selectedWorkspace).query, ...update })
  }, [documents, workspaceReplaceController, workspaceSearchController, workspaceSearchStore])

  const splitGlobs = (value: string): string[] | undefined => {
    const patterns = value.split(',').map(pattern => pattern.trim()).filter(Boolean)
    return patterns.length === 0 ? undefined : patterns
  }

  const sameGlobs = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean => (
    (left ?? []).join('\0') === (right ?? []).join('\0')
  )
  const replacePreviewEligible = workspaceId !== undefined
    && workspaceSearchSnapshot.activeWorkspaceId === workspaceId
    && workspaceReplaceSnapshot.activeWorkspaceId === workspaceId
    && workspaceSearchSession.status === 'complete'
    && workspaceSearchSession.items.length > 0
    && workspaceSearchSession.matchCount > 0
    && workspaceSearchSession.query.pattern.trim().length > 0
    && workspaceSearchSession.query.mode === 'literal'
    && !workspaceSearchSession.truncated
    && !workspaceSearchSession.dirtyBuffersOmitted
    && workspaceSearchSession.error === undefined
    && searchDraftError === undefined
    && sameGlobs(workspaceSearchSession.query.include, splitGlobs(searchIncludeDraft))
    && sameGlobs(workspaceSearchSession.query.exclude, splitGlobs(searchExcludeDraft))

  const updateSearchFilterDrafts = (includeDraft: string, excludeDraft: string): void => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined) return
    searchOpenGeneration.current += 1
    setSearchDraftError(undefined)
    workspaceSearchController.cancel()
    workspaceReplaceController.cancel()
    setSearchIncludeDraft(includeDraft)
    setSearchExcludeDraft(excludeDraft)
    searchFilterDrafts.current.set(selectedWorkspace, { include: includeDraft, exclude: excludeDraft })
    const current = workspaceSearchStore.session(selectedWorkspace).query
    const include = splitGlobs(includeDraft)
    const exclude = splitGlobs(excludeDraft)
    const { include: _oldInclude, exclude: _oldExclude, ...base } = current
    workspaceSearchStore.setDraft(selectedWorkspace, {
      ...base,
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
    })
  }

  const runWorkspaceSearch = (): void => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined) return
    searchOpenGeneration.current += 1
    workspaceReplaceController.cancel()
    const current = workspaceSearchStore.session(selectedWorkspace).query
    const include = splitGlobs(searchIncludeDraft)
    const exclude = splitGlobs(searchExcludeDraft)
    const { include: _oldInclude, exclude: _oldExclude, ...base } = current
    const query: WorkspaceTextSearchQuery = {
      ...base,
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
    }
    try {
      validateSearchGlobs(query.include, 'include')
      validateSearchGlobs(query.exclude, 'exclude')
    } catch {
      setSearchDraftError('Search pattern or file glob is invalid.')
      return
    }
    setSearchDraftError(undefined)
    void workspaceSearchController.run(query)
  }

  const clearWorkspaceSearch = (): void => {
    searchOpenGeneration.current += 1
    workspaceSearchController.cancel()
    workspaceReplaceController.cancel()
    // A draft glob error is page-local and can outlive workspace deselection;
    // Clear must still dismiss that projection even when no domain session is active.
    setSearchDraftError(undefined)
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined
      || workspaceSearchStore.getSnapshot().activeWorkspaceId !== selectedWorkspace
      || !workspaceSearchStore.clear(selectedWorkspace)) return
  }

  const activeReveal = workspaceId !== undefined && activeTab !== undefined && revealRequest !== undefined
    ? navigation.revealFor({
        workspaceId,
        path: activeTab.path,
        lifecycleId: activeTab.lifecycleId,
        historyEpoch: activeTab.historyEpoch,
        localRevision: activeTab.localRevision,
      })
    : undefined

  useEffect(() => {
    if (workspaceId === undefined || activeTab === undefined) {
      explorerController.setSelected(undefined)
      return
    }
    void explorerController.revealPath(activeTab.path, { select: true, focus: false })
  }, [activeTab?.lifecycleId, activeTab?.path, explorerController, workspaceId])

  const save = useCallback(async (): Promise<SaveResult> => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    const selectedTab = documents.activeTab()
    if (selectedWorkspace === undefined || selectedTab === undefined) return 'not-needed'
    return documentController.save(selectedWorkspace, selectedTab.path)
  }, [documentController, documents])

  const saveAll = useCallback(async (): Promise<void> => {
    const summary = await documentController.saveAll()
    if (summary === undefined || summary.totalDirty === 0) {
      setCommandNotice({ kind: 'status', message: 'No editors have unsaved changes.' })
      return
    }
    const unfinished = summary.blocked + summary.conflicts + summary.failed + summary.unknown + summary.stale
    if (unfinished === 0) {
      setCommandNotice({
        kind: 'status',
        message: `Saved ${summary.saved} ${summary.saved === 1 ? 'file' : 'files'}.`,
      })
      return
    }
    const details = [
      summary.saved > 0 ? `${summary.saved} saved` : undefined,
      summary.blocked > 0 ? `${summary.blocked} blocked` : undefined,
      summary.conflicts > 0 ? `${summary.conflicts} conflicted` : undefined,
      summary.failed > 0 ? `${summary.failed} failed` : undefined,
      summary.unknown > 0 ? `${summary.unknown} uncertain` : undefined,
      summary.stale > 0 ? `${summary.stale} stale` : undefined,
    ].filter((detail): detail is string => detail !== undefined)
    setCommandNotice({
      kind: 'error',
      message: `Save All finished: ${details.join(', ')}. Unsaved editors were preserved.`,
    })
  }, [documentController])

  const reconcileUnknownSave = useCallback(async () => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    const tab = documents.activeTab()
    if (selectedWorkspace === undefined || tab === undefined || tab.saveOutcome !== 'unknown') return
    try {
      await documentController.reconcileUnknownSave(selectedWorkspace, tab.path, tab.lifecycleId)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [documentController, documents])

  const recreateDeleted = useCallback(async (): Promise<SaveResult> => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    const tab = documents.activeTab()
    if (selectedWorkspace === undefined || tab === undefined || tab.externalState !== 'deleted') return 'not-needed'
    return await documentController.recreateDeleted(selectedWorkspace, tab.path)
  }, [documentController, documents])

  const prepareEditorCommandFocus = useCallback(() => prepareEditorFocusCommand({
    keyboardShortcutsOpen: keyboardShortcutsOpenRef.current,
    editorCloseIdle: editorCloseStore.getSnapshot().phase === 'idle',
    documentConflictIdle: documentConflictStore.getSnapshot().phase === 'idle',
    quickInputActive: quickInputModeRef.current !== 'none',
    compactPanel: compactPanelRef.current,
  }, {
    leaveMutationSurface,
    cancelPendingChord: () => { commands.shortcuts.cancelPendingChord() },
    dismissPortals: () => { setExplorerPortalDismissRequest(value => value + 1) },
    claimQuickInputEditorRestore: () => {
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
    },
    closeQuickInput: () => {
      setQuickInputMode('none')
      quickOpenController.setQuery('')
      commands.palette.setQuery('')
      setLineQuery('')
      setEolQuery('')
      pendingEolTarget.current = undefined
      setLanguageQuery('')
      pendingLanguageTarget.current = undefined
      setIndentationQuery('')
      pendingIndentationTarget.current = undefined
    },
    clearCompactRestoreOwner: () => {
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
    },
    closeCompactPanel: () => { setCompactPanel('none') },
  }), [commands, documentConflictStore, editorCloseStore, leaveMutationSurface, quickOpenController])

  const writeClipboard = useCallback(async (value: string): Promise<void> => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      throw new Error('Clipboard writing is unavailable in this browser context.')
    }
    await clipboard.writeText(value)
  }, [])

  const copyRelativePathOfActiveFile = useCallback(async (): Promise<void> => {
    const capture = (): DocumentIdentity => {
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      if (snapshot.activeWorkspaceId === undefined || tab === undefined) {
        throw new Error('No active editor.')
      }
      return {
        workspaceId: snapshot.activeWorkspaceId,
        workspaceEpoch: snapshot.activeWorkspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
      }
    }
    const isCurrent = (expected: DocumentIdentity): boolean => {
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      return snapshot.activeWorkspaceId === expected.workspaceId
        && snapshot.activeWorkspaceEpoch === expected.workspaceEpoch
        && tab?.path === expected.path
        && tab.lifecycleId === expected.lifecycleId
    }

    const target = capture()
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') throw new Error('Finish the active editor dialog first.')
    if (!isCurrent(target)) {
      throw new Error('The active editor changed before its relative path could be copied.')
    }
    await writeClipboard(target.path)
    setCommandNotice({ kind: 'status', message: 'Copied relative path.' })
  }, [documents, prepareEditorCommandFocus, writeClipboard])

  const revertActive = useCallback(async (): Promise<RevertResult> => {
    const snapshot = documents.getSnapshot()
    const tab = documents.activeTab()
    if (snapshot.activeWorkspaceId === undefined || tab === undefined) return 'not-needed'
    const identity: DocumentIdentity = {
      workspaceId: snapshot.activeWorkspaceId,
      workspaceEpoch: snapshot.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    }
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') return 'not-needed'
    const result = await documentController.revert(identity)
    if (result !== 'reverted' || focusAdmission !== 'immediate') return result
    const current = documents.getSnapshot()
    const currentTab = documents.activeTab()
    if (current.activeWorkspaceId === identity.workspaceId
      && current.activeWorkspaceEpoch === identity.workspaceEpoch
      && currentTab?.path === identity.path && currentTab.lifecycleId === identity.lifecycleId) {
      requestEditorSurfaceFocus()
    }
    return result
  }, [documentController, documents, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const publishEditorHistoryPort = useCallback((groupId: string, port: EditorHistoryPort): (() => void) => {
    editorHistoryBindings.current.get(groupId)?.unsubscribe()
    const token = {}
    const notify = (): void => {
      if (editorHistoryBindings.current.get(groupId)?.token === token
        && editorGroups.getSnapshot().activeGroupId === groupId) {
        setEditorHistoryRevision(value => value + 1)
      }
    }
    const unsubscribe = port.subscribe(notify)
    const binding = { token, port, unsubscribe }
    editorHistoryBindings.current.set(groupId, binding)
    if (editorGroups.getSnapshot().activeGroupId === groupId) {
      editorHistoryBinding.current = binding
      setEditorHistoryRevision(value => value + 1)
    }
    return () => {
      const current = editorHistoryBindings.current.get(groupId)
      if (current?.token !== token) return
      current.unsubscribe()
      editorHistoryBindings.current.delete(groupId)
      if (editorHistoryBinding.current?.token === token) {
        editorHistoryBinding.current = undefined
        setEditorHistoryRevision(value => value + 1)
      }
    }
  }, [editorGroups])

  const publishTerminalCommandPort = useCallback((port: TerminalCommandPort): (() => void) => {
    terminalCommandBinding.current?.unsubscribe()
    const token = {}
    const notify = (): void => {
      if (terminalCommandBinding.current?.token === token) {
        setTerminalCommandRevision(value => value + 1)
      }
    }
    const unsubscribe = port.subscribe(notify)
    terminalCommandBinding.current = { token, port, unsubscribe }
    setTerminalCommandRevision(value => value + 1)
    return () => {
      const current = terminalCommandBinding.current
      if (current?.token !== token) return
      current.unsubscribe()
      terminalCommandBinding.current = undefined
      setTerminalCommandRevision(value => value + 1)
    }
  }, [])

  const applyActiveEditorHistory = useCallback((operation: 'undo' | 'redo'): void => {
    const resolve = (): EditorHistoryPort => {
      const current = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (current.activeWorkspaceId === undefined || tab === undefined || port === undefined
        || port.workspaceId !== current.activeWorkspaceId || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId || port.historyEpoch !== tab.historyEpoch) {
        throw new Error('The active editor changed before its history command could run.')
      }
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(current.activeWorkspaceId, tab.path)) {
        throw new Error('The active editor is read-only.')
      }
      const availability = port.getSnapshot()
      if (operation === 'undo' ? !availability.canUndo : !availability.canRedo) {
        throw new Error(operation === 'undo'
          ? 'The active editor has no changes to undo.'
          : 'The active editor has no changes to redo.')
      }
      return port
    }

    resolve()
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') throw new Error('Finish the active editor dialog first.')
    const port = resolve()
    const applied = operation === 'undo' ? port.undo() : port.redo()
    if (!applied) throw new Error(`The active editor could not ${operation}.`)
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [documents, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const toggleActiveEditorLineComment = useCallback((): void => {
    const resolve = (expected?: EditorHistoryPort): EditorHistoryPort => {
      const current = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (current.activeWorkspaceId === undefined || tab === undefined || port === undefined
        || expected !== undefined && port !== expected
        || port.workspaceId !== current.activeWorkspaceId || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId || port.historyEpoch !== tab.historyEpoch) {
        throw new Error('The active editor changed before its comment command could run.')
      }
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(current.activeWorkspaceId, tab.path)) {
        throw new Error('The active editor is read-only.')
      }
      return port
    }

    resolve()
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') throw new Error('Finish the active editor dialog first.')
    const port = resolve()
    const applied = port.toggleLineComment()
    resolve(port)
    if (!applied) {
      throw new Error('The active editor language does not support comments at the current selection.')
    }
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [documents, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const trimActiveEditorTrailingWhitespace = useCallback((): void => {
    const resolve = (expected?: EditorHistoryPort): EditorHistoryPort => {
      const current = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (current.activeWorkspaceId === undefined || tab === undefined || port === undefined
        || expected !== undefined && port !== expected
        || port.workspaceId !== current.activeWorkspaceId || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId || port.historyEpoch !== tab.historyEpoch) {
        throw new Error('The active editor changed before its trim command could run.')
      }
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(current.activeWorkspaceId, tab.path)) {
        throw new Error('The active editor is read-only.')
      }
      return port
    }

    resolve()
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') throw new Error('Finish the active editor dialog first.')
    const port = resolve()
    const result = port.trimTrailingWhitespace()
    resolve(port)
    if (result === 'stale') {
      throw new Error('The active editor changed before its trim command could run.')
    }
    if (result === 'read-only') throw new Error('The active editor is read-only.')
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [documents, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const convertActiveEditorIndentation = useCallback((style: 'spaces' | 'tabs'): void => {
    interface Capture {
      readonly port: EditorHistoryPort
      readonly workspaceId: string
      readonly workspaceEpoch: number
      readonly path: string
      readonly lifecycleId: number
      readonly historyEpoch: number
      readonly localRevision: number
      readonly version: string
    }
    const resolve = (expected?: Capture): Capture => {
      const current = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (current.activeWorkspaceId === undefined || tab === undefined || port === undefined
        || port.workspaceId !== current.activeWorkspaceId || port.path !== tab.path
        || port.lifecycleId !== tab.lifecycleId || port.historyEpoch !== tab.historyEpoch
        || expected !== undefined && (
          port !== expected.port
          || current.activeWorkspaceId !== expected.workspaceId
          || current.activeWorkspaceEpoch !== expected.workspaceEpoch
          || tab.path !== expected.path || tab.lifecycleId !== expected.lifecycleId
          || tab.historyEpoch !== expected.historyEpoch
          || tab.localRevision !== expected.localRevision
          || tab.version !== expected.version
        )) {
        throw new Error('The active editor changed before its indentation command could run.')
      }
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(current.activeWorkspaceId, tab.path)) {
        throw new Error('The active editor is read-only.')
      }
      return {
        port,
        workspaceId: current.activeWorkspaceId,
        workspaceEpoch: current.activeWorkspaceEpoch,
        path: tab.path,
        lifecycleId: tab.lifecycleId,
        historyEpoch: tab.historyEpoch,
        localRevision: tab.localRevision,
        version: tab.version,
      }
    }

    const captured = resolve()
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') throw new Error('Finish the active editor dialog first.')
    const admitted = resolve(captured)
    const result = admitted.port.convertIndentation(style)
    if (result === 'stale') {
      throw new Error('The active editor changed before its indentation command could run.')
    }
    if (result === 'read-only') throw new Error('The active editor is read-only.')
    if (result === 'resource-limit') {
      throw new Error('This editor has too many lines or indentation changes to convert safely.')
    }

    const after = documents.getSnapshot()
    const afterTab = documents.activeTab()
    const expectedRevision = captured.localRevision + (result === 'applied' ? 1 : 0)
    if (editorHistoryBinding.current?.port !== captured.port
      || after.activeWorkspaceId !== captured.workspaceId
      || after.activeWorkspaceEpoch !== captured.workspaceEpoch
      || afterTab?.path !== captured.path || afterTab.lifecycleId !== captured.lifecycleId
      || afterTab.historyEpoch !== captured.historyEpoch
      || afterTab.localRevision !== expectedRevision
      || afterTab.version !== captured.version) {
      throw new Error('The active editor changed while its indentation command was running.')
    }
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [documents, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const navigateRelativeSearchResult = useCallback(async (delta: -1 | 1): Promise<void> => {
    if (prepareEditorCommandFocus() === 'blocked') return
    const documentSnapshot = documents.getSnapshot()
    const searchSnapshot = workspaceSearchStore.getSnapshot()
    const selectedWorkspace = documentSnapshot.activeWorkspaceId
    if (selectedWorkspace === undefined || searchSnapshot.activeWorkspaceId !== selectedWorkspace) return
    const searchSession = workspaceSearchStore.session(selectedWorkspace)
    if (searchSession.status !== 'complete' || searchSession.items.length === 0) return
    const selectedIndex = searchSession.selectedIndex < 0 ? 0 : searchSession.selectedIndex
    const itemIndex = ((selectedIndex + delta) % searchSession.items.length + searchSession.items.length)
      % searchSession.items.length
    const item = searchSession.items[itemIndex]
    if (item === undefined) return
    if (await openWorkspaceSearchItem(item, itemIndex)) requestEditorSurfaceFocus()
  }, [documents, openWorkspaceSearchItem, prepareEditorCommandFocus, requestEditorSurfaceFocus, workspaceSearchStore])

  const requestEditorTabFocus = useCallback((path: string): void => {
    setEditorTabFocusRequest({ requestId: ++editorPresentationSequence.current, path })
  }, [])

  const restoreEditorCloseFocus = useCallback((context: Pick<EditorCloseContext, 'identity' | 'origin'>): void => {
    const admitted = documents.getSnapshot()
    if (admitted.activeWorkspaceId === context.identity.workspaceId
      && admitted.activeWorkspaceEpoch === context.identity.workspaceEpoch
      && documents.activeTab() === undefined
      && quickInputRestoreTarget.current === 'editor') {
      quickInputRestoreTarget.current = 'default'
    }
    // The modal is a body portal while the app frame is inert. Wait until the
    // committed layout removes inert, then resolve the destination against the
    // exact workspace epoch instead of holding a stale DOM node.
    window.requestAnimationFrame(() => {
      const current = documents.getSnapshot()
      if (current.activeWorkspaceId !== context.identity.workspaceId
        || current.activeWorkspaceEpoch !== context.identity.workspaceEpoch) return
      if (context.origin === 'tab') {
        const original = documents.inspect(context.identity)
        const path = original?.path ?? documents.session(context.identity.workspaceId).activePath
        if (path !== undefined) {
          requestEditorTabFocus(path)
          return
        }
      }
      if (documents.activeTab() !== undefined) requestEditorSurfaceFocus()
      else focusAvailableTarget(defaultWorkbenchFocusTarget())
    })
  }, [defaultWorkbenchFocusTarget, documents, focusAvailableTarget, requestEditorSurfaceFocus, requestEditorTabFocus])

  const restoreEditorCloseBatchFocus = useCallback((workspace: EditorCloseBatchWorkspace): void => {
    const current = documents.getSnapshot()
    if (current.activeWorkspaceId !== workspace.workspaceId
      || current.activeWorkspaceEpoch !== workspace.workspaceEpoch) return
    const quickInputOwnsRestore = quickInputRestoreTarget.current === 'editor'
    if (documents.activeTab() === undefined && quickInputOwnsRestore) {
      // A deferred Quick Input cleanup cannot target an editor surface that the
      // completed batch removed. Let it resolve the default workbench owner.
      quickInputRestoreTarget.current = 'default'
    }
    if (quickInputOwnsRestore) return
    window.requestAnimationFrame(() => {
      const live = documents.getSnapshot()
      if (live.activeWorkspaceId !== workspace.workspaceId
        || live.activeWorkspaceEpoch !== workspace.workspaceEpoch) return
      if (documents.activeTab() !== undefined) {
        requestEditorSurfaceFocus()
        return
      }
      focusAvailableTarget(defaultWorkbenchFocusTarget())
    })
  }, [defaultWorkbenchFocusTarget, documents, focusAvailableTarget, requestEditorSurfaceFocus])

  const handleEditorCloseBatchResult = useCallback((
    result: EditorCloseBatchResult,
    workspace: EditorCloseBatchWorkspace,
  ): boolean => {
    if (result.status === 'ignored') return false
    if (result.closed.length > 0) {
      for (const identity of result.closed) {
        closedEditorHistory.record(identity.workspaceId, identity.path)
      }
      setOpenError(undefined)
    }
    if (result.status !== 'confirming' && editorCloseStore.getSnapshot().phase === 'idle') {
      restoreEditorCloseBatchFocus(workspace)
    }
    return true
  }, [closedEditorHistory, editorCloseStore, restoreEditorCloseBatchFocus])

  const restoreDocumentConflictFocus = useCallback((identity: DocumentIdentity): void => {
    window.requestAnimationFrame(() => {
      const current = documents.getSnapshot()
      if (current.activeWorkspaceId !== identity.workspaceId
        || current.activeWorkspaceEpoch !== identity.workspaceEpoch
        || documents.inspect(identity) === undefined) return
      requestEditorSurfaceFocus()
    })
  }, [documents, requestEditorSurfaceFocus])

  const handleEditorCloseOutcome = useCallback((
    outcome: EditorCloseOutcome,
    context: Pick<EditorCloseContext, 'identity' | 'origin'>,
  ): void => {
    if (outcome.status === 'closed' || outcome.status === 'stale') {
      if (outcome.status === 'closed') {
        closedEditorHistory.record(context.identity.workspaceId, context.identity.path)
        setOpenError(undefined)
      }
      restoreEditorCloseFocus(context)
    }
  }, [closedEditorHistory, restoreEditorCloseFocus])

  const requestEditorClose = useCallback((identity: DocumentIdentity, origin: EditorCloseOrigin): void => {
    if (documentConflictOpenRef.current || !leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    const outcome = editorCloseController.requestClose(identity, origin)
    handleEditorCloseOutcome(outcome, { identity, origin })
  }, [commands, editorCloseController, handleEditorCloseOutcome, leaveMutationSurface])

  const handleDocumentConflictOutcome = useCallback((
    outcome: DocumentConflictResolveResult,
    identity: DocumentIdentity,
  ): void => {
    if (outcome === 'applied' || outcome === 'stale') {
      documentConflictOpenRef.current = false
      if (outcome === 'applied') setOpenError(undefined)
      restoreDocumentConflictFocus(identity)
      return
    }
    if (outcome === 'invalid') {
      setOpenError('The merge result is not valid bounded editor text.')
    }
  }, [restoreDocumentConflictFocus])

  const requestDocumentConflict = useCallback((identity: DocumentIdentity): void => {
    if (documentConflictOpenRef.current || keyboardShortcutsOpenRef.current
      || editorCloseStore.getSnapshot().phase !== 'idle'
      || quickInputModeRef.current !== 'none' || !leaveMutationSurface()) return
    if (documents.inspect(identity) === undefined) return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    pendingCompactFocusTarget.current = undefined
    compactPanelInvoker.current = undefined
    if (compactPanelRef.current !== 'none') setCompactPanel('none')
    documentConflictOpenRef.current = true
    setOpenError(undefined)
    void documentConflictController.compare(identity).then(outcome => {
      if (outcome === 'ready' || outcome === 'failed') return
      documentConflictOpenRef.current = false
      if (outcome === 'blocked') setOpenError('This document is not ready for conflict comparison.')
      if (outcome === 'stale') restoreDocumentConflictFocus(identity)
    })
  }, [commands, documentConflictController, documents, editorCloseStore, leaveMutationSurface, restoreDocumentConflictFocus])

  const activateEditor = useCallback((identity: DocumentIdentity): void => {
    if (documents.inspect(identity) === undefined) return
    navigation.activateOpenDocument(identity)
  }, [documents, navigation])

  const activateRelativeEditor = useCallback((direction: -1 | 1): void => {
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') return
    const current = documents.getSnapshot()
    if (current.activeWorkspaceId === undefined) {
      if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
      return
    }
    const session = documents.session(current.activeWorkspaceId)
    if (session.tabs.length < 2 || session.activePath === undefined) {
      if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
      return
    }
    const index = session.tabs.findIndex(tab => tab.path === session.activePath)
    if (index < 0) {
      if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
      return
    }
    const target = session.tabs[(index + direction + session.tabs.length) % session.tabs.length]
    if (target !== undefined) {
      navigation.activateOpenDocument({
        workspaceId: current.activeWorkspaceId,
        workspaceEpoch: current.activeWorkspaceEpoch,
        path: target.path,
        lifecycleId: target.lifecycleId,
      })
    }
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [documents, navigation, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const navigateEditorHistory = useCallback(async (direction: 'back' | 'forward'): Promise<void> => {
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') {
      throw new Error('Finish the active editor dialog before navigating editor history.')
    }
    const result = direction === 'back'
      ? await navigation.navigateBack()
      : await navigation.navigateForward()
    if (result !== 'revealed') {
      throw new Error(result === 'invalid'
        ? 'That editor history location no longer exists in the file.'
        : result === 'failed'
          ? 'That editor history location could not be opened.'
          : 'The active editor changed before history navigation completed.')
    }
    // Quick Input may restore focus before a closed history target finishes
    // loading; issue a fresh monotonic request for the exact active target.
    requestEditorSurfaceFocus()
  }, [navigation, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const closeActiveEditor = useCallback((): void => {
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') return
    const current = documents.getSnapshot()
    const tab = documents.activeTab()
    if (current.activeWorkspaceId === undefined || tab === undefined) {
      if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
      return
    }
    requestEditorClose({
      workspaceId: current.activeWorkspaceId,
      workspaceEpoch: current.activeWorkspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    }, 'editor')
  }, [documents, prepareEditorCommandFocus, requestEditorClose, requestEditorSurfaceFocus])

  const closeAllEditors = useCallback((): void => {
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'blocked') return
    const current = documents.getSnapshot()
    if (current.activeWorkspaceId === undefined) {
      if (quickInputRestoreTarget.current === 'editor') quickInputRestoreTarget.current = 'default'
      return
    }
    const workspace = {
      workspaceId: current.activeWorkspaceId,
      workspaceEpoch: current.activeWorkspaceEpoch,
    }
    const queue = documents.session(workspace.workspaceId).tabs.map(tab => ({
      ...workspace,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    }))
    const result = editorCloseBatch.start(workspace, queue)
    handleEditorCloseBatchResult(result, workspace)
  }, [documents, editorCloseBatch, handleEditorCloseBatchResult, prepareEditorCommandFocus])

  const reopenClosedEditor = useCallback(async (): Promise<void> => {
    if (prepareEditorCommandFocus() === 'blocked') {
      throw new Error('Finish the active editor dialog before reopening a closed editor.')
    }
    const before = documents.getSnapshot()
    const selectedWorkspace = before.activeWorkspaceId
    if (selectedWorkspace === undefined) throw new Error('Select a workspace first.')
    const entry = closedEditorHistory.peek(selectedWorkspace)
    if (entry === undefined) throw new Error('No closed editor is available in the selected workspace.')

    let opened: boolean
    try {
      opened = await navigation.openPath(selectedWorkspace, entry.path)
    } catch {
      throw new Error('The closed editor could not be reopened from disk. Its history entry was preserved.')
    }
    const after = documents.getSnapshot()
    const session = documents.session(selectedWorkspace)
    const active = session.tabs.find(tab => tab.path === session.activePath)
    if (!opened || after.activeWorkspaceId !== selectedWorkspace
      || after.activeWorkspaceEpoch !== before.activeWorkspaceEpoch
      || active?.path !== entry.path) {
      throw new Error('The workspace changed before the closed editor could be reopened. Its history entry was preserved.')
    }
    closedEditorHistory.consumeIfCurrent(entry)
    setOpenError(undefined)
    requestEditorSurfaceFocus()
  }, [closedEditorHistory, documents, navigation, prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const focusActiveEditor = useCallback((): void => {
    const focusAdmission = prepareEditorCommandFocus()
    if (focusAdmission === 'immediate') requestEditorSurfaceFocus()
  }, [prepareEditorCommandFocus, requestEditorSurfaceFocus])

  const focusTerminalCommandTarget = useCallback((target: TerminalCommandTarget): void => {
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    const quickInputActive = quickInputModeRef.current !== 'none'
    pendingCompactFocusTarget.current = undefined
    compactPanelInvoker.current = undefined
    if (compactPanelRef.current !== 'none') setCompactPanel('none')
    if (compactRef.current) setCompactTerminalOpen(true)
    else setTerminalPanelOpen(true)
    if (quickInputActive) {
      pendingQuickInputTerminalFocus.current = target
      quickInputRestoreTarget.current = 'default'
      setQuickInputMode('none')
      quickOpenController.setQuery('')
      commands.palette.setQuery('')
      setLineQuery('')
      setEolQuery('')
      pendingEolTarget.current = undefined
      setLanguageQuery('')
      pendingLanguageTarget.current = undefined
      setIndentationQuery('')
      pendingIndentationTarget.current = undefined
    } else {
      requestTerminalSurfaceFocus(target)
    }
  }, [commands, quickOpenController, requestTerminalSurfaceFocus])

  const toggleTerminal = useCallback((): void => {
    if (!leaveMutationSurface()) return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    const terminalTarget = currentTerminalCommandTarget()
    const quickInputActive = quickInputModeRef.current !== 'none'
    if (quickInputActive) {
      setQuickInputMode('none')
      quickOpenController.setQuery('')
      commands.palette.setQuery('')
      setLineQuery('')
      setEolQuery('')
      pendingEolTarget.current = undefined
      setLanguageQuery('')
      pendingLanguageTarget.current = undefined
      setIndentationQuery('')
      pendingIndentationTarget.current = undefined
    }
    if (!compactRef.current && terminalPanelOpenRef.current) {
      terminalPanelOpenRef.current = false
      pendingQuickInputTerminalFocus.current = undefined
      setTerminalFocusRequest(undefined)
      setTerminalPanelMaximized(false)
      setTerminalPanelOpen(false)
      if (quickInputActive) {
        quickInputRestoreTarget.current = documents.activeTab() === undefined ? 'default' : 'editor'
      } else if (documents.activeTab() !== undefined) {
        requestEditorSurfaceFocus()
      } else if (!focusAvailableTarget(compactFilesButton.current)) {
        focusAvailableTarget(defaultWorkbenchFocusTarget())
      }
      return
    }
    if (compactRef.current && compactTerminalOpen) {
      pendingQuickInputTerminalFocus.current = undefined
      setTerminalFocusRequest(undefined)
      setCompactTerminalOpen(false)
      if (!quickInputActive) {
        if (documents.activeTab() !== undefined) requestEditorSurfaceFocus()
        else if (!focusAvailableTarget(compactFilesButton.current)) {
          focusAvailableTarget(defaultWorkbenchFocusTarget())
        }
      }
      return
    }
    pendingCompactFocusTarget.current = undefined
    compactPanelInvoker.current = undefined
    if (compactPanelRef.current !== 'none') setCompactPanel('none')
    if (compactRef.current) setCompactTerminalOpen(true)
    else {
      terminalPanelOpenRef.current = true
      setTerminalPanelOpen(true)
    }
    if (quickInputActive) {
      pendingQuickInputTerminalFocus.current = terminalTarget
      quickInputRestoreTarget.current = 'default'
    } else {
      requestTerminalSurfaceFocus(terminalTarget)
    }
  }, [commands, compactTerminalOpen, currentTerminalCommandTarget, defaultWorkbenchFocusTarget, documents, focusAvailableTarget, leaveMutationSurface, quickOpenController, requestEditorSurfaceFocus, requestTerminalSurfaceFocus])

  const toggleTerminalPanelMaximized = useCallback((): void => {
    if (compactRef.current) return
    terminalPanelOpenRef.current = true
    setTerminalPanelOpen(true)
    setTerminalPanelMaximized(current => !current)
  }, [])

  const createTerminal = useCallback((): void => {
    const resolve = (expectedPort?: TerminalCommandPort): {
      workspaceId: string
      workspaceEpoch: number
      port: TerminalCommandPort
      active?: TerminalCommandTarget
    } => {
      const current = documents.getSnapshot()
      const port = terminalCommandBinding.current?.port
      const command = port?.getSnapshot()
      if (current.activeWorkspaceId === undefined || port === undefined || expectedPort !== undefined && port !== expectedPort
        || command?.workspaceId !== current.activeWorkspaceId
        || command.workspaceEpoch !== current.activeWorkspaceEpoch) {
        throw new Error('The selected workspace changed before a terminal could be created.')
      }
      if (!command.canCreate) throw new Error('The terminal session limit has been reached.')
      return {
        workspaceId: current.activeWorkspaceId,
        workspaceEpoch: current.activeWorkspaceEpoch,
        port,
        ...(command.active === undefined ? {} : { active: command.active }),
      }
    }

    const admitted = resolve()
    if (!leaveMutationSurface()) throw new Error('Finish the active file operation first.')
    resolve(admitted.port)
    if (!admitted.port.create({ workspaceId: admitted.workspaceId, workspaceEpoch: admitted.workspaceEpoch })) {
      throw new Error('The selected workspace or terminal capacity changed before creation.')
    }
    const current = documents.getSnapshot()
    const binding = terminalCommandBinding.current
    const command = binding?.port.getSnapshot()
    const target = command?.active
    if (current.activeWorkspaceId !== admitted.workspaceId || current.activeWorkspaceEpoch !== admitted.workspaceEpoch
      || binding?.port !== admitted.port || command?.workspaceId !== admitted.workspaceId
      || command.workspaceEpoch !== admitted.workspaceEpoch || target === undefined
      || sameTerminalCommandTarget(target, admitted.active)) {
      throw new Error('The selected workspace changed while creating the terminal.')
    }
    focusTerminalCommandTarget(target)
  }, [documents, focusTerminalCommandTarget, leaveMutationSurface])

  const focusRelativeTerminal = useCallback((direction: -1 | 1): void => {
    const resolve = (expectedPort?: TerminalCommandPort, expectedActive?: TerminalCommandTarget): {
      workspaceId: string
      workspaceEpoch: number
      port: TerminalCommandPort
      active: TerminalCommandTarget
    } => {
      const current = documents.getSnapshot()
      const port = terminalCommandBinding.current?.port
      const command = port?.getSnapshot()
      if (current.activeWorkspaceId === undefined || port === undefined || expectedPort !== undefined && port !== expectedPort
        || command?.workspaceId !== current.activeWorkspaceId || command.workspaceEpoch !== current.activeWorkspaceEpoch
        || command.active === undefined || expectedActive !== undefined && !sameTerminalCommandTarget(command.active, expectedActive)
        || !command.canNavigate) {
        throw new Error('The active terminal changed before terminal navigation could run.')
      }
      return {
        workspaceId: current.activeWorkspaceId,
        workspaceEpoch: current.activeWorkspaceEpoch,
        port,
        active: command.active,
      }
    }

    const admitted = resolve()
    if (!leaveMutationSurface()) throw new Error('Finish the active file operation first.')
    resolve(admitted.port, admitted.active)
    const target = admitted.port.activateRelative(admitted.active, direction)
    if (target === undefined) throw new Error('The active terminal changed before terminal navigation could finish.')
    const current = documents.getSnapshot()
    const binding = terminalCommandBinding.current
    const command = binding?.port.getSnapshot()
    if (current.activeWorkspaceId !== admitted.workspaceId || current.activeWorkspaceEpoch !== admitted.workspaceEpoch
      || binding?.port !== admitted.port || command?.workspaceId !== admitted.workspaceId
      || command.workspaceEpoch !== admitted.workspaceEpoch || !sameTerminalCommandTarget(command.active, target)) {
      throw new Error('The active terminal changed while terminal navigation was finishing.')
    }
    focusTerminalCommandTarget(target)
  }, [documents, focusTerminalCommandTarget, leaveMutationSurface])

  const clearTerminal = useCallback((): void => {
    const resolve = (expectedPort?: TerminalCommandPort, expectedActive?: TerminalCommandTarget): {
      workspaceId: string
      workspaceEpoch: number
      port: TerminalCommandPort
      active: TerminalCommandTarget
    } => {
      const current = documents.getSnapshot()
      const port = terminalCommandBinding.current?.port
      const command = port?.getSnapshot()
      if (current.activeWorkspaceId === undefined || port === undefined || expectedPort !== undefined && port !== expectedPort
        || command?.workspaceId !== current.activeWorkspaceId || command.workspaceEpoch !== current.activeWorkspaceEpoch
        || command.active === undefined || expectedActive !== undefined && !sameTerminalCommandTarget(command.active, expectedActive)) {
        throw new Error('The active terminal changed before it could be cleared.')
      }
      return {
        workspaceId: current.activeWorkspaceId,
        workspaceEpoch: current.activeWorkspaceEpoch,
        port,
        active: command.active,
      }
    }

    const admitted = resolve()
    if (!leaveMutationSurface()) throw new Error('Finish the active file operation first.')
    resolve(admitted.port, admitted.active)
    const result = admitted.port.clear(admitted.active)
    if (result === 'stale') throw new Error('The active terminal changed before it could be cleared.')
    if (result === 'unavailable') throw new Error('The active terminal runtime is not available.')
    const current = documents.getSnapshot()
    const binding = terminalCommandBinding.current
    const command = binding?.port.getSnapshot()
    if (current.activeWorkspaceId !== admitted.workspaceId || current.activeWorkspaceEpoch !== admitted.workspaceEpoch
      || binding?.port !== admitted.port || command?.workspaceId !== admitted.workspaceId
      || command.workspaceEpoch !== admitted.workspaceEpoch
      || !sameTerminalCommandTarget(command.active, admitted.active)) {
      throw new Error('The active terminal changed while its buffer was being cleared.')
    }
    focusTerminalCommandTarget(admitted.active)
  }, [documents, focusTerminalCommandTarget, leaveMutationSurface])

  const beginExplorerCreate = useCallback((kind: 'file' | 'directory'): void => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    if (selectedWorkspace === undefined) throw new Error('Select a workspace first.')
    const supported = kind === 'file'
      ? mutationCapabilities?.createFile === true
      : mutationCapabilities?.createDirectory === true
    if (!supported) {
      throw new Error(mutationAvailabilityError
        ?? `This Host does not support containment-safe ${kind === 'file' ? 'file' : 'folder'} creation.`)
    }
    if (!mutationWriter) {
      throw new Error(
        mutationRecoveryError ?? mutationAvailabilityError
          ?? 'File operations are unavailable until this page owns safe recovery.',
      )
    }
    showExplorer()
    const session = explorerStore.session(selectedWorkspace)
    const rows = deriveVisibleExplorerRows(session)
    const anchor = session.focusedPath ?? session.selectedPath
    const parent = explorerCreateParentPath(rows, anchor)
    if (!mutationController.beginCreate(parent, kind)) throw new Error('Another file operation is already active.')
  }, [documents, explorerStore, mutationAvailabilityError, mutationCapabilities, mutationController, mutationRecoveryError, mutationWriter, showExplorer])

  const beginExplorerEntryMutation = useCallback((kind: 'rename' | 'delete'): void => {
    const documentIdentity = documents.getSnapshot()
    const selectedWorkspace = documentIdentity.activeWorkspaceId
    const explorerIdentity = explorerStore.getSnapshot()
    const mutation = mutationStore.getSnapshot()
    const capabilities = mutationCapabilitiesRef.current
    const supported = kind === 'rename' ? capabilities?.rename === true : capabilities?.delete === true
    if (selectedWorkspace === undefined) throw new Error('Select a workspace first.')
    if (!supported) {
      throw new Error(mutationAvailabilityError
        ?? `This Host does not support containment-safe ${kind}.`)
    }
    if (!mutationWriterRef.current) {
      throw new Error(
        mutationRecoveryError ?? mutationAvailabilityError
          ?? 'File operations are unavailable until this page owns safe recovery.',
      )
    }
    if (explorerIdentity.activeWorkspaceId !== selectedWorkspace
      || explorerIdentity.activeWorkspaceEpoch !== documentIdentity.activeWorkspaceEpoch
      || mutation.phase !== 'idle' || mutation.workspaceId !== selectedWorkspace
      || mutation.workspaceEpoch !== documentIdentity.activeWorkspaceEpoch) {
      throw new Error('The Explorer workspace changed or another file operation is active.')
    }
    const session = explorerStore.session(selectedWorkspace)
    const rows = deriveVisibleExplorerRows(session)
    const row = rows.find(candidate => candidate.path === session.focusedPath)
      ?? rows.find(candidate => candidate.path === session.selectedPath)
    const source = explorerMutationSource(row?.entry)
    if (source === undefined) throw new Error('Select a current file or folder in Explorer first.')

    // The rename input/delete dialog owns focus. A generic tree focus request
    // would run later and could pull focus back out of the delete modal.
    showExplorer(false)
    const currentDocuments = documents.getSnapshot()
    const currentExplorer = explorerStore.getSnapshot()
    const currentMutation = mutationStore.getSnapshot()
    const currentCapabilities = mutationCapabilitiesRef.current
    const currentSession = explorerStore.session(selectedWorkspace)
    const currentRows = deriveVisibleExplorerRows(currentSession)
    const currentRow = currentRows.find(candidate => candidate.path === currentSession.focusedPath)
      ?? currentRows.find(candidate => candidate.path === currentSession.selectedPath)
    const currentSource = explorerMutationSource(currentRow?.entry)
    if (!mutationWriterRef.current
      || (kind === 'rename' ? currentCapabilities?.rename !== true : currentCapabilities?.delete !== true)
      || currentDocuments.activeWorkspaceId !== selectedWorkspace
      || currentDocuments.activeWorkspaceEpoch !== documentIdentity.activeWorkspaceEpoch
      || currentExplorer.activeWorkspaceId !== selectedWorkspace
      || currentExplorer.activeWorkspaceEpoch !== documentIdentity.activeWorkspaceEpoch
      || currentMutation.phase !== 'idle' || currentMutation.workspaceId !== selectedWorkspace
      || currentMutation.workspaceEpoch !== documentIdentity.activeWorkspaceEpoch
      || currentSource?.path !== source.path || currentSource.type !== source.type
      || currentSource.version !== source.version) {
      throw new Error('The file operation is no longer available.')
    }
    const admitted = kind === 'rename'
      ? mutationController.beginRename(source)
      : beginExplorerDeleteMutation(mutationController, source)
    if (admitted !== true) throw new Error('The Explorer entry changed or another file operation is active.')
    explorerController.setFocus(source.path)
    explorerController.setSelected(source.path)
  }, [
    documents,
    explorerController,
    explorerStore,
    mutationAvailabilityError,
    mutationController,
    mutationRecoveryError,
    mutationStore,
    showExplorer,
  ])

  const retryMutationRecovery = useCallback((): void => {
    if (!mutationWriterOwned) return
    void restoreMutationRecovery().then(setMutationWriter).catch(error => {
      setMutationWriter(false)
      setMutationRecoveryError(error instanceof Error ? error.message : String(error))
    })
  }, [mutationWriterOwned, restoreMutationRecovery])

  const openInvalidMutationRecoveryReset = useCallback((invoker: HTMLElement): void => {
    if (!mutationWriterOwned || !mutationRecovery.canResetInvalid()
      || mutationStore.getSnapshot().phase !== 'idle') return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    invalidMutationRecoveryInvoker.current = invoker
    setInvalidMutationRecoveryResetError(undefined)
    setInvalidMutationRecoveryDialogOpen(true)
  }, [commands, mutationRecovery, mutationStore, mutationWriterOwned])

  const resetInvalidMutationRecovery = useCallback((): void => {
    if (invalidMutationRecoveryResetBusy || mutationStore.getSnapshot().phase !== 'idle') return
    setInvalidMutationRecoveryResetBusy(true)
    try {
      const outcome = mutationRecovery.resetInvalid()
      if (outcome.status === 'refused') {
        setMutationWriter(false)
        setMutationRecoveryError(outcome.message)
        setInvalidMutationRecoveryResetError(outcome.message)
        return
      }
      setMutationRecoveryError(undefined)
      setInvalidMutationRecoveryResetError(undefined)
      setMutationWriter(true)
      setInvalidMutationRecoveryDialogOpen(false)
      setCommandNotice({
        kind: 'status',
        message: 'Stopped tracking unreadable file-operation recovery without deciding its disk result. Review the workspace before another file operation.',
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMutationWriter(false)
      setMutationRecoveryError(detail)
      setInvalidMutationRecoveryResetError(detail)
    } finally {
      setInvalidMutationRecoveryResetBusy(false)
    }
  }, [invalidMutationRecoveryResetBusy, mutationRecovery, mutationStore])

  const openWorkbenchRecoveryReset = useCallback((invoker: HTMLElement): void => {
    if (!workbenchRecoveryResetAvailable || mutationModalOpen
      || editorCloseStore.getSnapshot().phase !== 'idle'
      || documentConflictStore.getSnapshot().phase !== 'idle') return
    commands.shortcuts.cancelPendingChord()
    setExplorerPortalDismissRequest(value => value + 1)
    workbenchRecoveryInvoker.current = invoker
    workbenchRecoveryExportRaw.current = undefined
    setWorkbenchRecoveryExported(false)
    setWorkbenchRecoveryDialogError(undefined)
    setWorkbenchRecoveryDialogOpen(true)
  }, [commands, documentConflictStore, editorCloseStore, mutationModalOpen, workbenchRecoveryResetAvailable])

  const exportInvalidWorkbenchRecovery = useCallback((): void => {
    if (workbenchRecoveryBusy || !mutationWriterOwned) return
    setWorkbenchRecoveryBusy(true)
    try {
      const exported = persistence.exportInvalidRaw()
      const blob = new Blob([exported.raw], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `dsh-code-ide-workbench-recovery-${new Date().toISOString().replace(/[:.]/gu, '-')}.txt`
        anchor.hidden = true
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      workbenchRecoveryExportRaw.current = exported.raw
      setWorkbenchRecoveryExported(true)
      setWorkbenchRecoveryDialogError(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      workbenchRecoveryExportRaw.current = undefined
      setWorkbenchRecoveryExported(false)
      setRecoveryError(message)
      setWorkbenchRecoveryDialogError(message)
    } finally {
      setWorkbenchRecoveryBusy(false)
    }
  }, [mutationWriterOwned, persistence, workbenchRecoveryBusy])

  const resetInvalidWorkbenchRecovery = useCallback((): void => {
    const expectedRaw = workbenchRecoveryExportRaw.current
    if (workbenchRecoveryBusy || expectedRaw === undefined || !mutationWriterOwned) return
    setWorkbenchRecoveryBusy(true)
    void (async () => {
      try {
        const outcome = persistence.resetInvalid(expectedRaw, documents.getSnapshot(), retainedRecovery)
        if (outcome.status === 'changed') {
          workbenchRecoveryExportRaw.current = undefined
          setWorkbenchRecoveryExported(false)
          setRecoveryError(outcome.message)
          setWorkbenchRecoveryDialogError(outcome.message)
          return
        }
        if (outcome.status === 'valid') {
          workbenchRecoveryExportRaw.current = undefined
          setWorkbenchRecoveryExported(false)
          if (documents.hasDirtyDocuments()) {
            const message = `${outcome.message} The current workbench also has dirty buffers, so the stored recovery was not loaded. Copy or save those buffers, then reload this page to restore the preserved checkpoint.`
            setRecoveryError(message)
            setWorkbenchRecoveryDialogError(message)
            return
          }
          const registered = new Set(workspaces.map(item => item.workspaceId))
          const nextRetained = outcome.workbench.workspaces.filter(item => !registered.has(item.workspaceId))
          const restorable = outcome.workbench.workspaces.filter(item => registered.has(item.workspaceId))
          const activeIndex = outcome.workbench.activeWorkspaceId === undefined
            ? -1
            : restorable.findIndex(item => item.workspaceId === outcome.workbench.activeWorkspaceId)
          if (activeIndex > 0) restorable.unshift(...restorable.splice(activeIndex, 1))
          for (const storedWorkspace of restorable) {
            const restored = await hydratePersistedWorkspace(storedWorkspace, fileApi.read)
            editorSessions.clearWorkspace(storedWorkspace.workspaceId)
            documents.restoreWorkspace(storedWorkspace.workspaceId, restored.documents, restored.activePath)
          }
          const activeWorkspaceId = outcome.workbench.activeWorkspaceId !== undefined
            && registered.has(outcome.workbench.activeWorkspaceId)
            ? outcome.workbench.activeWorkspaceId
            : undefined
          if (activeWorkspaceId !== undefined && !coordinateWorkspaceSelection(activeWorkspaceId)) {
            throw new Error('The preserved recovery was decoded, but its active workspace could not be selected. Session recovery writes remain blocked.')
          }
          if (!persistence.resumeValidRecovery(outcome.raw)) {
            throw new Error('Stored workbench recovery changed while it was being restored. It was preserved and session recovery writes remain blocked.')
          }
          setRetainedRecovery(nextRetained)
          setRecoveryError(undefined)
          setWorkbenchRecoveryDialogError(undefined)
          setWorkbenchRecoveryDialogOpen(false)
          setCommandNotice({
            kind: 'status',
            message: 'Stored workbench recovery became valid, was preserved, and has been restored. Inspect the workspace and dirty buffers before relying on disk state.',
          })
          return
        }
        setRecoveryError(undefined)
        setWorkbenchRecoveryDialogError(undefined)
        setWorkbenchRecoveryDialogOpen(false)
        setCommandNotice({
          kind: 'status',
          message: 'Invalid hot-exit recovery was atomically replaced with the current in-memory workbench snapshot. This did not inspect disk contents or reconstruct dirty-buffer or undo history.',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setRecoveryError(message)
        setWorkbenchRecoveryDialogError(message)
      } finally {
        setWorkbenchRecoveryBusy(false)
      }
    })()
  }, [coordinateWorkspaceSelection, documents, editorSessions, mutationWriterOwned, persistence, retainedRecovery, workbenchRecoveryBusy, workspaces])

  const revealActiveFile = useCallback(async (): Promise<void> => {
    const selectedWorkspace = documents.getSnapshot().activeWorkspaceId
    const tab = documents.activeTab()
    if (selectedWorkspace === undefined || tab === undefined) throw new Error('No active editor.')
    const identity = { path: tab.path, lifecycleId: tab.lifecycleId }
    showExplorer()
    await explorerController.selectWorkspace(selectedWorkspace)
    const revealed = await explorerController.revealPath(identity.path, { select: true, focus: true })
    const current = documents.activeTab()
    if (documents.getSnapshot().activeWorkspaceId !== selectedWorkspace
      || current?.path !== identity.path || current.lifecycleId !== identity.lifecycleId) return
    if (!revealed) throw new Error('The active file is no longer available in Explorer.')
  }, [documents, explorerController, showExplorer])

  const reportCommandOutcome = useCallback((outcome: CommandExecutionOutcome): void => {
    if (outcome.status === 'completed') return
    if (outcome.status === 'cancelled') {
      setCommandNotice({ kind: 'status', message: 'Command cancelled.' })
      return
    }
    setCommandNotice({
      kind: 'error',
      message: outcome.message ?? (outcome.status === 'busy'
        ? 'That command is already running.'
        : 'The command is no longer available.'),
    })
  }, [])

  const reportShortcutDecision = useCallback((decision: ShortcutDecision): void => {
    if (decision.kind !== 'conflict') return
    setCommandNotice({
      kind: 'error',
      message: `Shortcut conflict: ${decision.conflict.commandIds.join(', ')}. Open Keyboard Shortcuts to resolve it.`,
    })
  }, [])

  const executeWorkbenchCommand = useCallback((commandId: string): void => {
    void commands.registry.execute(commandId).then(reportCommandOutcome)
  }, [commands, reportCommandOutcome])

  const selectQuickInputOption = useCallback((option: WorkbenchQuickInputOption): void => {
    if (option.kind === 'file') {
      void openQuickOption(option.file)
      return
    }
    if (option.kind === 'line') {
      const result = navigation.revealActiveLocation(option.location)
      if (result !== 'revealed') {
        setCommandNotice({
          kind: 'error',
          message: result === 'invalid'
            ? 'That line does not exist in the active editor.'
            : 'The active editor changed. Open Go to Line/Column again.',
        })
        return
      }
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
      if (compactPanelRef.current !== 'none') setCompactPanel('none')
      setCommandNotice(undefined)
      setQuickInputMode('none')
      setLineQuery('')
      return
    }
    if (option.kind === 'eol') {
      const target = pendingEolTarget.current
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      if (quickInputModeRef.current !== 'eol'
        || target === undefined || snapshot.activeWorkspaceId !== target.workspaceId
        || snapshot.activeWorkspaceEpoch !== target.workspaceEpoch
        || tab?.path !== target.path || tab.lifecycleId !== target.lifecycleId
        || tab.localRevision !== target.localRevision
        || tab.historyEpoch !== target.historyEpoch
        || tab.version !== target.version
        || (tab.lineEnding ?? '\n') !== target.lineEnding) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change End of Line Sequence again.',
        })
        return
      }
      if (tab.readOnlyPresentation !== undefined
        || documents.isPathMutationLeased(target.workspaceId, target.path)) {
        setCommandNotice({ kind: 'error', message: 'The active editor is read-only.' })
        return
      }
      if (tab.pendingSaveId !== undefined || tab.pendingReloadId !== undefined
        || tab.pendingConflictId !== undefined) {
        setCommandNotice({ kind: 'error', message: 'Another document operation is in progress.' })
        return
      }
      if (tab.saveOutcome === 'unknown') {
        setCommandNotice({ kind: 'error', message: 'Check the uncertain save outcome first.' })
        return
      }
      if (tab.externalState === 'deleted') {
        setCommandNotice({ kind: 'error', message: 'The active file was deleted outside the IDE.' })
        return
      }
      const result = documents.changeLineEnding(target, option.lineEnding)
      if (result !== 'applied' && result !== 'not-needed') {
        setCommandNotice({
          kind: 'error',
          message: result === 'stale'
            ? 'The active editor changed. Open Change End of Line Sequence again.'
            : result === 'read-only'
              ? 'The active editor is read-only.'
              : 'Another document operation is in progress.',
        })
        return
      }
      const current = documents.getSnapshot()
      const currentTab = documents.activeTab()
      const expectedLocalRevision = target.localRevision + (result === 'applied' ? 1 : 0)
      if (current.activeWorkspaceId !== target.workspaceId
        || current.activeWorkspaceEpoch !== target.workspaceEpoch
        || currentTab?.path !== target.path || currentTab.lifecycleId !== target.lifecycleId
        || currentTab.localRevision !== expectedLocalRevision
        || currentTab.historyEpoch !== target.historyEpoch
        || currentTab.version !== target.version
        || (currentTab.lineEnding ?? '\n') !== option.lineEnding) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change End of Line Sequence again.',
        })
        return
      }
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
      if (compactPanelRef.current !== 'none') setCompactPanel('none')
      pendingEolTarget.current = undefined
      setCommandNotice(undefined)
      setQuickInputMode('none')
      setEolQuery('')
      return
    }
    if (option.kind === 'language') {
      const target = pendingLanguageTarget.current
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (quickInputModeRef.current !== 'language'
        || target === undefined
        || snapshot.activeWorkspaceId !== target.workspaceId
        || snapshot.activeWorkspaceEpoch !== target.workspaceEpoch
        || tab?.path !== target.path
        || tab.lifecycleId !== target.lifecycleId
        || tab.historyEpoch !== target.historyEpoch
        || tab.readOnlyPresentation !== undefined
        || port !== target.port
        || port.workspaceId !== target.workspaceId
        || port.path !== target.path
        || port.lifecycleId !== target.lifecycleId
        || port.historyEpoch !== target.historyEpoch) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change Language Mode again.',
        })
        return
      }
      const result = target.port.changeLanguage(option.languageId)
      if (result !== 'applied' && result !== 'not-needed') {
        setCommandNotice({
          kind: 'error',
          message: result === 'invalid'
            ? 'That language mode is no longer available.'
            : 'The active editor changed. Open Change Language Mode again.',
        })
        return
      }
      const current = documents.getSnapshot()
      const currentTab = documents.activeTab()
      const currentPort = editorHistoryBinding.current?.port
      if (current.activeWorkspaceId !== target.workspaceId
        || current.activeWorkspaceEpoch !== target.workspaceEpoch
        || currentTab?.path !== target.path
        || currentTab.lifecycleId !== target.lifecycleId
        || currentTab.historyEpoch !== target.historyEpoch
        || currentTab.readOnlyPresentation !== undefined
        || currentPort !== target.port
        || currentPort.getSnapshot().languageId !== option.languageId) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change Language Mode again.',
        })
        return
      }
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
      if (compactPanelRef.current !== 'none') setCompactPanel('none')
      pendingLanguageTarget.current = undefined
      setCommandNotice(undefined)
      setQuickInputMode('none')
      setLanguageQuery('')
      return
    }
    if (option.kind === 'indentation') {
      const target = pendingIndentationTarget.current
      const snapshot = documents.getSnapshot()
      const tab = documents.activeTab()
      const port = editorHistoryBinding.current?.port
      if (quickInputModeRef.current !== 'indentation'
        || target === undefined
        || snapshot.activeWorkspaceId !== target.workspaceId
        || snapshot.activeWorkspaceEpoch !== target.workspaceEpoch
        || tab?.path !== target.path
        || tab.lifecycleId !== target.lifecycleId
        || tab.historyEpoch !== target.historyEpoch
        || port !== target.port
        || port.workspaceId !== target.workspaceId
        || port.path !== target.path
        || port.lifecycleId !== target.lifecycleId
        || port.historyEpoch !== target.historyEpoch) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change Indentation Size again.',
        })
        return
      }
      const result = target.port.changeIndentationSize(option.size)
      if (result !== 'applied' && result !== 'not-needed') {
        setCommandNotice({
          kind: 'error',
          message: result === 'invalid'
            ? 'That indentation size is no longer available.'
            : 'The active editor changed. Open Change Indentation Size again.',
        })
        return
      }
      const current = documents.getSnapshot()
      const currentTab = documents.activeTab()
      const currentPort = editorHistoryBinding.current?.port
      const currentIndentation = currentPort?.getSnapshot().indentation
      if (current.activeWorkspaceId !== target.workspaceId
        || current.activeWorkspaceEpoch !== target.workspaceEpoch
        || currentTab?.path !== target.path
        || currentTab.lifecycleId !== target.lifecycleId
        || currentTab.historyEpoch !== target.historyEpoch
        || currentPort !== target.port
        || currentIndentation?.size !== option.size) {
        setCommandNotice({
          kind: 'error',
          message: 'The active editor changed. Open Change Indentation Size again.',
        })
        return
      }
      quickInputRestoreTarget.current = 'editor'
      quickInputInvoker.current = undefined
      quickInputOriginPanel.current = undefined
      pendingCompactFocusTarget.current = undefined
      compactPanelInvoker.current = undefined
      if (compactPanelRef.current !== 'none') setCompactPanel('none')
      pendingIndentationTarget.current = undefined
      setCommandNotice(undefined)
      setQuickInputMode('none')
      setIndentationQuery('')
      return
    }
    setQuickInputMode('none')
    void commands.palette.execute(option.commandId).then(reportCommandOutcome)
  }, [commands, documents, navigation, openQuickOption, reportCommandOutcome])

  commands.setActions({
    showCommands,
    showChangeEndOfLine,
    showChangeIndentationSize,
    showChangeLanguageMode,
    showGoToLine,
    showKeyboardShortcuts,
    showQuickOpen,
    showExplorer,
    showSearch,
    toggleTerminal,
    createTerminal,
    focusNextTerminal: () => { focusRelativeTerminal(1) },
    focusPreviousTerminal: () => { focusRelativeTerminal(-1) },
    clearTerminal,
    focusHarness,
    refreshExplorer: async () => { await explorerController.refreshExpanded() },
    revealActiveFile,
    copyRelativePathOfActiveFile,
    nextEditor: () => { activateRelativeEditor(1) },
    previousEditor: () => { activateRelativeEditor(-1) },
    navigateBack: async () => { await navigateEditorHistory('back') },
    navigateForward: async () => { await navigateEditorHistory('forward') },
    closeActiveEditor,
    closeAllEditors,
    reopenClosedEditor,
    nextSearchResult: async () => { await navigateRelativeSearchResult(1) },
    previousSearchResult: async () => { await navigateRelativeSearchResult(-1) },
    focusActiveEditor,
    toggleWordWrap: () => { setWordWrap(value => !value) },
    undoActiveEditor: () => { applyActiveEditorHistory('undo') },
    redoActiveEditor: () => { applyActiveEditorHistory('redo') },
    toggleLineComment: toggleActiveEditorLineComment,
    trimTrailingWhitespace: trimActiveEditorTrailingWhitespace,
    convertIndentationToSpaces: () => { convertActiveEditorIndentation('spaces') },
    convertIndentationToTabs: () => { convertActiveEditorIndentation('tabs') },
    createFile: () => { beginExplorerCreate('file') },
    createFolder: () => { beginExplorerCreate('directory') },
    renameExplorerEntry: () => { beginExplorerEntryMutation('rename') },
    deleteExplorerEntry: () => { beginExplorerEntryMutation('delete') },
    saveActive: save,
    saveAll,
    revertActive,
    recreateDeleted,
    checkSaveOutcome: reconcileUnknownSave,
  })

  useLayoutEffect(() => {
    const context: WorkbenchCommandContext = {
      workspaceSelected: bootReady && workspaceId !== undefined,
      activeEditor: bootReady && activeTab !== undefined,
      multipleEditors: bootReady && tabs.length > 1,
      activeEditorDirty: activeTab?.dirty ?? false,
      activeEditorSaving: activeTab?.pendingSaveId !== undefined
        || activeTab?.pendingReloadId !== undefined
        || activeTab?.pendingConflictId !== undefined
        || activeEditorMutationLeased,
      activeEditorDeleted: activeTab?.externalState === 'deleted',
      activeEditorReadOnly: activeTab?.readOnlyPresentation !== undefined,
      activeTextEditorVisible,
      activeEditorEditable: activeTextEditorVisible && !activeEditorMutationLeased,
      activeEditorUndoAvailable: activeEditorHistory?.canUndo ?? false,
      activeEditorRedoAvailable: activeEditorHistory?.canRedo ?? false,
      navigateBackAvailable: (activeNavigationHistory?.back ?? 0) > 0,
      navigateForwardAvailable: (activeNavigationHistory?.forward ?? 0) > 0,
      reopenableEditor: bootReady && workspaceId !== undefined
        && (closedEditorHistorySnapshot.workspaces.get(workspaceId)?.length ?? 0) > 0,
      searchResultsAvailable: bootReady && workspaceId !== undefined
        && workspaceSearchSnapshot.activeWorkspaceId === workspaceId
        && workspaceSearchSession.status === 'complete'
        && workspaceSearchSession.items.length > 0,
      saveableDirtyEditors: bootReady && workspaceId !== undefined && tabs.some(tab =>
        tab.dirty
        && tab.readOnlyPresentation === undefined
        && tab.externalState !== 'deleted'
        && tab.saveOutcome !== 'unknown'
        && tab.pendingSaveId === undefined
        && tab.pendingReloadId === undefined
        && tab.pendingConflictId === undefined
        && !documents.isPathMutationLeased(workspaceId, tab.path)
        && tabs.filter(candidate => candidate.path === tab.path).length === 1),
      workspaceMutationsAvailable: bootReady && mutationsEnabled,
      workspaceCreateFileAvailable: bootReady && mutationCapabilities?.createFile === true,
      workspaceCreateDirectoryAvailable: bootReady && mutationCapabilities?.createDirectory === true,
      workspaceRenameAvailable: bootReady && mutationCapabilities?.rename === true,
      workspaceDeleteAvailable: bootReady && mutationCapabilities?.delete === true,
      explorerMutableEntryAvailable: bootReady
        && explorerSnapshot.activeWorkspaceId === workspaceId
        && explorerSnapshot.activeWorkspaceEpoch === documentSnapshot.activeWorkspaceEpoch
        && (() => {
        const row = deriveVisibleExplorerRows(explorerSession)
          .find(candidate => candidate.path === explorerSession.focusedPath)
          ?? deriveVisibleExplorerRows(explorerSession)
            .find(candidate => candidate.path === explorerSession.selectedPath)
        return explorerMutationSource(row?.entry) !== undefined
      })(),
      workspaceMutationIdle: mutationSnapshot.phase === 'idle'
        && mutationSnapshot.workspaceId === workspaceId
        && mutationSnapshot.workspaceEpoch === documentSnapshot.activeWorkspaceEpoch,
      ...(activeTab?.saveOutcome === 'unknown' ? { activeEditorSaveOutcome: 'unknown' as const } : {}),
      quickInputMode,
      railView,
      compact,
      compactTerminalVisible: compactTerminalOpen,
      terminalCanCreate: bootReady && terminalCanCreate,
      terminalCanNavigate: bootReady && terminalCanNavigate,
      terminalCanClear: bootReady && terminalCanClear,
      compactPanel,
    }
    commands.setContext(context)
  }, [
    activeTab?.dirty,
    activeTab?.lifecycleId,
    activeTab?.pendingSaveId,
    activeTab?.pendingReloadId,
    activeTab?.pendingConflictId,
    activeTab?.readOnlyPresentation,
    activeTextEditorVisible,
    activeEditorHistory?.canUndo,
    activeEditorHistory?.canRedo,
    activeNavigationHistory?.back,
    activeNavigationHistory?.forward,
    activeTab?.saveOutcome,
    activeTab?.externalState,
    tabs,
    tabs.length,
    bootReady,
    commands,
    closedEditorHistorySnapshot,
    workspaceSearchSession.items.length,
    workspaceSearchSession.status,
    workspaceSearchSnapshot.activeWorkspaceId,
    compact,
    compactPanel,
    compactTerminalOpen,
    terminalCanCreate,
    terminalCanNavigate,
    terminalCanClear,
    quickInputMode,
    railView,
    mutationSnapshot.phase,
    mutationSnapshot.workspaceEpoch,
    mutationSnapshot.workspaceId,
    mutationCapabilities,
    mutationsEnabled,
    explorerSession,
    explorerSnapshot.activeWorkspaceEpoch,
    explorerSnapshot.activeWorkspaceId,
    documentSnapshot.activeWorkspaceEpoch,
    activeEditorMutationLeased,
    workspaceId,
  ])

  useEffect(() => {
    const handleTerminalPalette = (event: KeyboardEvent): void => {
      if (!bootReady || keyboardShortcutsOpenRef.current || editorCloseModalOpen
        || documentConflictOpenRef.current || safetyModalOpen) return
      dispatchTerminalPaletteShortcut(event, commands.registry, reportCommandOutcome, reportShortcutDecision)
    }
    const handleCommand = (event: KeyboardEvent): void => {
      if (!bootReady || keyboardShortcutsOpenRef.current || editorCloseModalOpen
        || documentConflictOpenRef.current || safetyModalOpen) return
      dispatchWorkbenchShortcut(event, commands.registry, reportCommandOutcome, reportShortcutDecision)
    }
    const cancelPending = (): void => { commands.shortcuts.cancelPendingChord() }
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') cancelPending()
    }
    window.addEventListener('keydown', handleTerminalPalette, true)
    window.addEventListener('keydown', handleCommand)
    window.addEventListener('blur', cancelPending)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('keydown', handleTerminalPalette, true)
      window.removeEventListener('keydown', handleCommand)
      window.removeEventListener('blur', cancelPending)
      document.removeEventListener('visibilitychange', handleVisibility)
      cancelPending()
    }
  }, [bootReady, commands, documentConflictModalOpen, editorCloseModalOpen, reportCommandOutcome, reportShortcutDecision, safetyModalOpen])

  const selectWorkspace = (next: string | undefined): void => {
    if (next === undefined || workspaces.some(candidate => candidate.workspaceId === next)) {
      setWorkspaceError(undefined)
    }
    coordinateWorkspaceSelection(next)
  }

  const startDrag = (kind: 'explorer' | 'harness' | 'terminal', event: ReactPointerEvent): void => {
    event.preventDefault()
    const originX = event.clientX
    const originY = event.clientY
    const startExplorer = explorerWidth
    const startHarness = harnessWidth
    const startTerminal = terminalHeight
    let nextExplorer = startExplorer
    let nextHarness = startHarness
    let nextTerminal = startTerminal
    const move = (moveEvent: PointerEvent): void => {
      if (kind === 'explorer' || kind === 'harness') {
        const available = frame.current?.getBoundingClientRect().width ?? window.innerWidth
        const desiredExplorer = kind === 'explorer' ? startExplorer + moveEvent.clientX - originX : startExplorer
        const desiredHarness = kind === 'harness' ? startHarness - moveEvent.clientX + originX : startHarness
        if (embeddedMode && kind === 'explorer') {
          nextExplorer = fitExplorerPane(desiredExplorer, available)
        } else {
          ;[nextExplorer, nextHarness] = fitSidePanes(desiredExplorer, desiredHarness, available)
        }
        setExplorerWidth(nextExplorer)
        if (!embeddedMode) setHarnessWidth(nextHarness)
      }
      else {
        const available = frame.current?.getBoundingClientRect().height ?? window.innerHeight
        nextTerminal = clamp(startTerminal - moveEvent.clientY + originY, TERMINAL_MIN, Math.max(TERMINAL_MIN, available - 180))
        setTerminalHeight(nextTerminal)
      }
    }
    const stop = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      if (kind === 'explorer') commitLayoutGeometry({ explorerWidth: nextExplorer })
      else if (kind === 'harness') commitLayoutGeometry({ harnessWidth: nextHarness })
      else commitLayoutGeometry({ terminalHeight: nextTerminal })
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
  }

  const recoveryWarning = persistenceStatus.kind === 'error' || persistenceStatus.kind === 'disabled'
    ? persistenceStatus.message
    : recoveryError
  const terminalSeparatorVisible = !compact && terminalPanelOpen && !terminalPanelMaximized
  const workbenchGridTemplateRows = compact
    ? compactTerminalOpen
      ? 'minmax(120px, 1fr) 0 minmax(120px, 40vh) 23px'
      : 'minmax(0, 1fr) 0 0 23px'
    : terminalPanelMaximized
      ? '0 0 minmax(120px, 1fr) 23px'
      : terminalPanelOpen
        ? `minmax(120px, 1fr) 5px ${terminalHeight}px 23px`
        : 'minmax(120px, 1fr) 0 35px 23px'

  const activeEditorSaveArea = (
    <div className={css.saveArea}>
      {!compact && (
        <button
          className={css.editorMore}
          type="button"
          aria-label={t('commands')}
          aria-keyshortcuts="Control+Shift+P Meta+Shift+P F1"
          title={`${t('commands')} (Ctrl/Cmd+Shift+P, F1)`}
          onPointerDown={() => { mutationController.cancel() }}
          onClick={() => executeWorkbenchCommand('workbench.action.showCommands')}
        >…</button>
      )}
      {openError !== undefined && <span title={openError}>Open failed</span>}
      {activeTab?.saveError !== undefined && <span title={activeTab.saveError}>Save failed</span>}
      {activeTab?.externalState !== undefined && (
        <span className={css.externalWarning} title={activeTab.externalState === 'deleted'
          ? 'This file was deleted outside the IDE. Your buffer is still open.'
          : 'This file changed outside the IDE. Unsaved local edits were preserved.'}
        >External {activeTab.externalState}</span>
      )}
      {workspaceId !== undefined && activeTab?.externalState === 'modified' && activeTab.dirty
        && activeTab.saveOutcome !== 'unknown' && activeTab.pendingConflictId === undefined && (
        <button
          type="button"
          onClick={() => requestDocumentConflict({
            workspaceId,
            workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
            path: activeTab.path,
            lifecycleId: activeTab.lifecycleId,
          })}
        >Review conflict</button>
      )}
      {coherenceError !== undefined && <span title={coherenceError}>Sync paused</span>}
      {recoveryWarning !== undefined && <span className={css.recoveryWarning} title={recoveryWarning}>Recovery unavailable</span>}
      {recoveryWarning !== undefined && workbenchRecoveryResetAvailable && (
        <button
          type="button"
          onClick={event => { openWorkbenchRecoveryReset(event.currentTarget) }}
        >Review hot-exit recovery...</button>
      )}
      {mutationRecoveryError !== undefined && (
        <span className={css.recoveryWarning} title={mutationRecoveryError}>File operation recovery required</span>
      )}
      {workspaceId !== undefined && mutationStatusNotice !== undefined && (
        <span className={css.recoveryWarning} title={mutationStatusNotice}>{mutationStatusNotice}</span>
      )}
      {!mutationWriter && mutationWriterOwned && mutationRecoveryError !== undefined && (
        <>
          <button type="button" onClick={retryMutationRecovery}>Retry file recovery</button>
          {invalidMutationRecoveryResetAvailable && (
            <button
              type="button"
              onClick={event => { openInvalidMutationRecoveryReset(event.currentTarget) }}
            >Review recovery safety fence...</button>
          )}
        </>
      )}
      {activeTab?.saveOutcome === 'unknown' && (
        <button type="button" onClick={() => executeWorkbenchCommand('workbench.action.files.checkSaveOutcome')}>Check save</button>
      )}
      {activeTab?.externalState === 'deleted' && activeTab.dirty && activeTab.saveOutcome !== 'unknown' && (
        <button
          type="button"
          disabled={activeTab.pendingSaveId !== undefined}
          onClick={() => executeWorkbenchCommand('workbench.action.files.recreateDeleted')}
        >{activeTab.pendingSaveId !== undefined ? 'Recreating…' : 'Recreate'}</button>
      )}
      {activeTab !== undefined && (activeTab.dirty || activeTab.pendingSaveId !== undefined) && (
        <button
          type="button"
          disabled={!activeTab.dirty || activeTab.pendingSaveId !== undefined
            || activeTab.pendingReloadId !== undefined || activeEditorMutationLeased
            || activeTab.pendingConflictId !== undefined
            || activeTab.readOnlyPresentation !== undefined
            || activeTab.saveOutcome === 'unknown' || activeTab.externalState === 'deleted'}
          onClick={() => executeWorkbenchCommand('workbench.action.files.save')}
        >
          {activeTab.readOnlyPresentation !== undefined
            ? t('readOnly')
            : activeTab.pendingSaveId !== undefined ? t('saving') : t('save')}
        </button>
      )}
    </div>
  )

  const activateEditorInGroup = (groupId: string, identity: DocumentIdentity): void => {
    const groupResult = editorGroups.activate(groupId, identity)
    if (groupResult === 'stale') return
    const current = documents.getSnapshot()
    if (current.activeWorkspaceId === identity.workspaceId
      && current.activeWorkspaceEpoch === identity.workspaceEpoch
      && documents.session(identity.workspaceId).activePath === identity.path) {
      return
    }
    activateEditor(identity)
  }

  const setEditorDragSession = (session: EditorTabDragSession | undefined): void => {
    setEditorGroupDropTarget(undefined)
    if (session === undefined) {
      editorGroups.cancelTabDrag(editorTabDragSession?.source)
      setEditorTabDragSession(undefined)
      return
    }
    const result = editorGroups.beginTabDrag(session.source)
    if (result === 'stale') {
      setEditorTabDragSession(undefined)
      return
    }
    setEditorTabDragSession(session)
  }

  const dragCanSplit = (event: ReactDragEvent<HTMLDivElement>): boolean => (
    editorTabDragSession !== undefined
    && Array.from(event.dataTransfer.types).includes(EDITOR_TAB_DRAG_MIME)
  )

  const applyEditorGroupSplit = (
    event: ReactDragEvent<HTMLDivElement>,
    groupId: string,
    edge: 'top' | 'right',
  ): void => {
    const source = dragCanSplit(event)
      ? resolveEditorTabDrag(editorTabDragSession, event.dataTransfer.getData(EDITOR_TAB_DRAG_MIME))
      : undefined
    if (source === undefined) {
      editorGroups.cancelTabDrag(editorTabDragSession?.source)
      setEditorGroupDropTarget(undefined)
      setEditorTabDragSession(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const result = editorGroups.splitTab(source, groupId, edge)
    setEditorGroupDropTarget(undefined)
    if (result.kind !== 'applied') editorGroups.cancelTabDrag(source)
    setEditorTabDragSession(undefined)
    if (result.kind === 'applied') {
      editorGroups.activate(result.groupId, source)
      activateEditor(source)
      requestEditorSurfaceFocus()
      return
    }
    if (result.kind === 'group-limit') {
      setCommandNotice({
        kind: 'status',
        message: locale === 'zh' ? '最多同时显示 4 个编辑器组。' : 'You can show at most 4 editor groups.',
      })
    } else if (result.kind === 'source-would-empty') {
      setCommandNotice({
        kind: 'status',
        message: locale === 'zh'
          ? '无法拆分组中的唯一文件；请先在该组打开另一个文件。'
          : 'The only file in a group cannot be split; open another file in that group first.',
      })
    }
  }

  const renderEditorGroupLayout = (layout: EditorGroupLayout, layoutKey: string): ReactNode => {
    if (layout.kind === 'split') {
      return (
        <div className={css.editorGroupSplit} data-split-axis={layout.axis} key={layoutKey}>
          <div className={css.editorGroupSplitPane}>
            {renderEditorGroupLayout(layout.first, `${layoutKey}-first`)}
          </div>
          <div className={css.editorGroupDivider} aria-hidden="true" />
          <div className={css.editorGroupSplitPane}>
            {renderEditorGroupLayout(layout.second, `${layoutKey}-second`)}
          </div>
        </div>
      )
    }

    const group = editorGroupsSnapshot.groups.find(candidate => candidate.id === layout.groupId)
    if (group === undefined) return null
    const groupTabs = group.tabs.flatMap(identity => {
      const tab = tabs.find(candidate => candidate.path === identity.path
        && candidate.lifecycleId === identity.lifecycleId)
      return tab === undefined ? [] : [tab]
    })
    const groupActiveTab = groupTabs.find(tab => tab.path === group.activePath) ?? groupTabs[0]
    const groupActiveIndex = groupActiveTab === undefined
      ? -1
      : groupTabs.findIndex(tab => tab.path === groupActiveTab.path
        && tab.lifecycleId === groupActiveTab.lifecycleId)
    const panelId = `${editorPanelId}-${group.id}`
    const isActiveGroup = group.id === activeEditorGroupId
    const groupMutationLeased = workspaceId !== undefined && groupActiveTab !== undefined
      && documents.isPathMutationLeased(workspaceId, groupActiveTab.path)
    const groupIdentity: DocumentIdentity | undefined = workspaceId === undefined || groupActiveTab === undefined
      ? undefined
      : {
          workspaceId,
          workspaceEpoch: documentSnapshot.activeWorkspaceEpoch,
          path: groupActiveTab.path,
          lifecycleId: groupActiveTab.lifecycleId,
        }
    const groupMarkdownPreviewCapable = groupActiveTab !== undefined
      && groupActiveTab.readOnlyPresentation === undefined
      && supportsMarkdownPreview(groupActiveTab.path)
    const groupPreviewMode = groupIdentity === undefined || !groupMarkdownPreviewCapable
      ? 'source'
      : previewModes.get(groupIdentity)
    const groupMediaDescriptor = groupActiveTab?.readOnlyPresentation === undefined
      ? undefined
      : mediaPreviewDescriptor(groupActiveTab.path)
    const activateGroupSurface = (): void => {
      if (groupIdentity !== undefined) activateEditorInGroup(group.id, groupIdentity)
    }
    const setGroupPreviewMode = (mode: 'source' | 'preview'): void => {
      if (groupIdentity === undefined) return
      activateGroupSurface()
      previewModes.set(groupIdentity, mode)
      requestEditorSurfaceFocus()
    }
    const dropTarget = editorGroupDropTarget?.groupId === group.id
      ? editorGroupDropTarget.edge
      : undefined

    return (
      <section
        key={layoutKey}
        className={css.editorGroupLeaf}
        data-editor-group-id={group.id}
        data-active-group={isActiveGroup || undefined}
      >
        <div className={css.tabBar}>
          <EditorTabs
            tabs={groupTabs}
            workspaceId={workspaceId ?? ''}
            workspaceEpoch={documentSnapshot.activeWorkspaceEpoch}
            activePath={groupActiveTab?.path}
            panelId={panelId}
            dragSession={editorTabDragSession}
            label={locale === 'zh' ? '打开的编辑器' : 'Open editors'}
            dragDescription={locale === 'zh'
              ? '拖到另一个标签左半侧可置于其前，右半侧可置于其后；拖到编辑区顶部或右侧可拆分视图。也可按 Alt+Shift+左右方向键移动。'
              : 'Drop on a tab half to reorder, or on the top or right edge of an editor to split. Use Alt+Shift+Left or Right Arrow to move by keyboard.'}
            onActivate={identity => { activateEditorInGroup(group.id, identity) }}
            onReorder={(source, target, placement) => {
              if (documents.reorderTab(source, target, placement) === 'stale') return
              const result = editorGroups.moveTab(source, group.id, target, placement)
              if (result !== 'applied') return
              activateEditor(source)
              requestEditorSurfaceFocus()
            }}
            onDragSessionChange={setEditorDragSession}
            onRequestClose={identity => { requestEditorClose(identity, 'tab') }}
            {...(!isActiveGroup || editorTabFocusRequest === undefined
              ? {}
              : { focusRequest: editorTabFocusRequest })}
            onFocusApplied={requestId => {
              setEditorTabFocusRequest(current => current?.requestId === requestId ? undefined : current)
            }}
          />
          {groupMarkdownPreviewCapable && (
            <div className={css.markdownViewSwitcher} role="group" aria-label={t('markdownPreview')}>
              <button
                type="button"
                aria-pressed={groupPreviewMode === 'source'}
                title={t('showMarkdownSource')}
                onClick={() => { setGroupPreviewMode('source') }}
              >{t('sourceView')}</button>
              <button
                type="button"
                aria-pressed={groupPreviewMode === 'preview'}
                title={t('showMarkdownPreview')}
                onClick={() => { setGroupPreviewMode('preview') }}
              >{t('previewView')}</button>
            </div>
          )}
          {isActiveGroup ? activeEditorSaveArea : null}
        </div>
        <div
          id={panelId}
          className={css.editorPanel}
          role="tabpanel"
          onPointerDownCapture={activateGroupSurface}
          onFocusCapture={activateGroupSurface}
          {...(groupActiveIndex < 0
            ? { 'aria-label': locale === 'zh' ? '编辑器' : 'Editor' }
            : { 'aria-labelledby': editorTabDomId(panelId, groupActiveIndex) })}
        >
          {groupActiveTab !== undefined && groupActiveTab.readOnlyPresentation === undefined
            && groupPreviewMode === 'preview' ? (
            <MarkdownPreview
              path={groupActiveTab.path}
              content={groupActiveTab.content}
              onOpenPath={openMarkdownPath}
              resolveImageSrc={resolveMarkdownImageSrc}
              {...(!isActiveGroup || editorFocusRequest === undefined
                ? {}
                : { focusRequest: editorFocusRequest })}
              onFocusApplied={requestId => {
                setEditorFocusRequest(current => current === requestId ? undefined : current)
              }}
            />
          ) : groupActiveTab !== undefined && groupActiveTab.readOnlyPresentation === undefined ? (
            <CodeEditor
              workspaceId={workspaceId}
              tab={groupActiveTab}
              registry={editorSessions}
              readOnly={groupMutationLeased}
              wordWrap={wordWrap}
              colorScheme={colorScheme}
              {...(!isActiveGroup || editorFocusRequest === undefined
                ? {}
                : { focusRequest: editorFocusRequest })}
              onFocusApplied={requestId => {
                setEditorFocusRequest(current => current === requestId ? undefined : current)
              }}
              {...(!isActiveGroup || activeReveal === undefined ? {} : { revealRequest: activeReveal })}
              onRevealApplied={requestId => navigation.acknowledge(requestId)}
              onHistoryPort={port => publishEditorHistoryPort(group.id, port)}
              onCursorPosition={(reportedWorkspace, path, lifecycleId, position) => {
                const current = documents.getSnapshot()
                if (current.activeWorkspaceId !== reportedWorkspace) return
                const currentSession = documents.session(reportedWorkspace)
                const currentTab = currentSession.tabs.find(tab => tab.path === path
                  && tab.lifecycleId === lifecycleId)
                if (currentSession.activePath !== path || currentTab === undefined
                  || currentTab.readOnlyPresentation !== undefined) return
                navigation.observeActiveLocation({
                  workspaceId: reportedWorkspace,
                  workspaceEpoch: current.activeWorkspaceEpoch,
                  path,
                  lifecycleId,
                  historyEpoch: currentTab.historyEpoch,
                  localRevision: currentTab.localRevision,
                }, position)
                const report = {
                  workspaceId: reportedWorkspace,
                  workspaceEpoch: current.activeWorkspaceEpoch,
                  path,
                  lifecycleId,
                  ...position,
                }
                setEditorCursorReport(previous => previous?.workspaceId === report.workspaceId
                  && previous.workspaceEpoch === report.workspaceEpoch
                  && previous.path === report.path
                  && previous.lifecycleId === report.lifecycleId
                  && previous.lineNumber === report.lineNumber
                  && previous.columnNumber === report.columnNumber
                  ? previous
                  : report)
              }}
              onChange={(changedWorkspace, path, lifecycleId, content) => {
                documents.editDocument(changedWorkspace, path, lifecycleId, content)
              }}
              onViewState={(changedWorkspace, path, lifecycleId, viewState) => {
                documents.updateViewState(changedWorkspace, path, lifecycleId, viewState)
              }}
            />
          ) : groupActiveTab !== undefined && workspaceId !== undefined && groupMediaDescriptor !== undefined ? (
            <MediaPreview
              workspaceId={workspaceId}
              path={groupActiveTab.path}
              version={groupActiveTab.version}
              descriptor={groupMediaDescriptor}
              previewLabel={groupMediaDescriptor.kind === 'image'
                ? t('imagePreview')
                : groupMediaDescriptor.kind === 'video' ? t('videoPreview') : t('audioPreview')}
              loadingLabel={t('loadingMediaPreview')}
              errorLabel={t('mediaPreviewFailed')}
              {...(!isActiveGroup || editorFocusRequest === undefined
                ? {}
                : { focusRequest: editorFocusRequest })}
              onFocusApplied={requestId => {
                setEditorFocusRequest(current => current === requestId ? undefined : current)
              }}
            />
          ) : groupActiveTab?.readOnlyPresentation !== undefined ? (
            <ReadOnlyFileView
              path={groupActiveTab.path}
              content={groupActiveTab.content}
              presentation={groupActiveTab.readOnlyPresentation}
              {...(!isActiveGroup || editorFocusRequest === undefined
                ? {}
                : { focusRequest: editorFocusRequest })}
              onFocusApplied={requestId => {
                setEditorFocusRequest(current => current === requestId ? undefined : current)
              }}
            />
          ) : null}
        </div>
        {editorTabDragSession === undefined ? null : (
          <div className={css.editorGroupDropOverlay} aria-hidden="true">
            {(['top', 'right'] as const).map(edge => (
              <div
                key={edge}
                className={css.editorGroupDropZone}
                data-edge={edge}
                data-drop-active={dropTarget === edge || undefined}
                onDragOver={event => {
                  if (!dragCanSplit(event)) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== edge) setEditorGroupDropTarget({ groupId: group.id, edge })
                }}
                onDragLeave={event => {
                  const related = event.relatedTarget
                  if (related instanceof Node && event.currentTarget.contains(related)) return
                  if (dropTarget === edge) setEditorGroupDropTarget(undefined)
                }}
                onDrop={event => { applyEditorGroupSplit(event, group.id, edge) }}
              />
            ))}
          </div>
        )}
      </section>
    )
  }

  return (
    <main
      ref={frame}
      className={`${css.app} ${embeddedMode ? css.appEmbedded : ''} ${compact ? css.appCompact : ''}`}
      style={{ gridTemplateColumns: compact
        ? 'minmax(0, 1fr)'
        : embeddedMode
          ? `${explorerWidth}px 5px minmax(0, 1fr)`
          : `${explorerWidth}px 5px minmax(0, 1fr) 5px ${harnessWidth}px` }}
    >
      <aside
        ref={explorerPanel}
        className={`${css.explorer} ${compact ? (compactPanel === 'rail' ? css.compactPanelOpen : css.compactPanelClosed) : ''}`}
        {...(compact && compactPanel === 'rail'
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': railView === 'search' ? 'Search side panel' : 'Explorer side panel' }
          : {})}
        onKeyDown={event => { if (compactPanel === 'rail') trapModalFocus(event, closeCompactPanel) }}
      >
        <header className={css.appHeader}>
          <div className={css.headerTitleRow}>
            {!embeddedMode && <strong>DSH Code IDE</strong>}
            {compact && <button ref={explorerClose} type="button" aria-label="Close side panel" onPointerDown={() => { mutationController.cancel() }} onClick={closeCompactPanel}>×</button>}
          </div>
          {!embeddedMode && (
            <select
              aria-label="Workspace"
              value={workspaceId ?? ''}
              disabled={!bootReady}
              onPointerDown={() => { mutationController.cancel() }}
              onChange={event => { selectWorkspace(event.target.value || undefined) }}
            >
              {workspaces.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
            </select>
          )}
          <nav className={css.viewSwitcher} aria-label={t('primarySideBar')}>
            <button type="button" aria-pressed={railView === 'explorer'} onClick={() => executeWorkbenchCommand('workbench.view.explorer')}>{t('explorer')}</button>
            <button type="button" aria-pressed={railView === 'search'} onPointerDown={() => { mutationController.cancel() }} onClick={() => executeWorkbenchCommand('workbench.view.search')}>{t('search')}</button>
          </nav>
        </header>
        {workspaceError !== undefined ? <div className={css.error}>{workspaceError}</div> : railView === 'explorer' ? (
          <FileExplorer
            workspace={workspace}
            store={explorerStore}
            controller={explorerController}
            onOpen={entry => { void openFile(entry) }}
            focusRequest={explorerFocusRequest}
            portalDismissRequest={explorerPortalDismissRequest}
            onError={error => { setOpenError(error instanceof Error ? error.message : String(error)) }}
            writeClipboard={writeClipboard}
            onClipboardWriteResult={result => {
              setCommandNotice(result.status === 'copied'
                ? { kind: 'status', message: 'Copied relative path.' }
                : {
                    kind: 'error',
                    message: `Could not copy relative path: ${result.error instanceof Error
                      ? result.error.message
                      : String(result.error)}`,
                  })
            }}
            {...(mutationUiEnabled ? {
              mutationStore,
              mutationController,
              mutationAdmissionEnabled: mutationWriter,
              mutationCreateFileEnabled: mutationCapabilities?.createFile ?? false,
              mutationCreateDirectoryEnabled: mutationCapabilities?.createDirectory ?? false,
              mutationRenameEnabled: mutationCapabilities?.rename ?? false,
              mutationDeleteEnabled: mutationCapabilities?.delete ?? false,
              mutationRecoveryWritable: mutationWriterOwned,
            } : {})}
          />
        ) : (
          <SearchView
            key={`${workspaceId ?? ''}:${String(documentSnapshot.activeWorkspaceEpoch)}`}
            focusRequest={searchFocusRequest}
            query={workspaceSearchSession.query.pattern}
            include={searchIncludeDraft}
            exclude={searchExcludeDraft}
            matchCase={workspaceSearchSession.query.caseSensitive}
            wholeWord={workspaceSearchSession.query.wholeWord}
            useRegex={workspaceSearchSession.query.mode === 'regex'}
            groups={searchView.groups}
            matchCount={workspaceSearchSession.matchCount}
            fileCount={workspaceSearchSession.fileCount}
            searching={workspaceSearchSession.status === 'running'}
            cancelled={workspaceSearchSession.status === 'cancelled'}
            hasSearched={workspaceSearchSession.status !== 'idle'}
            truncated={workspaceSearchSession.truncated}
            dirtyBuffersOmitted={workspaceSearchSession.dirtyBuffersOmitted}
            replacePreviewEligible={replacePreviewEligible}
            replace={{
              value: searchReplaceDraft,
              phase: workspaceReplaceSnapshot.phase,
              ...(workspaceReplaceSnapshot.preview === undefined ? {} : {
                preview: workspaceReplaceSnapshot.preview,
              }),
              ...(workspaceReplaceSnapshot.error === undefined ? {} : {
                error: workspaceReplaceSnapshot.error,
              }),
              onValueChange: value => {
                workspaceReplaceController.cancel()
                setSearchReplaceDraft(value)
              },
              onPreview: () => { void workspaceReplaceController.preview(searchReplaceDraft) },
              onApply: token => { void workspaceReplaceController.apply(token) },
              onCancel: () => { workspaceReplaceController.cancel() },
            }}
            {...((searchDraftError ?? workspaceSearchSession.error) === undefined
              ? {}
              : { error: searchDraftError ?? workspaceSearchSession.error })}
            onQueryChange={pattern => updateSearchQuery({ pattern })}
            onIncludeChange={value => { updateSearchFilterDrafts(value, searchExcludeDraft) }}
            onExcludeChange={value => { updateSearchFilterDrafts(searchIncludeDraft, value) }}
            onMatchCaseChange={caseSensitive => updateSearchQuery({ caseSensitive })}
            onWholeWordChange={wholeWord => updateSearchQuery({ wholeWord })}
            onUseRegexChange={enabled => updateSearchQuery({ mode: enabled ? 'regex' : 'literal' })}
            onSearch={runWorkspaceSearch}
            onStop={() => {
              searchOpenGeneration.current += 1
              workspaceSearchController.cancel()
              workspaceReplaceController.cancel()
            }}
            onClear={clearWorkspaceSearch}
            onOpen={match => { void openSearchResult(match) }}
          />
        )}
      </aside>
      <div
        className={`${css.verticalHandle} ${compact ? css.compactHidden : ''}`}
        role="separator"
        aria-label={t('resizeExplorer')}
        aria-orientation="vertical"
        aria-valuemin={EXPLORER_MIN}
        aria-valuemax={EXPLORER_MAX}
        aria-valuenow={explorerWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const requested = clamp(explorerWidth + (event.key === 'ArrowLeft' ? -16 : 16), EXPLORER_MIN, EXPLORER_MAX)
          const available = frame.current?.getBoundingClientRect().width ?? window.innerWidth
          if (embeddedMode) {
            const nextExplorer = fitExplorerPane(requested, available)
            setExplorerWidth(nextExplorer)
            commitLayoutGeometry({ explorerWidth: nextExplorer })
          } else {
            const [nextExplorer, nextHarness] = fitSidePanes(requested, harnessWidth, available)
            setExplorerWidth(nextExplorer)
            setHarnessWidth(nextHarness)
            commitLayoutGeometry({ explorerWidth: nextExplorer })
          }
        }}
        onPointerDown={event => { startDrag('explorer', event) }}
      />

      <section
        ref={workbench}
        className={css.workbench}
        style={{ gridTemplateRows: workbenchGridTemplateRows }}
      >
        <div className={css.editorArea}>
          {compact && (
            <div className={css.compactToolbar} aria-label={t('primarySideBar')}>
              <button ref={compactFilesButton} type="button" onClick={() => executeWorkbenchCommand('workbench.view.explorer')}>{t('explorer')}</button>
              <button type="button" onPointerDown={() => { mutationController.cancel() }} onClick={() => executeWorkbenchCommand('workbench.action.quickOpen')}>{t('open')}</button>
              <button type="button" aria-keyshortcuts="Control+Shift+P Meta+Shift+P F1" onPointerDown={() => { mutationController.cancel() }} onClick={() => executeWorkbenchCommand('workbench.action.showCommands')}>{t('commands')}</button>
              <button type="button" onPointerDown={() => { mutationController.cancel() }} onClick={() => executeWorkbenchCommand('workbench.view.search')}>{t('search')}</button>
              <button type="button" aria-pressed={compactTerminalOpen} onClick={() => executeWorkbenchCommand('workbench.action.terminal.toggle')}>{t('terminal')}</button>
              {!embeddedMode && <button ref={compactHarnessButton} type="button" aria-pressed={compactPanel === 'harness'} onPointerDown={() => { mutationController.cancel() }} onClick={() => executeWorkbenchCommand('workbench.action.harness.focus')}>{t('harness')}</button>}
            </div>
          )}
          <div className={css.editorGroupsRoot}>
            {editorGroupsSnapshot.layout === undefined
              ? null
              : renderEditorGroupLayout(editorGroupsSnapshot.layout, 'editor-groups-root')}
          </div>
        </div>
        <div
          className={`${css.horizontalHandle} ${terminalSeparatorVisible ? '' : css.compactHidden}`}
          role="separator"
          aria-label={t('resizeTerminal')}
          aria-orientation="horizontal"
          aria-valuemin={TERMINAL_MIN}
          aria-valuemax={Math.max(TERMINAL_MIN, (frame.current?.getBoundingClientRect().height ?? window.innerHeight) - 180)}
          aria-valuenow={terminalHeight}
          tabIndex={terminalSeparatorVisible ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const maximum = Math.max(TERMINAL_MIN, (frame.current?.getBoundingClientRect().height ?? window.innerHeight) - 180)
            const next = clamp(terminalHeight + (event.key === 'ArrowUp' ? 16 : -16), TERMINAL_MIN, maximum)
            setTerminalHeight(next)
            commitLayoutGeometry({ terminalHeight: next })
          }}
          onPointerDown={event => { startDrag('terminal', event) }}
        />
        {maxTerminalSessions === undefined
          ? <div className={css.terminalMount}>
              <div className={css.terminalRoot}><div className={css.empty}>{t('loadingTerminalCapacity')}</div></div>
            </div>
          : <div className={css.terminalMount} hidden={compact && !compactTerminalOpen}>
              <TerminalPane
                workspaceId={workspaceId}
                workspaceEpoch={documentSnapshot.activeWorkspaceEpoch}
                maxSessions={maxTerminalSessions}
                paneVisible={compact ? compactTerminalOpen : terminalPanelOpen}
                colorScheme={colorScheme}
                {...(compact ? {} : {
                  collapsed: !terminalPanelOpen,
                  maximized: terminalPanelMaximized,
                  onToggleCollapsed: toggleTerminal,
                  onToggleMaximized: toggleTerminalPanelMaximized,
                })}
                {...(terminalFocusRequest === undefined ? {} : { focusRequest: terminalFocusRequest })}
                onFocusApplied={requestId => {
                  setTerminalFocusRequest(current => current?.requestId === requestId ? undefined : current)
                }}
                onCommandPort={publishTerminalCommandPort}
              />
            </div>}
        <div className={css.editorStatusBar} aria-label={t('editorStatus')}>
          {activeMarkdownPreview ? <span>{t('markdownPreview')}</span>
            : activeMediaDescriptor !== undefined
              ? <span>{activeMediaDescriptor.kind === 'image'
                  ? t('imagePreview')
                  : activeMediaDescriptor.kind === 'video' ? t('videoPreview') : t('audioPreview')}</span>
              : activeTab !== undefined ? <>
            {activeCursorPosition !== undefined && (
              <button
                type="button"
                aria-label={t('cursorPosition', { line: activeCursorPosition.lineNumber, column: activeCursorPosition.columnNumber })}
                title={t('goToLineColumn')}
                onClick={() => executeWorkbenchCommand('workbench.action.gotoLine')}
              >{t('cursorPosition', { line: activeCursorPosition.lineNumber, column: activeCursorPosition.columnNumber })}</button>
            )}
            {activeTab.readOnlyPresentation === undefined && (
              <EditorLineEndingStatus
                lineEnding={activeTab.lineEnding ?? '\n'}
                disabled={!bootReady || activeEditorMutationLeased
                  || activeTab.pendingSaveId !== undefined
                  || activeTab.pendingReloadId !== undefined
                  || activeTab.pendingConflictId !== undefined
                  || activeTab.saveOutcome === 'unknown'
                  || activeTab.externalState === 'deleted'}
                onOpen={() => executeWorkbenchCommand('workbench.action.editor.changeEOL')}
              />
            )}
            {activeEditorLanguage !== undefined && activeTab.readOnlyPresentation === undefined && (
              <button
                type="button"
                title={t('changeLanguageMode')}
                onClick={() => executeWorkbenchCommand('workbench.action.editor.changeLanguageMode')}
              >{activeEditorLanguage.label}</button>
            )}
            {activeEditorIndentation !== undefined && activeTab.readOnlyPresentation === undefined && (
              <button
                type="button"
                title={t('changeIndentationSize')}
                onClick={() => executeWorkbenchCommand('editor.action.changeIndentationSize')}
              >{activeEditorIndentation.style === 'spaces'
                  ? t('spacesSize', { size: activeEditorIndentation.size })
                  : t('tabSize', { size: activeEditorIndentation.size })}</button>
            )}
              </> : null}
        </div>
      </section>

      {!embeddedMode && (
      <>
      <div
        className={`${css.verticalHandle} ${compact ? css.compactHidden : ''}`}
        role="separator"
        aria-label="Resize DeepSeek Harness"
        aria-orientation="vertical"
        aria-valuemin={HARNESS_MIN}
        aria-valuemax={HARNESS_MAX}
        aria-valuenow={harnessWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const requested = clamp(harnessWidth + (event.key === 'ArrowLeft' ? 16 : -16), HARNESS_MIN, HARNESS_MAX)
          const available = frame.current?.getBoundingClientRect().width ?? window.innerWidth
          const [nextExplorer, nextHarness] = fitSidePanes(explorerWidth, requested, available)
          setExplorerWidth(nextExplorer)
          setHarnessWidth(nextHarness)
          commitLayoutGeometry({ harnessWidth: nextHarness })
        }}
        onPointerDown={event => { startDrag('harness', event) }}
      />
      <aside
        ref={harnessPanel}
        className={`${css.harnessPane} ${compact ? (compactPanel === 'harness' ? css.compactPanelOpen : css.compactPanelClosed) : ''}`}
        {...(compact && compactPanel === 'harness'
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'DeepSeek Harness panel' }
          : {})}
        onKeyDown={event => { if (compactPanel === 'harness') trapModalFocus(event, closeCompactPanel) }}
      >
        <div className={css.harnessHeader}>
          <span>DEEPSEEK HARNESS</span>
          {compact && <button ref={harnessClose} type="button" aria-label="Close Harness" onPointerDown={() => { mutationController.cancel() }} onClick={closeCompactPanel}>×</button>}
        </div>
        <iframe
          ref={harnessFrame}
          className={css.harnessFrame}
          src="/"
          title="DeepSeek Harness"
          onFocus={scheduleHiddenCompactFocusRestore}
          onLoad={scheduleHiddenCompactFocusRestore}
        />
      </aside>
      </>
      )}
      <div className={css.commandNotice} aria-live="polite" aria-atomic="true">
        {keybindingSnapshot.pending !== undefined
          ? `${keybindingSnapshot.pending.label} pressed. Waiting for the second key of the chord.`
          : commandNotice?.kind === 'status' ? commandNotice.message : null}
      </div>
      {commandNotice?.kind === 'error' && quickInputMode === 'none' && !keyboardShortcutsOpen
        && !documentConflictModalOpen && compactPanel === 'none' ? (
        <div className={css.commandError} role="alert">
          <span>{commandNotice.message}</span>
          <button type="button" aria-label="Dismiss command error" onClick={() => setCommandNotice(undefined)}>×</button>
        </div>
      ) : null}
      <QuickInputDialog
        open={quickInputMode !== 'none'}
        query={quickInputMode === 'commands'
          ? commandPaletteSnapshot.query
          : quickInputMode === 'line'
            ? lineQuery
            : quickInputMode === 'eol'
              ? eolQuery
              : quickInputMode === 'language'
                ? languageQuery
                : quickInputMode === 'indentation' ? indentationQuery : quickOpenSnapshot.query}
        options={quickInputOptions}
        title={quickInputPresentation(locale, quickInputMode).title}
        inputLabel={quickInputPresentation(locale, quickInputMode).inputLabel}
        placeholder={quickInputPresentation(locale, quickInputMode).placeholder}
        listLabel={quickInputPresentation(locale, quickInputMode).listLabel}
        status={quickInputMode === 'commands'
          ? locale === 'zh' ? `${commandPaletteSnapshot.items.length} 条命令可用。` : `${commandPaletteSnapshot.items.length} command${commandPaletteSnapshot.items.length === 1 ? '' : 's'} available.`
          : quickInputMode === 'line'
            ? lineQuery.trim().length === 0
              ? locale === 'zh' ? '输入正整数行号。' : 'Type a positive line number.'
              : parseEditorLocation(lineQuery) === undefined
                ? locale === 'zh' ? '使用“行号”或“行号:列号”。' : 'Use line or line:column with positive numbers.'
                : locale === 'zh' ? '按 Enter 移动光标。' : 'Press Enter to move the cursor.'
          : quickInputMode === 'eol'
            ? locale === 'zh' ? '选择保存时使用的行尾序列。' : 'Choose how line endings are materialized when saved.'
          : quickInputMode === 'language'
            ? locale === 'zh' ? '选择当前编辑器的语法和语言功能。' : 'Choose the syntax and editor language features for this editor.'
          : quickInputMode === 'indentation'
            ? locale === 'zh' ? '选择当前编辑器的缩进宽度。' : 'Choose the indentation width for this editor.'
          : quickOpenSnapshot.status === 'debouncing' || quickOpenSnapshot.status === 'running'
            ? locale === 'zh' ? '正在搜索文件…' : 'Searching files…'
            : quickOpenOptions.length === 0
              ? quickOpenSnapshot.query.length === 0 ? locale === 'zh' ? '输入文件名进行搜索。' : 'Type a file name to search.' : locale === 'zh' ? '没有匹配的文件。' : 'No matching files.'
              : locale === 'zh' ? `找到 ${quickOpenOptions.length} 个文件${quickOpenSnapshot.incomplete ? '；结果已截断' : ''}。` : `${quickOpenOptions.length} file${quickOpenOptions.length === 1 ? '' : 's'} found${quickOpenSnapshot.incomplete ? '; results truncated' : ''}.`}
        hint={quickInputMode === 'line'
          ? locale === 'zh' ? '示例：42、:42 或 42:7。' : 'Examples: 42, :42, or 42:7.'
          : quickInputMode === 'files' && quickOpenSnapshot.incomplete
            ? locale === 'zh' ? '继续输入以缩小结果范围。' : 'Keep typing to narrow the truncated result set.'
            : undefined}
        busy={quickInputMode === 'files'
          ? quickOpenSnapshot.status === 'debouncing' || quickOpenSnapshot.status === 'running'
          : quickInputMode === 'commands' && commandPaletteSnapshot.items.some(item => item.running)}
        {...(quickInputMode === 'commands'
          ? { activeIndex: commandPaletteSnapshot.activeIndex, onActiveIndexChange: (index: number) => commands.palette.store.selectIndex(index) }
          : quickInputMode === 'eol'
            ? { activeIndex: eolActiveIndex, onActiveIndexChange: setEolActiveIndex }
            : quickInputMode === 'language'
              ? { activeIndex: languageActiveIndex, onActiveIndexChange: setLanguageActiveIndex }
            : quickInputMode === 'indentation'
              ? { activeIndex: indentationActiveIndex, onActiveIndexChange: setIndentationActiveIndex }
              : {})}
        {...(commandNotice?.kind === 'error'
          ? { error: commandNotice.message }
          : quickInputMode === 'files' && quickOpenSnapshot.error !== undefined ? { error: quickOpenSnapshot.error } : {})}
        onQueryChange={query => {
          if (quickInputMode === 'commands') commands.palette.setQuery(query)
          else if (quickInputMode === 'line') {
            setLineQuery(query)
            if (commandNotice?.kind === 'error') setCommandNotice(undefined)
          } else if (quickInputMode === 'eol') {
            setEolQuery(query)
            if (commandNotice?.kind === 'error') setCommandNotice(undefined)
          } else if (quickInputMode === 'language') {
            setLanguageQuery(query)
            if (commandNotice?.kind === 'error') setCommandNotice(undefined)
          } else if (quickInputMode === 'indentation') {
            setIndentationQuery(query)
            if (commandNotice?.kind === 'error') setCommandNotice(undefined)
          } else quickOpenController.setQuery(query)
        }}
        onSelect={selectQuickInputOption}
        onDismiss={() => {
          quickInputRestoreTarget.current = 'default'
          setQuickInputMode('none')
          quickOpenController.setQuery('')
          commands.palette.setQuery('')
          setLineQuery('')
          setEolQuery('')
          pendingEolTarget.current = undefined
          setLanguageQuery('')
          pendingLanguageTarget.current = undefined
          setIndentationQuery('')
          pendingIndentationTarget.current = undefined
          if (commandNotice?.kind === 'error') setCommandNotice(undefined)
        }}
        onRestoreFocus={restoreQuickInputFocus}
      />
      <KeyboardShortcutsDialog
        open={keyboardShortcutsOpen}
        snapshot={keybindingSnapshot}
        catalog={commandCatalog}
        onAdd={async input => await commands.shortcuts.addUserBinding(input)}
        onReplace={async (bindingId, input) => await commands.shortcuts.replaceUserBinding(bindingId, input)}
        onReplaceDefault={async (commandId, bindingId, input) => await commands.shortcuts.replaceDefaultBinding(commandId, bindingId, input)}
        onRemoveUser={async bindingId => await commands.shortcuts.removeUserBinding(bindingId)}
        onUnbindDefault={async (commandId, bindingId) => await commands.shortcuts.unbindDefault(commandId, bindingId)}
        onResetCommand={async commandId => await commands.shortcuts.resetCommand(commandId)}
        onResetAll={async () => await commands.shortcuts.resetAll()}
        onResetInvalid={async () => await commands.shortcuts.resetInvalidSettings()}
        onPreview={input => commands.shortcuts.previewUserBinding(input)}
        onFindSame={sequence => commands.shortcuts.findSame(sequence)}
        onDismiss={() => {
          keyboardShortcutsOpenRef.current = false
          setKeyboardShortcutsOpen(false)
        }}
        onRestoreFocus={restoreKeyboardShortcutsFocus}
      />
      <WorkbenchRecoveryDialog
        open={workbenchRecoveryModalOpen}
        busy={workbenchRecoveryBusy}
        canReset={workbenchRecoveryResetAvailable}
        exported={workbenchRecoveryExported}
        {...(workbenchRecoveryDialogError === undefined ? {} : { error: workbenchRecoveryDialogError })}
        onDismiss={() => {
          if (workbenchRecoveryBusy) return
          workbenchRecoveryExportRaw.current = undefined
          setWorkbenchRecoveryExported(false)
          setWorkbenchRecoveryDialogOpen(false)
        }}
        onExport={exportInvalidWorkbenchRecovery}
        onConfirm={resetInvalidWorkbenchRecovery}
        onRestoreFocus={restoreWorkbenchRecoveryFocus}
      />
      <InvalidMutationRecoveryDialog
        open={invalidMutationRecoveryModalOpen}
        busy={invalidMutationRecoveryResetBusy}
        canReset={invalidMutationRecoveryResetAvailable}
        {...(invalidMutationRecoveryResetError === undefined ? {} : { error: invalidMutationRecoveryResetError })}
        onDismiss={() => { if (!invalidMutationRecoveryResetBusy) setInvalidMutationRecoveryDialogOpen(false) }}
        onConfirm={resetInvalidMutationRecovery}
        onRestoreFocus={restoreInvalidMutationRecoveryFocus}
      />
      <DocumentConflictDialog
        snapshot={documentConflictSnapshot}
        onAcceptRemote={() => {
          if (documentConflictSnapshot.phase === 'idle') return
          const identity = documentConflictSnapshot.intent
          void documentConflictController.acceptRemote().then(outcome => {
            handleDocumentConflictOutcome(outcome, identity)
          })
        }}
        onKeepLocal={() => {
          if (documentConflictSnapshot.phase === 'idle') return
          const identity = documentConflictSnapshot.intent
          void documentConflictController.keepLocal().then(outcome => {
            handleDocumentConflictOutcome(outcome, identity)
          })
        }}
        onApplyMerged={content => {
          if (documentConflictSnapshot.phase === 'idle') return
          const identity = documentConflictSnapshot.intent
          void documentConflictController.applyMerged(content).then(outcome => {
            handleDocumentConflictOutcome(outcome, identity)
          })
        }}
        onRetry={() => { void documentConflictController.retry() }}
        onCancel={() => {
          if (documentConflictSnapshot.phase === 'idle') return
          const identity = documentConflictSnapshot.intent
          documentConflictOpenRef.current = false
          if (documentConflictController.cancel()) restoreDocumentConflictFocus(identity)
        }}
        onPresentationApplied={requestId => {
          documentConflictController.acknowledgePresentation(requestId)
        }}
      />
      <EditorCloseDialog
        snapshot={editorCloseSnapshot}
        onSave={() => {
          if (editorCloseSnapshot.phase !== 'confirming'
            && !(editorCloseSnapshot.phase === 'error' && editorCloseSnapshot.actions === 'decide')) return
          const context = editorCloseSnapshot
          void editorCloseController.save().then(outcome => {
            const workspace = {
              workspaceId: context.identity.workspaceId,
              workspaceEpoch: context.identity.workspaceEpoch,
            }
            if (!handleEditorCloseBatchResult(
              editorCloseBatch.resume(context.identity, outcome),
              workspace,
            )) handleEditorCloseOutcome(outcome, context)
          })
        }}
        onDiscard={() => {
          if (editorCloseSnapshot.phase !== 'confirming'
            && !(editorCloseSnapshot.phase === 'error' && editorCloseSnapshot.actions === 'decide')) return
          const context = editorCloseSnapshot
          const outcome = editorCloseController.discard()
          const workspace = {
            workspaceId: context.identity.workspaceId,
            workspaceEpoch: context.identity.workspaceEpoch,
          }
          if (!handleEditorCloseBatchResult(
            editorCloseBatch.resume(context.identity, outcome),
            workspace,
          )) handleEditorCloseOutcome(outcome, context)
        }}
        onCancel={() => {
          if (editorCloseSnapshot.phase === 'idle' || editorCloseSnapshot.phase === 'saving') return
          const context = editorCloseSnapshot
          if (editorCloseController.cancel()) {
            const workspace = {
              workspaceId: context.identity.workspaceId,
              workspaceEpoch: context.identity.workspaceEpoch,
            }
            if (!handleEditorCloseBatchResult(
              editorCloseBatch.cancel(context.identity),
              workspace,
            )) restoreEditorCloseFocus(context)
          }
        }}
        onPresentationApplied={requestId => {
          editorCloseController.acknowledgePresentation(requestId)
        }}
      />
    </main>
  )
}
