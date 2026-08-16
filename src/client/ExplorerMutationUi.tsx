import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { useIdeI18n, type IdeLocale } from './i18n.tsx'
import { MUTATION_MANUAL_RECONCILIATION_REQUIRED } from './mutations/controller.ts'
import type {
  MutationDraft,
  MutationFocusRequest,
  MutationImpact,
  MutationResourceKind,
  MutationSource,
  WorkspaceMutationSnapshot,
  WorkspaceMutationStore,
} from './mutations/store.ts'
import css from './ide.module.css'

export type ExplorerMutationResult = 'committed' | 'blocked' | 'unknown' | 'failed' | 'stale' | 'acknowledged'

/** The deliberately narrow controller surface consumed by Explorer. */
export interface ExplorerMutationController {
  beginCreate(parentPath: string, type: MutationResourceKind): unknown
  beginRename(source: MutationSource): unknown
  /** Optional because legacy/test adapters may expose rename without drag-to-folder movement. */
  beginMove?(source: MutationSource, destinationParentPath: string): unknown
  beginDelete(source: MutationSource): unknown
  updateName(name: string): unknown
  requestConfirmation(): unknown
  submit(): Promise<ExplorerMutationResult>
  reconcileUnknown(): Promise<ExplorerMutationResult>
  retryCommitted(): Promise<ExplorerMutationResult>
  acknowledgeUnresolvedOutcome(): Promise<ExplorerMutationResult>
  cancel(): unknown
}

/** Structural so tests and alternate page adapters do not need the concrete store class. */
export type ExplorerMutationStore = Pick<
  WorkspaceMutationStore,
  'getSnapshot' | 'subscribe' | 'acknowledgeFocus'
>

export interface ExplorerNameValidation {
  readonly valid: boolean
  readonly message?: string
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/iu
const INVALID_COMPONENT_CHARACTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/u
const HOST_INTERNAL_NAME_PREFIX = '.__dsh_code_ide_'

function utf8Length(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
  return unescape(encodeURIComponent(value)).length
}

/** Conservative cross-platform component validation; the controller remains authoritative. */
export function validateExplorerMutationName(name: string, locale: IdeLocale = 'en'): ExplorerNameValidation {
  const message = (english: string, chinese: string): string => locale === 'zh' ? chinese : english
  if (name.length === 0) return { valid: false, message: message('Enter a name.', '请输入名称。') }
  if (name === '.' || name === '..') {
    return { valid: false, message: message('Choose a name other than . or ...', '名称不能是“.”或“..”。') }
  }
  if (INVALID_COMPONENT_CHARACTER.test(name)) {
    return {
      valid: false,
      message: message(
        'Names cannot contain slashes, control characters, or < > : " | ? *.',
        '名称不能包含斜杠、控制字符或 < > : " | ? *。',
      ),
    }
  }
  if (/[. ]$/u.test(name)) {
    return { valid: false, message: message('Names cannot end with a period or space.', '名称不能以句点或空格结尾。') }
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    return { valid: false, message: message('That name is reserved by Windows.', '该名称是 Windows 保留名称。') }
  }
  if (name.toLowerCase().startsWith(HOST_INTERNAL_NAME_PREFIX)) {
    return {
      valid: false,
      message: message(
        'That name is reserved for internal workspace operations.',
        '该名称保留用于工作区内部操作。',
      ),
    }
  }
  if (utf8Length(name) > 255) {
    return { valid: false, message: message('The name is longer than 255 UTF-8 bytes.', '名称超过 255 个 UTF-8 字节。') }
  }
  return { valid: true }
}

export function explorerMutationNameInputLabel(
  kind: NamedMutationDraft['kind'],
  resourceKind: MutationResourceKind,
  locale: IdeLocale = 'en',
): string {
  if (locale === 'zh') {
    const resource = resourceKind === 'directory' ? '文件夹' : '文件'
    return kind === 'create' ? `新建${resource}名称` : `重命名${resource}名称`
  }
  return `${kind === 'create' ? 'New' : 'Rename'} ${resourceKind} name`
}

export function explorerMutationNameKeyboardHint(locale: IdeLocale = 'en'): string {
  return locale === 'zh'
    ? '按 Enter 应用，按 Escape 取消，或按 F2 切换选择名称部分。'
    : 'Press Enter to apply, Escape to cancel, or F2 to change the selected name part.'
}

export interface ExplorerSelectionRange {
  readonly start: number
  readonly end: number
  readonly part: 'stem' | 'extension' | 'all'
}

/** F2 cycles stem, extension, and full-name selections without inventing empty ranges. */
export function explorerRenameSelectionRanges(
  name: string,
  type: MutationResourceKind,
): readonly ExplorerSelectionRange[] {
  if (type === 'directory') return [{ start: 0, end: name.length, part: 'all' }]
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return [{ start: 0, end: name.length, part: 'all' }]
  return [
    { start: 0, end: dot, part: 'stem' },
    { start: 0, end: name.length, part: 'all' },
    { start: dot + 1, end: name.length, part: 'extension' },
  ]
}

export type ExplorerMutationShortcut = 'rename' | 'delete' | 'context-menu'

export interface ExplorerMutationShortcutInput {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isComposing?: boolean
  readonly editableTarget: boolean
}

/** Mutation shortcuts are fenced to the tree surface and never escape an editor/IME. */
export function explorerMutationShortcut(
  input: ExplorerMutationShortcutInput,
): ExplorerMutationShortcut | undefined {
  if (input.isComposing === true || input.editableTarget || input.altKey || input.ctrlKey || input.metaKey) {
    return undefined
  }
  if (input.key === 'F2' && !input.shiftKey) return 'rename'
  if (input.key === 'Delete' && !input.shiftKey) return 'delete'
  if (input.key === 'F10' && input.shiftKey) return 'context-menu'
  return undefined
}

export function isExplorerEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
}

