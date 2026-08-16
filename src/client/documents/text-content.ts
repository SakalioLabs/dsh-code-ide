/** CodeMirror and every browser-side editable buffer use LF-only coordinates. */
export const CANONICAL_DOCUMENT_LINE_ENDING = '\n' as const

export type DocumentLineEnding = '\n' | '\r\n'

export interface CanonicalEditableText {
  /** LF-only text. Every offset in the browser document domain refers to this value. */
  readonly content: string
  /** Line ending used only when materializing the canonical buffer for the Host. */
  readonly lineEnding: DocumentLineEnding
}

function inferredLineEnding(raw: string): DocumentLineEnding {
  let crlf = 0
  let other = 0
  let first: DocumentLineEnding | undefined
  for (const match of raw.matchAll(/\r\n|\r|\n/gu)) {
    const current: DocumentLineEnding = match[0] === '\r\n' ? '\r\n' : '\n'
    first ??= current
    if (current === '\r\n') crlf += 1
    else other += 1
  }
  if (crlf === other) return first ?? CANONICAL_DOCUMENT_LINE_ENDING
  return crlf > other ? '\r\n' : '\n'
}

/**
 * Cross the Host -> editable-buffer boundary once. Homogeneous LF/CRLF files
 * retain their exact convention; mixed/legacy input gets one deterministic
 * dominant convention and is normalized only if a later write occurs.
 */
export function normalizeEditableText(
  raw: string,
  preferredLineEnding?: DocumentLineEnding,
): CanonicalEditableText {
  return Object.freeze({
    content: raw.replace(/\r\n?|\n/gu, CANONICAL_DOCUMENT_LINE_ENDING),
    lineEnding: preferredLineEnding ?? inferredLineEnding(raw),
  })
}

/** Cross the editable-buffer -> Host boundary using the transaction-captured EOL. */
export function materializeEditableText(
  canonicalContent: string,
  lineEnding: DocumentLineEnding,
): string {
  const lf = canonicalContent.replace(/\r\n?|\n/gu, CANONICAL_DOCUMENT_LINE_ENDING)
  return lineEnding === '\r\n' ? lf.replace(/\n/gu, '\r\n') : lf
}
