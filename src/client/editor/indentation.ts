export const DOCUMENT_INDENTATION_SAMPLE_CHARACTERS = 100_000
export const DOCUMENT_INDENTATION_SAMPLE_LINES = 1_000

export type DocumentIndentation =
  | { readonly kind: 'tabs' }
  | { readonly kind: 'spaces'; readonly size: 2 | 4 }

function greatestCommonDivisor(left: number, right: number): number {
  let a = left
  let b = right
  while (b !== 0) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

/**
 * Infer only strong, conventional indentation evidence from a bounded prefix.
 * Ambiguous or mixed documents deliberately retain CodeMirror's defaults.
 */
export function detectDocumentIndentation(content: string): DocumentIndentation | undefined {
  const sampled = content.slice(0, DOCUMENT_INDENTATION_SAMPLE_CHARACTERS)
  const lines = sampled.split('\n', DOCUMENT_INDENTATION_SAMPLE_LINES)
  let tabLines = 0
  const spaceWidths: number[] = []

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0 || /^\s*$/.test(line)) continue
    const leading = /^[ \t]+/.exec(line)?.[0]
    if (leading === undefined) continue

    if (leading.startsWith('\t')) {
      // Tabs followed by spaces are a normal alignment pattern. Spaces before a
      // tab are mixed indentation and therefore provide no reliable evidence.
      if (/^\t+ *$/.test(leading)) tabLines += 1
      continue
    }
    if (leading.includes('\t')) continue
    spaceWidths.push(leading.length)
  }

  const spaceLines = spaceWidths.length
  if (tabLines >= 2 && tabLines >= spaceLines * 3) return { kind: 'tabs' }
  if (spaceLines < 2 || spaceLines < tabLines * 3
    || spaceWidths.some(value => value < 2)) return undefined

  const width = spaceWidths.reduce(greatestCommonDivisor)
  // Seeing the candidate unit itself avoids treating continuation alignment
  // alone as indentation evidence (for example, 4- and 6-column alignment).
  if (width % 4 === 0 && spaceWidths.includes(4)) return { kind: 'spaces', size: 4 }
  if (width % 2 === 0 && spaceWidths.includes(2)) return { kind: 'spaces', size: 2 }
  return undefined
}
