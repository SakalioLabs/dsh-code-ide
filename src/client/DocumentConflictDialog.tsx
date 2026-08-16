import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  DocumentConflictRelation,
  DocumentConflictSnapshot,
} from './documents/conflict.ts'
import {
  validateDocumentConflictVariant,
  type DocumentConflictVariantError,
} from './documents/session.ts'
import css from './ide.module.css'

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

export interface DocumentConflictDialogProps {
  readonly snapshot: DocumentConflictSnapshot
  readonly onAcceptRemote: () => void
  readonly onKeepLocal: () => void
  readonly onApplyMerged: (content: string) => void
  readonly onRetry: () => void
  readonly onCancel: () => void
  /** Acknowledge only after the requested static summary owns focus. */
  readonly onPresentationApplied?: (requestId: number) => void
}

export interface DocumentConflictDraft {
  readonly requestId: number
  readonly content: string
}

export interface DocumentConflictPresentationRequest {
  readonly requestId: number
  readonly target: 'summary'
}

export type DocumentConflictDialogKeyboardAction =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'trap'; readonly backwards: boolean }
  | { readonly kind: 'none' }

export function documentConflictDialogKeyboardAction(
  key: string,
  shiftKey = false,
  isComposing = false,
  defaultPrevented = false,
): DocumentConflictDialogKeyboardAction {
  if (defaultPrevented || isComposing) return { kind: 'none' }
  if (key === 'Escape') return { kind: 'cancel' }
  if (key === 'Tab') return { kind: 'trap', backwards: shiftKey }
  return { kind: 'none' }
}

/** Pure circular focus calculation used when Tab reaches a modal boundary. */
export function nextDocumentConflictFocusIndex(
  currentIndex: number,
  focusableCount: number,
  backwards: boolean,
): number {
  if (focusableCount <= 0) return -1
  if (currentIndex < 0 || currentIndex >= focusableCount) return backwards ? focusableCount - 1 : 0
  return backwards
    ? (currentIndex - 1 + focusableCount) % focusableCount
    : (currentIndex + 1) % focusableCount
}

/** Preserve a local merge draft across projection refreshes of the same exact intent. */
export function documentConflictDraft(
  requestId: number | undefined,
  local: string,
  current: DocumentConflictDraft | undefined,
): DocumentConflictDraft | undefined {
  if (requestId === undefined) return undefined
  return current?.requestId === requestId ? current : { requestId, content: local }
}

export function documentConflictVariantMessage(
  error: DocumentConflictVariantError | undefined,
): string | undefined {
  switch (error) {
    case undefined: return undefined
    case 'nul': return 'Merge result contains a NUL character.'
    case 'invalid-unicode': return 'Merge result contains an invalid Unicode surrogate.'
    case 'too-large': return 'Merge result exceeds the 1 MiB UTF-8 limit.'
  }
}

export function documentConflictRelationMessage(relation: DocumentConflictRelation | undefined): string {
  switch (relation) {
    case 'remote-equals-base': return 'Remote still matches Base; only Local has changed.'
    case 'local-equals-base': return 'Local still matches Base; only Remote has changed.'
    case 'local-equals-remote': return 'Local and Remote already contain the same text.'
    case 'diverged': return 'Local and Remote both differ from Base. Review the merge result.'
    case 'base-unavailable': return 'Base is unavailable. Compare Local and Remote directly.'
    case undefined: return 'Reading the current Remote text for comparison.'
  }
}

export function documentConflictPresentationRequest(
  snapshot: DocumentConflictSnapshot,
): DocumentConflictPresentationRequest | undefined {
  if (snapshot.phase === 'idle' || !('presentationRequest' in snapshot)) return undefined
  const request = snapshot.presentationRequest
  if (typeof request !== 'object' || request === null) return undefined
  const candidate = request as Partial<DocumentConflictPresentationRequest>
  return Number.isSafeInteger(candidate.requestId) && candidate.requestId !== undefined
    && candidate.requestId >= 0 && candidate.target === 'summary'
    ? { requestId: candidate.requestId, target: candidate.target }
    : undefined
}

function basename(path: string): string {
  return path.replace(/[/\\]+$/u, '').split(/[/\\]/u).pop() ?? path
}

function focusableDialogElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => {
    if (element.tabIndex < 0 || element.hidden
      || element.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  })
}

function remoteFor(snapshot: DocumentConflictSnapshot): { readonly content: string; readonly version: string } | undefined {
  return snapshot.phase === 'ready' || snapshot.phase === 'applying'
    ? snapshot.remote
    : snapshot.phase === 'error' ? snapshot.remote : undefined
}

function relationFor(snapshot: DocumentConflictSnapshot): DocumentConflictRelation | undefined {
  return snapshot.phase === 'ready' || snapshot.phase === 'applying'
    ? snapshot.relation
    : snapshot.phase === 'error' ? snapshot.relation : undefined
}

