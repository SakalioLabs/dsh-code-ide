import { useEffect, useId, useRef } from 'react'
import css from './ide.module.css'

export type ReadOnlyFileReason = 'binary' | 'too-large'

export interface ReadOnlyFilePresentation {
  readonly reason: ReadOnlyFileReason
  readonly sizeBytes: number
  readonly limitBytes: number
  readonly previewBytes: number
  readonly truncated: true
}

export interface ReadOnlyFileViewProps {
  readonly path: string
  /** Empty for binary files; a bounded UTF-8 prefix for oversized text files. */
  readonly content: string
  readonly presentation: ReadOnlyFilePresentation
  readonly focusRequest?: number
  readonly onFocusApplied?: (requestId: number) => void
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Unknown'
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes / 1024
  let unit: string = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index] ?? unit
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}

function fallbackType(reason: ReadOnlyFileReason): string {
  return reason === 'binary' ? 'Binary or non-UTF-8' : 'UTF-8 prefix'
}

/** Non-editable editor surface for files that must not be decoded into CodeMirror. */
export function ReadOnlyFileView({
  path,
  content,
  presentation,
  focusRequest,
  onFocusApplied,
}: ReadOnlyFileViewProps) {
  const surface = useRef<HTMLElement>(null)
  const headingId = useId()
  const onFocusAppliedRef = useRef(onFocusApplied)
  onFocusAppliedRef.current = onFocusApplied

  useEffect(() => {
    if (focusRequest === undefined) return
    const element = surface.current
    element?.focus()
    if (element !== null && document.activeElement === element) {
      onFocusAppliedRef.current?.(focusRequest)
    }
  }, [focusRequest, path, presentation.reason])

  const isBinary = presentation.reason === 'binary'
  return (
    <section
      ref={surface}
      className={css.readOnlyFileView}
      data-workbench-focus="editor"
      data-read-only-reason={presentation.reason}
      tabIndex={0}
      aria-labelledby={headingId}
    >
      <div className={css.readOnlyFileCard}>
        <span className={css.readOnlyFileBadge}>Read-only</span>
        <h2 id={headingId}>{isBinary ? 'Binary file is not editable' : 'File is too large for the text editor'}</h2>
        <p>
          {isBinary
            ? 'DeepSeek IDE only edits valid UTF-8 text. This file was not decoded into the editor.'
            : 'This file exceeds the safe editor size limit. Only a bounded prefix is shown; the remainder was not loaded.'}
        </p>
        <dl className={css.readOnlyFileFacts}>
          <div><dt>Path</dt><dd title={path}>{path}</dd></div>
          <div><dt>File type</dt><dd>{fallbackType(presentation.reason)}</dd></div>
          <div><dt>File size</dt><dd>{formatFileSize(presentation.sizeBytes)}</dd></div>
          {!isBinary && (
            <div><dt>Editor limit</dt><dd>{formatFileSize(presentation.limitBytes)}</dd></div>
          )}
        </dl>
        {!isBinary && (
          <div className={css.readOnlyFilePreview}>
            <div>
              <strong>Read-only preview</strong>
              <span>{formatFileSize(presentation.previewBytes)} shown; remainder not loaded</span>
            </div>
            <pre aria-label={`Read-only preview of ${path}`}>{content}</pre>
          </div>
        )}
        <p className={css.readOnlyFileHint}>You can switch tabs or close this file normally.</p>
      </div>
    </section>
  )
}
