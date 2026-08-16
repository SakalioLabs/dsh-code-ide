import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

const lowerExtension = (path: string): string => path.toLowerCase().split('.').pop() ?? ''

export type EditorLanguageId =
  | 'plaintext'
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'python'
  | 'c'
  | 'cpp'
  | 'java'
  | 'go'
  | 'rust'
  | 'shell'
  | 'powershell'
  | 'yaml'
  | 'xml'
  | 'sql'

export interface EditorLanguageOption {
  readonly id: EditorLanguageId
  readonly label: string
  readonly detail: string
}

export const EDITOR_LANGUAGE_OPTIONS: readonly EditorLanguageOption[] = Object.freeze([
  Object.freeze({ id: 'plaintext', label: 'Plain Text', detail: 'No language syntax' }),
  Object.freeze({ id: 'javascript', label: 'JavaScript', detail: 'JavaScript' }),
  Object.freeze({ id: 'javascriptreact', label: 'JavaScript React', detail: 'JavaScript with JSX' }),
  Object.freeze({ id: 'typescript', label: 'TypeScript', detail: 'TypeScript' }),
  Object.freeze({ id: 'typescriptreact', label: 'TypeScript React', detail: 'TypeScript with JSX' }),
  Object.freeze({ id: 'json', label: 'JSON', detail: 'JavaScript Object Notation' }),
  Object.freeze({ id: 'css', label: 'CSS', detail: 'CSS, SCSS, or Less' }),
  Object.freeze({ id: 'html', label: 'HTML', detail: 'HTML or compatible templates' }),
  Object.freeze({ id: 'markdown', label: 'Markdown', detail: 'Markdown' }),
  Object.freeze({ id: 'python', label: 'Python', detail: 'Python' }),
  Object.freeze({ id: 'c', label: 'C', detail: 'C' }),
  Object.freeze({ id: 'cpp', label: 'C++', detail: 'C++' }),
  Object.freeze({ id: 'java', label: 'Java', detail: 'Java' }),
  Object.freeze({ id: 'go', label: 'Go', detail: 'Go' }),
  Object.freeze({ id: 'rust', label: 'Rust', detail: 'Rust' }),
  Object.freeze({ id: 'shell', label: 'Shell Script', detail: 'Shell or Bash' }),
  Object.freeze({ id: 'powershell', label: 'PowerShell', detail: 'PowerShell' }),
  Object.freeze({ id: 'yaml', label: 'YAML', detail: 'YAML' }),
  Object.freeze({ id: 'xml', label: 'XML', detail: 'XML' }),
  Object.freeze({ id: 'sql', label: 'SQL', detail: 'SQL' }),
])

const EDITOR_LANGUAGE_IDS = new Set<EditorLanguageId>(EDITOR_LANGUAGE_OPTIONS.map(option => option.id))

export function isEditorLanguageId(value: string): value is EditorLanguageId {
  return EDITOR_LANGUAGE_IDS.has(value as EditorLanguageId)
}

export function editorLanguageForPath(path: string): EditorLanguageId {
  const extension = lowerExtension(path)
  if (extension === 'tsx') return 'typescriptreact'
  if (extension === 'ts') return 'typescript'
  if (extension === 'jsx') return 'javascriptreact'
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return 'javascript'
  if (extension === 'json' || extension === 'jsonc') return 'json'
  if (extension === 'css' || extension === 'scss' || extension === 'less') return 'css'
  if (extension === 'html' || extension === 'htm' || extension === 'vue') return 'html'
  if (extension === 'md' || extension === 'mdx') return 'markdown'
  if (extension === 'py' || extension === 'pyw' || extension === 'pyi') return 'python'
  if (extension === 'c' || extension === 'h') return 'c'
  if (extension === 'cc' || extension === 'cpp' || extension === 'cxx'
    || extension === 'hh' || extension === 'hpp' || extension === 'hxx') return 'cpp'
  if (extension === 'java') return 'java'
  if (extension === 'go') return 'go'
  if (extension === 'rs') return 'rust'
  if (extension === 'sh' || extension === 'bash' || extension === 'zsh'
    || extension === 'ksh') return 'shell'
  if (extension === 'ps1' || extension === 'psm1' || extension === 'psd1') return 'powershell'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'xml' || extension === 'xsd' || extension === 'xsl'
    || extension === 'xslt' || extension === 'svg') return 'xml'
  if (extension === 'sql') return 'sql'
  return 'plaintext'
}