export interface ExplorerMenuPosition {
  readonly left: number
  readonly top: number
}

export function clampExplorerMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 224,
  menuHeight = 168,
  margin = 6,
): ExplorerMenuPosition {
  return {
    left: Math.max(margin, Math.min(x, Math.max(margin, viewportWidth - menuWidth - margin))),
    top: Math.max(margin, Math.min(y, Math.max(margin, viewportHeight - menuHeight - margin))),
  }
}

type MenuNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

export function nextExplorerMenuIndex(
  current: number,
  key: MenuNavigationKey,
  enabled: readonly boolean[],
): number {
  const candidates = enabled.flatMap((value, index) => value ? [index] : [])
  if (candidates.length === 0) return -1
  if (key === 'Home') return candidates[0] ?? -1
  if (key === 'End') return candidates.at(-1) ?? -1
  const currentPosition = candidates.indexOf(current)
  if (key === 'ArrowDown') return candidates[(currentPosition + 1 + candidates.length) % candidates.length] ?? -1
  const previous = currentPosition < 0 ? candidates.length - 1 : currentPosition - 1
  return candidates[(previous + candidates.length) % candidates.length] ?? -1
}

export type ExplorerContextDismissReason = 'escape' | 'outside-pointer' | 'item-activation'

/** Pointer activation owns its ensuing focus; only a keyboard dismissal restores the tree row. */
export function explorerContextDismissRestoresFocus(reason: ExplorerContextDismissReason): boolean {
  return reason === 'escape'
}

export interface ExplorerContextMenuItem {
  readonly id: string
  readonly label: string
  readonly shortcut?: string
  readonly disabled?: boolean
  readonly separatorBefore?: boolean
  readonly onSelect: () => void
}

export interface ExplorerContextMenuProps {
  readonly label: string
  readonly position: ExplorerMenuPosition
  readonly items: readonly ExplorerContextMenuItem[]
  readonly onClose: (restoreFocus: boolean) => void
}

