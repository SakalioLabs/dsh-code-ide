import {
  Fragment,
  createElement,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { decodeWorkspacePath } from './workspace-path.ts'
import css from './ide.module.css'
import { useIdeI18n } from './i18n.tsx'

export const MAX_MARKDOWN_PREVIEW_BYTES = 1024 * 1024
export const MAX_MARKDOWN_PREVIEW_NODES = 50_000
const MAX_MARKDOWN_RENDER_DEPTH = 128
const UTF8 = new TextEncoder()

interface MarkdownSyntaxNode {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly firstChild: MarkdownSyntaxNode | null
  readonly nextSibling: MarkdownSyntaxNode | null
}

interface MarkdownReference {
  readonly destination: string
  readonly title?: string
}

export type MarkdownLinkTarget =
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'fragment'; readonly href: string }
  | { readonly kind: 'workspace'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'blocked' }

export type MarkdownPreviewState =
  | { readonly kind: 'ready'; readonly content: ReactNode; readonly nodeCount: number }
  | { readonly kind: 'too-large' | 'too-complex' | 'parse-error' }

export interface MarkdownPreviewProps {
  readonly path: string
  readonly content: string
  readonly focusRequest?: number
  readonly onFocusApplied?: (requestId: number) => void
  /** Receives only canonical workspace-relative paths that stayed inside the workspace. */
  readonly onOpenPath?: (path: string, fragment?: string) => void
  /** Receives only canonical workspace-relative image paths, never a raw Markdown URL. */
  readonly resolveImageSrc?: (path: string) => string | undefined
  readonly completedTaskLabel?: string
  readonly incompleteTaskLabel?: string
}

const MARK_NODES = new Set([
  'CodeInfo',
  'CodeMark',
  'EmphasisMark',
  'HeaderMark',
  'LinkLabel',
  'LinkMark',
  'LinkTitle',
  'ListMark',
  'QuoteMark',
  'StrikethroughMark',
  'SubscriptMark',
  'SuperscriptMark',
  'TableDelimiter',
  'TaskMarker',
  'URL',
])

function childrenOf(node: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  const children: MarkdownSyntaxNode[] = []
  for (let child = node.firstChild; child !== null; child = child.nextSibling) children.push(child)
  return children
}

function childNamed(node: MarkdownSyntaxNode, name: string): MarkdownSyntaxNode | undefined {
  return childrenOf(node).find(child => child.name === name)
}

function textOf(source: string, node: MarkdownSyntaxNode): string {
  return source.slice(node.from, node.to)
}

