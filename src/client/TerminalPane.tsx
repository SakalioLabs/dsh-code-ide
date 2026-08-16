import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IdeIcon } from './icons.tsx'
import { useIdeI18n, type IdeLocale } from './i18n.tsx'
import type { IdeColorScheme } from './theme.ts'

import css from './ide.module.css'
import {
  MAX_TERMINAL_SEARCH_QUERY_UNITS,
  TerminalRuntime,
  type TerminalSearchDirection,
  type TerminalSearchRuntimeResult,
} from './terminal/runtime.ts'
import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeLease,
} from './terminal/runtime-registry.ts'
import {
  TerminalSessionStore,
  type TerminalIdentity,
  type TerminalSession,
} from './terminal/session.ts'
import { useTerminalSessions } from './terminal/useTerminalSessions.ts'
import { createBrowserTerminalEnvironment } from './terminal/xterm-environment.ts'
import '@xterm/xterm/css/xterm.css'

function identity(session: TerminalSession): TerminalIdentity {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    lifecycleId: session.lifecycleId,
  }
}

function terminalKey(session: TerminalSession): string {
  return JSON.stringify([session.workspaceId, session.id, session.lifecycleId])
}

export interface TerminalWorkspaceIdentity {
  readonly workspaceId: string
  readonly workspaceEpoch: number
}

export interface TerminalCommandTarget extends TerminalWorkspaceIdentity {
  readonly id: string
  readonly lifecycleId: number
}

export interface TerminalFocusRequest extends TerminalCommandTarget {
  readonly requestId: number
}

export interface TerminalCommandSnapshot {
  readonly workspaceId?: string
  readonly workspaceEpoch?: number
  readonly active?: TerminalCommandTarget
  readonly canCreate: boolean
  readonly canNavigate: boolean
}

export type TerminalClearResult = 'cleared' | 'stale' | 'unavailable'
export type TerminalSearchResult = TerminalSearchRuntimeResult | 'stale'
export type TerminalSearchClearResult = 'cleared' | 'stale' | 'unavailable'
export type TerminalSearchKeyboardAction = TerminalSearchDirection | 'close' | 'none'

/** Narrow command-plane seam; it exposes neither shell text nor runtime/PTY authority. */
export interface TerminalCommandPort {
  getSnapshot(): TerminalCommandSnapshot
  subscribe(listener: () => void): () => void
  create(expected: TerminalWorkspaceIdentity): boolean
  activateRelative(expected: TerminalCommandTarget, direction: -1 | 1): TerminalCommandTarget | undefined
  clear(expected: TerminalCommandTarget): TerminalClearResult
}

export function terminalCommandSnapshot(
  store: Pick<TerminalSessionStore, 'activeTerminal' | 'allTerminals' | 'maxSessions' | 'workspace'>,
  workspaceId: string | undefined,
  workspaceEpoch: number,
): TerminalCommandSnapshot {
  const active = store.activeTerminal(workspaceId)
  return {
    ...(workspaceId === undefined ? {} : {
      workspaceId,
      workspaceEpoch,
      ...(active === undefined ? {} : {
        active: { ...identity(active), workspaceEpoch },
      }),
    }),
    canCreate: workspaceId !== undefined && store.allTerminals().length < store.maxSessions,
    canNavigate: active !== undefined && store.workspace(workspaceId).terminals.length > 1,
  }
}

export function activateRelativeTerminalCommand(
  store: Pick<TerminalSessionStore, 'activateTerminal' | 'activeTerminal' | 'workspace'>,
  published: TerminalWorkspaceIdentity | undefined,
  selected: TerminalWorkspaceIdentity | undefined,
  expected: TerminalCommandTarget,
  direction: -1 | 1,
): TerminalCommandTarget | undefined {
  if (published === undefined || selected === undefined
    || published.workspaceId !== expected.workspaceId || published.workspaceEpoch !== expected.workspaceEpoch
    || selected.workspaceId !== expected.workspaceId || selected.workspaceEpoch !== expected.workspaceEpoch
    || direction !== -1 && direction !== 1) return undefined
  const workspace = store.workspace(expected.workspaceId)
  const active = store.activeTerminal(expected.workspaceId)
  const sourceIndex = workspace.terminals.findIndex(session => (
    session.id === expected.id && session.lifecycleId === expected.lifecycleId
  ))
  if (workspace.activeTerminalId !== expected.id || active === undefined || active.id !== expected.id
    || active.lifecycleId !== expected.lifecycleId || sourceIndex < 0 || workspace.terminals.length < 2) return undefined
  const target = workspace.terminals[
    (sourceIndex + direction + workspace.terminals.length) % workspace.terminals.length
  ]
  if (target === undefined || target.id === expected.id
    || !store.activateTerminal(expected.workspaceId, target.id)) return undefined
  const current = store.activeTerminal(expected.workspaceId)
  if (current === undefined || current.id !== target.id || current.lifecycleId !== target.lifecycleId) return undefined
  return { ...identity(current), workspaceEpoch: expected.workspaceEpoch }
}

