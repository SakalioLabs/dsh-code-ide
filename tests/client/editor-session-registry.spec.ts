import { history, undoDepth } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { EditorSessionRegistry } from '../../src/client/editor/session-registry.ts'

interface ExactIdentity {
  workspaceId: string
  path: string
  lifecycleId: number
}

function registryHarness() {
  const current = new Map<string, number>()
  const pathKey = (identity: Pick<ExactIdentity, 'workspaceId' | 'path'>): string => (
    `${identity.workspaceId}\0${identity.path}`
  )
  return {
    registry: new EditorSessionRegistry(identity => current.get(pathKey(identity)) === identity.lifecycleId),
    admit(identity: ExactIdentity): void { current.set(pathKey(identity), identity.lifecycleId) },
    retire(identity: ExactIdentity): void {
      if (current.get(pathKey(identity)) === identity.lifecycleId) current.delete(pathKey(identity))
    },
  }
}

describe('EditorSessionRegistry', () => {
  it('retains an immutable CodeMirror state with history and selection per document identity', () => {
    const harness = registryHarness()
    const { registry } = harness
    const identity = { workspaceId: 'workspace', path: 'a.ts', lifecycleId: 1, historyEpoch: 0 }
    harness.admit(identity)
    let state = EditorState.create({ doc: 'one\n', extensions: [history()] })
    state = state.update({
      changes: { from: 0, to: 3, insert: 'two' },
      selection: EditorSelection.single(2),
    }).state
    registry.set(identity, { state, scrollTop: 320, scrollLeft: 12 })

    const restored = registry.get(identity)!
    expect(restored.state.doc.toString()).toBe('two\n')
    expect(restored.state.selection.main.anchor).toBe(2)
    expect(undoDepth(restored.state)).toBe(1)
    expect(restored).toMatchObject({ scrollTop: 320, scrollLeft: 12 })
    expect(registry.get({ ...identity, workspaceId: 'other' })).toBeUndefined()
  })

  it('drops obsolete history epochs and all generations when a document closes', () => {
    const harness = registryHarness()
    const { registry } = harness
    const base = { workspaceId: 'workspace', path: 'a.ts', lifecycleId: 1 }
    harness.admit(base)
    const state = EditorState.create({ doc: 'content' })
    registry.set({ ...base, historyEpoch: 0 }, { state, scrollTop: 0, scrollLeft: 0 })
    registry.set({ ...base, historyEpoch: 1 }, { state, scrollTop: 1, scrollLeft: 1 })
    registry.retainHistoryEpoch({ ...base, historyEpoch: 1 })
    expect(registry.get({ ...base, historyEpoch: 0 })).toBeUndefined()
    expect(registry.get({ ...base, historyEpoch: 1 })).toBeDefined()
    harness.retire(base)
    registry.deleteDocument(base)
    expect(registry.get({ ...base, historyEpoch: 1 })).toBeUndefined()
    registry.set({ ...base, historyEpoch: 1 }, { state, scrollTop: 2, scrollLeft: 2 })
    expect(registry.get({ ...base, historyEpoch: 1 })).toBeUndefined()

    const reopened = { ...base, lifecycleId: 2, historyEpoch: 0 }
    harness.admit(reopened)
    registry.set(reopened, { state, scrollTop: 3, scrollLeft: 3 })
    registry.set({ ...base, historyEpoch: 2 }, { state, scrollTop: 4, scrollLeft: 4 })
    registry.deleteDocument(base)
    expect(registry.get(reopened)).toMatchObject({ scrollTop: 3, scrollLeft: 3 })
  })

  it('admits an inactive live tab on its first set without comparing historical lifecycle numbers', () => {
    const harness = registryHarness()
    const { registry } = harness
    const state = EditorState.create({ doc: 'content' })
    const historical = { workspaceId: 'workspace', path: 'reused.ts', lifecycleId: 99, historyEpoch: 0 }
    harness.admit(historical)
    registry.set(historical, { state, scrollTop: 99, scrollLeft: 0 })
    harness.retire(historical)
    registry.deleteDocument(historical)

    const inactiveLive = { ...historical, lifecycleId: 4 }
    harness.admit(inactiveLive)
    registry.set(inactiveLive, { state, scrollTop: 4, scrollLeft: 0 })
    expect(registry.get(inactiveLive)).toMatchObject({ scrollTop: 4 })
    expect(registry.usage()).toEqual({ sessions: 1 })
  })

  it('clears restored workspaces and retains no state across many unique closes', () => {
    const harness = registryHarness()
    const { registry } = harness
    const state = EditorState.create({ doc: 'content' })
    const other = { workspaceId: 'other', path: 'kept.ts', lifecycleId: 1, historyEpoch: 0 }
    harness.admit(other)
    registry.set(other, { state, scrollTop: 1, scrollLeft: 0 })

    for (let index = 0; index < 512; index += 1) {
      const identity = { workspaceId: 'workspace', path: `closed-${String(index)}.ts`, lifecycleId: index + 1, historyEpoch: 0 }
      harness.admit(identity)
      registry.set(identity, { state, scrollTop: index, scrollLeft: 0 })
      harness.retire(identity)
      registry.deleteDocument(identity)
    }
    expect(registry.usage()).toEqual({ sessions: 1 })

    const restoredOld = { workspaceId: 'workspace', path: 'old.ts', lifecycleId: 900, historyEpoch: 0 }
    harness.admit(restoredOld)
    registry.set(restoredOld, { state, scrollTop: 900, scrollLeft: 0 })
    registry.clearWorkspace('workspace')
    expect(registry.usage()).toEqual({ sessions: 1 })
    expect(registry.get(other)).toBeDefined()
  })
})
