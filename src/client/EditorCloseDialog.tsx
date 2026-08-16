import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react'
import { createPortal } from 'react-dom'
import type { EditorClosePresentationRequest, EditorCloseSnapshot } from './editor/close.ts'
import { useIdeI18n } from './i18n.tsx'
import css from './ide.module.css'

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

export interface EditorCloseDialogProps {
  readonly snapshot: EditorCloseSnapshot
  readonly onSave: () => void
  readonly onDiscard: () => void
  readonly onCancel: () => void
  /** Acknowledge focus only after the requested control has been focused. */
  readonly onPresentationApplied?: (requestId: number) => void
}

export type EditorCloseDialogKeyboardAction =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'trap'; readonly backwards: boolean }
  | { readonly kind: 'contain' }
  | { readonly kind: 'none' }

export function editorCloseDialogKeyboardAction(
  key: string,
  shiftKey = false,
  saving = false,
): EditorCloseDialogKeyboardAction {
  if (key === 'Escape') return saving ? { kind: 'contain' } : { kind: 'cancel' }
  if (key === 'Tab') return { kind: 'trap', backwards: shiftKey }
  return { kind: 'none' }
}

export type EditorCloseBackdropAction = 'cancel' | 'contain' | 'none'

export function editorCloseBackdropAction(
  backdropWasTarget: boolean,
  saving: boolean,
): EditorCloseBackdropAction {
  if (!backdropWasTarget) return 'none'
  return saving ? 'contain' : 'cancel'
}

/** Pure circular focus calculation used by the modal's Tab trap. */
export function nextEditorCloseFocusIndex(
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

export function editorClosePresentationRequest(
  snapshot: EditorCloseSnapshot,
): EditorClosePresentationRequest | undefined {
  return snapshot.phase === 'confirming' || snapshot.phase === 'error'
    ? snapshot.presentationRequest
    : undefined
}

function focusableButtons(dialog: HTMLElement): HTMLButtonElement[] {
  return Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    .filter(button => button.hidden !== true && button.getAttribute('aria-hidden') !== 'true')
}

/** Non-blocking, body-portal confirmation for exact-identity editor closing. */
export function EditorCloseDialog({
  snapshot,
  onSave,
  onDiscard,
  onCancel,
  onPresentationApplied,
}: EditorCloseDialogProps) {
  const { t } = useIdeI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const acknowledgedRequest = useRef<number>()
  const presentationApplied = useRef(onPresentationApplied)
  const titleId = useId()
  const descriptionId = useId()
  const statusId = useId()
  const errorId = useId()
  presentationApplied.current = onPresentationApplied

  const presentationRequest = editorClosePresentationRequest(snapshot)
  const saving = snapshot.phase === 'saving'

  useClientLayoutEffect(() => {
    if (presentationRequest === undefined
      || acknowledgedRequest.current === presentationRequest.requestId) return

    // Both `cancel` and `dismiss` deliberately resolve to the least
    // destructive action. This is also the required initial focus.
    const target = cancelRef.current
    if (target === null) return
    target.focus({ preventScroll: true })
    if (document.activeElement !== target) return
    acknowledgedRequest.current = presentationRequest.requestId
    presentationApplied.current?.(presentationRequest.requestId)
  }, [presentationRequest])

  useClientLayoutEffect(() => {
    if (!saving) return
    const dialog = dialogRef.current
    if (dialog === null) return
    const active = document.activeElement
    if (!dialog.contains(active) || active instanceof HTMLButtonElement && active.disabled) {
      dialog.focus({ preventScroll: true })
    }
  }, [saving])

  if (snapshot.phase === 'idle') return null

  const error = snapshot.phase === 'error' ? snapshot.error.message : undefined
  const dismissOnly = snapshot.phase === 'error' && snapshot.actions === 'dismiss'
  const primaryLabel = snapshot.deleted ? t('recreate') : t('save')
  const savingLabel = snapshot.deleted ? t('recreatingBeforeClose') : t('savingBeforeClose')
  const trapOrDismiss = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const action = editorCloseDialogKeyboardAction(event.key, event.shiftKey, saving)
    if (action.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === 'contain') return
    if (action.kind === 'cancel') {
      onCancel()
      return
    }

    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = focusableButtons(dialog)
    const currentIndex = document.activeElement instanceof HTMLButtonElement
      ? focusable.indexOf(document.activeElement)
      : -1
    const nextIndex = nextEditorCloseFocusIndex(currentIndex, focusable.length, action.backwards)
    focusable[nextIndex]?.focus()
  }

  const describedBy = error === undefined
    ? `${descriptionId} ${statusId}`
    : `${descriptionId} ${statusId} ${errorId}`

  const dialog = (
    <div
      className={css.editorCloseBackdrop}
      onMouseDown={event => {
        const action = editorCloseBackdropAction(event.target === event.currentTarget, saving)
        if (action === 'contain') {
          event.preventDefault()
          return
        }
        if (action === 'cancel') onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className={css.editorCloseDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={saving || undefined}
        tabIndex={-1}
        onKeyDown={trapOrDismiss}
      >
        <h2 id={titleId}>{
          dismissOnly ? t('cannotCloseFile', { name: snapshot.name })
            : snapshot.deleted ? t('recreateFileQuestion', { name: snapshot.name })
              : t('saveChangesQuestion', { name: snapshot.name })
        }</h2>
        <p id={descriptionId} className={css.editorCloseCopy}>
          {dismissOnly
            ? t('resolveBeforeClose')
            : snapshot.deleted
              ? t('deletedFileRecreateDescription')
              : t('saveBeforeCloseDescription')}
          <code className={css.editorClosePath} title={snapshot.identity.path}>{snapshot.identity.path}</code>
        </p>

        <div id={statusId} className={css.editorCloseStatus} role="status" aria-live="polite" aria-atomic="true">
          {saving ? savingLabel : ''}
        </div>
        {error === undefined ? null : (
          <div id={errorId} className={css.editorCloseError} role="alert">{error}</div>
        )}

        <div className={css.editorCloseActions}>
          {dismissOnly ? null : (
            <button
              type="button"
              className={css.editorCloseDiscard}
              disabled={saving}
              onClick={onDiscard}
            >{t('dontSave')}</button>
          )}
          <button ref={cancelRef} type="button" disabled={saving} data-initial-focus="true" onClick={onCancel}>
            {dismissOnly ? t('dismiss') : t('cancel')}
          </button>
          {dismissOnly ? null : (
            <button
              type="button"
              className={css.editorClosePrimary}
              disabled={saving}
              onClick={onSave}
            >{primaryLabel}</button>
          )}
        </div>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
