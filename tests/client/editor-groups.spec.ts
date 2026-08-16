import { describe, expect, it, vi } from 'vitest'
import {
  EditorGroupsStore,
  MAX_EDITOR_GROUPS,
  type EditorGroupDocumentIdentity,
  type EditorGroupsDocuments,
} from '../../src/client/editor/groups.ts'

function documents(paths: readonly string[], activePath = paths[0], workspaceEpoch = 1): EditorGroupsDocuments {
  return {
    workspaceId: 'workspace',
    workspaceEpoch,
    tabs: paths.map((path, index) => ({ path, lifecycleId: index + 1 })),
    ...(activePath === undefined ? {} : { activePath }),
  }
}

function identity(
  path: string,
  lifecycleId: number,
  workspaceEpoch = 1,
): EditorGroupDocumentIdentity {
  return { workspaceId: 'workspace', workspaceEpoch, path, lifecycleId }
}

describe('EditorGroupsStore', () => {
  it('keeps document buffers out of the layout projection and splits right/top deterministically', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a.ts', 'b.ts', 'c.ts']))
    const first = store.getSnapshot().activeGroupId!

    const right = store.splitTab(identity('c.ts', 3), first, 'right')
    expect(right.kind).toBe('applied')
    if (right.kind !== 'applied') return
    expect(store.getSnapshot()).toMatchObject({
      activeGroupId: right.groupId,
      groups: [
        { id: first, activePath: 'a.ts', tabs: [{ path: 'a.ts' }, { path: 'b.ts' }] },
        { id: right.groupId, activePath: 'c.ts', tabs: [{ path: 'c.ts' }] },
      ],
      layout: {
        kind: 'split', axis: 'horizontal',
        first: { kind: 'group', groupId: first },
        second: { kind: 'group', groupId: right.groupId },
      },
    })

    const top = store.splitTab(identity('b.ts', 2), first, 'top')
    expect(top.kind).toBe('applied')
    if (top.kind !== 'applied') return
    expect(store.getSnapshot().layout).toMatchObject({
      kind: 'split', axis: 'horizontal',
      first: {
        kind: 'split', axis: 'vertical',
        first: { kind: 'group', groupId: top.groupId },
        second: { kind: 'group', groupId: first },
      },
      second: { kind: 'group', groupId: right.groupId },
    })
  })

  it('fences stale workspace/lifecycle identities and never creates an empty source group', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a.ts', 'b.ts']))
    const groupId = store.getSnapshot().activeGroupId!
    expect(store.splitTab(identity('a.ts', 99), groupId, 'right')).toEqual({ kind: 'stale' })
    expect(store.splitTab(identity('a.ts', 1, 2), groupId, 'right')).toEqual({ kind: 'stale' })

    const applied = store.splitTab(identity('b.ts', 2), groupId, 'right')
    expect(applied.kind).toBe('applied')
    if (applied.kind !== 'applied') return
    expect(store.splitTab(identity('b.ts', 2), applied.groupId, 'top')).toEqual({ kind: 'source-would-empty' })
  })

  it('caps the layout at four groups', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a', 'b', 'c', 'd', 'e']))
    const original = store.getSnapshot().activeGroupId!
    for (const [path, lifecycleId] of [['e', 5], ['d', 4], ['c', 3]] as const) {
      expect(store.splitTab(identity(path, lifecycleId), original, 'right').kind).toBe('applied')
    }
    expect(store.getSnapshot().groups).toHaveLength(MAX_EDITOR_GROUPS)
    expect(store.splitTab(identity('b', 2), original, 'top')).toEqual({ kind: 'group-limit' })
  })

  it('reconciles closes and workspace switches without retaining stale identities', () => {
    const store = new EditorGroupsStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.synchronize(documents(['a', 'b', 'c']))
    const original = store.getSnapshot().activeGroupId!
    expect(store.splitTab(identity('c', 3), original, 'right').kind).toBe('applied')

    store.synchronize(documents(['a', 'b'], 'b'))
    expect(store.getSnapshot().groups).toHaveLength(1)
    expect(store.getSnapshot().groups[0]).toMatchObject({ activePath: 'b', tabs: [{ path: 'a' }, { path: 'b' }] })

    store.synchronize(documents(['a'], 'a', 2))
    const reset = store.getSnapshot()
    expect(reset.workspaceEpoch).toBe(2)
    expect(reset.groups).toHaveLength(1)
    expect(reset.groups[0]?.tabs[0]).toEqual(identity('a', 1, 2))
    expect(listener).toHaveBeenCalled()

    store.synchronize(documents([], undefined, 2))
    expect(store.getSnapshot().groups).toEqual([{ id: reset.groups[0]!.id, tabs: [] }])
    expect(store.getSnapshot().groups[0]).not.toHaveProperty('activePath')
  })

  it('retains group placement and active tabs when paths are rebased under the same lifecycle', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'a.ts'))
    const original = store.getSnapshot().activeGroupId!
    const right = store.splitTab(identity('d.ts', 4), original, 'right')
    expect(right.kind).toBe('applied')
    if (right.kind !== 'applied') return
    const top = store.splitTab(identity('b.ts', 2), original, 'top')
    expect(top.kind).toBe('applied')
    if (top.kind !== 'applied') return
    const beforeLayout = store.getSnapshot().layout

    store.synchronize({
      workspaceId: 'workspace',
      workspaceEpoch: 1,
      tabs: [
        { path: 'a.ts', lifecycleId: 1 },
        { path: 'renamed/b.ts', lifecycleId: 2 },
        { path: 'c.ts', lifecycleId: 3 },
        { path: 'renamed/d.ts', lifecycleId: 4 },
      ],
      activePath: 'a.ts',
    })

    const snapshot = store.getSnapshot()
    expect(snapshot.layout).toEqual(beforeLayout)
    expect(snapshot.groups.find(group => group.id === original)).toMatchObject({
      activePath: 'a.ts', tabs: [{ path: 'a.ts' }, { path: 'c.ts' }],
    })
    expect(snapshot.groups.find(group => group.id === top.groupId)).toMatchObject({
      activePath: 'renamed/b.ts', tabs: [{ path: 'renamed/b.ts', lifecycleId: 2 }],
    })
    expect(snapshot.groups.find(group => group.id === right.groupId)).toMatchObject({
      activePath: 'renamed/d.ts', tabs: [{ path: 'renamed/d.ts', lifecycleId: 4 }],
    })
    expect(snapshot.activeGroupId).toBe(original)
  })

  it('moves and reorders tabs inside the projection while preserving exact identities', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a', 'b', 'c']))
    const groupId = store.getSnapshot().activeGroupId!
    expect(store.moveTab(identity('c', 3), groupId, identity('a', 1), 'before')).toBe('applied')
    expect(store.getSnapshot().groups[0]?.tabs.map(tab => tab.path)).toEqual(['c', 'a', 'b'])
    expect(store.moveTab(identity('c', 3), groupId, identity('a', 1), 'before')).toBe('not-needed')
    expect(store.moveTab(identity('c', 30), groupId, identity('a', 1), 'after')).toBe('stale')
  })
  it('collapses an emptied source pane during drag and restores the exact baseline on cancel', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a', 'b']))
    const original = store.getSnapshot().activeGroupId!
    const right = store.splitTab(identity('b', 2), original, 'right')
    expect(right.kind).toBe('applied')
    if (right.kind !== 'applied') return
    const baseline = store.getSnapshot()

    expect(store.beginTabDrag(identity('b', 2))).toBe('applied')
    expect(store.getSnapshot()).toMatchObject({
      groups: [{ id: original, tabs: [{ path: 'a' }] }],
      layout: { kind: 'group', groupId: original },
      activeGroupId: original,
    })
    expect(store.cancelTabDrag(identity('b', 2))).toBe('applied')
    expect(store.getSnapshot()).toEqual(baseline)
  })

  it('commits a previewed unique tab into a surviving group without duplicates', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a', 'b']))
    const original = store.getSnapshot().activeGroupId!
    const right = store.splitTab(identity('b', 2), original, 'right')
    expect(right.kind).toBe('applied')
    if (right.kind !== 'applied') return

    expect(store.beginTabDrag(identity('b', 2))).toBe('applied')
    expect(store.moveTab(identity('b', 2), original, identity('a', 1), 'after')).toBe('applied')
    const snapshot = store.getSnapshot()
    expect(snapshot.groups).toHaveLength(1)
    expect(snapshot.groups[0]).toMatchObject({
      id: original,
      activePath: 'b',
      tabs: [{ path: 'a' }, { path: 'b' }],
    })
    expect(snapshot.groups.flatMap(group => group.tabs).filter(tab => tab.path === 'b')).toHaveLength(1)
    expect(store.cancelTabDrag(identity('b', 2))).toBe('not-needed')
  })

  it('inherits the compacted layout for a legal split and still enforces four final groups', () => {
    const store = new EditorGroupsStore()
    store.synchronize(documents(['a', 'b', 'c', 'd', 'e']))
    const original = store.getSnapshot().activeGroupId!
    const created = [
      store.splitTab(identity('e', 5), original, 'right'),
      store.splitTab(identity('d', 4), original, 'right'),
      store.splitTab(identity('c', 3), original, 'right'),
    ]
    expect(created.every(result => result.kind === 'applied')).toBe(true)

    expect(store.beginTabDrag(identity('e', 5))).toBe('applied')
    expect(store.getSnapshot().groups).toHaveLength(3)
    const moved = store.splitTab(identity('e', 5), original, 'top')
    expect(moved.kind).toBe('applied')
    expect(store.getSnapshot().groups).toHaveLength(MAX_EDITOR_GROUPS)
    expect(store.getSnapshot().groups.flatMap(group => group.tabs).filter(tab => tab.path === 'e')).toHaveLength(1)

    expect(store.beginTabDrag(identity('a', 1))).toBe('applied')
    expect(store.splitTab(identity('a', 1), original, 'right')).toEqual({ kind: 'group-limit' })
    expect(store.cancelTabDrag(identity('a', 1))).toBe('applied')
    expect(store.getSnapshot().groups).toHaveLength(MAX_EDITOR_GROUPS)
  })

})
