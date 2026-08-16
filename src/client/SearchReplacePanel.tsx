import { useId } from 'react'
import { useIdeI18n } from './i18n.tsx'
import css from './ide.module.css'

export type SearchReplacePhase = 'idle' | 'previewing' | 'ready' | 'applying' | 'complete' | 'error'

export interface WorkspaceReplaceChangeView {
  readonly id: string
  readonly line: number
  readonly column: number
  readonly before: string
  readonly after: string
}

export interface WorkspaceReplaceFileGroupView {
  readonly path: string
  readonly changes: readonly WorkspaceReplaceChangeView[]
}

export interface WorkspaceReplacePreviewView {
  /** Exact, opaque preview identity. The controller must reject stale tokens. */
  readonly token: string
  readonly groups: readonly WorkspaceReplaceFileGroupView[]
  readonly replacementCount: number
  readonly fileCount: number
}

export interface SearchReplaceViewModel {
  readonly value: string
  readonly phase: SearchReplacePhase
  readonly preview?: WorkspaceReplacePreviewView
  readonly error?: string
  /** Changing the draft must invalidate any ready preview in the owner. */
  readonly onValueChange: (value: string) => void
  readonly onPreview: () => void
  readonly onApply: (previewToken: string) => void
  readonly onCancel: () => void
}

export interface SearchReplaceActionState {
  readonly canPreview: boolean
  readonly canApply: boolean
  readonly canCancel: boolean
}

export function searchReplaceActionState(
  query: string,
  searching: boolean,
  replace: Pick<SearchReplaceViewModel, 'phase' | 'preview' | 'error'>,
  previewEligible = false,
): SearchReplaceActionState {
  const busy = replace.phase === 'previewing' || replace.phase === 'applying'
  const exactPreviewReady = replace.phase === 'ready'
    && replace.error === undefined
    && replace.preview !== undefined
    && replace.preview.token.length > 0
    && replace.preview.replacementCount > 0
  return {
    canPreview: previewEligible && query.trim().length > 0 && !searching && !busy,
    canApply: exactPreviewReady,
    canCancel: busy || replace.phase === 'ready' && replace.preview !== undefined,
  }
}

export interface SearchReplacePanelProps {
  readonly query: string
  readonly searching: boolean
  readonly previewEligible: boolean
  readonly replace: SearchReplaceViewModel
}

export function SearchReplacePanel({ query, searching, previewEligible, replace }: SearchReplacePanelProps) {
  const { t } = useIdeI18n()
  const hintId = useId()
  const previewHeadingPrefix = useId()
  const actions = searchReplaceActionState(query, searching, replace, previewEligible)
  const preview = replace.preview
  const replacementCount = preview?.replacementCount ?? 0
  const fileCount = preview?.fileCount ?? 0
  const replacements = t(replacementCount === 1 ? 'oneReplacement' : 'manyReplacements', { count: replacementCount })
  const files = t(fileCount === 1 ? 'oneFile' : 'manyFiles', { count: fileCount })
  const status = replace.error !== undefined
    ? ''
    : replace.phase === 'previewing'
      ? t('buildingReplacementPreview')
      : replace.phase === 'applying'
        ? t('applyingReplacements', { replacements })
        : replace.phase === 'complete'
          ? t('appliedReplacements', { replacements })
        : replace.phase === 'ready'
          ? replacementCount === 0
            ? t('replacementPreviewEmpty')
            : t('replacementPreviewReady', { replacements, files })
          : ''

  const showSafetyHint = replace.value.length > 0 || replace.phase !== 'idle'
  return (
    <section className={css.searchReplacePanel} aria-label={t('workspaceReplace')}>
      <form
        className={css.searchReplaceForm}
        onSubmit={event => {
          event.preventDefault()
          if (actions.canPreview) replace.onPreview()
        }}
      >
        <label className={css.searchReplaceField}>
          <span className={css.visuallyHidden}>{t('replaceWith')}</span>
          <input
            value={replace.value}
            onChange={event => replace.onValueChange(event.currentTarget.value)}
            placeholder={t('replaceWith')}
            aria-describedby={showSafetyHint ? hintId : undefined}
            disabled={replace.phase === 'previewing' || replace.phase === 'applying'}
            spellCheck={false}
          />
        </label>
        <div className={css.searchReplaceActions} aria-label={t('replaceActions')}>
          <button type="submit" disabled={!actions.canPreview}>
            {replace.phase === 'ready' ? t('refreshReplacementPreview') : t('previewReplacement')}
          </button>
          {actions.canApply && preview !== undefined ? (
            <button
              type="button"
              className={css.searchReplaceApply}
              onClick={() => { replace.onApply(preview.token) }}
            >
              {t('applyReplacement')}
            </button>
          ) : null}
          {actions.canCancel ? (
            <button type="button" onClick={replace.onCancel}>{t('cancelReplacement')}</button>
          ) : null}
        </div>
      </form>

      {showSafetyHint ? <p id={hintId} className={css.searchReplaceHint}>
        {t('replacementSafetyHint')}
      </p> : null}
      {status.length > 0
        ? <div className={css.searchReplaceStatus} aria-live="polite" aria-atomic="true">{status}</div>
        : null}
      {replace.error !== undefined ? <div className={css.searchError} role="alert">{replace.error}</div> : null}

      {preview !== undefined && (replace.phase === 'ready' || replace.phase === 'applying') ? (
        <div className={css.searchReplacePreview} role="region" aria-label={t('replacementPreview')}>
          {preview.groups.map((group, groupIndex) => {
            const headingId = `${previewHeadingPrefix}-file-${String(groupIndex)}`
            return (
              <section key={group.path} className={css.searchReplaceGroup} aria-labelledby={headingId}>
                <div id={headingId} className={css.searchReplaceGroupHeader} title={group.path}>
                  <code>{group.path}</code>
                  <span>{t(group.changes.length === 1 ? 'oneChange' : 'manyChanges', { count: group.changes.length })}</span>
                </div>
                <ol className={css.searchReplaceChanges}>
                  {group.changes.map(change => (
                    <li key={change.id} className={css.searchReplaceChange}>
                      <span className={css.searchReplaceLocation}>{change.line}:{change.column}</span>
                      <div className={css.searchReplaceBefore}>
                        <span className={css.visuallyHidden}>{t('beforeReplacement')}: </span>
                        <del>{change.before}</del>
                      </div>
                      <div className={css.searchReplaceAfter}>
                        <span className={css.visuallyHidden}>{t('afterReplacement')}: </span>
                        <ins>{change.after}</ins>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
