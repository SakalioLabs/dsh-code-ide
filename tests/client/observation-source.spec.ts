import { describe, expect, it, vi } from 'vitest'
import type {
  InspectResponse,
  KnownObservationTarget,
  ObservationTarget,
} from '../../src/shared/workspace-observation.ts'
import {
  PollingWorkspaceObservationSource,
  type SchedulerPort,
  type VisibilityPort,
  type WorkspaceInvalidation,
} from '../../src/client/observation/source.ts'

class FakeVisibility implements VisibilityPort {
  visible = true
  readonly listeners = new Set<() => void>()
  isVisible(): boolean { return this.visible }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    for (const listener of this.listeners) listener()
  }
}

class FakeScheduler implements SchedulerPort {
  readonly listeners = new Set<() => void>()
  every(_milliseconds: number, listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  tick(): void { for (const listener of this.listeners) listener() }
}

function response(fileVersion = 'v1', directoryVersion = 'd1'): InspectResponse {
  return {
    snapshots: [
      { kind: 'file', path: 'index.ts', state: 'present', version: fileVersion, size: 10 },
      { kind: 'directory', path: '', state: 'present', version: directoryVersion },
    ],
  }
}

describe('PollingWorkspaceObservationSource', () => {
  it('uses the initial snapshots as a baseline, then emits bounded invalidations', async () => {
    const visibility = new FakeVisibility()
    const scheduler = new FakeScheduler()
    let current = response()
    const requests: ObservationTarget[][] = []
    const invalidations: WorkspaceInvalidation[][] = []
    const source = new PollingWorkspaceObservationSource({
      inspect: async (_workspaceId, targets) => {
        requests.push([...targets])
        return current
      },
    }, { visibility, scheduler })
    const targets: KnownObservationTarget[] = [
      { kind: 'file', path: 'index.ts', knownVersion: 'v1' },
      { kind: 'directory', path: '' },
    ]
    const subscription = source.subscribe({
      workspaceId: 'workspace',
      getTargets: () => targets,
      onInvalidations: values => { invalidations.push([...values]) },
    })
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    expect(invalidations).toEqual([])

    current = response('v2', 'd2')
    await subscription.refresh()
    expect(invalidations.at(-1)?.map(item => item.target.kind)).toEqual(['file', 'directory'])
    subscription.dispose()
    expect(scheduler.listeners.size).toBe(0)
    expect(visibility.listeners.size).toBe(0)
  })

  it('suppresses a disk version already adopted by the editor after save or reload', async () => {
    const visibility = new FakeVisibility()
    const scheduler = new FakeScheduler()
    let target: KnownObservationTarget = { kind: 'file', path: 'index.ts', knownVersion: 'v1' }
    let current: InspectResponse = { snapshots: [{ kind: 'file', path: 'index.ts', state: 'present', version: 'v1', size: 10 }] }
    const onInvalidations = vi.fn()
    const source = new PollingWorkspaceObservationSource({ inspect: async () => current }, { visibility, scheduler })
    const subscription = source.subscribe({
      workspaceId: 'workspace',
      getTargets: () => [target],
      onInvalidations,
    })
    await vi.waitFor(() => { expect(scheduler.listeners.size).toBe(1) })
    await subscription.refresh()
    target = { ...target, knownVersion: 'v2' }
    current = { snapshots: [{ kind: 'file', path: 'index.ts', state: 'present', version: 'v2', size: 10 }] }
    await subscription.refresh()
    expect(onInvalidations).not.toHaveBeenCalled()
    subscription.dispose()
  })

  it('pauses while hidden, refreshes when visible, and ignores an in-flight result after disposal', async () => {
    const visibility = new FakeVisibility()
    const scheduler = new FakeScheduler()
    let resolveInspect: ((value: InspectResponse) => void) | undefined
    const inspect = vi.fn(() => new Promise<InspectResponse>((resolve) => { resolveInspect = resolve }))
    const onInvalidations = vi.fn()
    const source = new PollingWorkspaceObservationSource({ inspect }, { visibility, scheduler })
    const subscription = source.subscribe({
      workspaceId: 'workspace',
      getTargets: () => [{ kind: 'file', path: 'index.ts', knownVersion: 'old' }],
      onInvalidations,
    })
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(1) })
    scheduler.tick()
    expect(inspect).toHaveBeenCalledTimes(1)
    visibility.setVisible(false)
    scheduler.tick()
    expect(inspect).toHaveBeenCalledTimes(1)
    subscription.dispose()
    resolveInspect?.({ snapshots: [{ kind: 'file', path: 'index.ts', state: 'present', version: 'new', size: 1 }] })
    await Promise.resolve()
    expect(onInvalidations).not.toHaveBeenCalled()
  })

  it('de-duplicates every target and batches requests at the Host limit without silently dropping any', async () => {
    const visibility = new FakeVisibility()
    const scheduler = new FakeScheduler()
    const sent: ObservationTarget[][] = []
    const targets: KnownObservationTarget[] = [
      { kind: 'directory', path: '' },
      { kind: 'directory', path: '' },
      ...Array.from({ length: 300 }, (_, index): KnownObservationTarget => ({ kind: 'file', path: `${String(index)}.ts` })),
    ]
    const source = new PollingWorkspaceObservationSource({
      inspect: async (_workspaceId, values) => {
        sent.push([...values])
        return { snapshots: values.map(target => target.kind === 'file'
          ? { ...target, state: 'missing' as const }
          : { ...target, state: 'present' as const, version: 'directory' }) }
      },
    }, { visibility, scheduler, maxTargets: 8 })
    const subscription = source.subscribe({
      workspaceId: 'workspace',
      getTargets: () => targets,
      onInvalidations: () => {},
    })
    await vi.waitFor(() => { expect(sent).toHaveLength(38) })
    expect(sent.every(batch => batch.length <= 8)).toBe(true)
    const flattened = sent.flat()
    expect(flattened).toHaveLength(301)
    expect(new Set(flattened.map(target => `${target.kind}:${target.path}`)).size).toBe(301)
    subscription.dispose()
  })
})
