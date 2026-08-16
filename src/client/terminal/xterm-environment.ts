import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { openTerminalSocket } from '../api.ts'
import { resolveIdeTerminalTheme, type IdeColorScheme } from '../theme.ts'
import type {
  TerminalDisposable,
  TerminalEmulatorPort,
  TerminalRuntimeEnvironment,
} from './runtime.ts'

interface XtermThemeTarget {
  options: { theme?: ITheme }
}

/** Keeps terminal coloring outside PTY/runtime state and covers future emulators. */
export class BrowserTerminalThemeController {
  private readonly targets = new Set<XtermThemeTarget>()

  constructor(
    private colorScheme: IdeColorScheme,
    private readonly source?: Document,
  ) {}

  register(target: XtermThemeTarget): () => void {
    this.targets.add(target)
    this.apply(target)
    return () => { this.targets.delete(target) }
  }

  setColorScheme(colorScheme: IdeColorScheme): void {
    this.colorScheme = colorScheme
    for (const target of this.targets) this.apply(target)
  }

  private apply(target: XtermThemeTarget): void {
    // xterm compares object references, so every update must use a fresh object.
    target.options.theme = { ...resolveIdeTerminalTheme(this.colorScheme, this.source) }
  }
}

function xtermEmulator(themes: BrowserTerminalThemeController): TerminalEmulatorPort {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    scrollback: 5_000,
    fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
    fontSize: 13,
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  const unregisterTheme = themes.register(terminal)
  let disposed = false
  return {
    get cols() { return terminal.cols },
    get rows() { return terminal.rows },
    open: host => { terminal.open(host) },
    fit: () => { fit.fit() },
    focus: () => { terminal.focus() },
    clear: () => { terminal.clear() },
    search: (query, direction) => direction === 'next'
      ? search.findNext(query, { regex: false })
      : search.findPrevious(query, { regex: false }),
    clearSearch: () => {
      search.clearDecorations()
      terminal.clearSelection()
    },
    write: data => { terminal.write(data) },
    onData: listener => terminal.onData(listener),
    dispose: () => {
      if (disposed) return
      disposed = true
      unregisterTheme()
      terminal.dispose()
    },
  }
}

export interface BrowserTerminalEnvironment extends TerminalRuntimeEnvironment {
  setColorScheme(colorScheme: IdeColorScheme): void
}

export function createBrowserTerminalEnvironment(
  surfaceClassName: string,
  initialColorScheme: IdeColorScheme = 'dark',
  themeSource?: Document,
): BrowserTerminalEnvironment {
  const resolvedThemeSource = themeSource ?? (
    typeof document === 'undefined' ? undefined : document
  )
  const themes = new BrowserTerminalThemeController(initialColorScheme, resolvedThemeSource)
  return {
    createSurface: () => {
      const surface = document.createElement('div')
      surface.className = surfaceClassName
      // The shell owns arbitrary user bindings while its emulator has focus.
      // A capture-phase bridge admits only the unchanged F1 / primary+Shift+P
      // Command Palette defaults; visible toolbar controls remain the fallback.
      surface.dataset.workbenchShortcuts = 'terminal'
      return surface
    },
    createEmulator: () => xtermEmulator(themes),
    setColorScheme: colorScheme => { themes.setColorScheme(colorScheme) },
    attachSurface: (surface, host) => {
      if (surface.parentElement === host) return
      surface.remove()
      host.append(surface)
    },
    detachSurface: surface => { surface.remove() },
    openSocket: options => openTerminalSocket(options),
    observeResize: (host, listener): TerminalDisposable => {
      const observer = new ResizeObserver(listener)
      observer.observe(host)
      return { dispose: () => { observer.disconnect() } }
    },
    scheduleFrame: (listener): TerminalDisposable => {
      const handle = requestAnimationFrame(listener)
      return { dispose: () => { cancelAnimationFrame(handle) } }
    },
  }
}
