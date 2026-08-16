import { describe, expect, it } from 'vitest'
import type { EditorTab } from '../../src/client/documents/session.ts'
import {
  applyDocumentReload,
  reconcileDirectories,
  reconcileDocuments,
} from '../../src/client/observation/reconciler.ts'
import type { WorkspaceInvalidation } from '../../src/client/observation/source.ts'

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    path: 'src/index.ts',
    name: 'index.ts',
    content: 'const value = 1\n',
    baselineContent: 'const value = 1\n',
    version: 'v1',
    dirty: false,
    lifecycleId: 1,
    localRevision: 0,
    historyEpoch: 0,
    ...overrides,
  }
}

function fileInvalidation(state: 'present' | 'missing', version = 'v2'): WorkspaceInvalidation {
  return {
    target: { kind: 'file', path: 'src/index.ts', knownVersion: 'v1' },
    current: state === 'present'
      ? { kind: 'file', path: 'src/index.ts', state, version, size: 12 }
      : { kind: 'file', path: 'src/index.ts', state },
    reason: 'changed',
  }
}

describe('document observation reconciliation', () => {
  it('reloads a clean changed tab without applying content in the pure planner', () => {
    const original = tab()
    const plan = reconcileDocuments([original], [fileInvalidation('present')])
    expect(plan.reloads).toEqual([{ path: original.path, expectedVersion: 'v1', observedVersion: 'v2' }])
    expect(plan.tabs[0]).toMatchObject({ content: original.content, baselineContent: original.baselineContent, externalState: 'modified' })
  })

  it('never overwrites a dirty tab and marks the external change', () => {
    const dirty = tab({ content: 'local unsaved edit\n', dirty: true })
    const plan = reconcileDocuments([dirty], [fileInvalidation('present')])
    expect(plan.reloads).toEqual([])
    expect(plan.tabs[0]).toEqual({ ...dirty, externalState: 'modified' })
  })

  it('marks deleted documents and clears a stale marker once versions agree', () => {
    expect(reconcileDocuments([tab()], [fileInvalidation('missing')]).tabs[0]?.externalState).toBe('deleted')
    const agreed = tab({ externalState: 'modified' })
    expect(reconcileDocuments([agreed], [fileInvalidation('present', 'v1')]).tabs[0]).toEqual(tab())
  })

  it('adopts a clean authoritative read but ignores a stale completion after a newer save', () => {
    const loaded = applyDocumentReload([tab({ externalState: 'modified' })], {
      path: 'src/index.ts',
      expectedVersion: 'v1',
      content: 'external content\n',
      version: 'v2',
    })
    expect(loaded[0]).toEqual(tab({
      content: 'external content\n',
      baselineContent: 'external content\n',
      version: 'v2',
      historyEpoch: 1,
    }))

    const savedWhileReading = tab({ version: 'v3', content: 'saved locally\n', baselineContent: 'saved locally\n' })
    expect(applyDocumentReload([savedWhileReading], {
      path: 'src/index.ts',
      expectedVersion: 'v1',
      content: 'stale read\n',
      version: 'v2',
    })[0]).toBe(savedWhileReading)
  })

  it('preserves and marks a buffer dirtied while an authoritative read was in flight', () => {
    const dirtied = tab({ content: 'typing continued\n', dirty: true })
    expect(applyDocumentReload([dirtied], {
      path: 'src/index.ts',
      expectedVersion: 'v1',
      content: 'external content\n',
      version: 'v2',
    })[0]).toEqual({ ...dirtied, externalState: 'modified' })
  })
})

describe('directory observation reconciliation', () => {
  it('refreshes changed directories and prunes a missing subtree via its parent', () => {
    const invalidations: WorkspaceInvalidation[] = [
      {
        target: { kind: 'directory', path: 'src' },
        current: { kind: 'directory', path: 'src', state: 'present', version: 'children-v2' },
        reason: 'changed',
      },
      {
        target: { kind: 'directory', path: 'src/generated' },
        current: { kind: 'directory', path: 'src/generated', state: 'missing' },
        reason: 'changed',
      },
    ]
    expect(reconcileDirectories(invalidations)).toEqual({
      refreshPaths: ['src'],
      removedPaths: ['src/generated'],
    })
  })
})
