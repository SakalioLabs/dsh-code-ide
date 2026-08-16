import type { CommandRegistry } from './registry.ts'
import type { CommandExecutionOutcome } from './types.ts'
import type { ShortcutDecision } from './keybindings.ts'

export interface DispatchableKeyboardEvent {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly defaultPrevented: boolean
  readonly isComposing: boolean
  readonly repeat: boolean
  readonly target?: EventTarget | null
  readonly keyCode?: number
  getModifierState?(key: string): boolean
  preventDefault(): void
  stopPropagation?(): void
}

interface ClosestTarget {
  closest(selector: string): unknown
}

function closestTarget(target: EventTarget | null | undefined): ClosestTarget | undefined {
  return typeof target === 'object' && target !== null && 'closest' in target
    && typeof (target as ClosestTarget).closest === 'function'
    ? target as ClosestTarget
    : undefined
}

/** Explicit outer-document exclusion seam for terminal surfaces. */
export function isWorkbenchShortcutSuppressedTarget(target: EventTarget | null | undefined): boolean {
  const candidate = closestTarget(target)
  if (candidate === undefined) return false
  try { return candidate.closest('[data-workbench-shortcuts="terminal"]') != null } catch { return true }
}

function isExactTerminalTarget(target: EventTarget | null | undefined): boolean {
  const candidate = closestTarget(target)
  if (candidate === undefined) return false
  try { return candidate.closest('[data-workbench-shortcuts="terminal"]') != null } catch { return false }
}

function isOriginalPaletteStroke(event: DispatchableKeyboardEvent, platform: 'mac' | 'windows' | 'linux'): boolean {
  if (event.key === 'F1') {
    return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  }
  if (event.key.toLocaleLowerCase('en-US') !== 'p' || !event.shiftKey || event.altKey) return false
  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

/**
 * Narrow capture-phase xterm bridge. It admits only an unchanged built-in
 * Command Palette default; every user binding and every other terminal key
 * remains owned by the PTY surface.
 */
export function dispatchTerminalPaletteShortcut<C>(
  event: DispatchableKeyboardEvent,
  registry: CommandRegistry<C>,
  onOutcome?: (outcome: CommandExecutionOutcome) => void,
  onShortcutDecision?: (decision: ShortcutDecision) => void,
): boolean {
  const platform = registry.keybindings.store.getSnapshot().platform
  if (!isExactTerminalTarget(event.target) || event.defaultPrevented || event.isComposing || event.repeat
    || event.key === 'Process' || event.keyCode === 229
    || event.getModifierState?.('AltGraph') === true
    || !isOriginalPaletteStroke(event, platform)) return false
  registry.keybindings.cancelPendingChord()
  const decision = registry.keybindings.acceptKeyboardEvent(event)
  const expectedBindingId = event.key === 'F1' ? 'f1' : 'primary'
  if (decision.kind !== 'execute'
    || decision.commandId !== 'workbench.action.showCommands'
    || decision.source !== 'default'
    || decision.bindingId !== expectedBindingId) {
    registry.keybindings.cancelPendingChord()
    return false
  }
  event.preventDefault()
  event.stopPropagation?.()
  onShortcutDecision?.(decision)
  void registry.execute(decision.commandId).then(outcome => { onOutcome?.(outcome) })
  return true
}

/**
 * The only outer-document shortcut dispatcher. Local editor/terminal keymaps
 * win by preventing default before their event reaches this boundary.
 */
export function dispatchWorkbenchShortcut<C>(
  event: DispatchableKeyboardEvent,
  registry: CommandRegistry<C>,
  onOutcome?: (outcome: CommandExecutionOutcome) => void,
  onShortcutDecision?: (decision: ShortcutDecision) => void,
): boolean {
  if (event.defaultPrevented || event.isComposing || event.key === 'Process' || event.keyCode === 229
    || isWorkbenchShortcutSuppressedTarget(event.target)) {
    registry.keybindings.cancelPendingChord()
    return false
  }
  if (event.repeat) return false
  const altGraph = event.getModifierState?.('AltGraph')
  if (altGraph === true || (altGraph === undefined && event.ctrlKey && event.altKey)) {
    registry.keybindings.cancelPendingChord()
    return false
  }
  const decision = registry.keybindings.acceptKeyboardEvent(event)
  if (decision.kind !== 'none') onShortcutDecision?.(decision)
  if (decision.consume) {
    event.preventDefault()
    if (decision.kind === 'execute') {
      void registry.execute(decision.commandId).then(outcome => { onOutcome?.(outcome) })
    }
    return true
  }
  const commandId = registry.commandForKeyboardEvent(event)
  if (commandId === undefined) return false
  event.preventDefault()
  void registry.execute(commandId).then(outcome => { onOutcome?.(outcome) })
  return true
}
