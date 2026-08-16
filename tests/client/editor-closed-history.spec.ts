import { describe, expect, it, vi } from 'vitest'
import {
  CLOSED_EDITOR_HISTORY_LIMIT,
  ClosedEditorHistoryStore,
} from '../../src/client/editor/closed-history.ts'

describe('ClosedEditorHistoryStore', () => {
  it('publishes stable snapshots and keeps independent workspace stacks', () => {
    const store = new ClosedEditorHistoryStore()
    const listener = vi.fn()
    store.subscribe(listener)
    const initial = store.getSnapshot()

    expect(store.getSnapshot()).toBe(initial)
    expect(store.record('', 'a.ts')).toBeUndefined()
    expect(store.record('workspace-a', '')).toBeUndefined()
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()

    store.record('workspace-a', 'a.ts')
    const first = store.getSnapshot()
    expect(first).not.toBe(initial)
    expect(store.getSnapshot()).toBe(first)
    store.record('workspace-b', 'b.ts')

    expect(store.peek('workspace-a')?.path).toBe('a.ts')
    expect(store.peek('workspace-b')?.path).toBe('b.ts')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('deduplicates paths at the top and bounds each workspace to fifty entries', () => {
    const store = new ClosedEditorHistoryStore()
    store.record('workspace', 'a.ts')
    store.record('workspace', 'b.ts')
    store.record('workspace', 'a.ts')

    expect(store.getSnapshot().workspaces.get('workspace')?.map(entry => entry.path))
      .toEqual(['b.ts', 'a.ts'])

    for (let index = 0; index <= CLOSED_EDITOR_HISTORY_LIMIT; index += 1) {
      store.record('bounded', `file-${String(index)}.ts`)
    }
    const bounded = store.getSnapshot().workspaces.get('bounded')
    expect(bounded).toHaveLength(CLOSED_EDITOR_HISTORY_LIMIT)
    expect(bounded?.[0]?.path).toBe('file-1.ts')
    expect(store.peek('bounded')?.path).toBe(`file-${String(CLOSED_EDITOR_HISTORY_LIMIT)}.ts`)
  })

  it('consumes only the exact current entry and removes an empty workspace stack', () => {
    const store = new ClosedEditorHistoryStore()
    const older = store.record('workspace', 'older.ts')!
    const current = store.record('workspace', 'current.ts')!
    store.record('other', 'other.ts')
    const beforeStaleConsume = store.getSnapshot()

    expect(store.consumeIfCurrent(older)).toBe(false)
    expect(store.getSnapshot()).toBe(beforeStaleConsume)
    expect(store.consumeIfCurrent(current)).toBe(true)
    expect(store.peek('workspace')).toBe(older)
    expect(store.consumeIfCurrent(older)).toBe(true)
    expect(store.getSnapshot().workspaces.has('workspace')).toBe(false)
    expect(store.peek('other')?.path).toBe('other.ts')
  })
})
