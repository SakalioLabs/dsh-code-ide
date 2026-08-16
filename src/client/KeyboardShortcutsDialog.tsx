import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  CommandKeybindingView,
  EffectiveKeybindingView,
  KeybindingController,
  KeybindingEditOutcome,
  KeybindingPreview,
  KeybindingSequence,
  KeybindingSnapshot,
  KeybindingWhenClause,
  KeyStroke,
  UserKeybindingInput,
} from './commands/keybindings.ts'
import type { WorkbenchCommandCatalogEntry } from './commands/types.ts'
import css from './ide.module.css'

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

type Controller = KeybindingController<unknown>
export const MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS = 512

export interface KeyboardShortcutsDialogProps {
  readonly open: boolean
  readonly snapshot: KeybindingSnapshot
  readonly catalog: readonly WorkbenchCommandCatalogEntry[]
  readonly onAdd: Controller['addUserBinding']
  readonly onReplace: Controller['replaceUserBinding']
  readonly onReplaceDefault: Controller['replaceDefaultBinding']
  readonly onRemoveUser: Controller['removeUserBinding']
  readonly onUnbindDefault: Controller['unbindDefault']
  readonly onResetCommand: Controller['resetCommand']
  readonly onResetAll: Controller['resetAll']
  readonly onResetInvalid: Controller['resetInvalidSettings']
  readonly onPreview: Controller['previewUserBinding']
  readonly onFindSame: Controller['findSame']
  readonly onShowSame?: (sequence: KeybindingSequence) => void
  readonly onDismiss: () => void
  readonly onRestoreFocus?: () => void
}

export interface ShortcutRecorderState {
  readonly recording: boolean
  readonly strokes: readonly Readonly<KeyStroke>[]
  readonly message: string
}

export interface ShortcutRecorderInput {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly repeat?: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
  readonly altGraph?: boolean
}

export type ShortcutRecorderTransition =
  | { readonly kind: 'update'; readonly state: ShortcutRecorderState }
  | { readonly kind: 'commit'; readonly state: ShortcutRecorderState }
  | { readonly kind: 'stop'; readonly state: ShortcutRecorderState }
  | { readonly kind: 'navigate'; readonly state: ShortcutRecorderState }
  | { readonly kind: 'ignored'; readonly state: ShortcutRecorderState }

export function emptyShortcutRecorder(): ShortcutRecorderState {
  return { recording: true, strokes: [], message: 'Press a shortcut. A shortcut can contain one or two key strokes.' }
}