function normalizeReferenceLabel(raw: string): string {
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  return unwrapped
    .replace(/\\([!-/:-@[-`{-~])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

function visibleLinkLabel(source: string, node: MarkdownSyntaxNode): string {
  const marks = childrenOf(node).filter(child => child.name === 'LinkMark')
  if (marks.length < 2) return textOf(source, node)
  return source.slice(marks[0]!.to, marks[1]!.from)
}

function linkTitle(source: string, node: MarkdownSyntaxNode): string | undefined {
  const title = childNamed(node, 'LinkTitle')
  if (title === undefined) return undefined
  const raw = textOf(source, title)
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))
    || (raw.startsWith('(') && raw.endsWith(')')))) return raw.slice(1, -1)
  return raw
}

function unwrapDestination(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed
}

function markdownDestination(source: string, node: MarkdownSyntaxNode): string | undefined {
  const direct = childNamed(node, 'URL')
  return direct === undefined ? undefined : unwrapDestination(textOf(source, direct))
}

function referenceDestination(
  source: string,
  node: MarkdownSyntaxNode,
  references: ReadonlyMap<string, MarkdownReference>,
): MarkdownReference | undefined {
  const direct = markdownDestination(source, node)
  if (direct !== undefined) {
    const title = linkTitle(source, node)
    return { destination: direct, ...(title === undefined ? {} : { title }) }
  }
  const explicit = childNamed(node, 'LinkLabel')
  const rawLabel = explicit === undefined || normalizeReferenceLabel(textOf(source, explicit)) === ''
    ? visibleLinkLabel(source, node)
    : textOf(source, explicit)
  return references.get(normalizeReferenceLabel(rawLabel))
}

function splitFragment(value: string): { path: string; fragment?: string } | undefined {
  const hash = value.indexOf('#')
  const rawPath = hash < 0 ? value : value.slice(0, hash)
  const rawFragment = hash < 0 ? undefined : value.slice(hash + 1)
  if (rawPath.includes('?') || rawFragment?.includes('\0') === true) return undefined
  let path: string
  let fragment: string | undefined
  try {
    path = decodeURIComponent(rawPath)
    fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment)
  } catch {
    return undefined
  }
  if (/\p{Cc}/u.test(path)) return undefined
  if (fragment !== undefined && (/\p{Cc}/u.test(fragment) || UTF8.encode(fragment).byteLength > 4 * 1024)) {
    return undefined
  }
  return { path, ...(fragment === undefined || fragment === '' ? {} : { fragment }) }
}

function resolveWorkspaceMarkdownPath(documentPath: string, raw: string): {
  readonly path: string
  readonly fragment?: string
} | undefined {
  const split = splitFragment(raw)
  if (split === undefined || split.path === '' || split.path.includes('\\') || split.path.includes('\0')) {
    return undefined
  }
  const absoluteFromRoot = split.path.startsWith('/')
  const segments = absoluteFromRoot ? [] : documentPath.split('/').slice(0, -1)
  for (const segment of split.path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const path = decodeWorkspacePath(segments.join('/'), { allowRoot: false })
  if (path === undefined) return undefined
  return { path, ...(split.fragment === undefined ? {} : { fragment: split.fragment }) }
}

/** Resolve an untrusted Markdown destination without ever turning a local path into a browser URL. */
export function resolveMarkdownLinkTarget(documentPath: string, rawValue: string): MarkdownLinkTarget {
  const raw = unwrapDestination(rawValue)
  if (raw === '' || raw.includes('\\') || /\p{Cc}/u.test(raw) || UTF8.encode(raw).byteLength > 16 * 1024) {
    return { kind: 'blocked' }
  }
  if (raw.startsWith('#')) {
    const split = splitFragment(raw)
    return split?.fragment === undefined ? { kind: 'blocked' } : { kind: 'fragment', href: `#${split.fragment}` }
  }
  if (raw.startsWith('//')) return { kind: 'blocked' }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(raw)?.[1]?.toLocaleLowerCase('en-US')
  if (scheme !== undefined) {
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return { kind: 'blocked' }
    try {
      const url = new URL(raw)
      if ((url.protocol === 'http:' || url.protocol === 'https:')
        && (url.username !== '' || url.password !== '')) return { kind: 'blocked' }
      if (url.protocol !== `${scheme}:`) return { kind: 'blocked' }
      return { kind: 'external', href: url.href }
    } catch {
      return { kind: 'blocked' }
    }
  }
  const workspace = resolveWorkspaceMarkdownPath(documentPath, raw)
  return workspace === undefined ? { kind: 'blocked' } : { kind: 'workspace', ...workspace }
}

function decodeEntity(raw: string): string {
  const named: Readonly<Record<string, string>> = {
    '&amp;': '&', '&apos;': "'", '&gt;': '>', '&lt;': '<', '&quot;': '"',
  }
  const known = named[raw]
  if (known !== undefined) return known
  const numeric = /^&#(x[0-9a-f]+|[0-9]+);$/iu.exec(raw)?.[1]
  if (numeric === undefined) return raw
  const point = numeric[0]?.toLocaleLowerCase('en-US') === 'x'
    ? Number.parseInt(numeric.slice(1), 16)
    : Number.parseInt(numeric, 10)
  return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
    && !(point >= 0xd800 && point <= 0xdfff)
    ? String.fromCodePoint(point)
    : raw
}

function countTreeNodes(tree: ReturnType<typeof markdownLanguage.parser.parse>): number {
  const cursor = tree.cursor()
  let count = 0
  do {
    count += 1
    if (count > MAX_MARKDOWN_PREVIEW_NODES) return count
  } while (cursor.next())
  return count
}

function collectReferences(
  tree: ReturnType<typeof markdownLanguage.parser.parse>,
  source: string,
): ReadonlyMap<string, MarkdownReference> {
  const references = new Map<string, MarkdownReference>()
  const cursor = tree.cursor()
  do {
    if (cursor.name !== 'LinkReference') continue
    const node = cursor.node as MarkdownSyntaxNode
    const label = childNamed(node, 'LinkLabel')
    const destination = childNamed(node, 'URL')
    if (label === undefined || destination === undefined) continue
    const normalized = normalizeReferenceLabel(textOf(source, label))
    if (normalized === '' || references.has(normalized)) continue
    const title = linkTitle(source, node)
    references.set(normalized, {
      destination: unwrapDestination(textOf(source, destination)),
      ...(title === undefined ? {} : { title }),
    })
  } while (cursor.next())
  return references
}

interface RenderContext {
  readonly source: string
  readonly documentPath: string
  readonly references: ReadonlyMap<string, MarkdownReference>
  readonly onOpenPath?: (path: string, fragment?: string) => void
  readonly resolveImageSrc?: (path: string) => string | undefined
  readonly completedTaskLabel: string
  readonly incompleteTaskLabel: string
}

function renderContents(
  node: MarkdownSyntaxNode,
  context: RenderContext,
  depth: number,
): ReactNode[] {
  if (depth > MAX_MARKDOWN_RENDER_DEPTH) return [textOf(context.source, node)]
  const output: ReactNode[] = []
  let position = node.from
  for (const child of childrenOf(node)) {
    if (child.from > position) output.push(context.source.slice(position, child.from))
    const rendered = renderNode(child, context, depth + 1)
    if (rendered !== null && rendered !== undefined) output.push(rendered)
    position = child.to
  }
  if (position < node.to) output.push(context.source.slice(position, node.to))
  return output
}

function renderLink(
  node: MarkdownSyntaxNode,
  context: RenderContext,
  depth: number,
): ReactNode {
  const reference = referenceDestination(context.source, node, context.references)
  const contents = node.name === 'Autolink' && reference !== undefined
    ? reference.destination
    : renderContents(node, context, depth)
  if (reference === undefined) {
    return <span key={node.from} className={css.markdownLinkBlocked} data-markdown-link-blocked="unresolved">{contents}</span>
  }
  const target = resolveMarkdownLinkTarget(context.documentPath, reference.destination)
  if (target.kind === 'external') {
    return <a
      key={node.from}
      className={css.markdownLink}
      href={target.href}
      title={reference.title}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >{contents}</a>
  }
  if (target.kind === 'fragment') {
    return <a key={node.from} className={css.markdownLink} href={target.href} title={reference.title}>{contents}</a>
  }
  if (target.kind === 'workspace' && context.onOpenPath !== undefined) {
    return <button
      key={node.from}
      type="button"
      className={css.markdownLink}
      data-markdown-workspace-path={target.path}
      title={reference.title}
      onClick={() => { context.onOpenPath?.(target.path, target.fragment) }}
    >{contents}</button>
  }
  return <span key={node.from} className={css.markdownLinkBlocked} data-markdown-link-blocked={target.kind}>{contents}</span>
}

function renderImage(node: MarkdownSyntaxNode, context: RenderContext): ReactNode {
  const reference = referenceDestination(context.source, node, context.references)
  const alt = visibleLinkLabel(context.source, node).replace(/\\([!-/:-@[-`{-~])/gu, '$1')
  if (reference === undefined) {
    return <span key={node.from} className={css.markdownImageFallback} data-markdown-image-blocked="unresolved">{alt}</span>
  }
  const target = resolveMarkdownLinkTarget(context.documentPath, reference.destination)
  if (target.kind !== 'workspace' || target.fragment !== undefined) {
    return <span key={node.from} className={css.markdownImageFallback} data-markdown-image-blocked="unsafe">{alt}</span>
  }
  let src: string | undefined
  try { src = context.resolveImageSrc?.(target.path) } catch { src = undefined }
  const safeSource = src !== undefined && !/\p{Cc}/u.test(src)
    && (src.startsWith('blob:') || src.startsWith('/') && !src.startsWith('//'))
  if (!safeSource) {
    return <span
      key={node.from}
      className={css.markdownImageFallback}
      data-markdown-image-path={target.path}
    >{alt}</span>
  }
  return <img
    key={node.from}
    className={css.markdownImage}
    src={src}
    alt={alt}
    title={reference.title}
    loading="lazy"
    decoding="async"
    referrerPolicy="no-referrer"
    data-markdown-image-path={target.path}
  />
}

function codeText(node: MarkdownSyntaxNode, source: string): string {
  const code = childNamed(node, 'CodeText')
  return code === undefined ? renderPlainContents(node, source) : textOf(source, code)
}

function renderPlainContents(node: MarkdownSyntaxNode, source: string): string {
  let output = ''
  let position = node.from
  for (const child of childrenOf(node)) {
    if (child.from > position) output += source.slice(position, child.from)
    if (!MARK_NODES.has(child.name)) output += renderPlainContents(child, source)
    position = child.to
  }
  if (position < node.to) output += source.slice(position, node.to)
  return output
}

function renderNode(node: MarkdownSyntaxNode, context: RenderContext, depth: number): ReactNode {
  const contents = (): ReactNode[] => renderContents(node, context, depth)
  if (MARK_NODES.has(node.name) || node.name === 'LinkReference') return null
  if (/^(?:ATX|Setext)Heading[1-6]$/u.test(node.name)) {
    const level = Number(node.name.at(-1))
    return createElement(`h${String(level)}`, { key: node.from }, contents())
  }
  switch (node.name) {
    case 'Document': return <Fragment key={node.from}>{contents()}</Fragment>
    case 'Paragraph': return <p key={node.from}>{contents()}</p>
    case 'BulletList': return <ul key={node.from}>{contents()}</ul>
    case 'OrderedList': {
      const firstMark = childNamed(childrenOf(node)[0] ?? node, 'ListMark')
      const start = firstMark === undefined ? 1 : Number.parseInt(textOf(context.source, firstMark), 10)
      return <ol key={node.from} {...(Number.isSafeInteger(start) && start > 1 ? { start } : {})}>{contents()}</ol>
    }
    case 'ListItem': return <li key={node.from}>{contents()}</li>
    case 'Blockquote': return <blockquote key={node.from} className={css.markdownBlockquote}>{contents()}</blockquote>
    case 'HorizontalRule': return <hr key={node.from} />
    case 'Emphasis': return <em key={node.from}>{contents()}</em>
    case 'StrongEmphasis': return <strong key={node.from}>{contents()}</strong>
    case 'Strikethrough': return <del key={node.from}>{contents()}</del>
    case 'Subscript': return <sub key={node.from}>{contents()}</sub>
    case 'Superscript': return <sup key={node.from}>{contents()}</sup>
    case 'InlineCode': return <code key={node.from} className={css.markdownInlineCode}>{renderPlainContents(node, context.source)}</code>
    case 'FencedCode':
    case 'CodeBlock': return <pre key={node.from} className={css.markdownCodeBlock}><code>{codeText(node, context.source)}</code></pre>
    case 'HardBreak': return <br key={node.from} />
    case 'Escape': return context.source.slice(Math.min(node.to, node.from + 1), node.to)
    case 'Entity': return decodeEntity(textOf(context.source, node))
    case 'Link':
    case 'Autolink': return renderLink(node, context, depth)
    case 'Image': return renderImage(node, context)
    case 'Task': {
      const marker = childNamed(node, 'TaskMarker')
      const checked = marker !== undefined && /^\[[xX]\]$/u.test(textOf(context.source, marker))
      return <span key={node.from} className={css.markdownTask}>
        <input
          type="checkbox"
          checked={checked}
          readOnly
          disabled
          aria-label={checked ? context.completedTaskLabel : context.incompleteTaskLabel}
        />
        {contents()}
      </span>
    }
    case 'Table': return <div key={node.from} className={css.markdownTableScroll}><table className={css.markdownTable}>{contents()}</table></div>
    case 'TableHeader': return <thead key={node.from}><tr>{childrenOf(node).map(child => child.name === 'TableCell'
      ? <th key={child.from}>{renderContents(child, context, depth + 1)}</th>
      : null)}</tr></thead>
    case 'TableRow': return <tr key={node.from}>{childrenOf(node).map(child => child.name === 'TableCell'
      ? <td key={child.from}>{renderContents(child, context, depth + 1)}</td>
      : null)}</tr>
    case 'TableCell': return <td key={node.from}>{contents()}</td>
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock': return <pre key={node.from} className={css.markdownRawHtml}><code>{textOf(context.source, node)}</code></pre>
    case 'HTMLTag': return <code key={node.from} className={css.markdownRawHtml}>{textOf(context.source, node)}</code>
    default: return <Fragment key={node.from}>{contents()}</Fragment>
  }
}

export function renderMarkdownPreview(
  source: string,
  documentPath: string,
  options: Pick<
    MarkdownPreviewProps,
    'onOpenPath' | 'resolveImageSrc' | 'completedTaskLabel' | 'incompleteTaskLabel'
  > = {},
): MarkdownPreviewState {
  if (UTF8.encode(source).byteLength > MAX_MARKDOWN_PREVIEW_BYTES) return { kind: 'too-large' }
  try {
    const tree = markdownLanguage.parser.parse(source)
    const nodeCount = countTreeNodes(tree)
    if (nodeCount > MAX_MARKDOWN_PREVIEW_NODES) return { kind: 'too-complex' }
    const context: RenderContext = {
      source,
      documentPath,
      references: collectReferences(tree, source),
      completedTaskLabel: options.completedTaskLabel ?? 'Completed task',
      incompleteTaskLabel: options.incompleteTaskLabel ?? 'Incomplete task',
      ...(options.onOpenPath === undefined ? {} : { onOpenPath: options.onOpenPath }),
      ...(options.resolveImageSrc === undefined ? {} : { resolveImageSrc: options.resolveImageSrc }),
    }
    return {
      kind: 'ready',
      content: renderNode(tree.topNode as MarkdownSyntaxNode, context, 0),
      nodeCount,
    }
  } catch {
    return { kind: 'parse-error' }
  }
}

/** A read-only presentation surface; the backing document remains an ordinary editable tab. */
export function MarkdownPreview({
  path,
  content,
  focusRequest,
  onFocusApplied,
  onOpenPath,
  resolveImageSrc,
}: MarkdownPreviewProps) {
  const { t } = useIdeI18n()
  const surface = useRef<HTMLElement>(null)
  const onFocusAppliedRef = useRef(onFocusApplied)
  onFocusAppliedRef.current = onFocusApplied
  const state = useMemo(() => renderMarkdownPreview(content, path, {
    completedTaskLabel: t('completedTask'),
    incompleteTaskLabel: t('incompleteTask'),
    ...(onOpenPath === undefined ? {} : { onOpenPath }),
    ...(resolveImageSrc === undefined ? {} : { resolveImageSrc }),
  }), [content, onOpenPath, path, resolveImageSrc, t])

  useEffect(() => {
    if (focusRequest === undefined) return
    const element = surface.current
    element?.focus()
    if (element !== null && document.activeElement === element) {
      onFocusAppliedRef.current?.(focusRequest)
    }
  }, [focusRequest, path, state.kind])

  return (
    <section
      ref={surface}
      className={css.markdownPreview}
      data-workbench-focus="editor"
      data-markdown-preview-state={state.kind}
      tabIndex={0}
      aria-label={`${t('markdownPreview')}: ${path}`}
    >
      <article className={css.markdownBody}>
        {state.kind === 'ready'
          ? state.content
          : <p className={css.markdownNotice} role="status">
              {state.kind === 'too-large'
                ? t('markdownPreviewTooLarge')
                : t('markdownPreviewUnavailable')}
            </p>}
      </article>
    </section>
  )
}
