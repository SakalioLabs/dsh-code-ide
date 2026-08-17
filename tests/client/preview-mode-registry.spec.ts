import { describe, expect, it, vi } from 'vitest'
import {
  PreviewModeRegistry,
  type PreviewModeIdentity,
} from '../../src/client/preview/mode-registry.ts'

function identity(overrides: Partial<PreviewModeIdentity> = {}): PreviewModeIdentity {
  return {
    workspaceId: 'workspace',
    workspaceEpoch: 1,
    path: 'README.md',
    lifecycleId: 1,
    ...overrides,
  }
}

describe('PreviewModeRegistry', () => {
  it('defaults to source and admits changes only for synchronized identities', () => {
    const registry = new PreviewModeRegistry()
    const document = identity()
    expect(registry.get(document)).toBe('source')
    expect(registry.set(document, 'preview')).toBe('stale')
    expect(registry.toggle(document)).toBe('stale')

    registry.synchronize([document])
    expect(registry.set(document, 'source')).toBe('not-needed')
    expect(registry.set(document, 'preview')).toBe('applied')
    expect(registry.get(document)).toBe('preview')
    expect(registry.set(document, 'preview')).toBe('not-needed')
    expect(registry.toggle(document)).toBe('applied')
    expect(registry.get(document)).toBe('source')
  })

  it('retains preview through a rename because path is not identity authority', () => {
    const registry = new PreviewModeRegistry()
    const before = identity({ path: 'docs/old.md' })
    const after = identity({ path: 'docs/new.md' })
    registry.synchronize([before])
    expect(registry.set(before, 'preview')).toBe('applied')

    const snapshot = registry.getSnapshot()
    registry.synchronize([after])
    expect(registry.getSnapshot()).toBe(snapshot)
    expect(registry.get(after)).toBe('preview')
  })

  it('retires a closed lifecycle before the same path is reopened', () => {
    const registry = new PreviewModeRegistry()
    const closed = identity({ lifecycleId: 11 })
    const reopened = identity({ lifecycleId: 12 })
    registry.synchronize([closed])
    registry.set(closed, 'preview')

    registry.synchronize([reopened])
    expect(registry.get(closed)).toBe('source')
    expect(registry.set(closed, 'preview')).toBe('stale')
    expect(registry.get(reopened)).toBe('source')
    expect(registry.getSnapshot()).toMatchObject({ liveIdentities: 1, previewIdentities: 0 })
  })

  it('fences a workspace ABA even when workspace id and lifecycle repeat', () => {
    const registry = new PreviewModeRegistry()
    const first = identity({ workspaceEpoch: 4, lifecycleId: 7 })
    const replacement = identity({ workspaceEpoch: 6, lifecycleId: 7 })
    registry.synchronize([first])
    registry.set(first, 'preview')

    registry.synchronize([replacement])
    expect(registry.get(first)).toBe('source')
    expect(registry.toggle(first)).toBe('stale')
    expect(registry.get(replacement)).toBe('source')
  })

  it('publishes stable snapshots once per committed presentation transition', () => {
    const registry = new PreviewModeRegistry()
    const first = identity()
    const second = identity({ workspaceId: 'other', path: 'guide.md', lifecycleId: 2 })
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)

    const empty = registry.getSnapshot()
    registry.synchronize([])
    expect(registry.getSnapshot()).toBe(empty)

    registry.synchronize([first, first])
    const admitted = registry.getSnapshot()
    expect(admitted).toMatchObject({ revision: 1, liveIdentities: 1, previewIdentities: 0 })
    registry.synchronize([first])
    expect(registry.getSnapshot()).toBe(admitted)
    expect(registry.set(first, 'source')).toBe('not-needed')
    expect(registry.getSnapshot()).toBe(admitted)

    registry.set(first, 'preview')
    registry.synchronize([first, second])
    registry.synchronize([second])
    expect(registry.getSnapshot()).toMatchObject({
      revision: 4,
      liveIdentities: 1,
      previewIdentities: 0,
    })
    expect(listener).toHaveBeenCalledTimes(4)

    unsubscribe()
    registry.set(second, 'preview')
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('keeps workspace ids containing separators collision-free', () => {
    const registry = new PreviewModeRegistry()
    const first = identity({ workspaceId: 'a\0b', workspaceEpoch: 1, lifecycleId: 2 })
    const second = identity({ workspaceId: 'a', workspaceEpoch: 1, lifecycleId: 2 })
    registry.synchronize([first, second])
    registry.set(first, 'preview')
    expect(registry.get(first)).toBe('preview')
    expect(registry.get(second)).toBe('source')
  })
})
