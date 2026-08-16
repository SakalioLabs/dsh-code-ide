import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_LANGUAGE_OPTIONS,
  editorLanguageForPath,
  isLazyEditorLanguage,
  loadEditorLanguageExtension,
  type EditorLanguageId,
} from '../../src/client/language.ts'

describe('lightweight editor languages', () => {
  it.each<[string, EditorLanguageId]>([
    ['module.py', 'python'],
    ['types.pyi', 'python'],
    ['main.c', 'c'],
    ['header.h', 'c'],
    ['main.cpp', 'cpp'],
    ['header.hpp', 'cpp'],
    ['Main.java', 'java'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['setup.sh', 'shell'],
    ['profile.ps1', 'powershell'],
    ['config.yml', 'yaml'],
    ['config.yaml', 'yaml'],
    ['schema.xml', 'xml'],
    ['icon.svg', 'xml'],
    ['query.sql', 'sql'],
  ])('detects %s as %s', (path, languageId) => {
    expect(editorLanguageForPath(path)).toBe(languageId)
  })

  it('keeps the public language list unique and lazy-loads only allowlisted chunks', async () => {
    const ids = EDITOR_LANGUAGE_OPTIONS.map(option => option.id)
    expect(new Set(ids).size).toBe(ids.length)

    const lazyIds: readonly EditorLanguageId[] = [
      'python', 'c', 'cpp', 'java', 'go', 'rust', 'shell', 'powershell', 'yaml', 'xml', 'sql',
    ]
    expect(lazyIds.every(isLazyEditorLanguage)).toBe(true)

    const loaded = await Promise.all(lazyIds.map(loadEditorLanguageExtension))
    for (const extension of loaded) {
      expect(() => EditorState.create({ doc: 'value', extensions: [extension] })).not.toThrow()
    }
    expect(await loadEditorLanguageExtension('python')).toBe(loaded[0])
  })

  it('loads language metadata needed by editor commands', async () => {
    const commentTokens = async (languageId: EditorLanguageId) => {
      const extension = await loadEditorLanguageExtension(languageId)
      return EditorState.create({ doc: 'value', extensions: [extension] })
        .languageDataAt<{ line?: string }>('commentTokens', 0)
    }

    expect(await commentTokens('python')).toContainEqual(expect.objectContaining({ line: '#' }))
    expect(await commentTokens('cpp')).toContainEqual(expect.objectContaining({ line: '//' }))
    expect(await commentTokens('yaml')).toContainEqual(expect.objectContaining({ line: '#' }))
  })
})
