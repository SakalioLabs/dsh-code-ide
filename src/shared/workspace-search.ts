/** Versioned JSON-safe contract shared by the workspace-search Host and browser. */

export type SearchPatternMode = 'literal' | 'regex'

export interface WorkspaceTextSearchQuery {
  pattern: string
  mode: SearchPatternMode
  caseSensitive: boolean
  wholeWord: boolean
  include?: string[]
  exclude?: string[]
}

export interface FindFilesRequest {
  op: 'findFiles'
  workspaceId: string
  query: string
}

export interface FindFileItem {
  path: string
}

export interface FindFilesResponse {
  items: FindFileItem[]
  incomplete: boolean
  limit: number
}

export interface SearchTextRequest {
  op: 'searchText'
  workspaceId: string
  query: WorkspaceTextSearchQuery
}

/** Zero-based UTF-16 columns, end-exclusive, in the complete logical line. */
export interface TextSearchRange {
  start: number
  end: number
}

export interface TextSearchItem {
  path: string
  /** One-based logical line number. */
  lineNumber: number
  /** A UTF-8-budgeted window of the logical line. */
  preview: string
  /** Zero-based UTF-16 column in the complete line where preview starts. */
  previewStart: number
  /** Actual line-relative UTF-16 ranges, not preview-relative ranges. */
  ranges: TextSearchRange[]
}

export interface SearchTextResponse {
  items: TextSearchItem[]
  matchCount: number
  fileCount: number
  incomplete: boolean
  limit: number
}

export interface SearchTextContentOptions {
  maxMatches?: number
  maxPreviewBytes?: number
}

const MAX_GLOB_BYTES = 1024
const MAX_GLOBS = 64

/** Validate the deliberately small glob subset shared with the rg adapter. */
export function validateSearchGlobs(value: unknown, field: 'include' | 'exclude'): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_GLOBS) {
    throw new TypeError(`${field} must be an array of at most ${String(MAX_GLOBS)} glob patterns.`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || new TextEncoder().encode(item).byteLength > MAX_GLOB_BYTES) {
      throw new TypeError(`${field} contains an invalid glob pattern.`)
    }
    if (item.includes('\0') || item.includes('\\') || item.startsWith('!') || item.startsWith('/')
      || /[{}\[\]]/.test(item) || item.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new TypeError(`${field} contains an unsupported glob pattern.`)
    }
    return item
  })
}

function globExpression(glob: string): RegExp {
  let expression = glob.includes('/') ? '^' : '^(?:.*/)?'
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          expression += '(?:.*/)?'
        } else expression += '.*'
      } else expression += '[^/]*'
    } else if (character === '?') expression += '[^/]'
    else expression += character?.replace(/[|\\{}()[\]^$+*.?]/g, '\\$&') ?? ''
  }
  return new RegExp(`${expression}$`, 'u')
}

/** Apply the same validated include/exclude path policy to dirty buffers. */
export function matchesSearchPath(path: string, query: WorkspaceTextSearchQuery): boolean {
  const include = validateSearchGlobs(query.include, 'include')
  const exclude = validateSearchGlobs(query.exclude, 'exclude')
  return (include.length === 0 || include.some(glob => globExpression(glob).test(path)))
    && !exclude.some(glob => globExpression(glob).test(path))
}

const DEFAULT_CONTENT_MATCH_LIMIT = 500
const DEFAULT_PREVIEW_BYTES = 2 * 1024
const WORD_CHARACTER = /[\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\u200c\u200d]/u

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHARACTER.test(value)
}

function codePointBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined
  const trailing = value.charCodeAt(offset - 1)
  const width = trailing >= 0xdc00 && trailing <= 0xdfff && offset >= 2 ? 2 : 1
  return value.slice(offset - width, offset)
}

function codePointAt(value: string, offset: number): string | undefined {
  if (offset >= value.length) return undefined
  const leading = value.charCodeAt(offset)
  const width = leading >= 0xd800 && leading <= 0xdbff && offset + 1 < value.length ? 2 : 1
  return value.slice(offset, offset + width)
}

