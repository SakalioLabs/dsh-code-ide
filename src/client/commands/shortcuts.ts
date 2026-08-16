import type { CommandKeybinding } from './types.ts'

export interface KeyboardEventLike {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/** `other` is retained as a Windows/Linux compatibility alias. */
export type ShortcutPlatform = 'mac' | 'windows' | 'linux' | 'other'

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase('en-US')
}

export function validateKeybinding(binding: CommandKeybinding): void {
  if (binding.key.length === 0 || binding.key.length > 32 || /[\u0000-\u001f\u007f]/u.test(binding.key)) {
    throw new Error('Command keybindings require a printable key with at most 32 characters.')
  }
  if (binding.primary === true && (binding.ctrl === true || binding.meta === true)) {
    throw new Error('A command keybinding cannot combine primary with an explicit Ctrl or Meta modifier.')
  }
}

export function keybindingSignature(
  binding: CommandKeybinding,
  platform: ShortcutPlatform = 'other',
): string {
  validateKeybinding(binding)
  return [
    binding.primary === true ? (platform === 'mac' ? 'meta' : 'ctrl') : '',
    binding.primary !== true && binding.ctrl === true ? 'ctrl' : '',
    binding.primary !== true && binding.meta === true ? 'meta' : '',
    binding.alt === true ? 'alt' : '',
    binding.shift === true ? 'shift' : '',
    normalizedKey(binding.key),
  ].filter(Boolean).join('+')
}

export function matchesKeybinding(
  event: KeyboardEventLike,
  binding: CommandKeybinding,
  platform: ShortcutPlatform = 'other',
): boolean {
  validateKeybinding(binding)
  if (normalizedKey(event.key) !== normalizedKey(binding.key)) return false
  if (event.altKey !== (binding.alt === true) || event.shiftKey !== (binding.shift === true)) return false

  if (binding.primary === true) {
    if (platform === 'mac') {
      if (!event.metaKey || event.ctrlKey) return false
    } else if (!event.ctrlKey || event.metaKey) return false
  } else {
    if (event.ctrlKey !== (binding.ctrl === true) || event.metaKey !== (binding.meta === true)) return false
  }
  return true
}

function displayKey(key: string): string {
  if (key.length === 1) return key.toLocaleUpperCase()
  const aliases: Record<string, string> = {
    arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up',
    escape: 'Esc', ' ': 'Space',
  }
  return aliases[key.toLocaleLowerCase('en-US')] ?? key
}

export function formatKeybinding(binding: CommandKeybinding, platform: ShortcutPlatform): string {
  validateKeybinding(binding)
  const modifiers: string[] = []
  if (platform === 'mac') {
    if (binding.ctrl === true) modifiers.push('⌃')
    if (binding.alt === true) modifiers.push('⌥')
    if (binding.shift === true) modifiers.push('⇧')
    if (binding.primary === true || binding.meta === true) modifiers.push('⌘')
    return `${modifiers.join('')}${displayKey(binding.key)}`
  }
  if (binding.primary === true || binding.ctrl === true) modifiers.push('Ctrl')
  if (binding.alt === true) modifiers.push('Alt')
  if (binding.shift === true) modifiers.push('Shift')
  if (binding.meta === true) modifiers.push('Meta')
  modifiers.push(displayKey(binding.key))
  return modifiers.join('+')
}