/** Clear only an exact active runtime; this never sends shell input or mutates session state. */
export function clearActiveTerminalCommand(
  store: Pick<TerminalSessionStore, 'activeTerminal' | 'workspace'>,
  registry: Pick<TerminalRuntimeRegistry, 'clearIdentity'>,
  published: TerminalWorkspaceIdentity | undefined,
  selected: () => TerminalWorkspaceIdentity | undefined,
  expected: TerminalCommandTarget,
): TerminalClearResult {
  const selection = selected()
  if (published === undefined || selection === undefined
    || published.workspaceId !== expected.workspaceId || published.workspaceEpoch !== expected.workspaceEpoch
    || selection.workspaceId !== expected.workspaceId || selection.workspaceEpoch !== expected.workspaceEpoch) return 'stale'
  const workspace = store.workspace(expected.workspaceId)
  const active = store.activeTerminal(expected.workspaceId)
  if (workspace.activeTerminalId !== expected.id || active === undefined
    || active.id !== expected.id || active.lifecycleId !== expected.lifecycleId) return 'stale'
  if (!registry.clearIdentity(identity(active))) return 'unavailable'
  const currentSelection = selected()
  const currentWorkspace = store.workspace(expected.workspaceId)
  const current = store.activeTerminal(expected.workspaceId)
  return currentSelection !== undefined
    && currentSelection.workspaceId === expected.workspaceId
    && currentSelection.workspaceEpoch === expected.workspaceEpoch
    && currentWorkspace.activeTerminalId === expected.id
    && current?.id === expected.id
    && current.lifecycleId === expected.lifecycleId
    ? 'cleared'
    : 'stale'
}

/** Search one exact active emulator without reading from or writing to its PTY. */
export function searchActiveTerminalCommand(
  store: Pick<TerminalSessionStore, 'activeTerminal' | 'workspace'>,
  registry: Pick<TerminalRuntimeRegistry, 'searchIdentity'>,
  published: TerminalWorkspaceIdentity | undefined,
  selected: () => TerminalWorkspaceIdentity | undefined,
  expected: TerminalCommandTarget,
  query: string,
  direction: TerminalSearchDirection,
): TerminalSearchResult {
  const selection = selected()
  if (published === undefined || selection === undefined
    || published.workspaceId !== expected.workspaceId || published.workspaceEpoch !== expected.workspaceEpoch
    || selection.workspaceId !== expected.workspaceId || selection.workspaceEpoch !== expected.workspaceEpoch) return 'stale'
  const workspace = store.workspace(expected.workspaceId)
  const active = store.activeTerminal(expected.workspaceId)
  if (workspace.activeTerminalId !== expected.id || active === undefined
    || active.id !== expected.id || active.lifecycleId !== expected.lifecycleId) return 'stale'
  const result = registry.searchIdentity(identity(active), query, direction)
  const currentSelection = selected()
  const currentWorkspace = store.workspace(expected.workspaceId)
  const current = store.activeTerminal(expected.workspaceId)
  return currentSelection !== undefined
    && currentSelection.workspaceId === expected.workspaceId
    && currentSelection.workspaceEpoch === expected.workspaceEpoch
    && currentWorkspace.activeTerminalId === expected.id
    && current?.id === expected.id
    && current.lifecycleId === expected.lifecycleId
    ? result
    : 'stale'
}

