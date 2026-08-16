export type IdeColorScheme = 'light' | 'dark'

export const IDE_COLOR_SCHEME_FALLBACK: IdeColorScheme = 'dark'

export interface IdeTerminalTheme {
  readonly background: string
  readonly foreground: string
  readonly cursor: string
  readonly cursorAccent: string
  readonly selectionBackground: string
  readonly selectionInactiveBackground: string
  readonly scrollbarSliderBackground: string
  readonly scrollbarSliderHoverBackground: string
  readonly scrollbarSliderActiveBackground: string
}

export const IDE_TERMINAL_THEME_FALLBACKS: Readonly<Record<IdeColorScheme, IdeTerminalTheme>> = {
  dark: {
    background: '#0f1117',
    foreground: '#d9dee8',
    cursor: '#7da2ff',
    cursorAccent: '#0f1117',
    selectionBackground: '#33466d',
    selectionInactiveBackground: '#293752',
    scrollbarSliderBackground: 'rgb(127 135 148 / 20%)',
    scrollbarSliderHoverBackground: 'rgb(127 135 148 / 40%)',
    scrollbarSliderActiveBackground: 'rgb(127 135 148 / 50%)',
  },
  light: {
    background: '#ffffff',
    foreground: '#20242c',
    cursor: '#315fd5',
    cursorAccent: '#ffffff',
    selectionBackground: '#cddcff',
    selectionInactiveBackground: '#e2e9f7',
    scrollbarSliderBackground: 'rgb(73 79 90 / 20%)',
    scrollbarSliderHoverBackground: 'rgb(73 79 90 / 40%)',
    scrollbarSliderActiveBackground: 'rgb(73 79 90 / 50%)',
  },
}

export function normalizeIdeColorScheme(value: unknown): IdeColorScheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined
}

function projectedToken(
  source: Document | undefined,
  name: string,
  fallback: string,
): string {
  if (source === undefined) return fallback
  try {
    const view = source.defaultView
    if (view === null) return fallback
    const value = view.getComputedStyle(source.documentElement).getPropertyValue(name).trim()
    if (value === '' || /var\s*\(/iu.test(value)) return fallback
    const supports = view.CSS?.supports
    if (typeof supports === 'function' && !view.CSS.supports('color', value)) return fallback
    return value
  } catch {
    return fallback
  }
}

/** Resolve the allow-listed Harness palette into concrete colors accepted by xterm. */
export function resolveIdeTerminalTheme(
  colorScheme: IdeColorScheme,
  source?: Document,
): IdeTerminalTheme {
  const fallback = IDE_TERMINAL_THEME_FALLBACKS[colorScheme]
  const background = projectedToken(source, '--dsw-alias-bg-base', fallback.background)
  return {
    background,
    foreground: projectedToken(source, '--dsw-alias-label-primary', fallback.foreground),
    cursor: projectedToken(source, '--dsw-alias-state-business-primary', fallback.cursor),
    cursorAccent: background,
    selectionBackground: projectedToken(
      source,
      '--dsw-alias-interactive-bg-active',
      fallback.selectionBackground,
    ),
    selectionInactiveBackground: projectedToken(
      source,
      '--dsw-alias-interactive-bg-hover',
      fallback.selectionInactiveBackground,
    ),
    scrollbarSliderBackground: projectedToken(
      source,
      '--dsw-alias-scrollbar-bg-l1',
      fallback.scrollbarSliderBackground,
    ),
    scrollbarSliderHoverBackground: projectedToken(
      source,
      '--dsw-alias-scrollbar-hover-l1',
      fallback.scrollbarSliderHoverBackground,
    ),
    scrollbarSliderActiveBackground: projectedToken(
      source,
      '--dsw-alias-scrollbar-hover-l1',
      fallback.scrollbarSliderActiveBackground,
    ),
  }
}
