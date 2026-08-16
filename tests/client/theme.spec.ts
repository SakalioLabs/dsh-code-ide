import { describe, expect, it } from 'vitest'
import type { ITheme } from '@xterm/xterm'
import {
  IDE_TERMINAL_THEME_FALLBACKS,
  normalizeIdeColorScheme,
  resolveIdeTerminalTheme,
} from '../../src/client/theme.ts'
import { BrowserTerminalThemeController } from '../../src/client/terminal/xterm-environment.ts'

function themeDocument(values: Record<string, string>): Document {
  return {
    documentElement: {},
    defaultView: {
      getComputedStyle: () => ({
        getPropertyValue: (name: string) => values[name] ?? '',
      }),
    },
  } as unknown as Document
}

describe('IDE color scheme', () => {
  it('normalizes only the two supported schemes', () => {
    expect(normalizeIdeColorScheme('light')).toBe('light')
    expect(normalizeIdeColorScheme('dark')).toBe('dark')
    expect(normalizeIdeColorScheme('system')).toBeUndefined()
  })

  it('resolves projected Harness colors and safely falls back for unusable tokens', () => {
    const source = themeDocument({
      '--dsw-alias-bg-base': 'rgb(250, 251, 252)',
      '--dsw-alias-label-primary': 'rgb(20, 24, 30)',
      '--dsw-alias-state-business-primary': 'rgb(40, 90, 220)',
      '--dsw-alias-interactive-bg-active': 'rgb(205, 220, 255)',
      '--dsw-alias-interactive-bg-hover': 'var(--unresolved-color)',
      '--dsw-alias-scrollbar-bg-l1': 'rgb(80 90 100 / 20%)',
      '--dsw-alias-scrollbar-hover-l1': 'rgb(80 90 100 / 40%)',
    })

    expect(resolveIdeTerminalTheme('light', source)).toEqual({
      background: 'rgb(250, 251, 252)',
      foreground: 'rgb(20, 24, 30)',
      cursor: 'rgb(40, 90, 220)',
      cursorAccent: 'rgb(250, 251, 252)',
      selectionBackground: 'rgb(205, 220, 255)',
      selectionInactiveBackground: IDE_TERMINAL_THEME_FALLBACKS.light.selectionInactiveBackground,
      scrollbarSliderBackground: 'rgb(80 90 100 / 20%)',
      scrollbarSliderHoverBackground: 'rgb(80 90 100 / 40%)',
      scrollbarSliderActiveBackground: 'rgb(80 90 100 / 40%)',
    })
    expect(resolveIdeTerminalTheme('dark')).toEqual(IDE_TERMINAL_THEME_FALLBACKS.dark)
  })

  it('updates every registered xterm with fresh objects and retains the scheme for later terminals', () => {
    const values: Record<string, string> = {
      '--dsw-alias-bg-base': '#111318',
      '--dsw-alias-label-primary': '#edf0f5',
    }
    const controller = new BrowserTerminalThemeController('dark', themeDocument(values))
    const first: { options: { theme?: ITheme } } = { options: {} }
    const unregister = controller.register(first)
    const initial = first.options.theme

    values['--dsw-alias-bg-base'] = '#ffffff'
    values['--dsw-alias-label-primary'] = '#20242c'
    controller.setColorScheme('light')
    expect(first.options.theme).not.toBe(initial)
    expect(first.options.theme).toMatchObject({ background: '#ffffff', foreground: '#20242c' })

    const second: { options: { theme?: ITheme } } = { options: {} }
    controller.register(second)
    expect(second.options.theme).toMatchObject({ background: '#ffffff', foreground: '#20242c' })

    const retained = first.options.theme
    unregister()
    values['--dsw-alias-bg-base'] = '#fafafa'
    controller.setColorScheme('light')
    expect(first.options.theme).toBe(retained)
    expect(second.options.theme).toMatchObject({ background: '#fafafa' })
  })
})
