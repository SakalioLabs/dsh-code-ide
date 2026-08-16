import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { deleteTrailingWhitespace, indentWithTab, redo, redoDepth, temporarilySetTabFocusMode, toggleComment, undo, undoDepth } from '@codemirror/commands'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeSet, type Extension, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { EditorTab, EditorViewSnapshot } from './documents/session.ts'
import { detectDocumentIndentation } from './editor/indentation.ts'
import { EditorSessionRegistry, type EditorSessionIdentity } from './editor/session-registry.ts'
import {
  editorLanguageExtension,
  editorLanguageForPath,
  isEditorLanguageId,
  isLazyEditorLanguage,
  loadEditorLanguageExtension,
  type EditorLanguageId,
} from './language.ts'
import type { EditorLocation, EditorRevealRequest } from './navigation/editor-navigation.ts'
import css from './ide.module.css'
import { useIdeI18n } from './i18n.tsx'
import type { IdeColorScheme } from './theme.ts'

interface CodeEditorProps {
  workspaceId: string | undefined
  tab: EditorTab | undefined
  registry: EditorSessionRegistry
  focusRequest?: number
  revealRequest?: EditorRevealRequest
  readOnly?: boolean
  wordWrap?: boolean
  colorScheme?: IdeColorScheme
  onFocusApplied?: (requestId: number) => void
  onRevealApplied?: (requestId: number) => void
  onCursorPosition: (
    workspaceId: string,
    path: string,
    lifecycleId: number,
    position: EditorLocation,
  ) => void
  onChange: (workspaceId: string, path: string, lifecycleId: number, content: string) => void
  onViewState: (workspaceId: string, path: string, lifecycleId: number, viewState: EditorViewSnapshot) => void
  onHistoryPort?: (port: EditorHistoryPort) => () => void
}

export interface EditorHistorySnapshot {
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export interface EditorPortSnapshot extends EditorHistorySnapshot {
  readonly languageId: EditorLanguageId
  readonly indentation: EditorIndentationConfiguration
}

export type EditorLanguageChangeResult = 'applied' | 'not-needed' | 'stale' | 'invalid'

export type EditorIndentationStyle = 'spaces' | 'tabs'
export interface EditorIndentationConfiguration {
  readonly style: EditorIndentationStyle
  readonly size: number
}
export type EditorIndentationSizeChangeResult = 'applied' | 'not-needed' | 'stale' | 'invalid'
export type EditorIndentationConversionResult =
  | 'applied'
  | 'not-needed'
  | 'stale'
  | 'read-only'
  | 'resource-limit'

export const EDITOR_INDENTATION_CONVERSION_MAX_LINES = 200_000
export const EDITOR_INDENTATION_CONVERSION_MAX_CHANGES = 50_000
export const EDITOR_INDENTATION_CONVERSION_MAX_INPUT_CODE_UNITS = 4 * 1024 * 1024
export const EDITOR_INDENTATION_CONVERSION_MAX_OUTPUT_CODE_UNITS = 16 * 1024 * 1024

const setEditorIndentation = StateEffect.define<EditorIndentationConfiguration>()
const setEditorLanguage = StateEffect.define<EditorLanguageId>()

/** Page-local manual language choice retained with the cached EditorState. */
export const editorLanguageState = StateField.define<EditorLanguageId | undefined>({
  create: () => undefined,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorLanguage)) return effect.value
    }
    return value
  },
})

/** Page-local manual choice; cached EditorState retains style and size together. */
export const editorIndentationState = StateField.define<EditorIndentationConfiguration | undefined>({
  create: () => undefined,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorIndentation)) return effect.value
    }
    return value
  },
})

/** Compatibility name for callers that previously retained only the style. */
export const editorIndentationStyleState = editorIndentationState

