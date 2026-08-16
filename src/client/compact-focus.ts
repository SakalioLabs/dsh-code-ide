export type CompactPanel = 'none' | 'rail' | 'harness'
export type HiddenCompactFocusTarget = 'files' | 'harness' | undefined
export type EditorFocusCommandAdmission = 'blocked' | 'immediate' | 'deferred'
export type QuickInputRestoreTarget = 'default' | 'search' | 'harness' | 'explorer' | 'editor'
export type QuickInputRestoreDisposition = 'clear' | 'editor' | 'default'

export interface EditorFocusCommandState {
  readonly keyboardShortcutsOpen: boolean
  readonly editorCloseIdle: boolean
  readonly documentConflictIdle: boolean
  readonly quickInputActive: boolean
  readonly compactPanel: CompactPanel
}

export interface EditorFocusCommandOwnership {
  /** Cancel only mutation surfaces whose current phase grants cancellation. */
  readonly leaveMutationSurface: () => boolean
  readonly cancelPendingChord: () => void
  readonly dismissPortals: () => void
  readonly claimQuickInputEditorRestore: () => void
  readonly closeQuickInput: () => void
  readonly clearCompactRestoreOwner: () => void
  readonly closeCompactPanel: () => void
}

/**
 * Transfer presentation ownership before an editor-targeting command runs.
 *
 * A Quick Input cleanup is intentionally deferred by one animation frame. If
 * the command focused CodeMirror immediately, that cleanup could restore the
 * old invoker afterward. Commands admitted from Quick Input therefore claim
 * its restore transaction and let the cleanup issue the final editor request.
 */
export function prepareEditorFocusCommand(
  state: EditorFocusCommandState,
  ownership: EditorFocusCommandOwnership,
): EditorFocusCommandAdmission {
  if (state.keyboardShortcutsOpen || !state.editorCloseIdle || !state.documentConflictIdle) return 'blocked'
  if (!ownership.leaveMutationSurface()) return 'blocked'

  ownership.cancelPendingChord()
  ownership.dismissPortals()
  if (state.quickInputActive) {
    ownership.claimQuickInputEditorRestore()
    ownership.closeQuickInput()
  }
  ownership.clearCompactRestoreOwner()
  if (state.compactPanel !== 'none') ownership.closeCompactPanel()
  return state.quickInputActive ? 'deferred' : 'immediate'
}

/** Decide who owns the deferred Quick Input cleanup frame. */
export function quickInputRestoreDisposition(
  target: QuickInputRestoreTarget,
  keyboardShortcutsOpen: boolean,
  editorDialogsIdle: boolean,
): QuickInputRestoreDisposition {
  if (keyboardShortcutsOpen || !editorDialogsIdle) return 'clear'
  return target === 'editor' ? 'editor' : 'default'
}

interface ContainsTarget<T> {
  contains(candidate: T): boolean
}

/**
 * Decide whether focus must be handed back to a visible compact toolbar
 * control when a desktop side surface becomes a hidden drawer.
 */
export function hiddenCompactFocusTarget<T>(
  compact: boolean,
  panel: CompactPanel,
  active: T | null,
  rail: ContainsTarget<T> | null,
  harness: ContainsTarget<T> | null,
): HiddenCompactFocusTarget {
  if (!compact || panel !== 'none' || active === null) return undefined
  if (harness?.contains(active) === true) return 'harness'
  if (rail?.contains(active) === true) return 'files'
  return undefined
}

interface FocusTargetLike<T> {
  readonly isConnected: boolean
  readonly hidden: boolean | string
  readonly parentElement: T | null
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
}

/**
 * Native `focus()` does not report failure when an ancestor is hidden or
 * inert. Check the composed ancestor chain before restoring focus so a closed
 * compact drawer can never be selected as the fallback target.
 */
export function isComposedFocusTarget<T extends FocusTargetLike<T>>(target: T | null | undefined): target is T {
  if (target === null || target === undefined || !target.isConnected) return false
  let current: T | null = target
  while (current !== null) {
    const ariaHidden = current.getAttribute('aria-hidden')
    if (current.hidden !== false
      || current.hasAttribute('inert')
      || ariaHidden !== null && ariaHidden !== 'false') return false
    current = current.parentElement
  }
  return true
}
