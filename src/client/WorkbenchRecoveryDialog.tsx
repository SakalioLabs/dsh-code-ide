import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import css from './ide.module.css'

export interface WorkbenchRecoveryDialogBodyProps {
  readonly titleId: string
  readonly descriptionId: string
  readonly reviewed: boolean
  readonly busy: boolean
  readonly canReset: boolean
  readonly exported: boolean
  readonly error?: string
  readonly dialogRef?: Ref<HTMLDivElement>
  readonly keepButtonRef?: Ref<HTMLButtonElement>
  readonly onDismiss: () => void
  readonly onExport: () => void
  readonly onReview: () => void
  readonly onKeep: () => void
  readonly onConfirm: () => void
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return
  const focusable = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (focusable.length === 0) {
    event.preventDefault()
    event.currentTarget.focus()
    return
  }
  const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.shiftKey
    ? current <= 0 ? focusable.length - 1 : current - 1
    : current < 0 || current === focusable.length - 1 ? 0 : current + 1
  event.preventDefault()
  focusable[next]?.focus()
}

/** Exported presentation seam keeps the destructive recovery contract testable without a DOM portal. */
export function WorkbenchRecoveryDialogBody({
  titleId,
  descriptionId,
  reviewed,
  busy,
  canReset,
  exported,
  error,
  dialogRef,
  keepButtonRef,
  onDismiss,
  onExport,
  onReview,
  onKeep,
  onConfirm,
}: WorkbenchRecoveryDialogBodyProps) {
  return (
    <div className={css.explorerDeleteBackdrop}>
      <div
        ref={dialogRef}
        className={css.explorerDeleteDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            event.stopPropagation()
            onDismiss()
            return
          }
          trapFocus(event)
        }}
      >
        <h2 id={titleId}>Stored workbench recovery is unsafe to decode</h2>
        <div id={descriptionId} className={css.explorerDeleteCopy}>
          <p>The IDE cannot safely decode this hot-exit checkpoint, so session recovery writes remain blocked.</p>
          <p>The download button re-reads the exact browser-stored value at that click. If the read fails, no download is created.</p>
          <p>Download it and inspect it and the workspace manually before resetting.</p>
          <p><strong>Reset does not inspect or decide disk contents, and it cannot reconstruct dirty-buffer, undo, or editor history.</strong></p>
          {reviewed && (
            <p>On confirmation, the IDE re-reads the checkpoint. A value that became valid is preserved. Only a still-invalid value is atomically replaced with the current in-memory workbench snapshot.</p>
          )}
        </div>
        {error !== undefined && <div className={css.explorerDeleteIssues} role="alert">{error}</div>}
        <div className={css.explorerDeleteActions}>
          {!reviewed ? (
            <>
              <button type="button" disabled={busy} onClick={onDismiss}>Keep Safety Fence</button>
              <button type="button" disabled={!canReset || busy} onClick={onExport}>
                {exported ? 'Download Again' : 'Download Exact Recovery Data'}
              </button>
              <button type="button" disabled={!canReset || !exported || busy} onClick={onReview}>Review Reset...</button>
            </>
          ) : (
            <>
              <button ref={keepButtonRef} type="button" disabled={busy} onClick={onKeep}>Keep Safety Fence</button>
              <button
                type="button"
                className={css.explorerDeleteDanger}
                disabled={!canReset || !exported || busy}
                onClick={onConfirm}
              >{busy ? 'Saving New Recovery...' : 'Reset Recovery From Current Workbench'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export interface WorkbenchRecoveryDialogProps {
  readonly open: boolean
  readonly busy: boolean
  readonly canReset: boolean
  readonly exported: boolean
  readonly error?: string
  readonly onDismiss: () => void
  readonly onExport: () => void
  readonly onConfirm: () => void
  readonly onRestoreFocus?: () => void
}

/** One body portal for exporting and safely replacing an invalid hot-exit checkpoint. */
export function WorkbenchRecoveryDialog({
  open,
  busy,
  canReset,
  exported,
  error,
  onDismiss,
  onExport,
  onConfirm,
  onRestoreFocus,
}: WorkbenchRecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const keepButtonRef = useRef<HTMLButtonElement>(null)
  const [reviewed, setReviewed] = useState(false)
  const wasOpen = useRef(false)
  const restoreFocus = useRef(onRestoreFocus)
  const titleId = useId()
  const descriptionId = useId()
  restoreFocus.current = onRestoreFocus

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      const frame = window.requestAnimationFrame(() => { dialogRef.current?.focus() })
      return () => { window.cancelAnimationFrame(frame) }
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    setReviewed(false)
    const frame = window.requestAnimationFrame(() => { restoreFocus.current?.() })
    return () => { window.cancelAnimationFrame(frame) }
  }, [open])

  useEffect(() => {
    if (open && reviewed) keepButtonRef.current?.focus()
  }, [open, reviewed])

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <WorkbenchRecoveryDialogBody
      titleId={titleId}
      descriptionId={descriptionId}
      reviewed={reviewed}
      busy={busy}
      canReset={canReset}
      exported={exported}
      {...(error === undefined ? {} : { error })}
      dialogRef={dialogRef}
      keepButtonRef={keepButtonRef}
      onDismiss={onDismiss}
      onExport={onExport}
      onReview={() => { setReviewed(true) }}
      onKeep={() => { setReviewed(false) }}
      onConfirm={onConfirm}
    />,
    document.body,
  )
}