/** Clear search selection only while its captured target remains the exact active lifecycle. */
export function clearActiveTerminalSearch(
  store: Pick<TerminalSessionStore, 'activeTerminal' | 'workspace'>,
  registry: Pick<TerminalRuntimeRegistry, 'clearSearchIdentity'>,
  published: TerminalWorkspaceIdentity | undefined,
  selected: () => TerminalWorkspaceIdentity | undefined,
  expected: TerminalCommandTarget,
): TerminalSearchClearResult {
  const selection = selected()
  if (published === undefined || selection === undefined
    || published.workspaceId !== expected.workspaceId || published.workspaceEpoch !== expected.workspaceEpoch
    || selection.workspaceId !== expected.workspaceId || selection.workspaceEpoch !== expected.workspaceEpoch) return 'stale'
  const workspace = store.workspace(expected.workspaceId)
  const active = store.activeTerminal(expected.workspaceId)
  if (workspace.activeTerminalId !== expected.id || active === undefined
    || active.id !== expected.id || active.lifecycleId !== expected.lifecycleId) return 'stale'
  if (!registry.clearSearchIdentity(identity(active))) return 'unavailable'
  const currentSelection = selected()
  const currentWorkspace = store.workspace(expected.workspaceId)
  const current = store.activeTerminal(expected.workspaceId)
  return currentSelection !== undefined
    && currentSelection.workspaceId === expected.workspaceId
    && currentSelection.workspaceEpoch === expected.workspaceEpoch
    && currentWorkspace.activeTerminalId === expected.id
    && current?.id === expected.id
    && current.lifecycleId === expected.lifecycleId
    ? 'cleared'
    : 'stale'
}

export function terminalSearchKeyboardAction(
  key: string,
  shiftKey = false,
  isComposing = false,
): TerminalSearchKeyboardAction {
  if (isComposing) return 'none'
  if (key === 'Escape') return 'close'
  if (key === 'Enter') return shiftKey ? 'previous' : 'next'
  return 'none'
}

function terminalCommandIdentity(target: TerminalCommandTarget): TerminalIdentity {
  return { workspaceId: target.workspaceId, id: target.id, lifecycleId: target.lifecycleId }
}

function sameTerminalTarget(left: TerminalCommandTarget | undefined, right: TerminalCommandTarget | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.workspaceId === right.workspaceId && left.workspaceEpoch === right.workspaceEpoch
    && left.id === right.id && left.lifecycleId === right.lifecycleId
}

interface TerminalSearchState {
  readonly target: TerminalCommandTarget
  readonly query: string
  readonly result?: TerminalSearchRuntimeResult
}

interface TerminalFocusTarget extends TerminalCommandTarget {
  readonly active: boolean
  readonly visible: boolean
}

/** Apply one monotonic focus request only to an exact, visible, mounted target. */
export function applyTerminalFocusRequest(
  request: TerminalFocusRequest | undefined,
  target: TerminalFocusTarget,
  lease: Pick<TerminalRuntimeLease, 'focus'> | undefined,
  appliedRequestId: number | undefined,
  onFocusApplied?: (requestId: number) => void,
): number | undefined {
  if (request === undefined
    || appliedRequestId !== undefined && request.requestId <= appliedRequestId
    || !target.active) return appliedRequestId
  if (request.workspaceId !== target.workspaceId || request.workspaceEpoch !== target.workspaceEpoch
    || request.id !== target.id || request.lifecycleId !== target.lifecycleId) {
    onFocusApplied?.(request.requestId)
    return request.requestId
  }
  if (!target.visible || lease === undefined) return appliedRequestId
  lease.focus()
  onFocusApplied?.(request.requestId)
  return request.requestId
}

function statusLabel(session: TerminalSession | undefined, locale: IdeLocale): string {
  if (session === undefined) return locale === 'zh' ? '无终端' : 'No terminal'
  if (session.status === 'connected') return locale === 'zh' ? '运行中' : 'Running'
  if (session.status === 'connecting') return locale === 'zh' ? '正在连接…' : 'Connecting…'
  if (session.status === 'failed') {
    return session.error ?? (locale === 'zh' ? '连接失败' : 'Connection failed')
  }
  const result = session.exitCode === undefined ? '' : ` (${String(session.exitCode)})`
  return locale === 'zh' ? `已退出${result}` : `Exited${result}`
}