function recordedStroke(input: ShortcutRecorderInput, allowBarePrintable: boolean): Readonly<KeyStroke> | undefined {
  if (input.repeat === true || input.isComposing === true || input.altGraph === true) return undefined
  if (input.key.length === 0 || input.key.length > 32 || /[\u0000-\u001f\u007f]/u.test(input.key)) return undefined
  if (['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(input.key)) return undefined
  const printable = [...input.key].length === 1
  const firstStrokeNeedsModifier = !allowBarePrintable && printable
    && !input.altKey && !input.ctrlKey && !input.metaKey
  if (firstStrokeNeedsModifier) return undefined
  const key = printable ? input.key.toLocaleLowerCase('en-US') : input.key
  return Object.freeze({
    key,
    ...(input.altKey ? { alt: true } : {}),
    ...(input.ctrlKey ? { ctrl: true } : {}),
    ...(input.metaKey ? { meta: true } : {}),
    ...(input.shiftKey ? { shift: true } : {}),
  })
}

export function reduceShortcutRecorder(
  state: ShortcutRecorderState,
  input: ShortcutRecorderInput,
): ShortcutRecorderTransition {
  if (!state.recording) return { kind: 'ignored', state }
  if (input.repeat === true || input.isComposing === true || input.keyCode === 229 || input.altGraph === true
    || ['Dead', 'Process', 'Unidentified'].includes(input.key)) {
    return { kind: 'ignored', state }
  }
  const unmodified = !input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey
  if (input.key === 'Tab' && unmodified) return { kind: 'navigate', state: { ...state, recording: false } }
  if (input.key === 'Escape' && unmodified) return { kind: 'stop', state: { ...state, recording: false } }
  if (input.key === 'Enter' && unmodified) {
    return state.strokes.length === 0
      ? { kind: 'ignored', state }
      : { kind: 'commit', state: { ...state, recording: false } }
  }
  if (input.key === 'Backspace' && unmodified) {
    return {
      kind: 'update',
      state: { ...state, strokes: state.strokes.slice(0, -1), message: 'Shortcut cleared. Press a new shortcut.' },
    }
  }
  const stroke = recordedStroke(input, state.strokes.length > 0)
  if (stroke === undefined) {
    return { kind: 'ignored', state: { ...state, message: 'That key cannot start a workbench shortcut.' } }
  }
  const strokes = state.strokes.length >= 2 ? [stroke] : [...state.strokes, stroke]
  return {
    kind: 'update',
    state: {
      recording: strokes.length < 2,
      strokes,
      message: strokes.length < 2 ? 'First stroke recorded. Press a second stroke or choose Save.' : 'Two-stroke shortcut recorded.',
    },
  }
}

export function recordedShortcutSequence(
  strokes: readonly Readonly<KeyStroke>[],
): KeybindingSequence | undefined {
  const first = strokes[0]
  if (first === undefined) return undefined
  const second = strokes[1]
  return second === undefined ? [first] : [first, second]
}

function formatStroke(stroke: Readonly<KeyStroke>, platform: KeybindingSnapshot['platform']): string {
  const parts: string[] = []
  if (stroke.primary === true) parts.push(platform === 'mac' ? 'Cmd' : 'Ctrl')
  if (stroke.ctrl === true) parts.push('Ctrl')
  if (stroke.meta === true) parts.push(platform === 'mac' ? 'Cmd' : platform === 'windows' ? 'Win' : 'Meta')
  if (stroke.alt === true) parts.push(platform === 'mac' ? 'Option' : 'Alt')
  if (stroke.shift === true) parts.push('Shift')
  const aliases: Readonly<Record<string, string>> = { ' ': 'Space', Escape: 'Esc' }
  parts.push(aliases[stroke.key] ?? (stroke.key.length === 1 ? stroke.key.toLocaleUpperCase('en-US') : stroke.key))
  return parts.join('+')
}

export function formatShortcutSequence(sequence: KeybindingSequence, platform: KeybindingSnapshot['platform']): string {
  return sequence.map(stroke => formatStroke(stroke, platform)).join(' ')
}

export interface KeyboardShortcutDisplayRow {
  readonly id: string
  readonly command: WorkbenchCommandCatalogEntry
  readonly view?: CommandKeybindingView
  readonly binding?: EffectiveKeybindingView
  readonly orphan: boolean
}

function catalogFallback(commandId: string): WorkbenchCommandCatalogEntry {
  return { id: commandId, title: commandId, defaultKeybindings: [], keybindingPolicy: 'none' }
}

function compareShortcutText(first: string | undefined, second: string | undefined): number {
  const left = (first ?? '').toLocaleLowerCase('en-US')
  const right = (second ?? '').toLocaleLowerCase('en-US')
  if (left < right) return -1
  if (left > right) return 1
  return (first ?? '') < (second ?? '') ? -1 : (first ?? '') > (second ?? '') ? 1 : 0
}

export function compareKeyboardShortcutRows(
  first: KeyboardShortcutDisplayRow,
  second: KeyboardShortcutDisplayRow,
): number {
  return compareShortcutText(first.command.category, second.command.category)
    || compareShortcutText(first.command.title, second.command.title)
    || compareShortcutText(first.command.id, second.command.id)
    || compareShortcutText(first.binding?.label, second.binding?.label)
    || compareShortcutText(first.binding?.id ?? first.id, second.binding?.id ?? second.id)
}

export function keyboardShortcutRows(
  snapshot: KeybindingSnapshot,
  catalog: readonly WorkbenchCommandCatalogEntry[],
): readonly KeyboardShortcutDisplayRow[] {
  const metadata = new Map(catalog.map(command => [command.id, command] as const))
  const views = new Map(snapshot.commands.map(command => [command.commandId, command] as const))
  const ids = new Set([...catalog.map(command => command.id), ...snapshot.commands.map(command => command.commandId)])
  return [...ids].flatMap(commandId => {
    const command = metadata.get(commandId) ?? catalogFallback(commandId)
    const view = views.get(commandId)
    const bindings = view?.effectiveBindings ?? []
    if (bindings.length === 0) return [{ id: `${commandId}:unbound`, command, ...(view === undefined ? {} : { view }), orphan: !metadata.has(commandId) }]
    return bindings.map(binding => ({
      id: `${commandId}:${binding.id}`,
      command,
      ...(view === undefined ? {} : { view }),
      binding,
      orphan: !metadata.has(commandId),
    }))
  }).sort(compareKeyboardShortcutRows)
}

export function filterKeyboardShortcutRows(
  rows: readonly KeyboardShortcutDisplayRow[],
  query: string,
): readonly KeyboardShortcutDisplayRow[] {
  const terms = query.slice(0, MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS)
    .trim().toLocaleLowerCase('en-US').split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return rows
  return rows.filter(row => {
    const haystack = [row.command.title, row.command.id, row.command.category, row.command.description, row.binding?.label,
      row.binding?.source, row.view?.state, row.orphan ? 'orphan' : ''].filter(Boolean).join(' ').toLocaleLowerCase('en-US')
    return terms.every(term => haystack.includes(term))
  })
}

export function hasKeyboardShortcutRow(
  rows: readonly KeyboardShortcutDisplayRow[],
  rowId: string | undefined,
): boolean {
  return rowId !== undefined && rows.some(row => row.id === rowId)
}

export interface KeyboardShortcutFocusRecoveryInput {
  readonly currentFocusUsable: boolean
  readonly previousFocusTracked: boolean
  readonly previousFocusUsable: boolean
  readonly activeRowId?: string
  readonly preferredCommandId?: string
}

export type KeyboardShortcutFocusRecoveryTarget =
  | { readonly kind: 'preserve' }
  | { readonly kind: 'row'; readonly rowId: string }
  | { readonly kind: 'search' }

/** Pure focus policy used after toolbar/row DOM changes and cross-page refreshes. */
export function keyboardShortcutFocusRecoveryTarget(
  rows: readonly KeyboardShortcutDisplayRow[],
  input: KeyboardShortcutFocusRecoveryInput,
): KeyboardShortcutFocusRecoveryTarget {
  if (input.currentFocusUsable || !input.previousFocusTracked || input.previousFocusUsable) {
    return { kind: 'preserve' }
  }
  const row = rows.find(candidate => candidate.id === input.activeRowId)
    ?? rows.find(candidate => candidate.command.id === input.preferredCommandId)
    ?? rows[0]
  return row === undefined ? { kind: 'search' } : { kind: 'row', rowId: row.id }
}

function rowStatuses(row: KeyboardShortcutDisplayRow): readonly string[] {
  const statuses: string[] = []
  if (row.orphan) statuses.push('Orphan')
  if (row.binding === undefined || row.view?.state === 'unbound') statuses.push('Unbound')
  if (row.binding?.source === 'default') statuses.push('Default')
  if (row.binding?.source === 'user') statuses.push('User')
  if (row.view?.state === 'customized') statuses.push('Customized')
  if (row.view?.state === 'conflict' || row.binding?.state === 'conflict' || (row.view?.conflicts.length ?? 0) > 0) {
    statuses.push('Conflict')
  }
  if (row.binding?.state === 'inactive') statuses.push('Inactive')
  if (row.binding?.state === 'shadowed') statuses.push('Shadowed')
  return statuses
}

function bindingOptions(row: KeyboardShortcutDisplayRow): Pick<UserKeybindingInput, 'platforms' | 'when'> {
  const binding = row.binding
  if (binding === undefined) return {}
  const source = binding.source === 'user'
    ? row.view?.userBindings.find(candidate => candidate.id === binding.bindingId)
    : row.view?.defaultBindings.find(candidate => candidate.id === binding.bindingId)
  if (source === undefined) return {}
  return {
    ...(source.platforms === undefined ? {} : { platforms: source.platforms }),
    ...(source.when === undefined ? {} : { when: source.when }),
  }
}

function persistenceMessage(snapshot: KeybindingSnapshot): string {
  switch (snapshot.persistence.kind) {
    case 'memory': return 'Changes apply to this browser session only.'
    case 'ready': return 'Keyboard shortcut settings are ready.'
    case 'saving': return 'Saving keyboard shortcuts…'
    case 'readOnly':
    case 'error': return snapshot.persistence.message
  }
}

function focusableDialogElements(dialog: HTMLElement): readonly HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    if (element.tabIndex < 0 || element.hidden || element.closest('[inert], [aria-hidden="true"]') !== null) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  })
}