export interface EditorHistoryPort extends EditorSessionIdentity {
  getSnapshot(): EditorPortSnapshot
  subscribe(listener: () => void): () => void
  undo(): boolean
  redo(): boolean
  toggleLineComment(): boolean
  trimTrailingWhitespace(): EditorTrimTrailingWhitespaceResult
  convertIndentation(style: EditorIndentationStyle): EditorIndentationConversionResult
  changeIndentationSize(size: number): EditorIndentationSizeChangeResult
  changeLanguage(languageId: EditorLanguageId): EditorLanguageChangeResult
}

export type EditorTrimTrailingWhitespaceResult = 'applied' | 'not-needed' | 'stale' | 'read-only'

export function editorHistorySnapshot(state: EditorState): EditorHistorySnapshot {
  return { canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0 }
}

export function effectiveEditorLanguage(
  state: EditorState,
  automatic: EditorLanguageId,
): EditorLanguageId {
  return state.field(editorLanguageState, false) ?? automatic
}

export function retainedEditorLanguage(
  path: string,
  cached?: EditorState,
): EditorLanguageId {
  return cached?.field(editorLanguageState, false) ?? editorLanguageForPath(path)
}

export function editorChangeLanguage(
  target: Parameters<StateCommand>[0],
  languageId: EditorLanguageId,
  language: Compartment,
  automatic: EditorLanguageId,
): EditorLanguageChangeResult {
  if (!isEditorLanguageId(languageId)) return 'invalid'
  const manual = target.state.field(editorLanguageState, false)
  if (manual === languageId && effectiveEditorLanguage(target.state, automatic) === languageId) {
    return 'not-needed'
  }
  target.dispatch(target.state.update({
    effects: [
      setEditorLanguage.of(languageId),
      language.reconfigure(editorLanguageExtension(languageId)),
    ],
    annotations: Transaction.addToHistory.of(false),
  }))
  return 'applied'
}

/** Matches basicSetup's Mod-/ behavior: line comments first, then a block-by-line fallback. */
export const editorToggleLineComment: StateCommand = toggleComment

export function editorTrimTrailingWhitespace(
  target: Parameters<StateCommand>[0],
): EditorTrimTrailingWhitespaceResult {
  if (target.state.readOnly) return 'read-only'
  return deleteTrailingWhitespace(target) ? 'applied' : 'not-needed'
}

function validEditorIndentationSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 1 && size <= 8
}

function normalizedEditorIndentationSize(size: number): number {
  return validEditorIndentationSize(size) ? size : 4
}

/** Effective insert unit shown by the status bar, including CodeMirror's default two spaces. */
export function effectiveEditorIndentation(state: EditorState): EditorIndentationConfiguration {
  const manual = state.field(editorIndentationState, false)
  if (manual !== undefined) return manual
  const unit = state.facet(indentUnit)
  if (unit === '\t') {
    const tabSize = state.facet(EditorState.tabSize)
    return { style: 'tabs', size: normalizedEditorIndentationSize(tabSize) }
  }
  const size = /^ +$/u.test(unit) && validEditorIndentationSize(unit.length) ? unit.length : 2
  return { style: 'spaces', size }
}

/** Change indentation width as presentation state while preserving the current tabs/spaces style. */
export function editorChangeIndentationSize(
  target: Parameters<StateCommand>[0],
  size: number,
  indentation: Compartment,
): EditorIndentationSizeChangeResult {
  if (!validEditorIndentationSize(size)) return 'invalid'
  const current = effectiveEditorIndentation(target.state)
  const next: EditorIndentationConfiguration = { style: current.style, size }
  const manual = target.state.field(editorIndentationState, false)
  const expectedUnit = next.style === 'tabs' ? '\t' : ' '.repeat(size)
  if (manual?.style === next.style && manual.size === size
    && target.state.facet(indentUnit) === expectedUnit
    && target.state.facet(EditorState.tabSize) === size) return 'not-needed'
  target.dispatch(target.state.update({
    effects: [
      setEditorIndentation.of(next),
      indentation.reconfigure(explicitEditorIndentationExtensions(next)),
    ],
    annotations: Transaction.addToHistory.of(false),
  }))
  return 'applied'
}

