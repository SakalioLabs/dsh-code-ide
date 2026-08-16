/** Additive Harness browser contribution: an optional IDE conversation tab. */
import type { Context } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'

const IDE_VIEW_ID = 'dsh-code-ide'
const IDE_VIEW_LABEL = 'IDE'

/**
 * Resolved Harness values copied into the same-origin IDE document. Keeping
 * the bridge allow-listed avoids mirroring arbitrary host or third-party CSS.
 */
export const HARNESS_THEME_TOKENS = [
  '--dsw-font-family',
  '--ds-font-family-code',
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-specific-input-major',
  '--dsw-specific-menu',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-hover-l1',
] as const

interface ThemeObserverLike {
  observe(target: Node, options: MutationObserverInit): void
  disconnect(): void
}

export interface HarnessThemeWatchRuntime {
  createObserver(callback: () => void): ThemeObserverLike
  requestFrame(callback: () => void): number
  cancelFrame(handle: number): void
}

function browserThemeWatchRuntime(source: Document): HarnessThemeWatchRuntime | undefined {
  const view = source.defaultView
  if (view === null || typeof view.requestAnimationFrame !== 'function'
    || typeof view.cancelAnimationFrame !== 'function') return undefined
  return {
    createObserver: callback => new view.MutationObserver(callback),
    requestFrame: callback => view.requestAnimationFrame(callback),
    cancelFrame: handle => { view.cancelAnimationFrame(handle) },
  }
}

/**
 * Copy the host's resolved palette to one already-loaded same-origin frame.
 * A cross-origin navigation or torn-down frame is a supported no-op.
 */
export function syncHarnessThemeToFrame(source: Document, frame: HTMLIFrameElement | null): boolean {
  if (frame === null) return false
  try {
    const target = frame.contentDocument
    const sourceView = source.defaultView
    if (target === null || sourceView === null) return false

    const sourceStyle = sourceView.getComputedStyle(source.body)
    const targetStyle = target.documentElement.style
    for (const token of HARNESS_THEME_TOKENS) {
      const value = sourceStyle.getPropertyValue(token).trim()
      if (value === '') targetStyle.removeProperty(token)
      else targetStyle.setProperty(token, value)
    }

    const dark = source.body.hasAttribute('data-ds-dark-theme')
    targetStyle.colorScheme = dark ? 'dark' : 'light'
    if (dark) target.body.setAttribute('data-ds-dark-theme', '')
    else target.body.removeAttribute('data-ds-dark-theme')
    return true
  } catch {
    return false
  }
}

/**
 * Watch only the attributes owned by Harness' ThemePresenter. Bursts of
 * token writes collapse into one animation-frame sync and cleanup is total.
 */
export function watchHarnessTheme(
  source: Document,
  onChange: () => void,
  providedRuntime?: HarnessThemeWatchRuntime,
): () => void {
  const runtime = providedRuntime ?? browserThemeWatchRuntime(source)
  if (runtime === undefined) return () => {}

  let observer: ThemeObserverLike | undefined
  let scheduledFrame: number | undefined
  let disposed = false
  const schedule = (): void => {
    if (disposed || scheduledFrame !== undefined) return
    try {
      scheduledFrame = runtime.requestFrame(() => {
        scheduledFrame = undefined
        if (disposed) return
        try { onChange() } catch { /* Theme projection must never block the IDE. */ }
      })
    } catch {
      scheduledFrame = undefined
    }
  }

  try {
    observer = runtime.createObserver(schedule)
    observer.observe(source.body, {
      attributes: true,
      attributeFilter: ['style', 'data-ds-dark-theme'],
    })
    observer.observe(source.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })
  } catch {
    try { observer?.disconnect() } catch { /* Best-effort teardown. */ }
    return () => {}
  }

  return () => {
    disposed = true
    if (scheduledFrame !== undefined) {
      try { runtime.cancelFrame(scheduledFrame) } catch { /* Best-effort teardown. */ }
      scheduledFrame = undefined
    }
    try { observer?.disconnect() } catch { /* Best-effort teardown. */ }
  }
}

interface WorkspaceViewLike {
  readonly workspaceId: string
  readonly sessionIds: readonly string[]
}

