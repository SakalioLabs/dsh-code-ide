import { history, undoDepth } from '@codemirror/commands'
import { highlightingFor } from '@codemirror/language'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { editorAppearanceExtensions } from '../../src/client/CodeEditor.tsx'

describe('CodeEditor appearance', () => {
  it('hot-reconfigures the dark facet without changing document or undo history', () => {
    const appearance = new Compartment()
    const initial = EditorState.create({
      doc: 'answer = 41',
      extensions: [history(), appearance.of(editorAppearanceExtensions('dark'))],
    })
    const edited = initial.update({ changes: { from: initial.doc.length, insert: ' + 1' } }).state
    expect(edited.facet(EditorView.darkTheme)).toBe(true)
    expect(undoDepth(edited)).toBe(1)
    const darkKeywordClass = highlightingFor(edited, [tags.keyword])
    expect(darkKeywordClass).not.toBeNull()

    const update = edited.update({
      effects: appearance.reconfigure(editorAppearanceExtensions('light')),
      annotations: Transaction.addToHistory.of(false),
    })

    expect(update.docChanged).toBe(false)
    expect(update.state.doc.toString()).toBe('answer = 41 + 1')
    expect(update.state.facet(EditorView.darkTheme)).toBe(false)
    expect(undoDepth(update.state)).toBe(1)
    const lightKeywordClass = highlightingFor(update.state, [tags.keyword])
    expect(lightKeywordClass).not.toBeNull()
    expect(lightKeywordClass).not.toBe(darkKeywordClass)
  })
})