interface IndentationChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

function indentationColumn(text: string, tabSize: number): number {
  let column = 0
  for (const character of text) {
    column += character === '\t' ? tabSize - column % tabSize : 1
  }
  return column
}

function nearestIndentationOffset(
  text: string,
  targetColumn: number,
  tabSize: number,
  assoc: number,
): number {
  let column = 0
  let bestOffset = 0
  let bestDistance = targetColumn
  for (let offset = 1; offset <= text.length; offset += 1) {
    column += text[offset - 1] === '\t' ? tabSize - column % tabSize : 1
    const distance = Math.abs(column - targetColumn)
    if (distance < bestDistance || distance === bestDistance && assoc > 0) {
      bestOffset = offset
      bestDistance = distance
    }
  }
  return bestOffset
}

function indentationChangeAt(
  changes: readonly IndentationChange[],
  position: number,
): IndentationChange | undefined {
  let low = 0
  let high = changes.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const change = changes[middle]!
    if (position < change.from) high = middle - 1
    else if (position > change.to) low = middle + 1
    else return change
  }
  return undefined
}

function mapIndentationPosition(
  state: EditorState,
  changeSet: ChangeSet,
  changes: readonly IndentationChange[],
  position: number,
  tabSize: number,
  assoc: number,
): number {
  const change = indentationChangeAt(changes, position)
  if (change === undefined) return changeSet.mapPos(position, assoc)
  const oldPrefix = state.doc.sliceString(change.from, position)
  const targetColumn = indentationColumn(oldPrefix, tabSize)
  const mappedStart = changeSet.mapPos(change.from, -1)
  return mappedStart + nearestIndentationOffset(change.insert, targetColumn, tabSize, assoc)
}

function mapIndentationSelection(
  state: EditorState,
  changeSet: ChangeSet,
  changes: readonly IndentationChange[],
  tabSize: number,
): EditorSelection {
  const ranges = state.selection.ranges.map(range => {
    if (range.undirectional) {
      return EditorSelection.undirectionalRange(
        mapIndentationPosition(state, changeSet, changes, range.from, tabSize, -1),
        mapIndentationPosition(state, changeSet, changes, range.to, tabSize, 1),
      )
    }
    const forward = range.anchor <= range.head
    const anchorAssoc = range.empty ? range.assoc : forward ? -1 : 1
    const headAssoc = range.empty ? range.assoc : forward ? 1 : -1
    const anchor = mapIndentationPosition(
      state, changeSet, changes, range.anchor, tabSize, anchorAssoc,
    )
    const head = mapIndentationPosition(
      state, changeSet, changes, range.head, tabSize, headAssoc,
    )
    return range.empty
      ? EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
      : EditorSelection.range(
        anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc,
      )
  })
  return EditorSelection.create(ranges, state.selection.mainIndex)
}