interface WorkspaceListLike {
  readonly items: readonly WorkspaceViewLike[]
  readonly phase: 'pending' | 'ready'
  readonly state: 'idle' | 'loading' | 'error'
  readonly baselinesReady: boolean
}

type SnapshotSelectorHook<Snapshot> = <Selected>(
  selector: (snapshot: Snapshot) => Selected,
  equal?: (left: Selected, right: Selected) => boolean,
) => Selected
type IdeLocale = 'en' | 'zh'


export interface HarnessIdeViewProps {
  readonly sessionId: string
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceListLike>
  readonly locale?: IdeLocale
}

interface ConversationViewOptions {
  readonly name: 'conversation.view'
  readonly id: string
  readonly order: number
  readonly label: string
}

interface ConversationComposerOwnerLike {
  readonly session?: {
    readonly sessionId: string
  }
}

interface ConversationComposerOptions {
  readonly name: 'conversation.composer'
  readonly priority: number
  readonly select: (owner: ConversationComposerOwnerLike) => true | null
}

interface ConversationComposerProps {
  readonly matched: true
}

interface SlotRegistryLike {
  inject(name: 'conversation.view' | 'conversation.composer', setup: () => () => void): () => void
  register(
    options: ConversationViewOptions,
    component: (props: HarnessIdeViewProps) => ReactNode,
  ): () => void
  register(
    options: ConversationComposerOptions,
    component: (props: ConversationComposerProps) => ReactNode,
  ): () => void
}

interface LocaleSnapshotLike {
  readonly active: IdeLocale
}

interface LocaleRuntimeLike {
  getSnapshot(): LocaleSnapshotLike
  subscribe(listener: () => void): () => void
}

interface HarnessClientContext {
  readonly slots: SlotRegistryLike
  readonly locale: LocaleRuntimeLike
}

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flex: '1 1 0',
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base)',
}

const FRAME_STYLE: CSSProperties = {
  display: 'block',
  flex: '1 1 0',
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  border: 0,
  background: 'var(--dsw-alias-bg-base)',
  colorScheme: 'light dark',
}

const STATUS_STYLE: CSSProperties = {
  display: 'grid',
  flex: '1 1 0',
  placeItems: 'center',
  minWidth: 0,
  minHeight: 0,
  padding: 24,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 13,
  textAlign: 'center',
}

/** Resolve the Workspace account that owns a Harness session. */
export function workspaceIdForSession(
  workspaces: readonly WorkspaceViewLike[],
  sessionId: string,
): string | undefined {
  return workspaces.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
}

export type WorkspaceTarget =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'unattached' }

const LOADING_TARGET: WorkspaceTarget = { kind: 'loading' }
const ERROR_TARGET: WorkspaceTarget = { kind: 'error' }
const UNATTACHED_TARGET: WorkspaceTarget = { kind: 'unattached' }

/** Distinguish a pending baseline from a ready-but-unaccounted Session. */
export function workspaceTargetForSession(
  snapshot: WorkspaceListLike,
  sessionId: string,
): WorkspaceTarget {
  const workspaceId = workspaceIdForSession(snapshot.items, sessionId)
  if (workspaceId !== undefined) return { kind: 'workspace', workspaceId }
  if (snapshot.state === 'error') return ERROR_TARGET
  return snapshot.phase === 'pending' || !snapshot.baselinesReady ? LOADING_TARGET : UNATTACHED_TARGET
}

function workspaceTargetsEqual(left: WorkspaceTarget, right: WorkspaceTarget): boolean {
  return left.kind === 'workspace' && right.kind === 'workspace'
    ? left.workspaceId === right.workspaceId
    : left.kind === right.kind
}

/** Build the same-origin companion URL without changing the Harness root route. */
export function ideFrameHref(workspaceId: string, locale: IdeLocale = 'en'): string {
  return `/dsh-code-ide/?embedded=1&workspaceId=${encodeURIComponent(workspaceId)}&locale=${locale}`
}

export function syncHarnessLocaleToFrame(
  frame: HTMLIFrameElement | null,
  locale: IdeLocale,
  targetOrigin: string = window.location.origin,
): boolean {
  if (frame === null) return false
  try {
    const target = frame.contentWindow
    if (target === null) return false
    target.postMessage({
      type: 'dsh-code-ide/locale',
      locale,
    }, targetOrigin)
    return true
  } catch {
    return false
  }
}