function statusFor(snapshot: DocumentConflictSnapshot): string {
  if (snapshot.phase === 'comparing') return 'Reading Remote text…'
  if (snapshot.phase === 'applying') return 'Checking Remote again before applying to the editor…'
  if (snapshot.phase === 'error') {
    return snapshot.operation === 'compare'
      ? 'Remote could not be read for comparison.'
      : 'Remote could not be verified. The merge result remains available.'
  }
  return documentConflictRelationMessage(snapshot.phase === 'ready' ? snapshot.relation : undefined)
}

/** Accessible, presentation-only three-way conflict review. It never writes the Host. */
export function DocumentConflictDialog({
  snapshot,
  onAcceptRemote,
  onKeepLocal,
  onApplyMerged,
  onRetry,
  onCancel,
  onPresentationApplied,
}: DocumentConflictDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const focusedIntent = useRef<number>()
  const acknowledgedPresentation = useRef<number>()
  const presentationApplied = useRef(onPresentationApplied)
  const [storedDraft, setStoredDraft] = useState<DocumentConflictDraft>()
  const titleId = useId()
  const summaryId = useId()
  const pathId = useId()
  const statusId = useId()
  const errorId = useId()
  const resultErrorId = useId()
  const applyNoteId = useId()
  const baseTitleId = useId()
  const localTitleId = useId()
  const remoteTitleId = useId()
  const resultTitleId = useId()
  presentationApplied.current = onPresentationApplied

  const requestId = snapshot.phase === 'idle' ? undefined : snapshot.intent.requestId
  const local = snapshot.phase === 'idle' ? '' : snapshot.local
  const draft = documentConflictDraft(requestId, local, storedDraft)
  const result = draft?.content ?? ''
  const resultError = documentConflictVariantMessage(validateDocumentConflictVariant(result))
  const remote = remoteFor(snapshot)
  const relation = relationFor(snapshot)
  const presentationRequest = documentConflictPresentationRequest(snapshot)

  useClientLayoutEffect(() => {
    if (requestId === undefined) {
      focusedIntent.current = undefined
      acknowledgedPresentation.current = undefined
      return
    }
    const needsInitialFocus = focusedIntent.current !== requestId
    const needsPresentation = presentationRequest !== undefined
      && acknowledgedPresentation.current !== presentationRequest.requestId
    if (!needsInitialFocus && !needsPresentation) return
    const target = summaryRef.current
    if (target === null) return
    target.focus({ preventScroll: true })
    if (document.activeElement !== target) return
    focusedIntent.current = requestId
    if (presentationRequest !== undefined) {
      acknowledgedPresentation.current = presentationRequest.requestId
      presentationApplied.current?.(presentationRequest.requestId)
    }
  }, [presentationRequest?.requestId, requestId])

  useClientLayoutEffect(() => {
    if (snapshot.phase !== 'applying') return
    const dialog = dialogRef.current
    const active = document.activeElement
    if (dialog === null || !(active instanceof HTMLElement)) return
    if (!dialog.contains(active) || active.matches(':disabled')) {
      cancelRef.current?.focus({ preventScroll: true })
    }
  }, [snapshot.phase])

  if (snapshot.phase === 'idle') return null

  const name = basename(snapshot.intent.path)
  const applying = snapshot.phase === 'applying'
  const ready = snapshot.phase === 'ready'
  const draftEditable = ready || snapshot.phase === 'error' && snapshot.operation === 'verify'
    && remote !== undefined
  const describedBy = [summaryId, pathId, statusId, applyNoteId,
    snapshot.phase === 'error' ? errorId : undefined,
    resultError === undefined ? undefined : resultErrorId,
  ].filter((id): id is string => id !== undefined).join(' ')

  const handleDialogKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const action = documentConflictDialogKeyboardAction(
      event.key,
      event.shiftKey,
      event.nativeEvent.isComposing || event.keyCode === 229,
      event.defaultPrevented,
    )
    if (action.kind === 'none') return
    event.stopPropagation()
    if (action.kind === 'cancel') {
      event.preventDefault()
      onCancel()
      return
    }

    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = focusableDialogElements(dialog)
    const currentIndex = document.activeElement instanceof HTMLElement
      ? focusable.indexOf(document.activeElement)
      : -1
    const atBoundary = currentIndex < 0
      || action.backwards && currentIndex === 0
      || !action.backwards && currentIndex === focusable.length - 1
    if (!atBoundary) return
    event.preventDefault()
    const nextIndex = nextDocumentConflictFocusIndex(currentIndex, focusable.length, action.backwards)
    if (nextIndex < 0) dialog.focus({ preventScroll: true })
    else focusable[nextIndex]?.focus()
  }

  const dialog = (
    <div
      className={css.documentConflictBackdrop}
      onMouseDown={event => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className={css.documentConflictDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={snapshot.phase === 'comparing' || applying || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKey}
      >
        <header className={css.documentConflictHeader}>
          <div ref={summaryRef} className={css.documentConflictSummary} tabIndex={-1} data-initial-focus="true">
            <h2 id={titleId}>Resolve conflict: {name}</h2>
            <p id={summaryId}>Compare Base, Local, and Remote, then choose what the editor should contain.</p>
            <code id={pathId} title={snapshot.intent.path}>{snapshot.intent.path}</code>
          </div>
          <button type="button" aria-label="Close conflict review" onClick={onCancel}>Close</button>
        </header>

        <div id={statusId} className={css.documentConflictStatus} role="status" aria-live="polite" aria-atomic="true">
          {statusFor(snapshot)}
        </div>
        {snapshot.phase === 'error' ? (
          <div id={errorId} className={css.documentConflictError} role="alert">
            {snapshot.error.message}
            <button type="button" onClick={onRetry}>Retry Remote Read</button>
          </div>
        ) : null}

        <div className={css.documentConflictBody}>
          <div className={css.documentConflictVariants}>
            <section className={css.documentConflictVariant} role="region" aria-labelledby={baseTitleId}>
              <div className={css.documentConflictVariantHeader}>
                <h3 id={baseTitleId}>Base</h3>
                {snapshot.base === undefined ? null : (
                  <button type="button" disabled={!draftEditable} onClick={() => setStoredDraft({ requestId: snapshot.intent.requestId, content: snapshot.base ?? '' })}>
                    Use Base in Result
                  </button>
                )}
              </div>
              {snapshot.base === undefined ? (
                <div className={css.documentConflictUnavailable}>Common Base is unavailable for this conflict.</div>
              ) : (
                <textarea aria-label={`Base text for ${name}`} value={snapshot.base} readOnly wrap="off" spellCheck={false} />
              )}
            </section>

            <section className={css.documentConflictVariant} role="region" aria-labelledby={localTitleId}>
              <div className={css.documentConflictVariantHeader}>
                <h3 id={localTitleId}>Local</h3>
                <button type="button" disabled={!draftEditable} onClick={() => setStoredDraft({ requestId: snapshot.intent.requestId, content: snapshot.local })}>
                  Use Local in Result
                </button>
              </div>
              <textarea aria-label={`Local text for ${name}`} value={snapshot.local} readOnly wrap="off" spellCheck={false} />
            </section>

            <section className={css.documentConflictVariant} role="region" aria-labelledby={remoteTitleId}>
              <div className={css.documentConflictVariantHeader}>
                <h3 id={remoteTitleId}>Remote</h3>
                <button type="button" disabled={!draftEditable || remote === undefined} onClick={() => {
                  if (remote !== undefined) setStoredDraft({ requestId: snapshot.intent.requestId, content: remote.content })
                }}>
                  Use Remote in Result
                </button>
              </div>
              {remote === undefined ? (
                <div className={css.documentConflictUnavailable}>Remote text is being read.</div>
              ) : (
                <textarea aria-label={`Remote text for ${name}`} value={remote.content} readOnly wrap="off" spellCheck={false} />
              )}
            </section>

            <section className={`${css.documentConflictVariant} ${css.documentConflictResult}`} role="region" aria-labelledby={resultTitleId}>
              <div className={css.documentConflictVariantHeader}>
                <h3 id={resultTitleId}>Merge Result</h3>
                <span>{relation === undefined ? '' : documentConflictRelationMessage(relation)}</span>
              </div>
              <textarea
                aria-label={`Merge result for ${name}`}
                aria-describedby={`${applyNoteId}${resultError === undefined ? '' : ` ${resultErrorId}`}`}
                aria-invalid={resultError === undefined ? undefined : 'true'}
                value={result}
                disabled={!draftEditable || applying}
                wrap="off"
                spellCheck={false}
                onChange={event => setStoredDraft({ requestId: snapshot.intent.requestId, content: event.currentTarget.value })}
              />
              <div id={resultErrorId} className={css.documentConflictResultError} role={resultError === undefined ? undefined : 'alert'}>
                {resultError ?? ''}
              </div>
            </section>
          </div>
        </div>

        <footer className={css.documentConflictFooter}>
          <p id={applyNoteId}>These actions update the editor only. They do not save or write to the Host.</p>
          <div className={css.documentConflictActions}>
            <button type="button" disabled={!ready || applying} onClick={onAcceptRemote}>Accept Remote</button>
            <button type="button" disabled={!ready || applying} onClick={onKeepLocal}>Keep Local</button>
            <span className={css.documentConflictActionSpacer} />
            <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className={css.documentConflictPrimary}
              aria-describedby={applyNoteId}
              disabled={!ready || applying || resultError !== undefined}
              onClick={() => {
                if (resultError === undefined) onApplyMerged(result)
              }}
            >Apply Merge to Editor</button>
          </div>
        </footer>
      </section>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