/** Convert every line's leading indentation without changing its visual column. */
export function editorConvertIndentation(
  target: Parameters<StateCommand>[0],
  style: EditorIndentationStyle,
  indentation?: Compartment,
): EditorIndentationConversionResult {
  if (target.state.readOnly) return 'read-only'
  const { doc } = target.state
  if (doc.length > EDITOR_INDENTATION_CONVERSION_MAX_INPUT_CODE_UNITS
    || doc.lines > EDITOR_INDENTATION_CONVERSION_MAX_LINES) return 'resource-limit'
  const tabSize = target.state.facet(EditorState.tabSize)
  const changes: IndentationChange[] = []
  let projectedDocumentLength = doc.length

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber)
    const leading = /^[ \t]+/u.exec(line.text)?.[0]
    if (leading === undefined) continue
    const column = indentationColumn(leading, tabSize)
    const replacementTabs = style === 'tabs' ? Math.floor(column / tabSize) : 0
    const replacementSpaces = style === 'spaces' ? column : column % tabSize
    const replacementLength = replacementTabs + replacementSpaces
    const nextDocumentLength = projectedDocumentLength - leading.length + replacementLength
    if (!Number.isSafeInteger(replacementLength)
      || nextDocumentLength > EDITOR_INDENTATION_CONVERSION_MAX_OUTPUT_CODE_UNITS) {
      return 'resource-limit'
    }
    projectedDocumentLength = nextDocumentLength
    const replacement = style === 'spaces'
      ? ' '.repeat(replacementSpaces)
      : `${'\t'.repeat(replacementTabs)}${' '.repeat(replacementSpaces)}`
    if (replacement !== leading) {
      if (changes.length >= EDITOR_INDENTATION_CONVERSION_MAX_CHANGES) return 'resource-limit'
      changes.push({ from: line.from, to: line.from + leading.length, insert: replacement })
    }
  }

  const retainedIndentation: EditorIndentationConfiguration = {
    style,
    size: normalizedEditorIndentationSize(tabSize),
  }
  const effects = indentation === undefined ? [] : [
    setEditorIndentation.of(retainedIndentation),
    indentation.reconfigure(explicitEditorIndentationExtensions(retainedIndentation)),
  ]
  if (changes.length === 0) {
    if (effects.length !== 0) {
      target.dispatch(target.state.update({
        effects,
        annotations: Transaction.addToHistory.of(false),
      }))
    }
    return 'not-needed'
  }
  const changeSet = target.state.changes(changes)
  target.dispatch(target.state.update({
    changes: changeSet,
    selection: mapIndentationSelection(target.state, changeSet, changes, tabSize),
    effects,
  }))
  return 'applied'
}

export function editorAccessExtensions(readOnly: boolean): readonly Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

/** Presentation-only extension seam; toggling it never changes document bytes or history. */
export function editorPresentationExtensions(wordWrap: boolean): readonly Extension[] {
  return wordWrap ? [EditorView.lineWrapping] : []
}

/** Theme-only extension seam; reconfiguration does not touch document or history state. */
export function editorAppearanceExtensions(colorScheme: IdeColorScheme): Extension {
  const dark = colorScheme === 'dark'
  const background = dark ? '#17191f' : '#ffffff'
  const foreground = dark ? '#d9dee8' : '#20242c'
  const caption = dark ? '#7f8794' : '#6f7785'
  const cursor = dark ? '#7da2ff' : '#315fd5'
  const selection = dark ? '#33466d' : '#cddcff'
  const syntax = dark ? {
    comment: '#8a957c', keyword: '#c792ea', string: '#c3e88d', number: '#f78c6c',
    type: '#82aaff', function: '#ffcb6b', variable: '#d9dee8', property: '#89ddff',
    tag: '#f07178', attribute: '#ffcb6b', operator: '#89ddff', punctuation: '#a9b1bd',
    meta: '#c792ea', heading: '#82aaff', link: '#89ddff', invalid: '#ff5370',
  } : {
    comment: '#587246', keyword: '#7a3e9d', string: '#3a6f2b', number: '#b84722',
    type: '#2457a6', function: '#8a5a00', variable: '#20242c', property: '#006a82',
    tag: '#a8323a', attribute: '#835c00', operator: '#006a82', punctuation: '#59616f',
    meta: '#7a3e9d', heading: '#2457a6', link: '#075ab3', invalid: '#b00020',
  }
  const syntaxStyle = HighlightStyle.define([
    { tag: tags.comment, color: syntax.comment, fontStyle: 'italic' },
    { tag: tags.keyword, color: syntax.keyword },
    { tag: [tags.string, tags.character, tags.attributeValue], color: syntax.string },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: syntax.number },
    { tag: [tags.typeName, tags.className, tags.namespace], color: syntax.type },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: syntax.function },
    { tag: [tags.variableName, tags.definition(tags.variableName)], color: syntax.variable },
    { tag: tags.propertyName, color: syntax.property },
    { tag: tags.tagName, color: syntax.tag },
    { tag: tags.attributeName, color: syntax.attribute },
    { tag: tags.operator, color: syntax.operator },
    { tag: [tags.punctuation, tags.bracket], color: syntax.punctuation },
    { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: syntax.meta },
    { tag: [tags.regexp, tags.escape], color: syntax.number },
    { tag: tags.heading, color: syntax.heading, fontWeight: '700' },
    { tag: [tags.link, tags.url], color: syntax.link, textDecoration: 'underline' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.invalid, color: syntax.invalid, textDecoration: 'underline wavy' },
  ])
  return [EditorView.theme({
    '&': {
      height: '100%',
      color: `var(--ide-code-foreground, var(--dsw-alias-label-primary, ${foreground}))`,
      backgroundColor: `var(--ide-code-background, var(--dsw-alias-bg-base, ${background}))`,
    },
    '.cm-scroller': { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)' },
    '.cm-gutters': {
      backgroundColor: `var(--ide-code-background, var(--dsw-alias-bg-base, ${background}))`,
      color: `var(--dsw-alias-label-caption, ${caption})`,
      border: 'none',
    },
    '.cm-content': { caretColor: `var(--dsw-alias-state-business-primary, ${cursor})` },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: `var(--ide-code-selection, var(--dsw-alias-interactive-bg-active, ${selection})) !important`,
    },
    '&.cm-focused': { outline: 'none' },
  }, { dark }), syntaxHighlighting(syntaxStyle)]
}