function HiddenIdeComposer(_props: ConversationComposerProps): ReactNode {
  return null
}

/**
 * Hide the ordinary composer only for the strict Session currently hosting
 * the mounted IDE view. Earlier question/approval takeovers keep winning the
 * chain; cleanup restores the normal fallback immediately.
 */
export function registerIdeComposerSuppression(
  slots: SlotRegistryLike,
  sessionId: string,
): () => void {
  return slots.inject('conversation.composer', () => slots.register({
    name: 'conversation.composer',
    priority: Number.MAX_SAFE_INTEGER,
    select: owner => owner.session?.sessionId === sessionId ? true : null,
  }, HiddenIdeComposer))
}

/** IDE body rendered only after the user selects the native IDE tab. */
export function HarnessIdeView({ sessionId, useWorkspaces, locale = 'en' }: HarnessIdeViewProps): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null)
  const source = useRef<{ readonly workspaceId: string; readonly href: string }>()
  const target = useWorkspaces(
    snapshot => workspaceTargetForSession(snapshot, sessionId),
    workspaceTargetsEqual,
  )
  const workspaceId = target.kind === 'workspace' ? target.workspaceId : undefined
  if (workspaceId !== undefined && source.current?.workspaceId !== workspaceId) {
    source.current = { workspaceId, href: ideFrameHref(workspaceId, locale) }
  }
  const syncTheme = useCallback(() => syncHarnessThemeToFrame(document, frame.current), [])
  const syncLocale = useCallback(() => syncHarnessLocaleToFrame(frame.current, locale), [locale])
  const syncFrame = useCallback(() => {
    syncTheme()
    syncLocale()
  }, [syncLocale, syncTheme])

  useEffect(() => {
    if (workspaceId === undefined) return
    syncTheme()
    return watchHarnessTheme(document, syncTheme)
  }, [syncTheme, workspaceId])

  useEffect(() => {
    if (workspaceId !== undefined) syncLocale()
  }, [syncLocale, workspaceId])

  return (
    <div data-conversation-composer-overlay="" style={ROOT_STYLE}>
      {workspaceId !== undefined
        ? (
            <iframe
              ref={frame}
              src={source.current?.href}
              title={locale === 'zh' ? 'IDE 代码浏览器' : 'IDE code browser'}
              style={FRAME_STYLE}
              allow="clipboard-write"
              onLoad={syncFrame}
            />
          )
        : (
            <div role={target.kind === 'error' ? 'alert' : 'status'} aria-live="polite" style={STATUS_STYLE}>
              {target.kind === 'loading'
                ? locale === 'zh' ? '正在加载工作区…' : 'Loading workspace…'
                : target.kind === 'error'
                  ? locale === 'zh' ? '无法加载工作区。' : 'Workspaces could not be loaded.'
                  : locale === 'zh' ? '此会话尚未关联工作区。' : 'This session is not attached to a workspace.'}
            </div>
          )}
    </div>
  )
}

/** Bind the composer lifecycle to the native IDE view's mounted lifetime. */
function bindHarnessIdeView(
  slots: SlotRegistryLike,
  locale: LocaleRuntimeLike,
): (props: HarnessIdeViewProps) => ReactNode {
  return function BoundHarnessIdeView(props: HarnessIdeViewProps): ReactNode {
    const subscribe = useCallback((listener: () => void) => locale.subscribe(listener), [])
    const getSnapshot = useCallback(() => locale.getSnapshot(), [])
    const activeLocale = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).active
    useLayoutEffect(
      () => registerIdeComposerSuppression(slots, props.sessionId),
      [props.sessionId],
    )
    return <HarnessIdeView {...props} locale={activeLocale} />
  }
}

/** Required Harness services; the conversation package owns the target slot. */
export const inject = ['slots', 'locale']

/** Register one additive list entry; Chat remains the official default view. */
export function apply(ctx: Context): void {
  const { slots, locale } = ctx as unknown as HarnessClientContext
  const ideView = bindHarnessIdeView(slots, locale)
  slots.inject('conversation.view', () => slots.register({
    name: 'conversation.view',
    id: IDE_VIEW_ID,
    order: 20,
    label: IDE_VIEW_LABEL,
  }, ideView))
}