function usableDialogFocus(dialog: HTMLElement, element: HTMLElement | null | undefined): boolean {
  if (element === null || element === undefined || !element.isConnected || !dialog.contains(element)) return false
  if (element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

type EditMode = 'add' | 'change'

interface ShortcutEditState {
  readonly rowId: string
  readonly mode: EditMode
  readonly recorder: ShortcutRecorderState
}

/** Accessible, presentation-only adapter over the browser keybinding snapshot. */
export function KeyboardShortcutsDialog(props: KeyboardShortcutsDialogProps) {
  const { open, snapshot, catalog, onDismiss } = props
  const [query, setQuery] = useState('')
  const [activeRowId, setActiveRowId] = useState<string>()
  const [bindingFilterIds, setBindingFilterIds] = useState<ReadonlySet<string>>()
  const [searchRecorder, setSearchRecorder] = useState<ShortcutRecorderState>()
  const [edit, setEdit] = useState<ShortcutEditState>()
  const [actionStatus, setActionStatus] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [mutationBusy, setMutationBusy] = useState(false)
  const [resetAllArmed, setResetAllArmed] = useState(false)
  const [resetInvalidArmed, setResetInvalidArmed] = useState(false)
  const titleId = useId()
  const statusId = useId()
  const editorTitleId = useId()
  const recorderStatusId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const recorderInput = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const lastDialogFocus = useRef<HTMLElement>()
  const focusedCommandId = useRef<string>()
  const previousFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(props.onRestoreFocus)
  const pendingRestoreFrame = useRef<number>()
  const mutationGeneration = useRef(0)
  const mutationAdmission = useRef<symbol>()
  const rows = useMemo(() => keyboardShortcutRows(snapshot, catalog), [catalog, snapshot])
  const visibleRows = useMemo(() => {
    const searched = filterKeyboardShortcutRows(rows, query)
    if (bindingFilterIds === undefined) return searched
    return searched.filter(row => row.binding !== undefined && bindingFilterIds.has(row.binding.id))
  }, [bindingFilterIds, query, rows])

  restoreFocus.current = props.onRestoreFocus

  useEffect(() => {
    if (!open) return

    // StrictMode replays setup/cleanup. A replayed setup cancels the deferred
    // restore so focus never briefly escapes the live modal.
    if (pendingRestoreFrame.current !== undefined) {
      window.cancelAnimationFrame(pendingRestoreFrame.current)
      pendingRestoreFrame.current = undefined
    }
    previousFocus.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => search.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      pendingRestoreFrame.current = window.requestAnimationFrame(() => {
        pendingRestoreFrame.current = undefined
        restoreFocus.current?.()
        if (restoreFocus.current === undefined) previousFocus.current?.focus()
        previousFocus.current = null
      })
    }
  }, [open])

  useEffect(() => {
    if (visibleRows.length === 0) {
      setActiveRowId(undefined)
      return
    }
    if (activeRowId === undefined || !visibleRows.some(row => row.id === activeRowId)) {
      setActiveRowId(visibleRows[0]?.id)
    }
  }, [activeRowId, visibleRows])

  useClientLayoutEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previous = lastDialogFocus.current
    const recovery = keyboardShortcutFocusRecoveryTarget(visibleRows, {
      currentFocusUsable: usableDialogFocus(dialog, active),
      previousFocusTracked: previous !== undefined,
      previousFocusUsable: usableDialogFocus(dialog, previous),
      ...(activeRowId === undefined ? {} : { activeRowId }),
      ...(focusedCommandId.current === undefined ? {} : { preferredCommandId: focusedCommandId.current }),
    })
    if (recovery.kind === 'preserve') return
    const row = recovery.kind === 'row' ? visibleRows.find(candidate => candidate.id === recovery.rowId) : undefined
    const target = recovery.kind === 'row' ? rowRefs.current.get(recovery.rowId) : search.current
    let destination: HTMLElement = dialog
    if (target !== null && target !== undefined && usableDialogFocus(dialog, target)) destination = target
    else if (search.current !== null && usableDialogFocus(dialog, search.current)) destination = search.current
    destination.focus()
    lastDialogFocus.current = destination
    if (row !== undefined) focusedCommandId.current = row.command.id
  })

  useEffect(() => {
    if (edit === undefined) return
    const frame = window.requestAnimationFrame(() => recorderInput.current?.focus())
    return () => { window.cancelAnimationFrame(frame) }
  }, [edit?.rowId])

  useEffect(() => {
    if (edit === undefined || hasKeyboardShortcutRow(rows, edit.rowId)) return
    setEdit(undefined)
    const frame = window.requestAnimationFrame(() => {
      const active = activeRowId === undefined ? undefined : rowRefs.current.get(activeRowId)
      const firstVisible = visibleRows[0] === undefined ? undefined : rowRefs.current.get(visibleRows[0].id)
      const target = active ?? firstVisible ?? search.current
      target?.focus()
    })
    return () => { window.cancelAnimationFrame(frame) }
  }, [activeRowId, edit, rows, visibleRows])

  useEffect(() => {
    if (!open) {
      mutationGeneration.current += 1
      mutationAdmission.current = undefined
      setMutationBusy(false)
      setEdit(undefined)
      setSearchRecorder(undefined)
      setBindingFilterIds(undefined)
      setQuery('')
      setActiveRowId(undefined)
      setActionStatus(undefined)
      setActionError(undefined)
      setResetAllArmed(false)
      setResetInvalidArmed(false)
      lastDialogFocus.current = undefined
      focusedCommandId.current = undefined
    }
  }, [open])

  useEffect(() => {
    setResetAllArmed(false)
    setResetInvalidArmed(false)
  }, [activeRowId, query])

  if (!open) return null
  const selected = visibleRows.find(row => row.id === activeRowId) ?? visibleRows[0]
  const editedRow = edit === undefined ? undefined : rows.find(row => row.id === edit.rowId)
  const editedSequence = edit === undefined ? undefined : recordedShortcutSequence(edit.recorder.strokes)
  let draftPreview: KeybindingPreview | undefined
  let draftPreviewError: string | undefined
  if (editedSequence !== undefined && editedRow !== undefined && !editedRow.orphan) {
    try {
      draftPreview = props.onPreview({
        commandId: editedRow.command.id,
        sequence: editedSequence,
        ...(edit?.mode === 'change' ? bindingOptions(editedRow) : {}),
      })
    } catch (error) {
      draftPreviewError = error instanceof Error ? error.message : 'The shortcut cannot be previewed.'
    }
  }
  const draftMatches = draftPreview === undefined
    ? []
    : [...draftPreview.exactMatches, ...draftPreview.prefixMatches].filter(match => (
        edit?.mode !== 'change' || match.id !== editedRow?.binding?.id
      ))
  const commandTitle = new Map(rows.map(row => [row.command.id, row.command.title] as const))
  const readOnly = snapshot.persistence.kind === 'readOnly'
  const mutationsDisabled = mutationBusy || snapshot.persistence.kind === 'saving' || readOnly
  const canBindSelected = selected !== undefined && !selected.orphan && selected.command.keybindingPolicy !== 'none'

  const closeEdit = (): void => {
    const rowId = edit?.rowId
    setEdit(undefined)
    window.requestAnimationFrame(() => {
      const destination = rowId === undefined ? undefined : rowRefs.current.get(rowId)
      const fallback = activeRowId === undefined ? undefined : rowRefs.current.get(activeRowId)
      const target = destination ?? fallback ?? search.current
      target?.focus()
    })
  }

  const runMutation = async (
    operation: () => Promise<KeybindingEditOutcome>,
    successMessage: string,
    closeEditor = false,
  ): Promise<void> => {
    if (mutationAdmission.current !== undefined) return
    const admission = Symbol('keyboard-shortcut-mutation')
    mutationAdmission.current = admission
    const generation = ++mutationGeneration.current
    setMutationBusy(true)
    setActionError(undefined)
    try {
      const outcome = await operation()
      if (generation !== mutationGeneration.current) return
      if (outcome.status === 'saved' || outcome.status === 'unchanged') {
        setActionStatus(outcome.status === 'unchanged' ? 'Keyboard shortcuts were already up to date.' : successMessage)
        if (closeEditor) closeEdit()
      } else {
        setActionError(outcome.message)
      }
    } catch (error) {
      if (generation === mutationGeneration.current) {
        setActionError(error instanceof Error ? error.message : 'The keyboard shortcut could not be changed.')
      }
    } finally {
      if (mutationAdmission.current === admission) {
        mutationAdmission.current = undefined
        if (generation === mutationGeneration.current) setMutationBusy(false)
      }
    }
  }

  const beginEdit = (row: KeyboardShortcutDisplayRow, mode: EditMode): void => {
    setActiveRowId(row.id)
    setActionError(undefined)
    setEdit({ rowId: row.id, mode, recorder: emptyShortcutRecorder() })
  }

  const saveEdit = (): void => {
    if (edit === undefined || editedRow === undefined || editedSequence === undefined || mutationsDisabled) return
    const input: UserKeybindingInput = {
      commandId: editedRow.command.id,
      sequence: editedSequence,
      ...(edit.mode === 'change' ? bindingOptions(editedRow) : {}),
    }
    if (edit.mode === 'change' && editedRow.binding?.source === 'user') {
      void runMutation(
        () => props.onReplace(editedRow.binding?.bindingId ?? '', input),
        `Changed the shortcut for ${editedRow.command.title}.`,
        true,
      )
      return
    }
    if (edit.mode === 'change' && editedRow.binding?.source === 'default') {
      void runMutation(
        () => props.onReplaceDefault(editedRow.command.id, editedRow.binding?.bindingId ?? '', input),
        `Changed the shortcut for ${editedRow.command.title}.`,
        true,
      )
      return
    }
    void runMutation(() => props.onAdd(input), `Added a shortcut for ${editedRow.command.title}.`, true)
  }

  const removeSelected = (row: KeyboardShortcutDisplayRow | undefined = selected): void => {
    if (row?.binding === undefined || mutationsDisabled) return
    if (row.binding.source === 'default') {
      void runMutation(
        () => props.onUnbindDefault(row.command.id, row.binding?.bindingId ?? ''),
        `Unbound the default shortcut for ${row.command.title}.`,
      )
    } else {
      void runMutation(
        () => props.onRemoveUser(row.binding?.bindingId ?? ''),
        `Removed the user shortcut for ${row.command.title}.`,
      )
    }
  }

  const resetSelected = (): void => {
    if (selected === undefined || mutationsDisabled) return
    void runMutation(
      () => props.onResetCommand(selected.command.id),
      `Restored the default shortcuts for ${selected.command.title}.`,
    )
  }

  const showSame = (): void => {
    if (selected?.binding === undefined) return
    setQuery('')
    setSearchRecorder(undefined)
    setBindingFilterIds(new Set(props.onFindSame(selected.binding.sequence).map(binding => binding.id)))
    setActionStatus(`Showing commands bound to ${selected.binding.label}.`)
    props.onShowSame?.(selected.binding.sequence)
    window.requestAnimationFrame(() => search.current?.focus())
  }

  const previewSearchSequence = (sequence: KeybindingSequence | undefined): void => {
    if (sequence === undefined) {
      setBindingFilterIds(undefined)
      return
    }
    const previewCommand = selected !== undefined && !selected.orphan && selected.command.keybindingPolicy !== 'none'
      ? selected.command
      : catalog.find(command => command.keybindingPolicy !== 'none')
    if (previewCommand === undefined) {
      setBindingFilterIds(new Set())
      setActionError('No configurable command is available to validate that shortcut.')
      return
    }
    try {
      const preview = props.onPreview({ commandId: previewCommand.id, sequence })
      setBindingFilterIds(new Set([...preview.exactMatches, ...preview.prefixMatches].map(binding => binding.id)))
      setActionError(undefined)
    } catch (error) {
      setBindingFilterIds(new Set())
      setActionError(error instanceof Error ? error.message : 'The shortcut cannot be searched.')
    }
  }

  const handleRecorderKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (edit === undefined) return
    if (!edit.recorder.recording) return
    const transition = reduceShortcutRecorder(edit.recorder, {
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      altGraph: event.getModifierState('AltGraph'),
    })
    setEdit({ ...edit, recorder: transition.state })
    if (transition.kind === 'navigate') return
    event.preventDefault()
    event.stopPropagation()
    if (transition.kind === 'commit') window.requestAnimationFrame(saveEdit)
  }

  const handleSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (searchRecorder === undefined) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowDown' && selected !== undefined) {
        event.preventDefault()
        rowRefs.current.get(selected.id)?.focus()
      }
      return
    }
    const transition = reduceShortcutRecorder(searchRecorder, {
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      altGraph: event.getModifierState('AltGraph'),
    })
    const sequence = recordedShortcutSequence(transition.state.strokes)
    setSearchRecorder(transition.kind === 'navigate' || transition.kind === 'stop' || transition.kind === 'commit'
      || !transition.state.recording
      ? undefined
      : transition.state)
    previewSearchSequence(sequence)
    if (transition.kind === 'navigate') return
    event.preventDefault()
    event.stopPropagation()
  }

  const moveRowFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowUp') {
      event.preventDefault()
      search.current?.focus()
      return
    }
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(visibleRows.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = visibleRows.length - 1
    else if (event.key === 'PageDown') next = Math.min(visibleRows.length - 1, index + 8)
    else if (event.key === 'PageUp') next = Math.max(0, index - 8)
    else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      const row = visibleRows[index]
      if (row !== undefined && row.binding !== undefined && !row.orphan && row.command.keybindingPolicy !== 'none') beginEdit(row, 'change')
      else if (row !== undefined && !row.orphan && row.command.keybindingPolicy !== 'none') beginEdit(row, 'add')
      return
    } else if (event.key === 'Delete') {
      event.preventDefault()
      removeSelected(visibleRows[index])
      return
    } else return
    event.preventDefault()
    const row = visibleRows[next]
    if (row !== undefined) {
      setActiveRowId(row.id)
      rowRefs.current.get(row.id)?.focus()
    }
  }

  const handleDialogKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (searchRecorder !== undefined) {
        setSearchRecorder(undefined)
      } else if (edit?.recorder.recording === true) {
        setEdit({ ...edit, recorder: { ...edit.recorder, recording: false, message: 'Recording paused.' } })
      } else if (edit !== undefined) {
        closeEdit()
      } else {
        onDismiss()
      }
      return
    }
    if (event.key !== 'Tab') return
    if (searchRecorder !== undefined) setSearchRecorder(undefined)
    if (edit?.recorder.recording === true) {
      setEdit({ ...edit, recorder: { ...edit.recorder, recording: false, message: 'Recording paused.' } })
    }
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = focusableDialogElements(dialog)
    const activeIndex = document.activeElement instanceof HTMLElement ? focusable.indexOf(document.activeElement) : -1
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
    } else if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault()
      focusable.at(-1)?.focus()
    } else if (!event.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1)) {
      event.preventDefault()
      focusable[0]?.focus()
    }
  }

  const searchValue = searchRecorder === undefined
    ? query
    : recordedShortcutSequence(searchRecorder.strokes) === undefined
      ? ''
      : formatShortcutSequence(recordedShortcutSequence(searchRecorder.strokes) as KeybindingSequence, snapshot.platform)
  const resultStatus = visibleRows.length === 0
    ? 'No keyboard shortcuts match the current filter.'
    : `${String(visibleRows.length)} keyboard shortcut row${visibleRows.length === 1 ? '' : 's'}.`
  const persistence = persistenceMessage(snapshot)
  const dialog = (
    <div
      className={css.keyboardShortcutsBackdrop}
      onMouseDown={event => { if (event.target === event.currentTarget) onDismiss() }}
    >
      <section
        ref={dialogRef}
        className={css.keyboardShortcutsDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onFocusCapture={event => {
          const target = event.target instanceof HTMLElement ? event.target : undefined
          if (target === undefined) return
          lastDialogFocus.current = target
          const rowId = target.closest<HTMLElement>('[data-keyboard-shortcut-row-id]')?.dataset.keyboardShortcutRowId
          const row = rowId === undefined ? undefined : visibleRows.find(candidate => candidate.id === rowId)
          if (row !== undefined) focusedCommandId.current = row.command.id
          else if (target.closest('[role="toolbar"]') !== null && selected !== undefined) {
            focusedCommandId.current = selected.command.id
          }
        }}
        onKeyDown={handleDialogKey}
      >
        <header className={css.keyboardShortcutsHeader}>
          <div>
            <h2 id={titleId}>Keyboard Shortcuts</h2>
            <span>View and customize workbench shortcuts.</span>
          </div>
          <button type="button" aria-label="Close Keyboard Shortcuts" onClick={onDismiss}>Close</button>
        </header>
        <div className={css.keyboardShortcutsSearchBar}>
          <label className={css.keyboardShortcutsSearch}>
            <span className={css.visuallyHidden}>Search keyboard shortcuts</span>
            <input
              ref={search}
              role="searchbox"
              value={searchValue}
              readOnly={searchRecorder !== undefined}
              maxLength={MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS}
              placeholder={searchRecorder === undefined ? 'Search by command, id, category, or shortcut' : 'Press a shortcut'}
              aria-describedby={statusId}
              onChange={event => {
                setQuery(event.currentTarget.value.slice(0, MAX_KEYBOARD_SHORTCUT_QUERY_CODE_UNITS))
                setBindingFilterIds(undefined)
                setActionStatus(undefined)
              }}
              onKeyDown={handleSearchKey}
            />
          </label>
          <button
            type="button"
            aria-pressed={searchRecorder !== undefined}
            onClick={() => {
              setQuery('')
              setBindingFilterIds(undefined)
              setActionStatus(undefined)
              setSearchRecorder(searchRecorder === undefined ? emptyShortcutRecorder() : undefined)
              window.requestAnimationFrame(() => search.current?.focus())
            }}
          >{searchRecorder === undefined ? 'Record Keys' : 'Stop Recording'}</button>
          {bindingFilterIds === undefined ? null : (
            <button className={css.keyboardShortcutsClearFilter} type="button" onClick={() => { setBindingFilterIds(undefined); setSearchRecorder(undefined); setActionStatus(undefined) }}>Clear Key Filter</button>
          )}
        </div>
        <div id={statusId} className={css.keyboardShortcutsStatus} aria-live="polite" aria-atomic="true">
          {searchRecorder?.message ?? actionStatus ?? resultStatus}
        </div>
        <div
          className={css.keyboardShortcutsPersistence}
          role={snapshot.persistence.kind === 'readOnly' || snapshot.persistence.kind === 'error' ? 'alert' : undefined}
          aria-live={snapshot.persistence.kind === 'saving' ? 'polite' : undefined}
          data-kind={snapshot.persistence.kind}
        >{persistence}</div>
        {snapshot.canResetInvalid ? (
          <div className={css.keyboardShortcutsInvalidRecovery} role="alert">
            <span>The stored shortcut settings are invalid. Resetting will overwrite the local shortcut settings.</span>
            <button
              type="button"
              disabled={mutationBusy || snapshot.persistence.kind === 'saving'}
              onClick={() => {
                if (!resetInvalidArmed) {
                  setResetInvalidArmed(true)
                  setActionStatus('Press Confirm Overwrite Local Shortcuts to replace the invalid stored settings.')
                  return
                }
                setResetInvalidArmed(false)
                void runMutation(props.onResetInvalid, 'Replaced the invalid local shortcut settings with defaults.')
              }}
            >{resetInvalidArmed ? 'Confirm Overwrite Local Shortcuts' : 'Reset Invalid Settings'}</button>
          </div>
        ) : null}
        {actionError === undefined ? null : <div className={css.keyboardShortcutsError} role="alert">{actionError}</div>}
        <div className={css.keyboardShortcutsToolbar} role="toolbar" aria-label="Shortcut actions">
          <button type="button" disabled={!canBindSelected || mutationsDisabled} onClick={() => { if (selected !== undefined) beginEdit(selected, 'add') }}>Add</button>
          <button type="button" disabled={!canBindSelected || selected?.binding === undefined || mutationsDisabled} onClick={() => { if (selected !== undefined) beginEdit(selected, 'change') }}>Change</button>
          <button type="button" disabled={selected?.binding === undefined || mutationsDisabled} onClick={() => removeSelected()}>{selected?.binding?.source === 'default' ? 'Unbind' : 'Remove'}</button>
          <button type="button" disabled={selected === undefined || selected.view?.state === 'default' || mutationsDisabled} onClick={resetSelected}>Reset</button>
          <button type="button" disabled={selected?.binding === undefined} onClick={showSame}>Show Same</button>
          <span className={css.keyboardShortcutsToolbarSpacer} />
          <button
            type="button"
            disabled={mutationsDisabled || !snapshot.commands.some(command => command.state !== 'default')}
            onClick={() => {
              if (!resetAllArmed) {
                setResetAllArmed(true)
                setActionStatus('Press Confirm Reset All to remove every keyboard shortcut customization.')
                return
              }
              setResetAllArmed(false)
              void runMutation(props.onResetAll, 'Restored all default keyboard shortcuts.')
            }}
          >{resetAllArmed ? 'Confirm Reset All' : 'Reset All'}</button>
        </div>

        {edit === undefined || editedRow === undefined ? null : (
          <section className={css.keyboardShortcutEditor} role="group" aria-labelledby={editorTitleId}>
            <div className={css.keyboardShortcutEditorHeader}>
              <h3 id={editorTitleId}>{edit.mode === 'add' ? 'Add' : 'Change'} shortcut for {editedRow.command.title}</h3>
              <button type="button" onClick={closeEdit}>Cancel</button>
            </div>
            {edit.mode === 'change' && editedRow.binding !== undefined
              ? <p>Current shortcut: <kbd>{editedRow.binding.label}</kbd></p>
              : null}
            <label className={css.keyboardShortcutRecorder}>
              <span>New shortcut</span>
              <input
                ref={recorderInput}
                readOnly
                value={draftPreview?.label ?? (editedSequence === undefined ? '' : formatShortcutSequence(editedSequence, snapshot.platform))}
                placeholder="Press a shortcut"
                aria-describedby={recorderStatusId}
                onKeyDown={handleRecorderKey}
              />
            </label>
            <div id={recorderStatusId} className={css.keyboardShortcutRecorderStatus} aria-live="polite">
              {edit.recorder.message}
            </div>
            {draftPreviewError === undefined ? null : <div className={css.keyboardShortcutConflict} role="alert">{draftPreviewError}</div>}
            {draftMatches.length === 0 ? null : (
              <div className={css.keyboardShortcutConflict} role="alert">
                Potential conflict with {[...new Set(draftMatches.map(match => commandTitle.get(match.commandId) ?? match.commandId))].join(', ')}. Saving does not silently remove those bindings.
              </div>
            )}
            <div className={css.keyboardShortcutEditorActions}>
              <button
                type="button"
                onClick={() => setEdit({ ...edit, recorder: emptyShortcutRecorder() })}
              >{edit.recorder.recording ? 'Restart Recording' : 'Record Keys'}</button>
              <button type="button" disabled={editedSequence === undefined || mutationsDisabled} onClick={saveEdit}>{mutationBusy ? 'Saving…' : 'Save'}</button>
            </div>
          </section>
        )}

        <ul className={css.keyboardShortcutsList} aria-label="Keyboard shortcuts">
          {visibleRows.map((row, index) => (
            <li key={row.id}>
              <button
                ref={element => {
                  if (element === null) rowRefs.current.delete(row.id)
                  else rowRefs.current.set(row.id, element)
                }}
                type="button"
                className={css.keyboardShortcutRow}
                data-keyboard-shortcut-row-id={row.id}
                tabIndex={selected?.id === row.id ? 0 : -1}
                aria-current={selected?.id === row.id ? 'true' : undefined}
                aria-label={`${row.command.title}, ${row.binding?.label ?? 'Unbound'}, ${rowStatuses(row).join(', ')}`}
                aria-describedby={(row.view?.conflicts.length ?? 0) === 0 ? undefined : `${titleId}-conflict-${String(index)}`}
                onFocus={() => setActiveRowId(row.id)}
                onMouseEnter={() => setActiveRowId(row.id)}
                onDoubleClick={() => {
                  if (!row.orphan && row.command.keybindingPolicy !== 'none') {
                    beginEdit(row, row.binding === undefined ? 'add' : 'change')
                  }
                }}
                onKeyDown={event => moveRowFocus(event, index)}
              >
                <span className={css.keyboardShortcutRowMain}>
                  <span className={css.keyboardShortcutRowTitle}>{row.command.category === undefined ? row.command.title : `${row.command.category}: ${row.command.title}`}</span>
                  <code className={css.keyboardShortcutRowId}>{row.command.id}</code>
                  {row.command.description === undefined ? null : <span className={css.keyboardShortcutRowDescription}>{row.command.description}</span>}
                </span>
                <kbd className={css.keyboardShortcutBinding}>{row.binding?.label ?? 'Unbound'}</kbd>
                <span className={css.keyboardShortcutBadges}>
                  {rowStatuses(row).map(status => <span key={status} data-kind={status.toLocaleLowerCase('en-US')}>{status}</span>)}
                </span>
              </button>
              {(row.view?.conflicts.length ?? 0) === 0 ? null : (
                <span id={`${titleId}-conflict-${String(index)}`} className={css.visuallyHidden}>Conflicts with {row.view?.conflicts.flatMap(conflict => conflict.commandIds).join(', ')}</span>
              )}
            </li>
          ))}
          {visibleRows.length === 0 ? <li className={css.keyboardShortcutsEmpty}>No matching keyboard shortcuts.</li> : null}
        </ul>
      </section>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

export type { KeybindingEditOutcome, KeybindingWhenClause, UserKeybindingInput }
