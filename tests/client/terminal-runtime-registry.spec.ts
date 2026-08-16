import { describe, expect, it, vi } from 'vitest'
import {
  TerminalRuntimeRegistry,
  type TerminalRuntimeFactory,
} from '../../src/client/terminal/runtime-registry.ts'
import type { TerminalRuntimePort } from '../../src/client/terminal/runtime.ts'

function runtime() {
  return {
    mount: vi.fn(),
    setVisible: vi.fn(),
    focus: vi.fn(),
    interrupt: vi.fn(() => true),
    terminate: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies TerminalRuntimePort
}

const first = { workspaceId: 'workspace', id: 'terminal-1', lifecycleId: 1 }

describe('TerminalRuntimeRegistry', () => {
  it('absorbs StrictMode detach and immediate reattach without a duplicate runtime', () => {
    const microtasks: Array<() => void> = []
    const created: ReturnType<typeof runtime>[] = []
    const factory: TerminalRuntimeFactory = () => {
      const value = runtime()
      created.push(value)
      return value
    }
    const registry = new TerminalRuntimeRegistry(factory, listener => { microtasks.push(listener) })
    const host = {} as HTMLElement

    const probe = registry.attach(first, host, true)
    probe.dispose()
    const live = registry.attach(first, host, true)
    for (const task of microtasks.splice(0)) task()

    expect(created).toHaveLength(1)
    expect(created[0]?.mount).toHaveBeenCalledTimes(1)
    expect(created[0]?.dispose).not.toHaveBeenCalled()
    live.dispose()
    for (const task of microtasks.splice(0)) task()
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(0)
  })

  it('routes surface commands only through the exact live lifecycle', () => {
    const created: ReturnType<typeof runtime>[] = []
    const registry = new TerminalRuntimeRegistry(() => {
      const value = runtime()
      created.push(value)
      return value
    }, listener => { listener() })
    const lease = registry.attach(first, {} as HTMLElement, false)

    lease.setVisible(true)
    lease.focus()
    expect(lease.interrupt()).toBe(true)
    expect(created[0]?.setVisible).toHaveBeenLastCalledWith(true)
    expect(created[0]?.focus).toHaveBeenCalledTimes(1)
    expect(created[0]?.interrupt).toHaveBeenCalledTimes(1)
  })

  it('requires an exact live runtime before a restart handoff can proceed', async () => {
    const registry = new TerminalRuntimeRegistry(() => runtime())
    await expect(registry.terminateIdentity(first)).rejects.toThrow('not available')
    registry.attach(first, {} as HTMLElement, true)
    await expect(registry.terminateIdentity(first)).resolves.toBeUndefined()
  })

  it('creates a fresh runtime on restart and makes an old lease harmless', () => {
    const created: ReturnType<typeof runtime>[] = []
    const microtasks: Array<() => void> = []
    const registry = new TerminalRuntimeRegistry(() => {
      const value = runtime()
      created.push(value)
      return value
    }, listener => { microtasks.push(listener) })
    const oldLease = registry.attach(first, {} as HTMLElement, true)
    registry.disposeIdentity(first)
    const restarted = { ...first, lifecycleId: 2 }
    const newLease = registry.attach(restarted, {} as HTMLElement, true)

    expect(created).toHaveLength(2)
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1)
    oldLease.dispose()
    expect(created[1]?.dispose).not.toHaveBeenCalled()
    newLease.dispose()
    for (const task of microtasks.splice(0)) task()
    expect(created[1]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes all independent workspace runtimes exactly once', () => {
    const created: ReturnType<typeof runtime>[] = []
    const registry = new TerminalRuntimeRegistry(() => {
      const value = runtime()
      created.push(value)
      return value
    })
    registry.attach(first, {} as HTMLElement, true)
    registry.attach({ workspaceId: 'other', id: 'terminal-2', lifecycleId: 2 }, {} as HTMLElement, false)

    registry.disposeAll()
    registry.disposeAll()
    expect(created.map(value => value.dispose.mock.calls.length)).toEqual([1, 1])
    expect(registry.size).toBe(0)
  })

  it('rolls back a failed mount and permits a clean retry', () => {
    const failed = runtime()
    failed.mount.mockImplementationOnce(() => { throw new Error('surface unavailable') })
    const healthy = runtime()
    const factory = vi.fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(healthy)
    const registry = new TerminalRuntimeRegistry(factory)

    expect(() => { registry.attach(first, {} as HTMLElement, true) }).toThrow('surface unavailable')
    expect(failed.dispose).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(0)
    registry.attach(first, {} as HTMLElement, true)
    expect(healthy.mount).toHaveBeenCalledTimes(1)
  })
})