export function ExplorerContextMenu({ label, position, items, onClose }: ExplorerContextMenuProps) {
  const enabled = useMemo(() => items.map(item => item.disabled !== true), [items])
  const [activeIndex, setActiveIndex] = useState(() => nextExplorerMenuIndex(-1, 'Home', enabled))
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())

  useEffect(() => {
    const next = enabled[activeIndex] === true ? activeIndex : nextExplorerMenuIndex(-1, 'Home', enabled)
    if (next !== activeIndex) setActiveIndex(next)
    itemRefs.current.get(next)?.focus()
  }, [activeIndex, enabled])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) === true) return
      onClose(explorerContextDismissRestoresFocus('outside-pointer'))
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => { document.removeEventListener('pointerdown', handlePointerDown, true) }
  }, [onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={menuRef}
      className={css.explorerContextMenu}
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top } as CSSProperties}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(explorerContextDismissRestoresFocus('escape'))
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp'
          && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        event.stopPropagation()
        const next = nextExplorerMenuIndex(activeIndex, event.key, enabled)
        setActiveIndex(next)
        itemRefs.current.get(next)?.focus()
      }}
    >
      {items.map((item, index) => (
        <div key={item.id} className={item.separatorBefore === true ? css.explorerMenuSeparator : undefined}>
          <button
            ref={element => {
              if (element === null) itemRefs.current.delete(index)
              else itemRefs.current.set(index, element)
            }}
            type="button"
            role="menuitem"
            tabIndex={index === activeIndex ? 0 : -1}
            aria-disabled={item.disabled === true}
            className={css.explorerMenuItem}
            onFocus={() => { if (item.disabled !== true) setActiveIndex(index) }}
            onClick={() => {
              if (item.disabled === true) return
              item.onSelect()
              onClose(explorerContextDismissRestoresFocus('item-activation'))
            }}
          >
            <span>{item.label}</span>
            {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

type NamedMutationDraft = Extract<MutationDraft, { readonly kind: 'create' | 'rename' }>

export interface ExplorerInlineMutationEditorProps {
  readonly draft: NamedMutationDraft
  readonly phase: WorkspaceMutationSnapshot['phase']
  readonly errorMessage: string | undefined
  readonly focusRequest: MutationFocusRequest | undefined
  readonly onAcknowledgeFocus: (requestId: number) => void
  readonly onUpdateName: (name: string) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

function namedDraftResourceKind(draft: NamedMutationDraft): MutationResourceKind {
  return draft.kind === 'create' ? draft.resourceKind : draft.source.type
}

export function ExplorerInlineMutationEditor({
  draft,
  phase,
  errorMessage,
  focusRequest,
  onAcknowledgeFocus,
  onUpdateName,
  onSubmit,
  onCancel,
}: ExplorerInlineMutationEditorProps) {
  const { locale } = useIdeI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const canceling = useRef(false)
  const committing = useRef(false)
  const hintId = useId()
  const errorId = useId()
  const resourceKind = namedDraftResourceKind(draft)
  const validation = validateExplorerMutationName(draft.name, locale)
  const visibleError = validation.valid ? errorMessage : validation.message
  const disabled = phase !== 'editing'

  const selectRange = (cycle: boolean): void => {
    const input = inputRef.current
    if (input === null) return
    const ranges = draft.kind === 'rename'
      ? explorerRenameSelectionRanges(draft.name, resourceKind)
      : [{ start: 0, end: draft.name.length, part: 'all' as const }]
    let index = 0
    if (cycle) {
      const current = ranges.findIndex(range => range.start === input.selectionStart && range.end === input.selectionEnd)
      index = (current + 1) % ranges.length
    }
    const range = ranges[index]
    if (range !== undefined) input.setSelectionRange(range.start, range.end)
  }

  useEffect(() => {
    const input = inputRef.current
    if (input === null || disabled) return
    input.focus()
    selectRange(false)
  // Selecting once on mount is intentional; typing must not be re-selected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (focusRequest?.target !== 'name' || disabled) return
    inputRef.current?.focus()
    selectRange(false)
    onAcknowledgeFocus(focusRequest.requestId)
  // draft.name changes on every keystroke and must not replay the request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, focusRequest?.requestId, focusRequest?.target, onAcknowledgeFocus])

  useEffect(() => {
    if (phase !== 'editing') return
    committing.current = false
    if (errorMessage !== undefined) inputRef.current?.focus()
  }, [errorMessage, phase])

  return (
    <span className={css.explorerInlineEditor}>
      <input
        ref={inputRef}
        value={draft.name}
        disabled={disabled}
        tabIndex={0}
        data-workbench-focus="explorer-edit"
        aria-label={explorerMutationNameInputLabel(draft.kind, resourceKind, locale)}
        aria-invalid={visibleError !== undefined}
        aria-describedby={`${hintId}${visibleError === undefined ? '' : ` ${errorId}`}`}
        onChange={event => {
          committing.current = false
          onUpdateName(event.currentTarget.value)
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'F2') {
            event.preventDefault()
            event.stopPropagation()
            selectRange(true)
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            canceling.current = true
            onCancel()
            return
          }
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          if (validation.valid && !committing.current) {
            committing.current = true
            onSubmit()
          }
          else inputRef.current?.focus()
        }}
        onBlur={() => {
          if (canceling.current || committing.current || phase !== 'editing') return
          if (validation.valid) {
            committing.current = true
            onSubmit()
          }
          else onCancel()
        }}
      />
      <span id={hintId} className={css.visuallyHidden}>{explorerMutationNameKeyboardHint(locale)}</span>
      {visibleError !== undefined && (
        <span id={errorId} className={css.explorerInlineError} role="status" aria-live="polite">
          {visibleError}
        </span>
      )}
    </span>
  )
}

export function workspacePathParent(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export function isNamedMutationSnapshot(
  snapshot: WorkspaceMutationSnapshot,
): snapshot is Exclude<WorkspaceMutationSnapshot, { readonly phase: 'idle' }> & { readonly draft: NamedMutationDraft } {
  return snapshot.phase !== 'idle' && (snapshot.draft.kind === 'create' || snapshot.draft.kind === 'rename')
}

export function isDeleteMutationSnapshot(
  snapshot: WorkspaceMutationSnapshot,
): snapshot is Exclude<WorkspaceMutationSnapshot, { readonly phase: 'idle' }> & {
  readonly draft: Extract<MutationDraft, { readonly kind: 'delete' }>
} {
  return snapshot.phase !== 'idle' && snapshot.draft.kind === 'delete'
}

export function mutationSnapshotError(snapshot: WorkspaceMutationSnapshot): string | undefined {
  return 'error' in snapshot ? snapshot.error?.message : undefined
}

export function mutationSnapshotImpact(snapshot: WorkspaceMutationSnapshot): MutationImpact | undefined {
  return 'impact' in snapshot ? snapshot.impact : undefined
}

export function isManualMutationReconciliation(snapshot: WorkspaceMutationSnapshot): boolean {
  return snapshot.phase === 'unknown' && snapshot.error.code === MUTATION_MANUAL_RECONCILIATION_REQUIRED
}

export function explorerFocusTrapIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return shiftKey ? count - 1 : 0
  return (current + (shiftKey ? -1 : 1) + count) % count
}

export function explorerDeleteImpactMessages(
  source: MutationSource,
  impact: MutationImpact | undefined,
  locale: IdeLocale = 'en',
): readonly string[] {
  const messages = [locale === 'zh'
    ? `${source.path} 将被永久删除。此操作无法撤销。`
    : `${source.path} will be permanently deleted. This cannot be undone.`]
  if (source.type === 'directory') {
    messages.push(locale === 'zh'
      ? '此文件夹及其所有内容将被递归删除。'
      : 'The folder and all of its contents will be deleted recursively.')
  }
  const affected = impact?.affectedDocuments ?? 0
  if (affected > 0) {
    messages.push(locale === 'zh'
      ? `将影响 ${affected} 个打开的文档。`
      : `${affected} open ${affected === 1 ? 'document is' : 'documents are'} affected.`)
  }
  if (impact?.preservesDirtyFile === true) {
    messages.push(locale === 'zh'
      ? '未保存的编辑器缓冲区仍会保留在内存中，但磁盘上的文件将被删除。'
      : 'The dirty editor buffer remains open in memory, but its file on disk will be removed.')
  }
  return messages
}

export interface ExplorerDeleteDialogProps {
  readonly snapshot: ExplorerDeleteMutationSnapshot
  readonly store: ExplorerMutationStore
  readonly controller: ExplorerMutationController
  readonly onModalChange: ((open: boolean) => void) | undefined
  readonly onUnexpectedError: ((error: unknown) => void) | undefined
  readonly canAcknowledge: boolean
}

export type ExplorerDeleteMutationSnapshot = Exclude<
  WorkspaceMutationSnapshot,
  { readonly phase: 'idle' }
> & { readonly draft: Extract<MutationDraft, { readonly kind: 'delete' }> }

function invokeMutationPromise(
  operation: () => Promise<ExplorerMutationResult>,
  onUnexpectedError: ((error: unknown) => void) | undefined,
): void {
  void operation().catch(error => { onUnexpectedError?.(error) })
}

export function ExplorerDeleteDialog({
  snapshot,
  store,
  controller,
  onModalChange,
  onUnexpectedError,
  canAcknowledge,
}: ExplorerDeleteDialogProps) {
  const { locale } = useIdeI18n()
  const dialogCopy = locale === 'zh' ? {
    title: '永久删除？',
    deleting: '正在删除…',
    unknown: '删除结果未知。请先检查状态，再执行其他操作。',
    reconciling: '正在检查删除状态…',
    applying: '正在完成工作台中的已提交删除操作…',
    recoveryNeeded: '删除已提交，但本地工作台恢复需要处理。',
    cancel: '取消',
    checkStatus: '检查状态',
    retryRecovery: '重试工作台恢复',
    confirm: '永久删除',
  } : {
    title: 'Delete permanently?', deleting: 'Deleting…',
    unknown: 'The delete outcome is unknown. Check status before taking another action.',
    reconciling: 'Checking delete status…', applying: 'Finishing the committed delete in the workbench…',
    recoveryNeeded: 'The delete committed, but local workbench recovery needs attention.',
    cancel: 'Cancel', checkStatus: 'Check Status', retryRecovery: 'Retry Workbench Recovery',
    confirm: 'Delete Permanently',
  }
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const checkRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const keepFenceRef = useRef<HTMLButtonElement>(null)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const modalChange = useRef(onModalChange)
  modalChange.current = onModalChange
  const titleId = useId()
  const descriptionId = useId()
  const issuesId = useId()
  const impact = mutationSnapshotImpact(snapshot)
  const error = mutationSnapshotError(snapshot)
  const blockers = impact?.blockers ?? []
  const cancellable = snapshot.phase === 'editing' || snapshot.phase === 'confirming'
  const canSubmit = snapshot.phase === 'confirming' && blockers.length === 0
  const source = snapshot.draft.source
  const impactMessages = explorerDeleteImpactMessages(source, impact, locale)
  const manual = isManualMutationReconciliation(snapshot)

  useEffect(() => {
    modalChange.current?.(true)
    return () => { modalChange.current?.(false) }
  }, [])

  useEffect(() => {
    if (confirmRelease) keepFenceRef.current?.focus()
    else if (snapshot.phase === 'confirming') cancelRef.current?.focus()
    else if (snapshot.phase === 'unknown' && !manual) checkRef.current?.focus()
    else if (snapshot.phase === 'applying' && error !== undefined) retryRef.current?.focus()
    else dialogRef.current?.focus()
    if ('focusRequest' in snapshot && snapshot.focusRequest?.target === 'confirm') {
      store.acknowledgeFocus(snapshot.focusRequest.requestId)
    }
  // A focus request is consumed once; other state changes do not steal focus.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmRelease, error, manual, snapshot.phase, snapshot.phase === 'editing' || snapshot.phase === 'confirming' ? snapshot.focusRequest?.requestId : undefined, store])

  useEffect(() => { if (!manual) setConfirmRelease(false) }, [manual])

  if (typeof document === 'undefined') return null
  const busy = snapshot.phase === 'submitting' || snapshot.phase === 'reconciling' || snapshot.phase === 'applying'

  return createPortal(
    <div className={css.explorerDeleteBackdrop}>
      <div
        ref={dialogRef}
        className={css.explorerDeleteDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId}${blockers.length > 0 || error !== undefined ? ` ${issuesId}` : ''}`}
        tabIndex={-1}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape' && cancellable) {
            event.preventDefault()
            event.stopPropagation()
            controller.cancel()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          if (focusable.length === 0) {
            event.preventDefault()
            dialogRef.current?.focus()
            return
          }
          const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
          const next = explorerFocusTrapIndex(current, focusable.length, event.shiftKey)
          event.preventDefault()
          focusable[next]?.focus()
        }}
      >
        <h2 id={titleId}>{manual ? 'Delete outcome unresolved' : dialogCopy.title}</h2>
        <div id={descriptionId} className={css.explorerDeleteCopy}>
          {manual
            ? <p>The Host can no longer determine whether <strong>{source.path}</strong> was deleted. No automatic status result is available.</p>
            : impactMessages.map((message, index) => index === 0
              ? <p key={message}><strong>{source.path}</strong>{message.slice(source.path.length)}</p>
              : <p key={message}>{message}</p>)}
        </div>
        {(blockers.length > 0 || error !== undefined) && (
          <div id={issuesId} className={css.explorerDeleteIssues} role="alert">
            {error !== undefined && <p>{error}</p>}
            {blockers.length > 0 && (
              <ul>{blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.path ?? index}`}>{blocker.message}</li>)}</ul>
            )}
          </div>
        )}
        <div className={css.explorerDeleteStatus} role="status" aria-live="polite">
          {snapshot.phase === 'submitting' && dialogCopy.deleting}
          {snapshot.phase === 'unknown' && (manual
            ? 'The IDE safety fence remains active until you explicitly stop tracking this unresolved outcome.'
            : dialogCopy.unknown)}
          {snapshot.phase === 'reconciling' && dialogCopy.reconciling}
          {snapshot.phase === 'applying' && (error === undefined
            ? dialogCopy.applying
            : dialogCopy.recoveryNeeded)}
        </div>
        {manual && confirmRelease && (
          <div className={css.explorerDeleteIssues} role="alert">
            Stopping IDE tracking will not decide whether this delete committed and will not change any file.
            Review the workspace before editing or starting another file operation.
          </div>
        )}
        <div className={css.explorerDeleteActions}>
          {!manual && (
            <button
              ref={cancelRef}
              type="button"
              disabled={!cancellable}
              onClick={() => { controller.cancel() }}
            >{dialogCopy.cancel}</button>
          )}
          {snapshot.phase === 'unknown' && !manual && (
            <button
              ref={checkRef}
              type="button"
              onClick={() => { invokeMutationPromise(() => controller.reconcileUnknown(), onUnexpectedError) }}
            >{dialogCopy.checkStatus}</button>
          )}
          {snapshot.phase === 'applying' && error !== undefined && (
            <button
              ref={retryRef}
              type="button"
              onClick={() => { invokeMutationPromise(() => controller.retryCommitted(), onUnexpectedError) }}
            >{dialogCopy.retryRecovery}</button>
          )}
          {manual && !confirmRelease && (
            <button type="button" disabled={!canAcknowledge} onClick={() => { setConfirmRelease(true) }}>
              Review Safety-Fence Release…
            </button>
          )}
          {manual && confirmRelease && (
            <>
              <button ref={keepFenceRef} type="button" onClick={() => { setConfirmRelease(false) }}>Keep Safety Fence</button>
              <button
                type="button"
                className={css.explorerDeleteDanger}
                disabled={!canAcknowledge}
                onClick={() => { invokeMutationPromise(() => controller.acknowledgeUnresolvedOutcome(), onUnexpectedError) }}
              >Stop Tracking Without Deciding</button>
            </>
          )}
          {!manual && (
            <button
              type="button"
              className={css.explorerDeleteDanger}
              disabled={!canSubmit || busy}
              onClick={() => { invokeMutationPromise(() => controller.submit(), onUnexpectedError) }}
            >{dialogCopy.confirm}</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export interface ExplorerUnresolvedMutationDialogProps {
  readonly snapshot: Exclude<WorkspaceMutationSnapshot, { readonly phase: 'idle' }>
  readonly controller: ExplorerMutationController
  readonly onUnexpectedError: ((error: unknown) => void) | undefined
  readonly canAcknowledge: boolean
}

export interface InvalidMutationRecoveryDialogBodyProps {
  readonly titleId: string
  readonly descriptionId: string
  readonly reviewed: boolean
  readonly busy: boolean
  readonly canReset: boolean
  readonly error?: string
  readonly dialogRef?: Ref<HTMLDivElement>
  readonly keepButtonRef?: Ref<HTMLButtonElement>
  readonly onDismiss: () => void
  readonly onReview: () => void
  readonly onKeep: () => void
  readonly onConfirm: () => void
}

/** Exported presentation seam keeps the safety copy and two-step projection directly testable. */
export function InvalidMutationRecoveryDialogBody({
  titleId,
  descriptionId,
  reviewed,
  busy,
  canReset,
  error,
  dialogRef,
  keepButtonRef,
  onDismiss,
  onReview,
  onKeep,
  onConfirm,
}: InvalidMutationRecoveryDialogBodyProps) {
  return (
    <div className={css.explorerDeleteBackdrop}>
      <div
        ref={dialogRef}
        className={css.explorerDeleteDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            event.stopPropagation()
            onDismiss()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))]
          if (focusable.length === 0) {
            event.preventDefault()
            event.currentTarget.focus()
            return
          }
          const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
          event.preventDefault()
          focusable[explorerFocusTrapIndex(current, focusable.length, event.shiftKey)]?.focus()
        }}
      >
        <h2 id={titleId}>Stored file-operation recovery is unreadable</h2>
        <div id={descriptionId} className={css.explorerDeleteCopy}>
          <p>The IDE cannot safely read this file-operation checkpoint, so new file operations remain blocked.</p>
          <p>Stopping tracking only removes the local checkpoint. It will not decide, retry, undo, or roll back any disk result.</p>
          <p><strong>Inspect the workspace manually before starting another file operation.</strong></p>
          {reviewed && (
            <p>Confirm only after reviewing the workspace. A checkpoint that has become valid pending, committed, or manual recovery will be preserved.</p>
          )}
        </div>
        {error !== undefined && <div className={css.explorerDeleteIssues} role="alert">{error}</div>}
        <div className={css.explorerDeleteActions}>
          {!reviewed ? (
            <>
              <button type="button" disabled={busy} onClick={onDismiss}>Keep Safety Fence</button>
              <button type="button" disabled={!canReset || busy} onClick={onReview}>Review Safety-Fence Release...</button>
            </>
          ) : (
            <>
              <button ref={keepButtonRef} type="button" disabled={busy} onClick={onKeep}>Keep Safety Fence</button>
              <button
                type="button"
                className={css.explorerDeleteDanger}
                disabled={!canReset || busy}
                onClick={onConfirm}
              >{busy ? 'Stopping Tracking...' : 'Stop Tracking Without Deciding'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export interface InvalidMutationRecoveryDialogProps {
  readonly open: boolean
  readonly busy: boolean
  readonly canReset: boolean
  readonly error?: string
  readonly onDismiss: () => void
  readonly onConfirm: () => void
  readonly onRestoreFocus?: () => void
}

/** One body portal for the otherwise undecodable recovery checkpoint. */
export function InvalidMutationRecoveryDialog({
  open,
  busy,
  canReset,
  error,
  onDismiss,
  onConfirm,
  onRestoreFocus,
}: InvalidMutationRecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const keepButtonRef = useRef<HTMLButtonElement>(null)
  const [reviewed, setReviewed] = useState(false)
  const wasOpen = useRef(false)
  const restoreFocus = useRef(onRestoreFocus)
  const titleId = useId()
  const descriptionId = useId()
  restoreFocus.current = onRestoreFocus

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      const frame = window.requestAnimationFrame(() => { dialogRef.current?.focus() })
      return () => { window.cancelAnimationFrame(frame) }
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    setReviewed(false)
    const frame = window.requestAnimationFrame(() => { restoreFocus.current?.() })
    return () => { window.cancelAnimationFrame(frame) }
  }, [open])

  useEffect(() => {
    if (open && reviewed) keepButtonRef.current?.focus()
  }, [open, reviewed])

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <InvalidMutationRecoveryDialogBody
      titleId={titleId}
      descriptionId={descriptionId}
      reviewed={reviewed}
      busy={busy}
      canReset={canReset}
      {...(error === undefined ? {} : { error })}
      dialogRef={dialogRef}
      keepButtonRef={keepButtonRef}
      onDismiss={onDismiss}
      onReview={() => { setReviewed(true) }}
      onKeep={() => { setReviewed(false) }}
      onConfirm={onConfirm}
    />,
    document.body,
  )
}

export function ExplorerUnresolvedMutationDialog({
  snapshot,
  controller,
  onUnexpectedError,
  canAcknowledge,
}: ExplorerUnresolvedMutationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const keepFenceRef = useRef<HTMLButtonElement>(null)
  const [confirmRelease, setConfirmRelease] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const manual = isManualMutationReconciliation(snapshot) && snapshot.draft.kind !== 'delete'
  const affectedPaths = snapshot.draft.kind === 'create'
    ? [snapshot.draft.parentPath === '' ? snapshot.draft.name : `${snapshot.draft.parentPath}/${snapshot.draft.name}`]
    : snapshot.draft.kind === 'rename'
      ? [
        snapshot.draft.source.path,
        workspacePathParent(snapshot.draft.source.path) === ''
          ? snapshot.draft.name
          : `${workspacePathParent(snapshot.draft.source.path)}/${snapshot.draft.name}`,
      ]
      : []

  useEffect(() => {
    if (!manual) return
    if (confirmRelease) keepFenceRef.current?.focus()
    else dialogRef.current?.focus()
  }, [confirmRelease, manual])

  if (typeof document === 'undefined' || !manual) return null

  return createPortal(
    <div className={css.explorerDeleteBackdrop}>
      <div
        ref={dialogRef}
        className={css.explorerDeleteDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          if (focusable.length === 0) {
            event.preventDefault()
            dialogRef.current?.focus()
            return
          }
          const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
          event.preventDefault()
          focusable[explorerFocusTrapIndex(current, focusable.length, event.shiftKey)]?.focus()
        }}
      >
        <h2 id={titleId}>File operation outcome unresolved</h2>
        <div id={descriptionId} className={css.explorerDeleteCopy}>
          <p>{mutationSnapshotError(snapshot)}</p>
          <p>The IDE cannot determine whether this operation committed. It will not retry or change any file.</p>
          <p>Review: {affectedPaths.join(' → ')}</p>
          {confirmRelease && <p><strong>Review the workspace externally before stopping IDE tracking.</strong></p>}
        </div>
        <div className={css.explorerDeleteActions}>
          {!confirmRelease ? (
            <button type="button" disabled={!canAcknowledge} onClick={() => { setConfirmRelease(true) }}>
              Review Safety-Fence Release…
            </button>
          ) : (
            <>
              <button ref={keepFenceRef} type="button" onClick={() => { setConfirmRelease(false) }}>Keep Safety Fence</button>
              <button
                type="button"
                className={css.explorerDeleteDanger}
                disabled={!canAcknowledge}
                onClick={() => { invokeMutationPromise(() => controller.acknowledgeUnresolvedOutcome(), onUnexpectedError) }}
              >Stop Tracking Without Deciding</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ExplorerMutationLiveStatus({ children }: { readonly children?: ReactNode }) {
  return <div className={css.visuallyHidden} role="status" aria-live="polite">{children}</div>
}
