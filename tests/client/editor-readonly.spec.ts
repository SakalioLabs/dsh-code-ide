import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { Compartment, EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_INDENTATION_CONVERSION_MAX_OUTPUT_CODE_UNITS,
  editorAccessExtensions,
  editorChangeIndentationSize,
  editorConvertIndentation,
  editorChangeLanguage,
  editorCursorPosition,
  editorHistorySnapshot,
  editorIndentationExtensions,
  editorIndentationState,
  editorIndentKeybindings,
  editorLanguageState,
  editorPresentationExtensions,
  editorTabFocusEscapeKeybindings,
  editorTrimTrailingWhitespace,
  editorToggleLineComment,
  effectiveEditorIndentation,
  retainedEditorIndentationExtensions,
  retainedEditorLanguage,
} from '../../src/client/CodeEditor.tsx'
import { detectDocumentIndentation } from '../../src/client/editor/indentation.ts'
import {
  editorLanguageExtension,
  editorLanguageForPath,
  languageForPath,
} from '../../src/client/language.ts'

function stateCommandTarget(initialState: EditorState): {
  current: () => EditorState
  target: { state: EditorState; dispatch: (transaction: Transaction) => void }
} {
  let state = initialState
  const target = {
    get state() { return state },
    dispatch(transaction: Transaction) { state = transaction.state },
  }
  return { current: () => state, target }
}