function nextCodePointOffset(value: string, offset: number): number {
  const point = codePointAt(value, offset)
  return point === undefined ? offset : offset + point.length
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Build a preview containing the first match without cutting a Unicode code
 * point. Undefined means the match itself cannot fit the byte budget.
 */
export function textSearchPreview(
  line: string,
  first: TextSearchRange,
  maxBytes = DEFAULT_PREVIEW_BYTES,
): { preview: string; previewStart: number } | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined
  let usedBytes = utf8Bytes(line.slice(first.start, first.end))
  if (usedBytes > maxBytes) return undefined
  let start = first.start
  let end = first.end
  let preferLeft = true
  for (;;) {
    const left = codePointBefore(line, start)
    const right = codePointAt(line, end)
    const leftBytes = left === undefined ? 0 : utf8Bytes(left)
    const rightBytes = right === undefined ? 0 : utf8Bytes(right)
    const canLeft = left !== undefined && usedBytes + leftBytes <= maxBytes
    const canRight = right !== undefined && usedBytes + rightBytes <= maxBytes
    if (!canLeft && !canRight) break
    if ((preferLeft && canLeft) || !canRight) {
      start -= left?.length ?? 0
      usedBytes += leftBytes
    } else {
      end += right?.length ?? 0
      usedBytes += rightBytes
    }
    preferLeft = !preferLeft
  }
  return { preview: line.slice(start, end), previewStart: start }
}

function compileLineMatcher(query: WorkspaceTextSearchQuery): RegExp {
  const pattern = query.mode === 'literal'
    ? query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : query.pattern
  return new RegExp(pattern, `dg${query.caseSensitive ? '' : 'i'}u`)
}

/** Validate the browser dirty-buffer matcher independently of path filters. */
export function validateTextSearchPattern(query: WorkspaceTextSearchQuery): void {
  compileLineMatcher(query)
}

/**
 * Pure matcher for dirty editor buffers. It intentionally works one logical
 * line at a time, matching ripgrep's non-multiline search mode. Invalid regex
 * syntax is reported by the native RegExp SyntaxError to the validating caller.
 */
export function searchTextContent(
  path: string,
  content: string,
  query: WorkspaceTextSearchQuery,
  options: SearchTextContentOptions = {},
): TextSearchItem[] {
  if (!matchesSearchPath(path, query)) return []
  const maxMatches = options.maxMatches ?? DEFAULT_CONTENT_MATCH_LIMIT
  const maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_PREVIEW_BYTES
  if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0) return []
  const matcher = compileLineMatcher(query)
  // Match ripgrep's --crlf line model: LF delimits records and a preceding CR
  // is the line ending; a lone CR remains content rather than a new line.
  const lines = content.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  const items: TextSearchItem[] = []
  let matchCount = 0
  for (let index = 0; index < lines.length && matchCount < maxMatches; index += 1) {
    const line = lines[index] ?? ''
    matcher.lastIndex = 0
    const ranges: TextSearchRange[] = []
    for (;;) {
      const match = matcher.exec(line)
      if (match === null) break
      const indices = match.indices?.[0]
      if (indices === undefined) break
      const [start, end] = indices
      if (!query.wholeWord
        || (!isWordCharacter(codePointBefore(line, start)) && !isWordCharacter(codePointAt(line, end)))) {
        ranges.push({ start, end })
        matchCount += 1
      }
      if (start === end) {
        const next = nextCodePointOffset(line, end)
        matcher.lastIndex = next > end ? next : end + 1
      }
      if (matchCount >= maxMatches) break
    }
    const first = ranges[0]
    if (first === undefined) continue
    const preview = textSearchPreview(line, first, maxPreviewBytes)
    if (preview === undefined) continue
    items.push({
      path,
      lineNumber: index + 1,
      preview: preview.preview,
      previewStart: preview.previewStart,
      ranges,
    })
  }
  return items
}
