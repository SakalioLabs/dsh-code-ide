import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  type HarnessThemeWatchRuntime,
  HarnessIdeView,
  ideFrameHref,
  registerIdeComposerSuppression,
  syncHarnessThemeToFrame,
  syncHarnessLocaleToFrame,
  watchHarnessTheme,
  workspaceIdForSession,
  workspaceTargetForSession,
} from '../../src/harness-client/index.tsx'

describe('Harness IDE conversation entry', () => {
  it('maps the active session through the public workspace projection', () => {
    expect(workspaceIdForSession([
      { workspaceId: 'alpha', sessionIds: ['session-a'] },
      { workspaceId: 'beta', sessionIds: ['session-b', 'session-c'] },
    ], 'session-c')).toBe('beta')
    expect(workspaceIdForSession([], 'session-c')).toBeUndefined()
    expect(workspaceTargetForSession({
      items: [], phase: 'pending', state: 'loading', baselinesReady: false,
    }, 'session-c')).toEqual({ kind: 'loading' })
    expect(workspaceTargetForSession({
      items: [], phase: 'ready', state: 'idle', baselinesReady: true,
    }, 'session-c')).toEqual({ kind: 'unattached' })
    expect(workspaceTargetForSession({
      items: [], phase: 'pending', state: 'error', baselinesReady: false,
    }, 'session-c')).toEqual({ kind: 'error' })
  })

  it('keeps the IDE on its companion route and encodes the workspace id', () => {
    expect(ideFrameHref('workspace/a b')).toBe(
      '/dsh-code-ide/?embedded=1&workspaceId=workspace%2Fa%20b&locale=en',
    )
    expect(ideFrameHref('workspace/a b', 'zh')).toContain('&locale=zh')

  })

  it('wires the iframe ref and load event to a fail-open resolved-token copy', () => {
    const componentSource = HarnessIdeView.toString()
    expect(componentSource).toMatch(/ref:\s*frame/)
    expect(componentSource).toMatch(/onLoad:\s*syncFrame/)
    expect(componentSource).toMatch(/data-conversation-composer-overlay/)

    const values: Record<string, string> = {
      '--dsw-alias-bg-base': ' rgb(255, 255, 255) ',
      '--dsw-alias-label-primary': 'rgb(15, 17, 21)',
    }
    const sourceBody = { hasAttribute: vi.fn().mockReturnValue(true) }
    const source = {
      body: sourceBody,
      documentElement: {},
      defaultView: {
        getComputedStyle: vi.fn().mockReturnValue({
          getPropertyValue: (name: string) => values[name] ?? '',
        }),
      },
    } as unknown as Document
    const targetStyle = {
      colorScheme: '',
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    }
    const targetBody = {
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    }
    const frame = {
      contentDocument: {
        documentElement: { style: targetStyle },
        body: targetBody,
      },
    } as unknown as HTMLIFrameElement

    expect(syncHarnessThemeToFrame(source, frame)).toBe(true)
    expect(targetStyle.setProperty).toHaveBeenCalledWith(
      '--dsw-alias-bg-base',
      'rgb(255, 255, 255)',
    )
    expect(targetStyle.setProperty).toHaveBeenCalledWith(
      '--dsw-alias-label-primary',
      'rgb(15, 17, 21)',
    )
    expect(targetStyle.removeProperty).toHaveBeenCalledWith('--dsw-font-family')
    expect(targetStyle.colorScheme).toBe('dark')
    expect(targetBody.setAttribute).toHaveBeenCalledWith('data-ds-dark-theme', '')

    sourceBody.hasAttribute.mockReturnValue(false)
    expect(syncHarnessThemeToFrame(source, frame)).toBe(true)
    expect(targetStyle.colorScheme).toBe('light')
    expect(targetBody.removeAttribute).toHaveBeenCalledWith('data-ds-dark-theme')

    const inaccessible = {}
    Object.defineProperty(inaccessible, 'contentDocument', {
      get: () => { throw new Error('cross-origin') },
    })
    expect(syncHarnessThemeToFrame(source, inaccessible as HTMLIFrameElement)).toBe(false)
  })

  it('posts a bounded locale update to the exact same-origin frame', () => {
    const postMessage = vi.fn()
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement
    expect(syncHarnessLocaleToFrame(frame, 'zh', 'http://127.0.0.1:3080')).toBe(true)
    expect(postMessage).toHaveBeenCalledWith({
      type: 'dsh-code-ide/locale',
      locale: 'zh',
    }, 'http://127.0.0.1:3080')

    const inaccessible = {}
    Object.defineProperty(inaccessible, 'contentWindow', {
      get: () => { throw new Error('torn down') },
    })
    expect(syncHarnessLocaleToFrame(
      inaccessible as HTMLIFrameElement,
      'en',
      'http://127.0.0.1:3080',
    )).toBe(false)
  })

  it('suppresses only the mounted IDE session composer at the end of the takeover chain', () => {
    const disposeRegistration = vi.fn()
    const disposeInjection = vi.fn()
    let injectedSlot: string | undefined
    let registration: Record<string, unknown> | undefined
    let component: ((props: { matched: true }) => unknown) | undefined
    const slots = {
      inject(name: string, setup: () => () => void) {
        injectedSlot = name
        const dispose = setup()
        return () => {
          dispose()
          disposeInjection()
        }
      },
      register(
        options: Record<string, unknown>,
        registeredComponent: (props: { matched: true }) => unknown,
      ) {
        registration = options
        component = registeredComponent
        return disposeRegistration
      },
    }

    const dispose = registerIdeComposerSuppression(
      slots as unknown as Parameters<typeof registerIdeComposerSuppression>[0],
      'session-b',
    )

    expect(injectedSlot).toBe('conversation.composer')
    expect(registration?.name).toBe('conversation.composer')
    expect(registration?.priority).toBe(Number.MAX_SAFE_INTEGER)
    const select = registration?.select as ((owner: {
      session?: { sessionId: string }
    }) => true | null)
    expect(select({ session: { sessionId: 'session-b' } })).toBe(true)
    expect(select({ session: { sessionId: 'session-a' } })).toBeNull()
    expect(select({})).toBeNull()
    expect(component?.({ matched: true })).toBeNull()

    dispose()
    expect(disposeRegistration).toHaveBeenCalledTimes(1)
    expect(disposeInjection).toHaveBeenCalledTimes(1)
  })

  it('coalesces narrow host mutations and cancels pending bridge work on cleanup', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    const cancelFrame = vi.fn()
    const onChange = vi.fn()
    let observerCallback: () => void = () => { throw new Error('observer not created') }
    let frameCallback: () => void = () => { throw new Error('frame not requested') }
    const requestFrame = vi.fn((callback: () => void) => {
      frameCallback = callback
      return 17
    })
    const runtime: HarnessThemeWatchRuntime = {
      createObserver(callback) {
        observerCallback = callback
        return { observe, disconnect }
      },
      requestFrame,
      cancelFrame,
    }
    const source = { body: {}, documentElement: {} } as unknown as Document

    const dispose = watchHarnessTheme(source, onChange, runtime)
    expect(observe).toHaveBeenNthCalledWith(1, source.body, {
      attributes: true,
      attributeFilter: ['style', 'data-ds-dark-theme'],
    })
    expect(observe).toHaveBeenNthCalledWith(2, source.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })

    observerCallback()
    observerCallback()
    expect(requestFrame).toHaveBeenCalledTimes(1)
    frameCallback()
    expect(onChange).toHaveBeenCalledTimes(1)

    observerCallback()
    dispose()
    expect(cancelFrame).toHaveBeenCalledWith(17)
    expect(disconnect).toHaveBeenCalledTimes(1)
    frameCallback()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('registers an additive IDE tab without replacing the official root or Chat', () => {
    const dispose = vi.fn()
    let injectedSlot: string | undefined
    let registration: Record<string, unknown> | undefined
    let component: unknown
    const context = {
      slots: {
        inject(name: string, setup: () => () => void) {
          injectedSlot = name
          setup()
          return dispose
        },
        register(options: Record<string, unknown>, registeredComponent: unknown) {
          registration = options
          component = registeredComponent
          return dispose
        },
      },
      locale: {
        getSnapshot: () => ({ active: 'zh' as const }),
        subscribe: () => () => {},
      },
    }

    apply(context as unknown as Parameters<typeof apply>[0])

    expect(injectedSlot).toBe('conversation.view')
    expect(registration).toEqual({
      name: 'conversation.view',
      id: 'dsh-code-ide',
      order: 20,
      label: 'IDE',
    })
    expect(component).not.toBe(HarnessIdeView)
    expect(typeof component).toBe('function')
    expect(String(component)).toMatch(/useLayoutEffect/)
    expect(String(component)).toMatch(/registerIdeComposerSuppression/)
    expect(String(component)).toMatch(/useSyncExternalStore/)
  })
})
