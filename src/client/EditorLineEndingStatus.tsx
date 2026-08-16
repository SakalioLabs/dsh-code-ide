import type { DocumentLineEnding } from './documents/text-content.ts'

export interface EditorLineEndingStatusProps {
  readonly lineEnding: DocumentLineEnding
  readonly disabled: boolean
  readonly onOpen: () => void
}

function label(lineEnding: DocumentLineEnding): 'LF' | 'CRLF' {
  return lineEnding === '\r\n' ? 'CRLF' : 'LF'
}

/** Compact editor status control; the caller owns exact document admission. */
export function EditorLineEndingStatus({
  lineEnding,
  disabled,
  onOpen,
}: EditorLineEndingStatusProps) {
  const currentLabel = label(lineEnding)
  const description = `End of line sequence: ${currentLabel}. Open LF and CRLF choices.`
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={description}
      title={description}
      onClick={onOpen}
    >{currentLabel}</button>
  )
}
