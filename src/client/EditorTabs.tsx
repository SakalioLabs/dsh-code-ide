import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import type {
  DocumentIdentity,
  DocumentTabDropPlacement,
  EditorTab,
} from './documents/session.ts'
import css from './ide.module.css'

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

export const EDITOR_TAB_DRAG_MIME = 'application/x-dsh-editor-tab'

let editorTabDragSequence = 0

export interface EditorTabDragSession {
  readonly token: string
  readonly source: DocumentIdentity
}

function createEditorTabDragToken(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid !== undefined) return `dsh-editor-tab-${randomUuid}`
  editorTabDragSequence += 1
  return `dsh-editor-tab-${Date.now().toString(36)}-${editorTabDragSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Keep exact document identity in memory; HTML drag data carries only this opaque token. */
export function beginEditorTabDrag(source: DocumentIdentity): EditorTabDragSession {
  return Object.freeze({
    token: createEditorTabDragToken(),
    source: Object.freeze({ ...source }),
  })
}

/** An external/stale drag payload cannot supply or replace a document path. */
export function resolveEditorTabDrag(
  session: EditorTabDragSession | undefined,
  token: string,
): DocumentIdentity | undefined {
  return session !== undefined && session.token === token ? session.source : undefined
}

export function editorTabDropPlacement(
  clientX: number,
  targetLeft: number,
  targetWidth: number,
): DocumentTabDropPlacement {
  return clientX < targetLeft + Math.max(0, targetWidth) / 2 ? 'before' : 'after'
}

export type EditorTabNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export interface EditorTabKeyboardInput {
  readonly key: string
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

export type EditorTabKeyboardAction =
  | { readonly kind: 'activate'; readonly index: number }
  | { readonly kind: 'close'; readonly index: number }
  | { readonly kind: 'none' }

export type EditorTabKeyboardReorderAction =
  | {
    readonly kind: 'reorder'
    readonly targetIndex: number
    readonly placement: DocumentTabDropPlacement
  }
  | { readonly kind: 'none' }

export interface EditorTabAuxiliaryInput {
  readonly button: number
}

export type EditorTabAuxiliaryAction = 'close' | 'none'

/** Middle-click is the only auxiliary gesture owned by the tab strip. */
export function editorTabAuxiliaryAction(input: EditorTabAuxiliaryInput): EditorTabAuxiliaryAction {
  return input.button === 1 ? 'close' : 'none'
}

export interface EditorTabFocusRequest {
  /** Monotonic presentation request identifier. */
  readonly requestId: number
  /** Omit to focus the current active tab. */
  readonly path?: string
}

export interface EditorTabsProps {
  readonly tabs: readonly EditorTab[]
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly activePath: string | undefined
  /** ID of the single editor panel controlled by every tab. */
  readonly panelId: string
  readonly label?: string
  readonly onActivate: (identity: DocumentIdentity) => void
  readonly onRequestClose: (identity: DocumentIdentity) => void
  /** Exact reorder request; the document domain remains the authority. */
  readonly onReorder?: (
    source: DocumentIdentity,
    target: DocumentIdentity,
    placement: DocumentTabDropPlacement,
  ) => void
  /** Controlled workbench drag session shared by every editor group. */
  readonly dragSession?: EditorTabDragSession | undefined
  /** Publishes only the component-owned, frozen in-memory drag session. */
  readonly onDragSessionChange?: (session: EditorTabDragSession | undefined) => void
  /** Screen-reader explanation of the pointer drop halves. */
  readonly dragDescription?: string
  /**
   * Requests presentation focus after a domain transition such as closing a
   * tab. The request is acknowledged only after its exact target exists and
   * the component has applied focus to it.
   */
  readonly focusRequest?: EditorTabFocusRequest
  readonly onFocusApplied?: (requestId: number) => void
}

/** Pure ARIA-tab keyboard decision. Navigation wraps like VS Code's tab strip. */
export function editorTabKeyboardAction(
  input: EditorTabKeyboardInput,
  currentIndex: number,
  tabCount: number,
): EditorTabKeyboardAction {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount
    || input.altKey === true || input.ctrlKey === true || input.metaKey === true) {
    return { kind: 'none' }
  }

  switch (input.key) {
    case 'ArrowLeft':
      return { kind: 'activate', index: (currentIndex - 1 + tabCount) % tabCount }
    case 'ArrowRight':
      return { kind: 'activate', index: (currentIndex + 1) % tabCount }
    case 'Home':
      return { kind: 'activate', index: 0 }
    case 'End':
      return { kind: 'activate', index: tabCount - 1 }
    case 'Delete':
      return { kind: 'close', index: currentIndex }
    default:
      return { kind: 'none' }
  }
}

/** Alt+Shift+Arrow moves a tab by one position without wrapping at either edge. */
export function editorTabKeyboardReorderAction(
  input: EditorTabKeyboardInput,
  currentIndex: number,
  tabCount: number,
): EditorTabKeyboardReorderAction {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount
    || input.altKey !== true || input.shiftKey !== true
    || input.ctrlKey === true || input.metaKey === true) {
    return { kind: 'none' }
  }

  if (input.key === 'ArrowLeft' && currentIndex > 0) {
    return { kind: 'reorder', targetIndex: currentIndex - 1, placement: 'before' }
  }
  if (input.key === 'ArrowRight' && currentIndex + 1 < tabCount) {
    return { kind: 'reorder', targetIndex: currentIndex + 1, placement: 'after' }
  }
  return { kind: 'none' }
}

export function editorTabAccessibleLabel(tab: EditorTab): string {
  const status: string[] = []
  if (tab.readOnlyPresentation !== undefined) {
    status.push(tab.readOnlyPresentation.reason === 'binary' ? 'binary file, read-only' : 'large file preview, read-only')
  }
  if (tab.dirty) status.push('unsaved changes')
  if (tab.externalState === 'modified') status.push('modified outside the IDE')
  if (tab.externalState === 'deleted') status.push('deleted outside the IDE')
  if (tab.pendingSaveId !== undefined) status.push('saving')
  if (tab.pendingReloadId !== undefined) status.push('reloading')
  if (tab.saveOutcome === 'unknown' || tab.unknownSave !== undefined) status.push('save outcome unknown')
  if (tab.saveError !== undefined) status.push('save failed')
  if (tab.loadError !== undefined) status.push('load failed')
  return status.length === 0 ? tab.path : `${tab.path}, ${status.join(', ')}`
}

export function editorTabIdentity(
  tab: EditorTab,
  workspaceId: string,
  workspaceEpoch: number,
): DocumentIdentity {
  return {
    workspaceId,
    workspaceEpoch,
    path: tab.path,
    lifecycleId: tab.lifecycleId,
  }
}

/** Shared by the tab strip and its single active tabpanel. */
export function editorTabDomId(panelId: string, index: number): string {
  return `${panelId}-tab-${index}`
}

/**
 * Resolve a requested presentation target without silently acknowledging a
 * stale path. An omitted path means the current active tab.
 */
export function editorTabFocusTargetIndex(
  tabs: readonly EditorTab[],
  activePath: string | undefined,
  request: EditorTabFocusRequest,
): number {
  const path = request.path ?? activePath
  return path === undefined ? -1 : tabs.findIndex(tab => tab.path === path)
}

function tabRefKey(tab: EditorTab): string {
  return `${tab.path}\u0000${tab.lifecycleId}`
}

function statusGlyph(tab: EditorTab): string | undefined {
  if (tab.saveOutcome === 'unknown' || tab.unknownSave !== undefined) return '?'
  if (tab.pendingSaveId !== undefined) return '~'
  if (tab.externalState !== undefined) return '!'
  if (tab.dirty) return '*'
  return undefined
}

/** Accessible, presentation-only adapter over the document session tabs. */
export function EditorTabs({
  tabs,
  workspaceId,
  workspaceEpoch,
  activePath,
  panelId,
  label = 'Open editors',
  onActivate,
  onRequestClose,
  onReorder,
  dragSession,
  onDragSessionChange,
  dragDescription = 'Drag this tab onto the left half of another tab to place it before, or the right half to place it after. Use Alt+Shift+Left or Right Arrow to move it one position with the keyboard.',
  focusRequest,
  onFocusApplied,
}: EditorTabsProps) {
  const tabElements = useRef(new Map<string, HTMLButtonElement>())
  const tabWrappers = useRef(new Map<string, HTMLDivElement>())
  const ownedDragSession = useRef<EditorTabDragSession>()
  const dropTarget = useRef<HTMLDivElement>()
  const suppressDragActivation = useRef(false)
  const acknowledgedRequest = useRef<number>()
  const focusApplied = useRef(onFocusApplied)
  focusApplied.current = onFocusApplied

  const selectedIndex = activePath === undefined
    ? -1
    : tabs.findIndex(tab => tab.path === activePath)
  // A temporarily inconsistent parent snapshot must not leave a non-empty
  // tablist without a keyboard entry point. It does not fabricate selection.
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : tabs.length === 0 ? -1 : 0
  const activeTab = selectedIndex < 0 ? undefined : tabs[selectedIndex]
  const activeRefKey = activeTab === undefined ? undefined : tabRefKey(activeTab)
  const tabOrderSignature = tabs.map(tabRefKey).join('\u0001')

  useClientLayoutEffect(() => {
    if (activeRefKey === undefined) return
    tabWrappers.current.get(activeRefKey)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeRefKey, tabOrderSignature])

  useClientLayoutEffect(() => {
    if (focusRequest === undefined || acknowledgedRequest.current === focusRequest.requestId) return
    const targetIndex = editorTabFocusTargetIndex(tabs, activePath, focusRequest)
    const target = targetIndex < 0 ? undefined : tabs[targetIndex]
    if (target === undefined) return
    const element = tabElements.current.get(tabRefKey(target))
    if (element === undefined) return
    element.focus({ preventScroll: true })
    if (document.activeElement !== element) return
    tabWrappers.current.get(tabRefKey(target))?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    acknowledgedRequest.current = focusRequest.requestId
    focusApplied.current?.(focusRequest.requestId)
  }, [activePath, focusRequest, tabs])

  const applyKeyboardAction = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (onReorder !== undefined) {
      const reorder = editorTabKeyboardReorderAction(event, index, tabs.length)
      if (reorder.kind === 'reorder') {
        const source = tabs[index]
        const target = tabs[reorder.targetIndex]
        if (source !== undefined && target !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          onReorder(
            editorTabIdentity(source, workspaceId, workspaceEpoch),
            editorTabIdentity(target, workspaceId, workspaceEpoch),
            reorder.placement,
          )
          return
        }
      }
    }

    const action = editorTabKeyboardAction(event, index, tabs.length)
    if (action.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()

    const target = tabs[action.index]
    if (target === undefined) return
    const identity = editorTabIdentity(target, workspaceId, workspaceEpoch)
    if (action.kind === 'close') {
      onRequestClose(identity)
      return
    }

    onActivate(identity)
    const element = tabElements.current.get(tabRefKey(target))
    element?.focus({ preventScroll: true })
    tabWrappers.current.get(tabRefKey(target))?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const currentDragSession = (): EditorTabDragSession | undefined => (
    dragSession ?? ownedDragSession.current
  )

  const clearDragSession = (): void => {
    if (currentDragSession() === undefined) return
    ownedDragSession.current = undefined
    onDragSessionChange?.(undefined)
  }

  const clearDropTarget = (): void => {
    if (dropTarget.current === undefined) return
    dropTarget.current.removeAttribute('data-drop-position')
    dropTarget.current = undefined
  }
  useClientLayoutEffect(() => {
    if (dragSession !== undefined || dropTarget.current === undefined) return
    dropTarget.current.removeAttribute('data-drop-position')
    dropTarget.current = undefined
  }, [dragSession])


  const dragDescriptionId = `${panelId}-tab-drag-description`

  return (
    <>
      {onReorder === undefined ? null : (
        <span id={dragDescriptionId} style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}>{dragDescription}</span>
      )}
      <div className={css.editorTabs} role="tablist" aria-label={label} aria-orientation="horizontal">
        {tabs.map((tab, index) => {
          const selected = index === selectedIndex
          const refKey = tabRefKey(tab)
          const accessibleLabel = editorTabAccessibleLabel(tab)
          const glyph = statusGlyph(tab)
          const identity = editorTabIdentity(tab, workspaceId, workspaceEpoch)
          return (
            <div
              key={refKey}
              ref={element => {
                if (element === null) tabWrappers.current.delete(refKey)
                else tabWrappers.current.set(refKey, element)
              }}
              role="presentation"
              className={selected ? css.tabActive : css.tab}
              data-active={selected || undefined}
              data-dirty={tab.dirty || undefined}
              data-external={tab.externalState}
              onDragOver={event => {
                if (onReorder === undefined || currentDragSession() === undefined
                  || !Array.from(event.dataTransfer.types).includes(EDITOR_TAB_DRAG_MIME)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const bounds = event.currentTarget.getBoundingClientRect()
                const placement = editorTabDropPlacement(event.clientX, bounds.left, bounds.width)
                if (dropTarget.current !== event.currentTarget) clearDropTarget()
                event.currentTarget.dataset.dropPosition = placement
                dropTarget.current = event.currentTarget
              }}
              onDragLeave={event => {
                const relatedTarget = event.relatedTarget
                if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return
                if (dropTarget.current === event.currentTarget) clearDropTarget()
              }}
              onDrop={event => {
                const source = resolveEditorTabDrag(
                  currentDragSession(),
                  event.dataTransfer.getData(EDITOR_TAB_DRAG_MIME),
                )
                if (source === undefined || onReorder === undefined) {
                  clearDropTarget()
                  return
                }
                event.preventDefault()
                event.stopPropagation()
                const bounds = event.currentTarget.getBoundingClientRect()
                const placement = editorTabDropPlacement(event.clientX, bounds.left, bounds.width)
                clearDropTarget()
                onReorder(source, identity, placement)
                clearDragSession()
              }}
              onMouseDown={event => {
                if (editorTabAuxiliaryAction(event) === 'close') event.preventDefault()
              }}
              onAuxClick={event => {
                if (editorTabAuxiliaryAction(event) !== 'close') return
                event.preventDefault()
                event.stopPropagation()
                onRequestClose(identity)
              }}
            >
              <button
                id={editorTabDomId(panelId, index)}
                ref={element => {
                  if (element === null) tabElements.current.delete(refKey)
                  else tabElements.current.set(refKey, element)
                }}
                type="button"
                role="tab"
                tabIndex={index === rovingIndex ? 0 : -1}
                aria-selected={selected}
                aria-controls={panelId}
                aria-label={accessibleLabel}
                aria-describedby={onReorder === undefined ? undefined : dragDescriptionId}
                title={accessibleLabel}
                className={css.tabSelect}
                draggable={onReorder !== undefined}
                onDragStart={event => {
                  if (onReorder === undefined) {
                    event.preventDefault()
                    return
                  }
                  const session = beginEditorTabDrag(identity)
                  ownedDragSession.current = session
                  suppressDragActivation.current = true
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(EDITOR_TAB_DRAG_MIME, session.token)
                  onDragSessionChange?.(session)
                }}
                onDragEnd={() => {
                  clearDragSession()
                  clearDropTarget()
                  globalThis.setTimeout(() => {
                    suppressDragActivation.current = false
                  }, 0)
                }}
                onClick={() => {
                  if (suppressDragActivation.current) {
                    suppressDragActivation.current = false
                    return
                  }
                  onActivate(identity)
                }}
                onKeyDown={event => applyKeyboardAction(event, index)}
              >
                {glyph === undefined ? null : (
                  <span className={css.editorTabStatus} aria-hidden="true" data-status={
                    tab.saveOutcome === 'unknown' || tab.unknownSave !== undefined ? 'unknown'
                      : tab.pendingSaveId !== undefined ? 'saving'
                        : tab.externalState ?? 'dirty'
                  }>{glyph}</span>
                )}
                <span>{tab.name}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                className={css.tabClose}
                aria-label={`Close ${tab.path}`}
                title={`Close ${tab.path}`}
                onClick={event => {
                  event.stopPropagation()
                  onRequestClose(identity)
                }}
              >&times;</button>
            </div>
          )
        })}
      </div>
    </>
  )
}
