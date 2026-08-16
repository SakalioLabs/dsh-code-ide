import type { CSSProperties, ReactNode } from 'react'

import './seti-icons.css'

export type IdeIconName =
  | 'new-file'
  | 'new-folder'
  | 'collapse-all'
  | 'refresh'
  | 'new-terminal'
  | 'search'
  | 'clear'
  | 'more'
  | 'panel-maximize'
  | 'panel-restore'
  | 'panel-collapse'
  | 'panel-expand'

export type ExplorerFileIconKind =
  | 'folder'
  | 'python'
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'
  | 'json'
  | 'html'
  | 'css'
  | 'scss'
  | 'markdown'
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
  | 'image'
  | 'docker'
  | 'git'
  | 'config'
  | 'lock'
  | 'file'

const EXPLORER_FILE_ICON_BY_EXTENSION: Readonly<Record<string, ExplorerFileIconKind>> = {
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'typescriptreact',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html',
  css: 'css', less: 'css',
  scss: 'scss', sass: 'scss',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  java: 'java',
  go: 'go',
  rs: 'rust',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', xsl: 'xml',
  sql: 'sql',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', ico: 'image', svg: 'image',
}

const LOCK_FILE_NAMES = new Set(['cargo.lock', 'composer.lock', 'deno.lock', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'yarn.lock'])
const CONFIG_FILE_NAMES = new Set(['.editorconfig', '.eslintrc', '.prettierrc', 'biome.json', 'jsconfig.json', 'pyproject.toml', 'rustfmt.toml', 'tsconfig.json', 'vitest.config.ts'])
const GIT_FILE_NAMES = new Set(['.gitattributes', '.gitignore', '.gitmodules'])

/** Lightweight Seti-style classification without loading an icon theme or extension host. */
export function explorerFileIconKind(name: string, type: 'file' | 'directory' | 'other'): ExplorerFileIconKind {
  if (type === 'directory') return 'folder'
  if (type !== 'file') return 'file'
  const basename = name.toLocaleLowerCase('en-US')
  if (LOCK_FILE_NAMES.has(basename)) return 'lock'
  if (GIT_FILE_NAMES.has(basename)) return 'git'
  if (basename === 'dockerfile' || basename.startsWith('dockerfile.') || basename === 'compose.yaml' || basename === 'compose.yml') return 'docker'
  if (CONFIG_FILE_NAMES.has(basename) || /(?:^|\.)(?:config|rc)\.[^.]+$/.test(basename)) return 'config'
  if (basename === 'makefile') return 'shell'
  const separator = basename.lastIndexOf('.')
  return separator < 0 ? 'file' : EXPLORER_FILE_ICON_BY_EXTENSION[basename.slice(separator + 1)] ?? 'file'
}

type ExplorerSetiIconMeta = {
  readonly character: string
  readonly dark: string
  readonly light: string
}

const EXPLORER_FILE_ICON_META: Readonly<Record<Exclude<ExplorerFileIconKind, 'folder'>, ExplorerSetiIconMeta>> = {
  file: { character: '\ue023', dark: '#d4d7d6', light: '#bfc2c1' },
  c: { character: '\ue00c', dark: '#519aba', light: '#498ba7' },
  cpp: { character: '\ue01a', dark: '#519aba', light: '#498ba7' },
  config: { character: '\ue019', dark: '#6d8086', light: '#627379' },
  css: { character: '\ue01d', dark: '#519aba', light: '#498ba7' },
  sql: { character: '\ue022', dark: '#f55385', light: '#dd4b78' },
  docker: { character: '\ue025', dark: '#519aba', light: '#498ba7' },
  git: { character: '\ue034', dark: '#41535b', light: '#3b4b52' },
  go: { character: '\ue03a', dark: '#519aba', light: '#498ba7' },
  html: { character: '\ue048', dark: '#e37933', light: '#cc6d2e' },
  image: { character: '\ue04c', dark: '#a074c4', light: '#9068b0' },
  java: { character: '\ue050', dark: '#cc3e44', light: '#b8383d' },
  javascript: { character: '\ue051', dark: '#cbcb41', light: '#b7b73b' },
  json: { character: '\ue055', dark: '#cbcb41', light: '#b7b73b' },
  lock: { character: '\ue05d', dark: '#8dc149', light: '#7fae42' },
  markdown: { character: '\ue060', dark: '#519aba', light: '#498ba7' },
  powershell: { character: '\ue074', dark: '#519aba', light: '#498ba7' },
  python: { character: '\ue07b', dark: '#519aba', light: '#498ba7' },
  javascriptreact: { character: '\ue07d', dark: '#519aba', light: '#498ba7' },
  rust: { character: '\ue082', dark: '#6d8086', light: '#627379' },
  scss: { character: '\ue084', dark: '#f55385', light: '#dd4b78' },
  shell: { character: '\ue089', dark: '#8dc149', light: '#7fae42' },
  typescript: { character: '\ue099', dark: '#519aba', light: '#498ba7' },
  typescriptreact: { character: '\ue07d', dark: '#519aba', light: '#498ba7' },
  xml: { character: '\ue0a5', dark: '#e37933', light: '#cc6d2e' },
  yaml: { character: '\ue0a7', dark: '#a074c4', light: '#9068b0' },
}