/** Per-document indentation projection; no reliable evidence keeps editor defaults. */
export function editorIndentationExtensions(content: string): readonly Extension[] {
  const indentation = detectDocumentIndentation(content)
  if (indentation === undefined) return []
  if (indentation.kind === 'tabs') return [indentUnit.of('\t')]
  return [indentUnit.of(' '.repeat(indentation.size)), EditorState.tabSize.of(indentation.size)]
}

function explicitEditorIndentationExtensions(
  indentation: EditorIndentationConfiguration,
): readonly Extension[] {
  return [
    indentUnit.of(indentation.style === 'tabs' ? '\t' : ' '.repeat(indentation.size)),
    EditorState.tabSize.of(indentation.size),
  ]
}

export function retainedEditorIndentationExtensions(
  content: string,
  cachedState: EditorState | undefined,
): readonly Extension[] {
  if (cachedState === undefined) return editorIndentationExtensions(content)
  const manual = cachedState.field(editorIndentationState, false)
  return manual === undefined
    ? editorIndentationExtensions(content)
    : explicitEditorIndentationExtensions(manual)
}

/** Editor-local bindings. Escape remains lower priority than basicSetup's selection simplification. */
export const editorIndentKeybindings: readonly KeyBinding[] = [indentWithTab]
export const editorTabFocusEscapeKeybindings: readonly KeyBinding[] = [
  { key: 'Escape', run: temporarilySetTabFocusMode },
]

export function editorTabKeybindingExtensions(): readonly Extension[] {
  return [
    keymap.of(editorIndentKeybindings),
    Prec.low(keymap.of(editorTabFocusEscapeKeybindings)),
  ]
}

/** Read the active caret as VS Code-style one-based, UTF-16 line/column coordinates. */
export function editorCursorPosition(state: EditorState): EditorLocation {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { lineNumber: line.number, columnNumber: head - line.from + 1 }
}

function restoredSelection(tab: EditorTab): EditorSelection | undefined {
  const snapshot = tab.viewState
  if (snapshot === undefined || snapshot.ranges.length === 0) return undefined
  const maximum = tab.content.length
  return EditorSelection.create(
    snapshot.ranges.map(range => EditorSelection.range(
      Math.min(maximum, Math.max(0, range.anchor)),
      Math.min(maximum, Math.max(0, range.head)),
    )),
    Math.min(snapshot.ranges.length - 1, Math.max(0, snapshot.mainIndex)),
  )
}

