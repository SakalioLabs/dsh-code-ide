import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useIdeI18n } from './i18n.tsx'
import { isListNavigationKey, nextListIndex } from './list-navigation.ts'
import { SearchReplacePanel, type SearchReplaceViewModel } from './SearchReplacePanel.tsx'
import css from './ide.module.css'

export type {
  SearchReplacePhase,
  SearchReplaceViewModel,
  WorkspaceReplaceChangeView,
  WorkspaceReplaceFileGroupView,
  WorkspaceReplacePreviewView,
} from './SearchReplacePanel.tsx'

export interface SearchTextRange {
  start: number
  end: number
}

export interface WorkspaceSearchMatchView {
  id: string
  path: string
  line: number
  column: number
  preview: string
  highlights?: readonly SearchTextRange[]
}

export interface WorkspaceSearchFileGroup {
  path: string
  matches: readonly WorkspaceSearchMatchView[]
  /** Total ranges in the matching lines, not merely the number of rows. */
  occurrenceCount?: number
}

/** Preserve result order while excluding every match owned by a collapsed file group. */
export function visibleSearchMatches(
  groups: readonly WorkspaceSearchFileGroup[],
  collapsedPaths: ReadonlySet<string>,
): readonly WorkspaceSearchMatchView[] {
  return groups.flatMap(group => collapsedPaths.has(group.path) ? [] : group.matches)
}

export type WorkspaceSearchTreeNode =
  | { readonly kind: 'group'; readonly id: string; readonly path: string }
  | {
      readonly kind: 'match'
      readonly id: string
      readonly parentId: string
      readonly path: string
      readonly match: WorkspaceSearchMatchView
    }

function searchGroupNodeId(path: string): string {
  return `group\u0000${path}`
}

/** Project the exact visible tree order used by roving keyboard focus. */
export function visibleSearchTreeNodes(
  groups: readonly WorkspaceSearchFileGroup[],
  collapsedPaths: ReadonlySet<string>,
): readonly WorkspaceSearchTreeNode[] {
  return groups.flatMap(group => {
    const parentId = searchGroupNodeId(group.path)
    const header: WorkspaceSearchTreeNode = { kind: 'group', id: parentId, path: group.path }
    if (collapsedPaths.has(group.path)) return [header]
    return [
      header,
      ...group.matches.map((match): WorkspaceSearchTreeNode => ({
        kind: 'match',
        id: `match\u0000${group.path}\u0000${match.id}`,
        parentId,
        path: group.path,
        match,
      })),
    ]
  })
}

export interface SearchViewProps {
  /** Monotonic request used by workbench shortcuts to focus the query field. */
  focusRequest?: number
  query: string
  include: string
  exclude: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
  groups: readonly WorkspaceSearchFileGroup[]
  matchCount?: number
  fileCount?: number
  searching: boolean
  cancelled?: boolean
  hasSearched: boolean
  truncated?: boolean
  dirtyBuffersOmitted?: boolean
  error?: string
  /** True only while the visible controls still describe one complete safe literal result set. */
  replacePreviewEligible?: boolean
  /** Optional explicit preview/apply replacement workflow. */
  replace?: SearchReplaceViewModel
  onQueryChange: (query: string) => void
  onIncludeChange: (include: string) => void
  onExcludeChange: (exclude: string) => void
  onMatchCaseChange: (enabled: boolean) => void
  onWholeWordChange: (enabled: boolean) => void
  onUseRegexChange: (enabled: boolean) => void
  onSearch: () => void
  onStop: () => void
  onClear: () => void
  onOpen: (match: WorkspaceSearchMatchView) => void
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

function dirname(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

export function highlightedPreview(text: string, ranges: readonly SearchTextRange[] = []): ReactNode {
  const normalized: SearchTextRange[] = []
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const start = Math.max(0, Math.min(text.length, Math.floor(range.start)))
    const end = Math.max(start, Math.min(text.length, Math.floor(range.end)))
    if (start === end) continue
    const previous = normalized.at(-1)
    if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end)
    else normalized.push({ start, end })
  }

  if (normalized.length === 0) return text

  const output: ReactNode[] = []
  let offset = 0
  for (const [index, range] of normalized.entries()) {
    if (range.start > offset) output.push(text.slice(offset, range.start))
    output.push(<mark key={`${range.start}:${range.end}:${index}`}>{text.slice(range.start, range.end)}</mark>)
    offset = range.end
  }
  if (offset < text.length) output.push(text.slice(offset))
  return output
}