/** Code-OSS Seti glyphs keep common file types recognizable without an icon runtime. */
export function ExplorerFileIcon({
  name,
  type,
  expanded = false,
}: {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly expanded?: boolean
}): ReactNode {
  const kind = explorerFileIconKind(name, type)
  if (kind === 'folder') {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
        focusable="false"
        data-explorer-file-icon={kind}
        style={{ flex: '0 0 auto', color: '#d7aa50' }}
      >
        <path
          d={expanded ? 'M1.25 5.25h13.5l-1.5 8H2.5z' : 'M1.5 3.25h4.25l1.5 1.75h7.25v8.25h-13z'}
          fill="currentColor"
          opacity=".92"
        />
      </svg>
    )
  }

  const meta = EXPLORER_FILE_ICON_META[kind]
  return (
    <span
      aria-hidden
      data-explorer-file-icon={kind}
      data-explorer-seti-icon
      style={{
        '--seti-icon-dark': meta.dark,
        '--seti-icon-light': meta.light,
      } as CSSProperties}
    >
      {meta.character}
    </span>
  )
}

export function IdeIcon({ name }: { readonly name: IdeIconName }): ReactNode {
  const common = {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false,
  }
  if (name === 'new-file') return <svg {...common}><path d="M3.5 1.75h5l3 3v9.5h-8z"/><path d="M8.5 1.75v3h3M8 8v4M6 10h4"/></svg>
  if (name === 'new-folder') return <svg {...common}><path d="M1.75 4.25h4l1.25 1.5h7.25v7.5H1.75z"/><path d="M9.5 7.75v4M7.5 9.75h4"/></svg>
  if (name === 'collapse-all') return <svg {...common}><path d="m4 5 4-3 4 3M4 11l4 3 4-3M8 2v12"/></svg>
  if (name === 'refresh') return <svg {...common}><path d="M13.25 5.75A5.5 5.5 0 1 0 13 11"/><path d="M13.25 2.75v3h-3"/></svg>
  if (name === 'new-terminal') return <svg {...common}><path d="M2 2.25h12v11.5H2zM4.25 5l2.25 2-2.25 2M8 10h3.5"/><path d="M12 1v4M10 3h4"/></svg>
  if (name === 'search') return <svg {...common}><circle cx="6.75" cy="6.75" r="4.25"/><path d="m10 10 3.5 3.5"/></svg>
  if (name === 'clear') return <svg {...common}><path d="M2 3.25h12v9.5H2zM4 5.5l2 2-2 2M7.5 10h4"/><path d="m11.5 2 2.5 2.5"/></svg>
  if (name === 'panel-maximize') return <svg {...common}><path d="M2.5 13.25h11M4.25 8.75 8 5l3.75 3.75"/></svg>
  if (name === 'panel-restore') return <svg {...common}><path d="M2.5 2.75h11M4.25 7.25 8 11l3.75-3.75"/></svg>
  if (name === 'panel-collapse') return <svg {...common}><path d="m3.5 5.75 4.5 4.5 4.5-4.5"/></svg>
  if (name === 'panel-expand') return <svg {...common}><path d="m3.5 10.25 4.5-4.5 4.5 4.5"/></svg>
  return <svg {...common} fill="currentColor" stroke="none"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg>
}