function TerminalSessionSurface({
  registry,
  session,
  workspaceEpoch,
  active,
  visible,
  focusRequest,
  onFocusApplied,
  onMountError,
}: {
  registry: TerminalRuntimeRegistry
  session: TerminalSession
  workspaceEpoch: number
  active: boolean
  visible: boolean
  focusRequest?: TerminalFocusRequest
  onFocusApplied?: (requestId: number) => void
  onMountError: (session: TerminalSession, message: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const lease = useRef<TerminalRuntimeLease>()
  const wasVisible = useRef(visible)
  const appliedFocusRequest = useRef<number>()
  const focusApplied = useRef(onFocusApplied)
  focusApplied.current = onFocusApplied

  useEffect(() => {
    const element = host.current
    if (element === null) return
    let current: TerminalRuntimeLease
    try {
      current = registry.attach(identity(session), element, visible)
    } catch (error) {
      onMountError(session, error instanceof Error ? error.message : 'Failed to initialize the terminal surface.')
      return
    }
    lease.current = current
    return () => {
      if (lease.current === current) lease.current = undefined
      current.dispose()
    }
  }, [onMountError, registry, session.id, session.lifecycleId, session.workspaceId])

  useEffect(() => {
    lease.current?.setVisible(visible)
    wasVisible.current = visible
  }, [visible])

  useEffect(() => {
    appliedFocusRequest.current = applyTerminalFocusRequest(
      focusRequest,
      { ...identity(session), workspaceEpoch, active, visible },
      lease.current,
      appliedFocusRequest.current,
      focusApplied.current,
    )
  }, [
    active,
    focusRequest?.id,
    focusRequest?.lifecycleId,
    focusRequest?.requestId,
    focusRequest?.workspaceEpoch,
    focusRequest?.workspaceId,
    session.id,
    session.lifecycleId,
    session.workspaceId,
    visible,
    workspaceEpoch,
  ])

  return (
    <div
      ref={host}
      id={`terminal-panel-${session.id}-${String(session.lifecycleId)}`}
      className={css.terminalViewport}
      hidden={!visible}
      role="tabpanel"
      aria-label={session.name}
    />
  )
}

export function TerminalPane({
  workspaceId,
  workspaceEpoch,
  maxSessions,
  paneVisible = true,
  focusRequest,
  colorScheme = 'dark',
  collapsed = false,
  maximized = false,
  onFocusApplied,
  onCommandPort,
  onToggleCollapsed,
  onToggleMaximized,
}: {
  workspaceId: string | undefined
  workspaceEpoch: number
  maxSessions: number
  paneVisible?: boolean
  focusRequest?: TerminalFocusRequest
  colorScheme?: IdeColorScheme
  collapsed?: boolean
  maximized?: boolean
  onFocusApplied?: (requestId: number) => void
  onCommandPort?: (port: TerminalCommandPort) => () => void
  onToggleCollapsed?: () => void
  onToggleMaximized?: () => void
}) {
  const [store] = useState(() => new TerminalSessionStore(maxSessions))
  const [environment] = useState(() => createBrowserTerminalEnvironment(
    css.terminalSurface ?? 'dsh-code-ide-terminal-surface',
    colorScheme,
  ))
  const { locale, t } = useIdeI18n()
  useEffect(() => {
    const syncTheme = (): void => { environment.setColorScheme(colorScheme) }
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })
    return () => { observer.disconnect() }
  }, [colorScheme, environment])
  const terminalMoreMenu = useRef<HTMLDetailsElement>(null)
  const [registry] = useState(() => new TerminalRuntimeRegistry((terminalIdentity) => (
    new TerminalRuntime(terminalIdentity, environment, {
      onConnected: value => { store.markConnected(value) },
      onExited: (value, code, signal) => { store.markExited(value, code, signal) },
      onError: (value, message) => { store.noteError(value, message) },
      onTransportClosed: (value, message) => { store.markTransportClosed(value, message) },
    })
  )))
  const snapshot = useTerminalSessions(store)
  const [actionError, setActionError] = useState<string>()
  const [pendingTerminations, setPendingTerminations] = useState<ReadonlySet<string>>(() => new Set())
  const [terminalSearch, setTerminalSearch] = useState<TerminalSearchState>()
  const terminalSearchInput = useRef<HTMLInputElement>(null)
  const terminalSearchRef = useRef<TerminalSearchState>()
  terminalSearchRef.current = terminalSearch
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const selectedWorkspace = useRef<TerminalWorkspaceIdentity>()
  selectedWorkspace.current = workspaceId === undefined ? undefined : { workspaceId, workspaceEpoch }
  const onMountError = useRef((session: TerminalSession, message: string): void => {
    store.markTransportClosed(identity(session), message)
  }).current

  useEffect(() => {
    if (workspaceId !== undefined) store.ensureWorkspaceTerminal(workspaceId)
  }, [store, workspaceId])

  const createTerminalForWorkspace = useCallback((expected: TerminalWorkspaceIdentity): boolean => {
    const selected = selectedWorkspace.current
    if (selected === undefined || selected.workspaceId !== expected.workspaceId
      || selected.workspaceEpoch !== expected.workspaceEpoch) return false
    setActionError(undefined)
    if (store.createTerminal(expected.workspaceId) !== undefined) return true
    setActionError(`Terminal limit reached (${String(store.maxSessions)}).`)
    return false
  }, [store])

  useEffect(() => {
    if (onCommandPort === undefined) return
    let alive = true
    const published = workspaceId === undefined ? undefined : { workspaceId, workspaceEpoch }
    const dispose = onCommandPort({
      getSnapshot: () => alive
        ? terminalCommandSnapshot(store, published?.workspaceId, published?.workspaceEpoch ?? workspaceEpoch)
        : { canCreate: false, canNavigate: false },
      subscribe: listener => alive ? store.subscribe(listener) : () => undefined,
      create: (expected) => {
        if (!alive || published === undefined || published.workspaceId !== expected.workspaceId
          || published.workspaceEpoch !== expected.workspaceEpoch) return false
        return createTerminalForWorkspace(expected)
      },
      activateRelative: (expected, direction) => alive
        ? activateRelativeTerminalCommand(store, published, selectedWorkspace.current, expected, direction)
        : undefined,
      clear: expected => alive
        ? clearActiveTerminalCommand(store, registry, published, () => selectedWorkspace.current, expected)
        : 'stale',
    })
    return () => {
      alive = false
      dispose()
    }
  }, [createTerminalForWorkspace, onCommandPort, registry, store, workspaceEpoch, workspaceId])

  const workspace = store.workspace(workspaceId)
  const active = store.activeTerminal(workspaceId)
  const allSessions = [...snapshot.workspaces.values()].flatMap(value => value.terminals)

  useEffect(() => {
    const target = terminalSearch?.target
    if (target === undefined) return
    const current = active === undefined || workspaceId === undefined
      ? undefined
      : { ...identity(active), workspaceId, workspaceEpoch }
    if (sameTerminalTarget(target, current)
      && !pendingTerminations.has(JSON.stringify([target.workspaceId, target.id, target.lifecycleId]))) return
    registry.clearSearchIdentity(terminalCommandIdentity(target))
    setTerminalSearch(undefined)
  }, [
    active?.id,
    active?.lifecycleId,
    pendingTerminations,
    registry,
    terminalSearch?.target,
    workspaceEpoch,
    workspaceId,
  ])

  useEffect(() => {
    if (collapsed || terminalSearch === undefined || active === undefined) return
    const selected = selectedWorkspace.current
    const current = selected === undefined
      ? undefined
      : { ...identity(active), workspaceEpoch: selected.workspaceEpoch }
    if (!sameTerminalTarget(terminalSearch.target, current)) return
    terminalSearchInput.current?.focus({ preventScroll: true })
  }, [
    collapsed,
    active?.id,
    active?.lifecycleId,
    terminalSearch?.target.id,
    terminalSearch?.target.lifecycleId,
    terminalSearch?.target.workspaceEpoch,
    terminalSearch?.target.workspaceId,
    workspaceEpoch,
    workspaceId,
  ])

  useEffect(() => () => {
    const current = terminalSearchRef.current
    if (current !== undefined) registry.clearSearchIdentity(terminalCommandIdentity(current.target))
  }, [registry])

  const createTerminal = (): void => {
    if (workspaceId === undefined) return
    createTerminalForWorkspace({ workspaceId, workspaceEpoch })
  }

  const clearTerminal = (): void => {
    if (workspaceId === undefined || active === undefined || pendingTerminations.has(terminalKey(active))) return
    setActionError(undefined)
    const published = { workspaceId, workspaceEpoch }
    const result = clearActiveTerminalCommand(
      store,
      registry,
      published,
      () => selectedWorkspace.current,
      { ...identity(active), workspaceEpoch },
    )
    if (result === 'stale') setActionError('The active terminal changed before it could be cleared.')
    else if (result === 'unavailable') setActionError('The active terminal runtime is not available.')
  }

  const openTerminalSearch = (): void => {
    if (workspaceId === undefined || active === undefined || pendingTerminations.has(terminalKey(active))) return
    const target = { ...identity(active), workspaceEpoch }
    if (sameTerminalTarget(terminalSearch?.target, target)) {
      terminalSearchInput.current?.focus({ preventScroll: true })
      return
    }
    if (terminalSearch !== undefined) {
      registry.clearSearchIdentity(terminalCommandIdentity(terminalSearch.target))
    }
    setTerminalSearch({ target, query: '' })
  }

  const runTerminalSearch = (direction: TerminalSearchDirection): void => {
    const current = terminalSearch
    if (current === undefined) return
    const published = workspaceId === undefined ? undefined : { workspaceId, workspaceEpoch }
    const result = searchActiveTerminalCommand(
      store,
      registry,
      published,
      () => selectedWorkspace.current,
      current.target,
      current.query,
      direction,
    )
    if (result === 'stale') {
      registry.clearSearchIdentity(terminalCommandIdentity(current.target))
      setTerminalSearch(undefined)
      return
    }
    setTerminalSearch(value => value !== undefined && sameTerminalTarget(value.target, current.target)
      ? { ...value, result }
      : value)
  }

  const closeTerminalSearch = (): void => {
    const current = terminalSearch
    if (current === undefined) return
    const published = workspaceId === undefined ? undefined : { workspaceId, workspaceEpoch }
    const result = clearActiveTerminalSearch(
      store,
      registry,
      published,
      () => selectedWorkspace.current,
      current.target,
    )
    if (result !== 'cleared') {
      registry.clearSearchIdentity(terminalCommandIdentity(current.target))
    }
    setTerminalSearch(undefined)
    if (result === 'cleared') registry.focusIdentity(terminalCommandIdentity(current.target))
  }

  const closeTerminal = async (session: TerminalSession): Promise<void> => {
    const key = terminalKey(session)
    if (pendingTerminations.has(key)) return
    setActionError(undefined)
    setPendingTerminations(current => new Set(current).add(key))
    try {
      try { await registry.terminateIdentity(identity(session)) } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Unable to stop the terminal.')
      }
      registry.disposeIdentity(identity(session))
      store.closeTerminal(session.workspaceId, session.id, session.lifecycleId)
    } finally {
      setPendingTerminations((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const restartTerminal = async (): Promise<void> => {
    if (active === undefined) return
    const key = terminalKey(active)
    if (pendingTerminations.has(key)) return
    setActionError(undefined)
    setPendingTerminations(current => new Set(current).add(key))
    try {
      try {
        await registry.terminateIdentity(identity(active))
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Unable to stop the current terminal.')
        return
      }
      registry.disposeIdentity(identity(active))
      store.restartTerminal(active.workspaceId, active.id, active.lifecycleId)
    } finally {
      setPendingTerminations((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const renameTerminal = (): void => {
    if (active === undefined) return
    const value = window.prompt(t('renameTerminal'), active.name)
    if (value === null) return
    setActionError(store.renameTerminal(active.workspaceId, active.id, value)
      ? undefined
      : 'Terminal names must contain 1–64 characters.')
  }

  const moveActive = (event: ReactKeyboardEvent, terminalId: string): void => {
    if (workspaceId === undefined || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const index = workspace.terminals.findIndex(item => item.id === terminalId)
    if (index < 0 || workspace.terminals.length < 2) return
    event.preventDefault()
    const offset = event.key === 'ArrowLeft' ? -1 : 1
    const next = workspace.terminals[(index + offset + workspace.terminals.length) % workspace.terminals.length]
    if (next !== undefined) {
      store.activateTerminal(workspaceId, next.id)
      tabButtons.current.get(next.id)?.focus()
    }
  }

  return (
    <section
      className={css.terminalRoot}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-maximized={maximized ? 'true' : 'false'}
      aria-label={t('terminal')}
    >
      <header className={css.terminalToolbar}>
        <div className={css.terminalTitleGroup}>
          <span className={css.terminalTitle}>{t('terminal')}</span>
          {workspace.terminals.length > 1 && (
            <span className={css.terminalCountBadge} aria-label={t('terminalSessionCount', { count: workspace.terminals.length })}>
              {workspace.terminals.length}
            </span>
          )}
        </div>
        <div className={css.terminalTabs} role="tablist" aria-label={t('terminalSessions')}>
          {workspace.terminals.map(session => (
            <div
              key={session.id}
              className={session.id === workspace.activeTerminalId ? css.terminalTabActive : css.terminalTab}
            >
              <button
                type="button"
                role="tab"
                ref={(element) => {
                  if (element === null) tabButtons.current.delete(session.id)
                  else tabButtons.current.set(session.id, element)
                }}
                tabIndex={session.id === workspace.activeTerminalId ? 0 : -1}
                aria-selected={session.id === workspace.activeTerminalId}
                aria-controls={`terminal-panel-${session.id}-${String(session.lifecycleId)}`}
                title={`${session.name} — ${statusLabel(session, locale)}`}
                onClick={() => {
                  store.activateTerminal(session.workspaceId, session.id)
                  registry.focusIdentity(identity(session))
                }}
                onKeyDown={event => { moveActive(event, session.id) }}
              >
                <span className={css.terminalState} data-status={session.status} aria-hidden="true" />
                <span>{session.name}</span>
              </button>
              <button
                type="button"
                className={css.terminalTabClose}
                aria-label={t('killNamedTerminal', { name: session.name })}
                title={t('killNamedTerminal', { name: session.name })}
                disabled={pendingTerminations.has(terminalKey(session))}
                onClick={() => { void closeTerminal(session) }}
              >×</button>
            </div>
          ))}
        </div>
        <span className={actionError === undefined ? css.terminalStatus : css.terminalError} title={actionError ?? active?.error} aria-live="polite">
          {workspaceId === undefined
            ? t('noWorkspace')
            : active !== undefined && pendingTerminations.has(terminalKey(active))
              ? t('stopping')
              : actionError ?? statusLabel(active, locale)}
        </span>
        <div className={css.terminalActions} role="group" aria-label={t('terminalActions')}>
          <button
            type="button"
            title={t('newTerminal')}
            aria-label={t('newTerminal')}
            disabled={workspaceId === undefined || allSessions.length >= store.maxSessions}
            onClick={createTerminal}
          ><span className={css.terminalCreateGlyph} aria-hidden="true">+</span></button>
          <details
            ref={terminalMoreMenu}
            className={css.terminalMore}
            onBlur={event => {
              const next = event.relatedTarget
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                event.currentTarget.removeAttribute('open')
              }
            }}
          >
            <summary title={t('moreActions')} aria-label={t('moreActions')}>
              <IdeIcon name="more" />
            </summary>
            <div className={css.terminalMoreMenu}>
              <button
                type="button"
                aria-expanded={terminalSearch !== undefined}
                disabled={active === undefined || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => { terminalMoreMenu.current?.removeAttribute('open'); openTerminalSearch() }}
              >{t('findInTerminal')}</button>
              <button
                type="button"
                disabled={active === undefined || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => { terminalMoreMenu.current?.removeAttribute('open'); clearTerminal() }}
              >{t('clearTerminal')}</button>
              <span className={css.terminalMenuSeparator} aria-hidden="true" />
              <button
                type="button"
                disabled={active === undefined || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => { terminalMoreMenu.current?.removeAttribute('open'); renameTerminal() }}
              >{t('renameTerminal')}</button>
              <button
                type="button"
                disabled={active === undefined || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => { terminalMoreMenu.current?.removeAttribute('open'); void restartTerminal() }}
              >{t('restartTerminal')}</button>
              <button
                type="button"
                disabled={active?.status !== 'connected' || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => {
                  terminalMoreMenu.current?.removeAttribute('open')
                  if (active !== undefined && !registry.interruptIdentity(identity(active))) {
                    setActionError(locale === 'zh' ? '终端尚未准备好接收输入。' : 'The terminal is not ready for input.')
                  }
                }}
              >{t('interruptTerminal')}</button>
              <button
                type="button"
                disabled={active === undefined || (active !== undefined && pendingTerminations.has(terminalKey(active)))}
                onClick={() => {
                  terminalMoreMenu.current?.removeAttribute('open')
                  if (active !== undefined) void closeTerminal(active)
                }}
              >{t('killTerminal')}</button>
            </div>
          </details>
          {onToggleMaximized !== undefined && !collapsed && (
            <button
              type="button"
              title={maximized ? t('restorePanel') : t('maximizePanel')}
              aria-label={maximized ? t('restorePanel') : t('maximizePanel')}
              aria-pressed={maximized}
              onClick={onToggleMaximized}
            >
              <IdeIcon name={maximized ? 'panel-restore' : 'panel-maximize'} />
            </button>
          )}
          {onToggleCollapsed !== undefined && (
            <button
              type="button"
              title={collapsed ? t('expandPanel') : t('collapsePanel')}
              aria-label={collapsed ? t('expandPanel') : t('collapsePanel')}
              aria-expanded={!collapsed}
              aria-controls="terminal-panel-body"
              onClick={onToggleCollapsed}
            >
              <IdeIcon name={collapsed ? 'panel-expand' : 'panel-collapse'} />
            </button>
          )}
        </div>
      </header>
      <div id="terminal-panel-body" className={css.terminalBody} hidden={collapsed}>
        {terminalSearch !== undefined && (
          <div
            className={css.terminalFind}
            role="search"
            aria-label={t('findInTerminal')}
            onKeyDown={event => {
              const action = terminalSearchKeyboardAction(
                event.key,
                event.shiftKey,
                event.nativeEvent.isComposing || event.keyCode === 229,
              )
              if (action === 'none' || action !== 'close' && event.target !== terminalSearchInput.current) return
              event.preventDefault()
              event.stopPropagation()
              if (action === 'close') closeTerminalSearch()
              else runTerminalSearch(action)
            }}
          >
            <input
              ref={terminalSearchInput}
              aria-label={t('searchTerminalBuffer')}
              value={terminalSearch.query}
              maxLength={MAX_TERMINAL_SEARCH_QUERY_UNITS}
              spellCheck={false}
              onChange={event => {
                registry.clearSearchIdentity(terminalCommandIdentity(terminalSearch.target))
                setTerminalSearch({ target: terminalSearch.target, query: event.currentTarget.value })
              }}
            />
            <button
              type="button"
              title={t('previousMatchWithKey')}
              aria-label={t('previousMatch')}
              disabled={terminalSearch.query.length === 0}
              onClick={() => { runTerminalSearch('previous') }}
            >↑</button>
            <button
              type="button"
              title={t('nextMatchWithKey')}
              aria-label={t('nextMatch')}
              disabled={terminalSearch.query.length === 0}
              onClick={() => { runTerminalSearch('next') }}
            >↓</button>
            <span className={css.terminalFindStatus} role="status" aria-live="polite">
              {terminalSearch.result === 'not-found'
                ? t('noResults')
                : terminalSearch.result === 'invalid'
                  ? t('searchLength')
                  : terminalSearch.result === 'unavailable'
                    ? t('searchUnavailable')
                    : ''}
            </span>
            <button
              type="button"
              title={t('closeFind')}
              aria-label={t('closeFind')}
              onClick={closeTerminalSearch}
            >×</button>
          </div>
        )}
        {allSessions.map(session => {
          const active = session.workspaceId === workspaceId && session.id === workspace.activeTerminalId
          return (
            <TerminalSessionSurface
              key={`${session.workspaceId}:${session.id}:${String(session.lifecycleId)}`}
              registry={registry}
              session={session}
              workspaceEpoch={workspaceEpoch}
              active={active}
              visible={paneVisible && !collapsed && active}
              {...(focusRequest === undefined ? {} : { focusRequest })}
              {...(onFocusApplied === undefined ? {} : { onFocusApplied })}
              onMountError={onMountError}
            />
          )
        })}
        {workspaceId === undefined
          ? <div className={css.empty}>{t('selectWorkspaceForTerminal')}</div>
          : workspace.terminals.length === 0
            ? <div className={css.empty}>{t('noTerminal')}</div>
            : null}
      </div>
    </section>
  )
}
