import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  isQuickInputNavigationKey,
  QuickInputDialog,
  QuickOpenDialog,
  type QuickInputDialogProps,
  type QuickOpenDialogProps,
} from '../../src/client/QuickOpenDialog.tsx'
import {
  SearchView,
  highlightedPreview,
  visibleSearchMatches,
  visibleSearchTreeNodes,
  type SearchReplaceViewModel,
  type SearchViewProps,
} from '../../src/client/SearchView.tsx'
import { searchReplaceActionState } from '../../src/client/SearchReplacePanel.tsx'
import { isListNavigationKey, nextListIndex } from '../../src/client/list-navigation.ts'

function quickOpenProps(overrides: Partial<QuickOpenDialogProps> = {}): QuickOpenDialogProps {
  return {
    open: true,
    query: 'app',
    options: [
      { id: 'src/app.ts', path: 'src/app.ts', label: 'app.ts', detail: 'src' },
      { id: 'tests/app.spec.ts', path: 'tests/app.spec.ts' },
    ],
    searching: false,
    onQueryChange: vi.fn(),
    onOpen: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

function searchViewProps(overrides: Partial<SearchViewProps> = {}): SearchViewProps {
  return {
    query: 'needle',
    include: 'src/**',
    exclude: '**/dist/**',
    matchCase: true,
    wholeWord: false,
    useRegex: false,
    replacePreviewEligible: true,
    groups: [{
      path: 'src/app.ts',
      matches: [{
        id: 'src/app.ts:4:8',
        path: 'src/app.ts',
        line: 4,
        column: 8,
        preview: 'const needle = true',
        highlights: [{ start: 6, end: 12 }],
      }],
    }],
    searching: false,
    hasSearched: true,
    onQueryChange: vi.fn(),
    onIncludeChange: vi.fn(),
    onExcludeChange: vi.fn(),
    onMatchCaseChange: vi.fn(),
    onWholeWordChange: vi.fn(),
    onUseRegexChange: vi.fn(),
    onSearch: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  }
}

function searchReplaceModel(overrides: Partial<SearchReplaceViewModel> = {}): SearchReplaceViewModel {
  return {
    value: 'replacement',
    phase: 'idle',
    onValueChange: vi.fn(),
    onPreview: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('list navigation', () => {
  it('supports arrows, boundaries, Home/End and page movement', () => {
    expect(nextListIndex(3, 12, 'ArrowDown')).toBe(4)
    expect(nextListIndex(0, 12, 'ArrowUp')).toBe(0)
    expect(nextListIndex(3, 12, 'Home')).toBe(0)
    expect(nextListIndex(3, 12, 'End')).toBe(11)
    expect(nextListIndex(3, 12, 'PageDown', 5)).toBe(8)
    expect(nextListIndex(3, 12, 'PageUp', 5)).toBe(0)
    expect(nextListIndex(0, 0, 'ArrowDown')).toBe(-1)
    expect(isListNavigationKey('PageDown')).toBe(true)
    expect(isListNavigationKey('Enter')).toBe(false)
  })
})

describe('QuickOpenDialog', () => {
  it('renders a modal combobox/listbox with an active descendant and truncation status', () => {
    const html = renderToStaticMarkup(createElement(QuickOpenDialog, quickOpenProps({ truncated: true })))

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('role="option"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('results truncated')
    expect(html).toContain('Keep typing to narrow')
  })

  it('announces searching, empty and error states without inventing results', () => {
    const searching = renderToStaticMarkup(createElement(QuickOpenDialog, quickOpenProps({ searching: true, options: [] })))
    const empty = renderToStaticMarkup(createElement(QuickOpenDialog, quickOpenProps({ query: 'missing', options: [] })))
    const failed = renderToStaticMarkup(createElement(QuickOpenDialog, quickOpenProps({ error: 'Unavailable', options: [] })))

    expect(searching).toContain('Searching files')
    expect(empty).toContain('No matching files')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Unavailable')
    expect(renderToStaticMarkup(createElement(QuickOpenDialog, quickOpenProps({ open: false })))).toBe('')
  })
})

describe('QuickInputDialog', () => {
  function quickInputProps(
    overrides: Partial<QuickInputDialogProps> = {},
  ): QuickInputDialogProps {
    return {
      open: true,
      query: 'save',
      options: [
        { id: 'save', label: 'File: Save', detail: 'Save the active file', shortcut: 'Ctrl+S' },
        {
          id: 'close',
          label: 'File: Close Editor',
          disabled: true,
          disabledReason: 'No editor is active',
        },
      ],
      title: 'Command Palette',
      inputLabel: 'Search commands',
      placeholder: 'Type a command',
      listLabel: 'Available commands',
      status: '2 commands',
      hint: 'Commands are provided by the workbench.',
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    }
  }

  it('renders configurable picker copy, shortcut badges and disabled reasons', () => {
    const html = renderToStaticMarkup(createElement(QuickInputDialog, quickInputProps()))

    expect(html).toContain('Command Palette')
    expect(html).toContain('Search commands')
    expect(html).toContain('placeholder="Type a command"')
    expect(html).toContain('aria-label="Available commands"')
    expect(html).toContain('<kbd')
    expect(html).toContain('Ctrl+S')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('No editor is active')
    expect(html).toContain('Commands are provided by the workbench.')
  })

  it('supports a controlled active option without changing combobox text editing semantics', () => {
    const html = renderToStaticMarkup(createElement(QuickInputDialog, quickInputProps({ activeIndex: 1 })))

    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toMatch(/id="[^\"]+-1"[^>]*aria-selected="true"[^>]*aria-disabled="true"/)
    expect(html).toContain('aria-describedby=')
    expect(isQuickInputNavigationKey('ArrowDown')).toBe(true)
    expect(isQuickInputNavigationKey('PageUp')).toBe(true)
    expect(isQuickInputNavigationKey('Home')).toBe(false)
    expect(isQuickInputNavigationKey('End')).toBe(false)
  })
})

describe('SearchView', () => {
  it('renders accessible controls, grouped roving results and highlighted previews', () => {
    const html = renderToStaticMarkup(createElement(SearchView, searchViewProps()))

    expect(html).toContain('role="search"')
    expect(html).toContain('aria-label="Match case"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Files to include')
    expect(html).toContain('Files to exclude')
    expect(html.match(/role="tree"/g)).toHaveLength(1)
    expect(html).toContain('role="group"')
    expect(html).toContain('role="treeitem"')
    expect(html).toContain('aria-level="1"')
    expect(html).toContain('aria-level="2"')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('role="option"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('<mark>needle</mark>')
    expect(html).toContain('1 occurrence in 1 file')
  })

  it('projects roving navigation from visible groups without changing total group data', () => {
    const groups = [
      {
        path: 'src/\u7f16\u8f91\u5668.ts',
        matches: [
          { id: 'unicode:1', path: 'src/\u7f16\u8f91\u5668.ts', line: 1, column: 1, preview: 'one' },
          { id: 'unicode:2', path: 'src/\u7f16\u8f91\u5668.ts', line: 2, column: 1, preview: 'two' },
        ],
      },
      {
        path: 'tests/app.spec.ts',
        matches: [
          { id: 'test:1', path: 'tests/app.spec.ts', line: 4, column: 3, preview: 'three' },
        ],
      },
    ]

    expect(visibleSearchMatches(groups, new Set(['src/\u7f16\u8f91\u5668.ts'])).map(match => match.id))
      .toEqual(['test:1'])
    expect(visibleSearchMatches(groups, new Set(groups.map(group => group.path)))).toEqual([])
    expect(visibleSearchTreeNodes(groups, new Set(['src/\u7f16\u8f91\u5668.ts'])).map(node => [node.kind, node.path]))
      .toEqual([
        ['group', 'src/\u7f16\u8f91\u5668.ts'],
        ['group', 'tests/app.spec.ts'],
        ['match', 'tests/app.spec.ts'],
      ])
    expect(groups.map(group => group.matches.length)).toEqual([2, 1])
  })

  it('exposes Stop, empty/error announcements and truncated state', () => {
    const running = renderToStaticMarkup(createElement(SearchView, searchViewProps({ searching: true })))
    const empty = renderToStaticMarkup(createElement(SearchView, searchViewProps({ groups: [] })))
    const failed = renderToStaticMarkup(createElement(SearchView, searchViewProps({ groups: [], error: 'Invalid regex' })))
    const truncated = renderToStaticMarkup(createElement(SearchView, searchViewProps({ truncated: true })))

    expect(running).toContain('>Stop</button>')
    expect(running).toContain('>Clear results</button>')
    expect(running.match(/Clear results/g)).toHaveLength(1)
    expect(running).toContain('Searching workspace')
    expect(empty).toContain('No results found')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('Invalid regex')
    expect(truncated).toContain('Results are truncated')
  })

  it('enables Clear only for an active, completed, or failed search projection', () => {
    const idle = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      groups: [], hasSearched: false,
    })))
    const complete = renderToStaticMarkup(createElement(SearchView, searchViewProps()))
    const failedDraft = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      groups: [], hasSearched: false, error: 'Invalid glob',
    })))

    expect(idle).not.toContain('Clear results')
    expect(complete).toContain('>Clear results</button>')
    expect(failedDraft).toContain('>Clear results</button>')
  })

  it('explains when regex search omits unsaved buffers', () => {
    const html = renderToStaticMarkup(createElement(SearchView, searchViewProps({ dirtyBuffersOmitted: true })))
    expect(html).toContain('Regex or file-filter results omit unsaved buffers')
  })

  it('normalizes overlapping highlight ranges before rendering markup', () => {
    const html = renderToStaticMarkup(createElement('span', null, highlightedPreview('abcdef', [
      { start: 1, end: 3 },
      { start: 2, end: 5 },
      { start: 9, end: 10 },
    ])))

    expect(html).toBe('<span>a<mark>bcde</mark>f</span>')
  })

  it('keeps replace optional and requires an explicit preview before Apply', () => {
    const searchOnly = renderToStaticMarkup(createElement(SearchView, searchViewProps()))
    const replaceIdle = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      replace: searchReplaceModel(),
    })))

    expect(searchOnly).not.toContain('Workspace replace')
    expect(replaceIdle).toContain('aria-label="Show replace"')
    expect(replaceIdle).toContain('aria-expanded="false"')
    expect(replaceIdle).not.toContain('aria-label="Workspace replace"')
    expect(replaceIdle).not.toContain('>Preview</button>')
    expect(replaceIdle).not.toContain('>Apply</button>')
    expect(searchReplaceActionState('needle', false, { phase: 'idle' }, false).canPreview).toBe(false)
  })

  it('renders a ready before/after preview and enables only the exact preview token', () => {
    const preview = {
      token: 'preview-7',
      replacementCount: 1,
      fileCount: 1,
      groups: [{
        path: 'src/app.ts',
        changes: [{ id: 'change-1', line: 4, column: 7, before: 'needle', after: 'replacement' }],
      }],
    }
    const html = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      replace: searchReplaceModel({ phase: 'ready', preview }),
    })))

    expect(html).toContain('aria-label="Replacement preview"')
    expect(html).toContain('1 replacement in 1 file ready to apply')
    expect(html).toContain('<del>needle</del>')
    expect(html).toContain('<ins>replacement</ins>')
    expect(html).toContain('>Apply</button>')

    expect(searchReplaceActionState('needle', false, { phase: 'idle' }).canApply).toBe(false)
    expect(searchReplaceActionState('needle', false, {
      phase: 'ready', preview: { ...preview, token: '' },
    }).canApply).toBe(false)
    expect(searchReplaceActionState('needle', false, { phase: 'ready', preview }).canApply).toBe(true)
    expect(searchReplaceActionState('needle', false, { phase: 'previewing' })).toEqual({
      canPreview: false, canApply: false, canCancel: true,
    })
  })

  it('announces replacement preview errors without presenting stale changes as applicable', () => {
    const html = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      replace: searchReplaceModel({ phase: 'idle', error: 'Preview became stale.' }),
    })))

    expect(html).toContain('role="alert"')
    expect(html).toContain('Preview became stale.')
    expect(searchReplaceActionState('needle', false, {
      phase: 'ready',
      error: 'Preview became stale.',
      preview: { token: 'old', replacementCount: 2, fileCount: 1, groups: [] },
    }).canApply).toBe(false)
  })

  it('describes completed application as unsaved editor-buffer changes', () => {
    const html = renderToStaticMarkup(createElement(SearchView, searchViewProps({
      replace: searchReplaceModel({
        phase: 'complete',
        preview: { token: 'applied', replacementCount: 2, fileCount: 1, groups: [] },
      }),
    })))

    expect(html).toContain('Applied 2 replacements to editor buffers')
    expect(html).toContain('The changes are unsaved')
    expect(html).not.toContain('>Apply</button>')
  })
})