function viewSnapshot(editor: EditorView): EditorViewSnapshot {
  const visibleTop = Math.max(0, editor.scrollDOM.getBoundingClientRect().top - editor.documentTop)
  const viewportAnchor = editor.lineBlockAtHeight(visibleTop).from
  return {
    ranges: editor.state.selection.ranges.map(range => ({ anchor: range.anchor, head: range.head })),
    mainIndex: editor.state.selection.mainIndex,
    scrollTop: editor.scrollDOM.scrollTop,
    scrollLeft: editor.scrollDOM.scrollLeft,
    viewportAnchor,
  }
}

/** A thin CodeMirror adapter. Document authority remains in DocumentSessionStore. */
export function CodeEditor({
  workspaceId,
  tab,
  registry,
  focusRequest,
  revealRequest,
  readOnly = false,
  wordWrap = false,
  colorScheme = 'dark',
  onFocusApplied,
  onRevealApplied,
  onCursorPosition,
  onChange,
  onViewState,
  onHistoryPort,
}: CodeEditorProps) {
  const { t } = useIdeI18n()
  const surface = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>()
  const applyingExternalContent = useRef(false)
  const access = useRef(new Compartment())
  const language = useRef(new Compartment())
  const indentation = useRef(new Compartment())
  const presentation = useRef(new Compartment())
  const appearance = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onViewStateRef = useRef(onViewState)
  const onFocusAppliedRef = useRef(onFocusApplied)
  const onRevealAppliedRef = useRef(onRevealApplied)
  const onCursorPositionRef = useRef(onCursorPosition)
  const onHistoryPortRef = useRef(onHistoryPort)
  onChangeRef.current = onChange
  onViewStateRef.current = onViewState
  onFocusAppliedRef.current = onFocusApplied
  onRevealAppliedRef.current = onRevealApplied
  onCursorPositionRef.current = onCursorPosition
  onHistoryPortRef.current = onHistoryPort

  useEffect(() => {
    const element = host.current
    if (element === null || workspaceId === undefined || tab === undefined) {
      view.current?.destroy()
      view.current = undefined
      return
    }
    const identity: EditorSessionIdentity = {
      workspaceId,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
      historyEpoch: tab.historyEpoch,
    }
    registry.retainHistoryEpoch(identity)
    const cached = registry.get(identity)
    let animationFrame: number | undefined
    const automaticLanguage = editorLanguageForPath(tab.path)
    const cachedManualLanguage = cached?.state.field(editorLanguageState, false)
    const effectiveLanguage = cachedManualLanguage ?? automaticLanguage
    const cachedManualIndentation = cached?.state.field(editorIndentationState, false)
    let historyValue: EditorPortSnapshot = {
      canUndo: false,
      canRedo: false,
      languageId: effectiveLanguage,
      indentation: { style: 'spaces', size: 2 },
    }
    const historyListeners = new Set<() => void>()
    let languageLoadGeneration = 0

    const updateHistory = (state: EditorState): void => {
      const history = editorHistorySnapshot(state)
      const next: EditorPortSnapshot = {
        ...history,
        languageId: effectiveEditorLanguage(state, automaticLanguage),
        indentation: effectiveEditorIndentation(state),
      }
      if (next.canUndo === historyValue.canUndo && next.canRedo === historyValue.canRedo
        && next.languageId === historyValue.languageId
        && next.indentation.style === historyValue.indentation.style
        && next.indentation.size === historyValue.indentation.size) return
      historyValue = next
      for (const listener of historyListeners) listener()
    }

    const capture = (editor: EditorView): void => {
      registry.set(identity, {
        state: editor.state,
        scrollTop: editor.scrollDOM.scrollTop,
        scrollLeft: editor.scrollDOM.scrollLeft,
      })
      onViewStateRef.current(workspaceId, tab.path, tab.lifecycleId, viewSnapshot(editor))
    }
    const scheduleCapture = (editor: EditorView): void => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined
        if (view.current === editor) capture(editor)
      })
    }

    const extensions = [
      basicSetup,
      editorTabKeybindingExtensions(),
      editorLanguageState.init(() => cachedManualLanguage),
      language.current.of(editorLanguageExtension(effectiveLanguage)),
      access.current.of(editorAccessExtensions(readOnly)),
      editorIndentationState.init(() => cachedManualIndentation),
      indentation.current.of(retainedEditorIndentationExtensions(tab.content, cached?.state)),
      presentation.current.of(editorPresentationExtensions(wordWrap)),
      appearance.current.of(editorAppearanceExtensions(colorScheme)),
      EditorView.updateListener.of((update) => {
        updateHistory(update.state)
        if (update.docChanged && !applyingExternalContent.current) {
          onChangeRef.current(workspaceId, tab.path, tab.lifecycleId, update.state.doc.toString())
        }
        if (update.docChanged || update.selectionSet) {
          onCursorPositionRef.current(
            workspaceId,
            tab.path,
            tab.lifecycleId,
            editorCursorPosition(update.state),
          )
          scheduleCapture(update.view)
        }
      }),
    ]

    const selection = restoredSelection(tab)
    const state = cached !== undefined && cached.state.doc.toString() === tab.content
      ? cached.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({
          doc: tab.content,
          ...(selection === undefined ? {} : { selection }),
          extensions,
        })
    const persistedAnchor = cached === undefined ? tab.viewState?.viewportAnchor : undefined
    const editor = new EditorView({
      state,
      parent: element,
      ...(persistedAnchor === undefined ? {} : {
        scrollTo: EditorView.scrollIntoView(Math.min(state.doc.length, Math.max(0, persistedAnchor)), { y: 'start' }),
      }),
    })
    view.current = editor
    const requestLanguageExtension = (languageId: EditorLanguageId): void => {
      const requestGeneration = ++languageLoadGeneration
      if (!isLazyEditorLanguage(languageId)) return
      void loadEditorLanguageExtension(languageId).then(extension => {
        if (view.current !== editor
          || requestGeneration !== languageLoadGeneration
          || effectiveEditorLanguage(editor.state, automaticLanguage) !== languageId) return
        editor.dispatch({
          effects: language.current.reconfigure(extension),
          annotations: Transaction.addToHistory.of(false),
        })
        capture(editor)
      }).catch(() => {
        // The loader logs a diagnostic; LanguageDescription makes the next request retryable.
      })
    }
    requestLanguageExtension(effectiveLanguage)
    updateHistory(editor.state)
    const disposeHistoryPort = onHistoryPortRef.current?.({
      ...identity,
      getSnapshot: () => historyValue,
      subscribe: listener => {
        historyListeners.add(listener)
        return () => { historyListeners.delete(listener) }
      },
      undo: () => view.current === editor && undo(editor),
      redo: () => view.current === editor && redo(editor),
      toggleLineComment: () => view.current === editor && editorToggleLineComment(editor),
      trimTrailingWhitespace: () => (
        view.current === editor ? editorTrimTrailingWhitespace(editor) : 'stale'
      ),
      convertIndentation: style => {
        if (view.current !== editor) return 'stale'
        const result = editorConvertIndentation(editor, style, indentation.current)
        if (result === 'applied' || result === 'not-needed') capture(editor)
        return result
      },
      changeIndentationSize: size => {
        if (view.current !== editor) return 'stale'
        const result = editorChangeIndentationSize(editor, size, indentation.current)
        if (result === 'applied') capture(editor)
        return result
      },
      changeLanguage: languageId => {
        if (view.current !== editor) return 'stale'
        const result = editorChangeLanguage(editor, languageId, language.current, automaticLanguage)
        if (result === 'applied' || result === 'not-needed') requestLanguageExtension(languageId)
        if (result === 'applied') capture(editor)
        return result
      },
    })
    onCursorPositionRef.current(workspaceId, tab.path, tab.lifecycleId, editorCursorPosition(editor.state))
    const scrollTop = cached?.scrollTop ?? tab.viewState?.scrollTop ?? 0
    const scrollLeft = cached?.scrollLeft ?? tab.viewState?.scrollLeft ?? 0
    const restoreFrame = window.requestAnimationFrame(() => {
      if (view.current !== editor) return
      if (persistedAnchor === undefined) editor.scrollDOM.scrollTop = scrollTop
      editor.scrollDOM.scrollLeft = scrollLeft
    })
    const handleScroll = (): void => { scheduleCapture(editor) }
    editor.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      languageLoadGeneration += 1
      window.cancelAnimationFrame(restoreFrame)
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
      editor.scrollDOM.removeEventListener('scroll', handleScroll)
      disposeHistoryPort?.()
      historyListeners.clear()
      capture(editor)
      editor.destroy()
      if (view.current === editor) view.current = undefined
    }
  }, [registry, tab?.historyEpoch, tab?.lifecycleId, tab?.path, workspaceId])

  useEffect(() => {
    const editor = view.current
    if (editor === undefined) return
    editor.dispatch({ effects: access.current.reconfigure(editorAccessExtensions(readOnly)) })
  }, [readOnly])

  useEffect(() => {
    const editor = view.current
    if (editor === undefined) return
    editor.dispatch({ effects: presentation.current.reconfigure(editorPresentationExtensions(wordWrap)) })
  }, [wordWrap])

  useEffect(() => {
    const editor = view.current
    if (editor === undefined) return
    editor.dispatch({
      effects: appearance.current.reconfigure(editorAppearanceExtensions(colorScheme)),
      annotations: Transaction.addToHistory.of(false),
    })
  }, [colorScheme])

  useEffect(() => {
    const editor = view.current
    if (editor === undefined || tab === undefined) return
    const current = editor.state.doc.toString()
    if (current === tab.content) return
    applyingExternalContent.current = true
    try {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: tab.content },
        annotations: Transaction.addToHistory.of(false),
      })
    } finally {
      applyingExternalContent.current = false
    }
  }, [tab?.content, tab?.path])

  useEffect(() => {
    const editor = view.current
    if (editor === undefined || tab === undefined || workspaceId === undefined || revealRequest === undefined) return
    if (revealRequest.workspaceId !== workspaceId || revealRequest.path !== tab.path
      || revealRequest.lifecycleId !== tab.lifecycleId || revealRequest.historyEpoch !== tab.historyEpoch
      || revealRequest.localRevision !== tab.localRevision) return
    const maximum = editor.state.doc.length
    const from = Math.min(maximum, Math.max(0, revealRequest.from))
    const to = Math.min(maximum, Math.max(from, revealRequest.to))
    editor.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    })
    editor.focus()
    onRevealAppliedRef.current?.(revealRequest.requestId)
  }, [revealRequest?.requestId, tab?.historyEpoch, tab?.lifecycleId, tab?.localRevision, tab?.path, workspaceId])

  useEffect(() => {
    if (focusRequest === undefined) return
    const editor = view.current
    if (editor !== undefined) {
      editor.focus()
      if (editor.hasFocus) onFocusAppliedRef.current?.(focusRequest)
      return
    }
    const element = surface.current
    element?.focus()
    if (element !== undefined && document.activeElement === element) {
      onFocusAppliedRef.current?.(focusRequest)
    }
  }, [focusRequest, tab?.lifecycleId, tab?.path, workspaceId])

  return (
    <div
      ref={surface}
      className={css.editorHost}
      data-workbench-focus="editor"
      tabIndex={tab === undefined ? 0 : -1}
    >
      {tab === undefined && <div className={css.editorEmpty}>{t('openFileFromExplorer')}</div>}
      {tab?.loadError !== undefined && <div className={css.editorLoadError}>{tab.loadError}</div>}
      <div ref={host} className={css.codeMirror} aria-readonly={readOnly} />
    </div>
  )
}