export function SearchView({
  focusRequest,
  query,
  include,
  exclude,
  matchCase,
  wholeWord,
  useRegex,
  groups,
  matchCount: reportedMatchCount,
  fileCount: reportedFileCount,
  searching,
  cancelled = false,
  hasSearched,
  truncated = false,
  dirtyBuffersOmitted = false,
  error,
  replacePreviewEligible = false,
  replace,
  onQueryChange,
  onIncludeChange,
  onExcludeChange,
  onMatchCaseChange,
  onWholeWordChange,
  onUseRegexChange,
  onSearch,
  onStop,
  onClear,
  onOpen,
}: SearchViewProps) {
  const { t } = useIdeI18n()
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const [filtersExpanded, setFiltersExpanded] = useState(() => include.trim().length > 0 || exclude.trim().length > 0)
  const [replaceExpanded, setReplaceExpanded] = useState(() => replace !== undefined
    && (replace.phase !== 'idle' || replace.preview !== undefined || replace.error !== undefined))
  const allMatches = useMemo(() => groups.flatMap(group => group.matches), [groups])
  const treeNodes = useMemo(
    () => visibleSearchTreeNodes(groups, collapsedPaths),
    [collapsedPaths, groups],
  )
  const [activeNodeId, setActiveNodeId] = useState<string>()
  const treeNodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const queryInputRef = useRef<HTMLInputElement>(null)
  const groupPrefix = useId()
  const filtersId = useId()
  const replaceId = useId()
  const treeNodeIndices = useMemo(
    () => new Map(treeNodes.map((node, index) => [node.id, index])),
    [treeNodes],
  )
  const effectiveActiveNodeId = activeNodeId !== undefined && treeNodeIndices.has(activeNodeId)
    ? activeNodeId
    : treeNodes[0]?.id
  const treeNodeSignature = treeNodes.map(node => node.id).join('\u0000')
  const groupPathSignature = groups.map(group => group.path).join('\u0000')
  const matchCount = reportedMatchCount ?? allMatches.length
  const fileCount = reportedFileCount ?? groups.length
  const canClear = searching || hasSearched || error !== undefined

  useEffect(() => {
    const currentPaths = new Set(groups.map(group => group.path))
    setCollapsedPaths(current => {
      if ([...current].every(path => currentPaths.has(path))) return current
      return new Set([...current].filter(path => currentPaths.has(path)))
    })
  }, [groupPathSignature])

  useEffect(() => {
    if (treeNodes.length === 0) {
      setActiveNodeId(undefined)
      return
    }
    setActiveNodeId(current => treeNodes.some(node => node.id === current) ? current : treeNodes[0]?.id)
  }, [treeNodeSignature])

  useEffect(() => {
    if (focusRequest !== undefined) queryInputRef.current?.focus()
  }, [focusRequest])

  useEffect(() => {
    if (include.trim().length > 0 || exclude.trim().length > 0) setFiltersExpanded(true)
  }, [exclude, include])

  useEffect(() => {
    if (replace !== undefined
      && (replace.phase !== 'idle' || replace.preview !== undefined || replace.error !== undefined)) {
      setReplaceExpanded(true)
    }
  }, [replace?.error, replace?.phase, replace?.preview])

  const focusTreeNode = (index: number): void => {
    const node = treeNodes[index]
    if (node === undefined) return
    setActiveNodeId(node.id)
    window.requestAnimationFrame(() => treeNodeRefs.current.get(node.id)?.focus())
  }

  const status = error !== undefined
    ? ''
    : searching
      ? t('searchingWorkspaceResults', {
          results: t(matchCount === 1 ? 'oneResult' : 'manyResults', { count: matchCount }),
        })
      : cancelled
        ? t('workspaceSearchCancelled')
      : !hasSearched
        ? t('enterWorkspaceSearchQuery')
        : matchCount === 0
          ? t('noWorkspaceSearchResults')
          : t('workspaceSearchSummary', {
              occurrences: t(matchCount === 1 ? 'oneOccurrence' : 'manyOccurrences', { count: matchCount }),
              files: t(fileCount === 1 ? 'oneFile' : 'manyFiles', { count: fileCount }),
              truncated: truncated ? t('searchResultsTruncatedSuffix') : '',
            })

  return (
    <section className={css.searchView} role="search" aria-label={t('workspaceSearch')}>
      <form
        className={css.searchForm}
        onSubmit={event => {
          event.preventDefault()
          if (!searching && query.trim().length > 0) onSearch()
        }}
      >
        <div className={css.searchQueryRow}>
          {replace === undefined ? null : (
            <button
              type="button"
              className={css.searchReplaceToggle}
              aria-label={t(replaceExpanded ? 'hideWorkspaceReplace' : 'showWorkspaceReplace')}
              title={t(replaceExpanded ? 'hideWorkspaceReplace' : 'showWorkspaceReplace')}
              aria-expanded={replaceExpanded}
              aria-controls={replaceId}
              onClick={() => { setReplaceExpanded(current => !current) }}
            >
              <span aria-hidden="true">{replaceExpanded ? '⌄' : '›'}</span>
            </button>
          )}
          <label className={css.searchQueryField}>
            <span className={css.visuallyHidden}>{t('searchQuery')}</span>
            <input
              ref={queryInputRef}
              data-workbench-focus="search-query"
              value={query}
              onChange={event => onQueryChange(event.currentTarget.value)}
              onKeyDown={event => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowDown' && treeNodes.length > 0) {
                  event.preventDefault()
                  focusTreeNode(0)
                }
              }}
              placeholder={t('searchCode')}
              aria-keyshortcuts="Control+Shift+F Meta+Shift+F"
              spellCheck={false}
            />
          </label>
          <div className={css.searchToggles} aria-label={t('searchOptions')}>
            <button type="button" aria-label={t('matchCase')} aria-pressed={matchCase} title={t('matchCase')} onClick={() => onMatchCaseChange(!matchCase)}>Aa</button>
            <button type="button" aria-label={t('matchWholeWord')} aria-pressed={wholeWord} title={t('matchWholeWord')} onClick={() => onWholeWordChange(!wholeWord)}>ab</button>
            <button type="button" aria-label={t('useRegularExpression')} aria-pressed={useRegex} title={t('useRegularExpression')} onClick={() => onUseRegexChange(!useRegex)}>.*</button>
          </div>
          <button
            type="button"
            className={css.searchDetailsToggle}
            aria-label={t('searchDetails')}
            title={t('searchDetails')}
            aria-expanded={filtersExpanded}
            aria-controls={filtersId}
            data-has-value={include.trim().length > 0 || exclude.trim().length > 0 || undefined}
            onClick={() => { setFiltersExpanded(current => !current) }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M2 4h5m3 0h4M2 8h2m3 0h7M2 12h7m3 0h2" />
              <circle cx="8.5" cy="4" r="1.5" />
              <circle cx="5.5" cy="8" r="1.5" />
              <circle cx="10.5" cy="12" r="1.5" />
            </svg>
          </button>
          {searching ? <button type="button" className={css.searchStop} onClick={onStop}>{t('stopSearch')}</button> : null}
        </div>

        {filtersExpanded ? (
          <div id={filtersId} className={css.searchDetailsFields}>
            <label className={css.searchPatternField}>
              <span>{t('filesToInclude')}</span>
              <input value={include} onChange={event => onIncludeChange(event.currentTarget.value)} placeholder={t('filesToIncludePlaceholder')} spellCheck={false} />
            </label>
            <label className={css.searchPatternField}>
              <span>{t('filesToExclude')}</span>
              <input value={exclude} onChange={event => onExcludeChange(event.currentTarget.value)} placeholder={t('filesToExcludePlaceholder')} spellCheck={false} />
            </label>
          </div>
        ) : null}
      </form>

      {replace === undefined || !replaceExpanded ? null : (
        <div id={replaceId}>
          <SearchReplacePanel
            query={query}
            searching={searching}
            previewEligible={replacePreviewEligible}
            replace={replace}
          />
        </div>
      )}

      <div className={css.searchResultsHeader}>
        <div className={css.searchStatus} aria-live="polite" aria-atomic="true">{status}</div>
        {canClear ? <button type="button" onClick={onClear}>{t('clearSearchResults')}</button> : null}
      </div>
      {error !== undefined ? <div className={css.searchError} role="alert">{error}</div> : null}
      {dirtyBuffersOmitted && error === undefined
        ? <div className={css.searchHint}>{t('dirtyBuffersOmittedFromSearch')}</div>
        : truncated && error === undefined
          ? <div className={css.searchHint}>{t('workspaceSearchTruncatedHint')}</div>
          : null}

      <div className={css.searchResults} role="tree" aria-label={t('workspaceSearchResults')}>
        {groups.map((group, groupIndex) => {
          const headingId = `${groupPrefix}-group-${groupIndex}`
          const matchesId = `${groupPrefix}-matches-${groupIndex}`
          const groupNodeId = searchGroupNodeId(group.path)
          const groupIndexInTree = treeNodeIndices.get(groupNodeId) ?? -1
          const groupActive = effectiveActiveNodeId === groupNodeId
          const expanded = !collapsedPaths.has(group.path)
          return (
            <section key={group.path} className={css.searchGroup} role="presentation">
              <div className={css.searchGroupHeader} title={group.path}>
                <button
                  ref={element => {
                    if (element === null) treeNodeRefs.current.delete(groupNodeId)
                    else treeNodeRefs.current.set(groupNodeId, element)
                  }}
                  id={headingId}
                  type="button"
                  role="treeitem"
                  aria-level={1}
                  aria-selected={groupActive}
                  className={css.searchGroupDisclosure}
                  aria-expanded={expanded}
                  aria-controls={matchesId}
                  tabIndex={groupActive ? 0 : -1}
                  onFocus={() => setActiveNodeId(groupNodeId)}
                  onClick={() => {
                    setActiveNodeId(groupNodeId)
                    setCollapsedPaths(current => {
                      const next = new Set(current)
                      if (next.has(group.path)) next.delete(group.path)
                      else next.add(group.path)
                      return next
                    })
                  }}
                  onKeyDown={event => {
                    if (event.key === 'ArrowRight') {
                      event.preventDefault()
                      if (!expanded) {
                        setCollapsedPaths(current => {
                          const next = new Set(current)
                          next.delete(group.path)
                          return next
                        })
                      } else if (treeNodes[groupIndexInTree + 1]?.kind === 'match') {
                        focusTreeNode(groupIndexInTree + 1)
                      }
                      return
                    }
                    if (event.key === 'ArrowLeft') {
                      if (!expanded) return
                      event.preventDefault()
                      setCollapsedPaths(current => new Set([...current].concat(group.path)))
                      return
                    }
                    if (!isListNavigationKey(event.key)) return
                    event.preventDefault()
                    focusTreeNode(nextListIndex(groupIndexInTree, treeNodes.length, event.key))
                  }}
                >
                  <span className={css.searchGroupChevron} aria-hidden="true">{expanded ? '\u25be' : '\u25b8'}</span>
                  <strong>{basename(group.path)}</strong>
                  <span className={css.searchGroupDirectory}>{dirname(group.path)}</span>
                  <span>{group.occurrenceCount ?? group.matches.length}</span>
                </button>
              </div>
              <div id={matchesId} role="group" aria-labelledby={headingId} hidden={!expanded}>
              {expanded && group.matches.map(match => {
                const nodeId = `match\u0000${group.path}\u0000${match.id}`
                const index = treeNodeIndices.get(nodeId) ?? -1
                const selected = nodeId === effectiveActiveNodeId
                return (
                  <button
                    key={match.id}
                    ref={element => {
                      if (element === null) treeNodeRefs.current.delete(nodeId)
                      else treeNodeRefs.current.set(nodeId, element)
                    }}
                    type="button"
                    role="treeitem"
                    aria-level={2}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className={selected ? css.searchResultActive : css.searchResult}
                    title={`${match.path}:${match.line}:${match.column}`}
                    onFocus={() => setActiveNodeId(nodeId)}
                    onClick={() => onOpen(match)}
                    onKeyDown={event => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowUp') {
                        event.preventDefault()
                        queryInputRef.current?.focus()
                        return
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        onOpen(match)
                        return
                      }
                      if (event.key === ' ') {
                        event.preventDefault()
                        return
                      }
                      if (event.key === 'ArrowLeft') {
                        event.preventDefault()
                        focusTreeNode(treeNodeIndices.get(searchGroupNodeId(group.path)) ?? -1)
                        return
                      }
                      if (!isListNavigationKey(event.key)) return
                      event.preventDefault()
                      focusTreeNode(nextListIndex(index, treeNodes.length, event.key))
                    }}
                  >
                    <span className={css.searchResultLocation}>{match.line}:{match.column}</span>
                    <span className={css.searchResultPreview}>{highlightedPreview(match.preview, match.highlights)}</span>
                  </button>
                )
              })}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}