describe('editor mutation access', () => {
  it('makes a mutation-leased editor both state-read-only and DOM-non-editable', () => {
    const locked = EditorState.create({ extensions: editorAccessExtensions(true) })
    expect(locked.readOnly).toBe(true)
    expect(locked.facet(EditorView.editable)).toBe(false)

    const writable = EditorState.create({ extensions: editorAccessExtensions(false) })
    expect(writable.readOnly).toBe(false)
    expect(writable.facet(EditorView.editable)).toBe(true)
  })

  it('reconfigures word wrap as presentation without changing document bytes or undo history', () => {
    const presentation = new Compartment()
    let state = EditorState.create({
      doc: 'one long line',
      extensions: [history(), presentation.of(editorPresentationExtensions(false))],
    })
    state = state.update({ changes: { from: state.doc.length, insert: '!' } }).state
    const beforeDocument = state.doc.toString()
    const beforeUndoDepth = undoDepth(state)

    const enabled = state.update({
      effects: presentation.reconfigure(editorPresentationExtensions(true)),
    })
    expect(enabled.docChanged).toBe(false)
    expect(enabled.state.doc.toString()).toBe(beforeDocument)
    expect(undoDepth(enabled.state)).toBe(beforeUndoDepth)
    expect(enabled.state.facet(EditorView.contentAttributes)).toContainEqual({ class: 'cm-lineWrapping' })

    const disabled = enabled.state.update({
      effects: presentation.reconfigure(editorPresentationExtensions(false)),
    })
    expect(disabled.docChanged).toBe(false)
    expect(disabled.state.doc.toString()).toBe(beforeDocument)
    expect(undoDepth(disabled.state)).toBe(beforeUndoDepth)
    expect(disabled.state.facet(EditorView.contentAttributes)).not.toContainEqual({ class: 'cm-lineWrapping' })
  })

  it('reads the main caret as one-based UTF-16 line and column without changing document history', () => {
    expect(editorCursorPosition(EditorState.create({ doc: 'initial' }))).toEqual({
      lineNumber: 1,
      columnNumber: 1,
    })

    let state = EditorState.create({
      doc: 'first\r\n😀x\nlast',
      extensions: [history(), EditorState.allowMultipleSelections.of(true)],
    })
    state = state.update({ changes: { from: state.doc.length, insert: '!' } }).state
    const secondLine = state.doc.line(2)
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.range(secondLine.from + 3, secondLine.from + 2),
      ], 1),
    }).state
    const beforeDocument = state.doc.toString()
    const beforeUndoDepth = undoDepth(state)

    expect(editorCursorPosition(state)).toEqual({ lineNumber: 2, columnNumber: 3 })
    expect(state.doc.toString()).toBe(beforeDocument)
    expect(undoDepth(state)).toBe(beforeUndoDepth)
  })

  it('indents and outdents writable documents with normal undo transactions', () => {
    const tab = editorIndentKeybindings[0]
    expect(tab?.key).toBe('Tab')

    const indented = stateCommandTarget(EditorState.create({
      doc: 'alpha',
      extensions: [history(), editorIndentationExtensions('    one\n        two')],
    }))
    expect(tab?.run?.(indented.target as EditorView)).toBe(true)
    expect(indented.current().doc.toString()).toBe('    alpha')
    expect(undoDepth(indented.current())).toBe(1)
    expect(undo(indented.target)).toBe(true)
    expect(indented.current().doc.toString()).toBe('alpha')

    const outdented = stateCommandTarget(EditorState.create({
      doc: '    alpha',
      extensions: [history(), editorIndentationExtensions('    one\n        two')],
    }))
    expect(tab?.shift?.(outdented.target as EditorView)).toBe(true)
    expect(outdented.current().doc.toString()).toBe('alpha')
    expect(undoDepth(outdented.current())).toBe(1)
    expect(undo(outdented.target)).toBe(true)
    expect(outdented.current().doc.toString()).toBe('    alpha')
  })

  it('detects only strong bounded tab or conventional space indentation evidence', () => {
    expect(detectDocumentIndentation('\tone\n\t\ttwo\n\tthree')).toEqual({ kind: 'tabs' })
    expect(detectDocumentIndentation('\tone\n\t\ttwo\n\tthree\n  aligned')).toEqual({ kind: 'tabs' })
    expect(detectDocumentIndentation('  one\n    two\n      three')).toEqual({ kind: 'spaces', size: 2 })
    expect(detectDocumentIndentation('    one\n        two\n            three')).toEqual({ kind: 'spaces', size: 4 })
    expect(detectDocumentIndentation('\tone\n    two')).toBeUndefined()
    expect(detectDocumentIndentation('    one\n      aligned')).toBeUndefined()
    expect(detectDocumentIndentation('        nested\n            deeper')).toBeUndefined()
    expect(detectDocumentIndentation('    only-one-indented-line')).toBeUndefined()

    const tab = editorIndentKeybindings[0]
    const tabIndented = stateCommandTarget(EditorState.create({
      doc: 'alpha',
      extensions: [history(), editorIndentationExtensions('\tone\n\t\ttwo')],
    }))
    expect(tab?.run?.(tabIndented.target as EditorView)).toBe(true)
    expect(tabIndented.current().doc.toString()).toBe('\talpha')
  })

  it('changes indentation size as retained presentation while preserving style and editor state', () => {
    expect(effectiveEditorIndentation(EditorState.create())).toEqual({ style: 'spaces', size: 2 })

    const indentation = new Compartment()
    let initial = EditorState.create({
      doc: 'alpha',
      selection: { anchor: 1, head: 4 },
      extensions: [history(), editorIndentationState, indentation.of([]), editorAccessExtensions(true)],
    })
    initial = initial.update({ annotations: Transaction.addToHistory.of(false) }).state
    const editor = stateCommandTarget(initial)
    const selection = initial.selection.toJSON()

    expect(editorChangeIndentationSize(editor.target, 4, indentation)).toBe('applied')
    expect(effectiveEditorIndentation(editor.current())).toEqual({ style: 'spaces', size: 4 })
    expect(editor.current().field(editorIndentationState)).toEqual({ style: 'spaces', size: 4 })
    expect(editor.current().facet(indentUnit)).toBe('    ')
    expect(editor.current().facet(EditorState.tabSize)).toBe(4)
    expect(editor.current().doc.toString()).toBe('alpha')
    expect(editor.current().selection.toJSON()).toEqual(selection)
    expect(editor.current().readOnly).toBe(true)
    expect(undoDepth(editor.current())).toBe(0)
    expect(editorChangeIndentationSize(editor.target, 4, indentation)).toBe('not-needed')
    expect(editorChangeIndentationSize(editor.target, 0, indentation)).toBe('invalid')
    expect(editorChangeIndentationSize(editor.target, 1.5, indentation)).toBe('invalid')
    expect(editorChangeIndentationSize(editor.target, 9, indentation)).toBe('invalid')

    const tabs = stateCommandTarget(EditorState.create({
      doc: '\tone\n\t\ttwo',
      extensions: [
        editorIndentationState,
        indentation.of(editorIndentationExtensions('\tone\n\t\ttwo')),
        editorAccessExtensions(true),
      ],
    }))
    expect(effectiveEditorIndentation(tabs.current())).toEqual({ style: 'tabs', size: 4 })
    expect(editorChangeIndentationSize(tabs.target, 3, indentation)).toBe('applied')
    expect(effectiveEditorIndentation(tabs.current())).toEqual({ style: 'tabs', size: 3 })
    expect(tabs.current().facet(indentUnit)).toBe('\t')
    expect(tabs.current().facet(EditorState.tabSize)).toBe(3)
  })

  it('does not indent or outdent read-only documents', () => {
    const tab = editorIndentKeybindings[0]
    const locked = stateCommandTarget(EditorState.create({
      doc: '  alpha',
      extensions: [history(), editorAccessExtensions(true)],
    }))

    expect(tab?.run?.(locked.target as EditorView)).toBe(false)
    expect(tab?.shift?.(locked.target as EditorView)).toBe(false)
    expect(locked.current().doc.toString()).toBe('  alpha')
    expect(undoDepth(locked.current())).toBe(0)
  })

  it('matches the editor-local comment command for line, block fallback, unsupported, and read-only states', () => {
    const typescript = stateCommandTarget(EditorState.create({
      doc: 'const answer = 42',
      extensions: [history(), languageForPath('answer.ts'), editorAccessExtensions(false)],
    }))
    expect(editorToggleLineComment(typescript.target)).toBe(true)
    expect(typescript.current().doc.toString()).toBe('// const answer = 42')
    expect(undoDepth(typescript.current())).toBe(1)

    const html = stateCommandTarget(EditorState.create({
      doc: '<main></main>',
      extensions: [history(), languageForPath('index.html'), editorAccessExtensions(false)],
    }))
    expect(editorToggleLineComment(html.target)).toBe(true)
    expect(html.current().doc.toString()).toMatch(/^<!-- .* -->$/u)

    const unsupported = stateCommandTarget(EditorState.create({
      doc: 'plain text',
      extensions: [history(), languageForPath('notes.txt'), editorAccessExtensions(false)],
    }))
    expect(editorToggleLineComment(unsupported.target)).toBe(false)
    expect(unsupported.current().doc.toString()).toBe('plain text')

    const locked = stateCommandTarget(EditorState.create({
      doc: 'const answer = 42',
      extensions: [history(), languageForPath('answer.ts'), editorAccessExtensions(true)],
    }))
    expect(editorToggleLineComment(locked.target)).toBe(false)
    expect(locked.current().doc.toString()).toBe('const answer = 42')
  })

  it('changes language as retained presentation without touching text, selection, read-only state, or undo history', () => {
    expect(editorLanguageForPath('component.jsx')).toBe('javascriptreact')
    expect(editorLanguageForPath('component.tsx')).toBe('typescriptreact')
    expect(editorLanguageForPath('component.ts')).toBe('typescript')

    const language = new Compartment()
    const initial = EditorState.create({
      doc: 'const answer = 42',
      selection: { anchor: 2, head: 8 },
      extensions: [
        history(),
        editorLanguageState,
        language.of(editorLanguageExtension('plaintext')),
        editorAccessExtensions(true),
      ],
    })
    const editor = stateCommandTarget(initial)
    const selection = initial.selection.toJSON()

    expect(editorChangeLanguage(editor.target, 'typescript', language, 'plaintext')).toBe('applied')
    expect(editor.current().doc.toString()).toBe('const answer = 42')
    expect(editor.current().selection.toJSON()).toEqual(selection)
    expect(editor.current().readOnly).toBe(true)
    expect(undoDepth(editor.current())).toBe(0)
    expect(editor.current().field(editorLanguageState)).toBe('typescript')

    const cached = editor.current()
    const retained = cached.update({
      effects: StateEffect.reconfigure.of([
        history(),
        editorLanguageState,
        language.of(editorLanguageExtension(retainedEditorLanguage('renamed.unknown', cached))),
        editorAccessExtensions(false),
      ]),
    }).state
    expect(retained.field(editorLanguageState)).toBe('typescript')
    const writable = stateCommandTarget(retained)
    expect(editorToggleLineComment(writable.target)).toBe(true)
    expect(writable.current().doc.toString()).toBe('// const answer = 42')

    const changedDocument = EditorState.create({
      doc: 'const replacement = true',
      extensions: [
        history(),
        editorLanguageState.init(() => cached.field(editorLanguageState, false)),
        language.of(editorLanguageExtension(retainedEditorLanguage('renamed.unknown', cached))),
        editorAccessExtensions(false),
      ],
    })
    expect(changedDocument.field(editorLanguageState)).toBe('typescript')
    const changed = stateCommandTarget(changedDocument)
    expect(editorToggleLineComment(changed.target)).toBe(true)
    expect(changed.current().doc.toString()).toBe('// const replacement = true')
  })

  it('trims trailing whitespace as one undoable edit and distinguishes clean and read-only documents', () => {
    const original = 'alpha  \n beta\t\nlast \t'
    const editable = stateCommandTarget(EditorState.create({
      doc: original,
      extensions: [history(), editorAccessExtensions(false)],
    }))
    expect(editorTrimTrailingWhitespace(editable.target)).toBe('applied')
    expect(editable.current().doc.toString()).toBe('alpha\n beta\nlast')
    expect(undoDepth(editable.current())).toBe(1)
    expect(undo(editable.target)).toBe(true)
    expect(editable.current().doc.toString()).toBe(original)

    const clean = stateCommandTarget(EditorState.create({
      doc: 'alpha\n beta\nlast',
      extensions: [history(), editorAccessExtensions(false)],
    }))
    expect(editorTrimTrailingWhitespace(clean.target)).toBe('not-needed')
    expect(undoDepth(clean.current())).toBe(0)

    const locked = stateCommandTarget(EditorState.create({
      doc: original,
      extensions: [history(), editorAccessExtensions(true)],
    }))
    expect(editorTrimTrailingWhitespace(locked.target)).toBe('read-only')
    expect(locked.current().doc.toString()).toBe(original)
    expect(undoDepth(locked.current())).toBe(0)
  })

  it('converts leading indentation at live tab stops as one undoable edit', () => {
    const original = '\talpha\n \tbeta\n      gamma\nplain\n\t  aligned'
    const spaces = stateCommandTarget(EditorState.create({
      doc: original,
      extensions: [history(), EditorState.tabSize.of(4), editorAccessExtensions(false)],
    }))
    expect(editorConvertIndentation(spaces.target, 'spaces')).toBe('applied')
    expect(spaces.current().doc.toString()).toBe(
      '    alpha\n    beta\n      gamma\nplain\n      aligned',
    )
    expect(undoDepth(spaces.current())).toBe(1)
    expect(undo(spaces.target)).toBe(true)
    expect(spaces.current().doc.toString()).toBe(original)

    const tabs = stateCommandTarget(EditorState.create({
      doc: '    alpha\n      beta\n  shallow',
      extensions: [history(), EditorState.tabSize.of(4), editorAccessExtensions(false)],
    }))
    expect(editorConvertIndentation(tabs.target, 'tabs')).toBe('applied')
    expect(tabs.current().doc.toString()).toBe('\talpha\n\t  beta\n  shallow')
    expect(undoDepth(tabs.current())).toBe(1)
    expect(undo(tabs.target)).toBe(true)
    expect(tabs.current().doc.toString()).toBe('    alpha\n      beta\n  shallow')

    const clean = stateCommandTarget(EditorState.create({
      doc: '    alpha',
      extensions: [history(), EditorState.tabSize.of(4), editorAccessExtensions(false)],
    }))
    expect(editorConvertIndentation(clean.target, 'spaces')).toBe('not-needed')
    expect(undoDepth(clean.current())).toBe(0)

    const locked = stateCommandTarget(EditorState.create({
      doc: '\talpha',
      extensions: [history(), EditorState.tabSize.of(4), editorAccessExtensions(true)],
    }))
    expect(editorConvertIndentation(locked.target, 'spaces')).toBe('read-only')
    expect(locked.current().doc.toString()).toBe('\talpha')
    expect(undoDepth(locked.current())).toBe(0)

    const oversized = stateCommandTarget(EditorState.create({
      doc: '\t\talpha',
      extensions: [
        history(),
        EditorState.tabSize.of(EDITOR_INDENTATION_CONVERSION_MAX_OUTPUT_CODE_UNITS),
        editorAccessExtensions(false),
      ],
    }))
    expect(editorConvertIndentation(oversized.target, 'spaces')).toBe('resource-limit')
    expect(oversized.current().doc.toString()).toBe('\t\talpha')
    expect(undoDepth(oversized.current())).toBe(0)
  })

  it('retains manual indentation across cached reconfiguration and maps every selection by visual column', () => {
    const indentation = new Compartment()
    const source = '      alpha\n\tbeta'
    const converted = stateCommandTarget(EditorState.create({
      doc: source,
      selection: EditorSelection.create([
        EditorSelection.range(5, 1),
        EditorSelection.cursor(13),
      ], 1),
      extensions: [
        history(),
        EditorState.allowMultipleSelections.of(true),
        editorIndentationState,
        indentation.of([EditorState.tabSize.of(4)]),
        editorAccessExtensions(false),
      ],
    }))

    expect(editorConvertIndentation(converted.target, 'tabs', indentation)).toBe('applied')
    expect(converted.current().doc.toString()).toBe('\t  alpha\n\tbeta')
    expect(converted.current().selection.mainIndex).toBe(1)
    expect(converted.current().selection.ranges[0]).toMatchObject({ anchor: 2, head: 0 })
    expect(converted.current().selection.ranges[1]).toMatchObject({ anchor: 10, head: 10 })
    expect(converted.current().facet(indentUnit)).toBe('\t')
    expect(converted.current().facet(EditorState.tabSize)).toBe(4)

    const cached = converted.current()
    const reconfigured = cached.update({
      effects: StateEffect.reconfigure.of([
        history(),
        EditorState.allowMultipleSelections.of(true),
        editorIndentationState,
        indentation.of(retainedEditorIndentationExtensions(cached.doc.toString(), cached)),
        editorAccessExtensions(false),
      ]),
    }).state
    expect(reconfigured.facet(indentUnit)).toBe('\t')
    expect(reconfigured.facet(EditorState.tabSize)).toBe(4)
    expect(reconfigured.field(editorIndentationState)).toEqual({ style: 'tabs', size: 4 })

    const changedDocument = EditorState.create({
      doc: '  replacement',
      extensions: [
        editorIndentationState.init(() => cached.field(editorIndentationState, false)),
        indentation.of(retainedEditorIndentationExtensions('  replacement', cached)),
      ],
    })
    expect(changedDocument.field(editorIndentationState)).toEqual({ style: 'tabs', size: 4 })
    expect(changedDocument.facet(indentUnit)).toBe('\t')
    expect(changedDocument.facet(EditorState.tabSize)).toBe(4)
  })

  it('temporarily releases Tab focus capture after an unhandled Escape', () => {
    const escape = editorTabFocusEscapeKeybindings[0]
    let timeout: number | undefined
    const target = {
      setTabFocusMode(value?: boolean | number) {
        timeout = typeof value === 'number' ? value : undefined
      },
    } as EditorView

    expect(escape?.key).toBe('Escape')
    expect(escape?.run?.(target)).toBe(true)
    expect(timeout).toBe(2000)
  })

  it('reports live undo and redo availability from the exact CodeMirror history state', () => {
    const editor = stateCommandTarget(EditorState.create({ doc: 'alpha', extensions: history() }))
    expect(editorHistorySnapshot(editor.current())).toEqual({ canUndo: false, canRedo: false })

    editor.target.dispatch(editor.current().update({ changes: { from: 5, insert: '!' } }))
    expect(editorHistorySnapshot(editor.current())).toEqual({ canUndo: true, canRedo: false })
    expect(undo(editor.target)).toBe(true)
    expect(editorHistorySnapshot(editor.current())).toEqual({ canUndo: false, canRedo: true })
    expect(redoDepth(editor.current())).toBe(1)
    expect(redo(editor.target)).toBe(true)
    expect(editorHistorySnapshot(editor.current())).toEqual({ canUndo: true, canRedo: false })
  })
})
