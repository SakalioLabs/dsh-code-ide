import { describe, expect, it } from 'vitest'

import { explorerFileIconKind } from '../../src/client/icons.tsx'

describe('Explorer Seti file icon classification', () => {
  it('recognizes common languages and exact filenames before generic suffixes', () => {
    expect([
      explorerFileIconKind('lib.rs', 'file'),
      explorerFileIconKind('view.jsx', 'file'),
      explorerFileIconKind('view.tsx', 'file'),
      explorerFileIconKind('theme.scss', 'file'),
      explorerFileIconKind('Dockerfile', 'file'),
      explorerFileIconKind('.gitignore', 'file'),
      explorerFileIconKind('tsconfig.json', 'file'),
      explorerFileIconKind('pnpm-lock.yaml', 'file'),
      explorerFileIconKind('preview.png', 'file'),
    ]).toEqual([
      'rust',
      'javascriptreact',
      'typescriptreact',
      'scss',
      'docker',
      'git',
      'config',
      'lock',
      'image',
    ])
  })

  it('keeps directories and unknown files on safe fallback icons', () => {
    expect(explorerFileIconKind('src', 'directory')).toBe('folder')
    expect(explorerFileIconKind('LICENSE', 'file')).toBe('file')
    expect(explorerFileIconKind('socket', 'other')).toBe('file')
  })
})