const cppDescription = LanguageDescription.of({
  name: 'C/C++',
  load: () => import('@codemirror/lang-cpp').then(module => module.cpp()),
})

const LAZY_EDITOR_LANGUAGES: Readonly<Partial<Record<EditorLanguageId, LanguageDescription>>> =
  Object.freeze({
    python: LanguageDescription.of({
      name: 'Python',
      load: () => import('@codemirror/lang-python').then(module => module.python()),
    }),
    c: cppDescription,
    cpp: cppDescription,
    java: LanguageDescription.of({
      name: 'Java',
      load: () => import('@codemirror/lang-java').then(module => module.java()),
    }),
    go: LanguageDescription.of({
      name: 'Go',
      load: () => import('@codemirror/lang-go').then(module => module.go()),
    }),
    rust: LanguageDescription.of({
      name: 'Rust',
      load: () => import('@codemirror/lang-rust').then(module => module.rust()),
    }),
    shell: LanguageDescription.of({
      name: 'Shell',
      load: () => import('@codemirror/legacy-modes/mode/shell')
        .then(module => new LanguageSupport(StreamLanguage.define(module.shell))),
    }),
    powershell: LanguageDescription.of({
      name: 'PowerShell',
      load: () => import('@codemirror/legacy-modes/mode/powershell')
        .then(module => new LanguageSupport(StreamLanguage.define(module.powerShell))),
    }),
    yaml: LanguageDescription.of({
      name: 'YAML',
      load: () => import('@codemirror/lang-yaml').then(module => module.yaml()),
    }),
    xml: LanguageDescription.of({
      name: 'XML',
      load: () => import('@codemirror/lang-xml').then(module => module.xml()),
    }),
    sql: LanguageDescription.of({
      name: 'SQL',
      load: () => import('@codemirror/lang-sql').then(module => module.sql()),
    }),
  })

export function editorLanguageExtension(languageId: EditorLanguageId): Extension {
  const lazy = LAZY_EDITOR_LANGUAGES[languageId]
  if (lazy !== undefined) return lazy.support ?? []
  switch (languageId) {
    case 'javascript': return javascript()
    case 'javascriptreact': return javascript({ jsx: true })
    case 'typescript': return javascript({ typescript: true })
    case 'typescriptreact': return javascript({ typescript: true, jsx: true })
    case 'json': return json()
    case 'css': return css()
    case 'html': return html()
    case 'markdown': return markdown()
    case 'python':
    case 'c':
    case 'cpp':
    case 'java':
    case 'go':
    case 'rust':
    case 'shell':
    case 'powershell':
    case 'yaml':
    case 'xml':
    case 'sql':
    case 'plaintext': return []
  }
}

export function isLazyEditorLanguage(languageId: EditorLanguageId): boolean {
  return LAZY_EDITOR_LANGUAGES[languageId] !== undefined
}

/** Loads only a build-time allowlisted language chunk; failed loads remain retryable. */
export function loadEditorLanguageExtension(languageId: EditorLanguageId): Promise<Extension> {
  const lazy = LAZY_EDITOR_LANGUAGES[languageId]
  if (lazy === undefined) return Promise.resolve(editorLanguageExtension(languageId))
  return lazy.load().catch(error => {
    console.warn(`[dsh-code-ide] Failed to load ${languageId} syntax highlighting`, error)
    throw error
  })
}

/** Compatibility entry point for automatic path-based language detection. */
export function languageForPath(path: string): Extension {
  return editorLanguageExtension(editorLanguageForPath(path))
}
