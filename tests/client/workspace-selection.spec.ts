import { describe, expect, it, vi } from 'vitest'
import { coordinateWorkbenchWorkspaceSelection } from '../../src/client/workspace-selection.ts'

describe('workbench workspace selection coordinator', () => {
  it('delivers every batched W1 -> W2 -> W1 transition to all domain owners', async () => {
    const calls: string[] = []
    const syncPort = (name: string) => ({
      selectWorkspace: vi.fn((workspaceId: string | undefined) => {
        calls.push(`${name}:${workspaceId ?? 'none'}`)
      }),
    })
    const explorer = {
      selectWorkspace: vi.fn(async (workspaceId: string | undefined) => {
        calls.push(`explorer:${workspaceId ?? 'none'}`)
      }),
    }
    let activeWorkspaceId: string | undefined
    let activeWorkspaceEpoch = 0
    const documents = {
      selectWorkspace: vi.fn((workspaceId: string | undefined) => {
        if (workspaceId === activeWorkspaceId) return
        activeWorkspaceId = workspaceId
        activeWorkspaceEpoch += 1
        calls.push(`documents:${workspaceId ?? 'none'}`)
      }),
      getSnapshot: () => ({
        activeWorkspaceEpoch,
        ...(activeWorkspaceId === undefined ? {} : { activeWorkspaceId }),
      }),
    }
    const editorClose = {
      selectWorkspace: vi.fn((workspaceId: string | undefined, workspaceEpoch: number) => {
        calls.push(`close:${workspaceId ?? 'none'}:${String(workspaceEpoch)}`)
      }),
    }
    const documentConflict = {
      selectWorkspace: vi.fn((workspaceId: string | undefined, workspaceEpoch: number) => {
        calls.push(`conflict:${workspaceId ?? 'none'}:${String(workspaceEpoch)}`)
      }),
    }
    const ports = {
      explorer,
      quickOpen: syncPort('quick'),
      workspaceSearch: syncPort('search'),
      workspaceReplace: syncPort('replace'),
      documents,
      editorClose,
      documentConflict,
    }

    const first = coordinateWorkbenchWorkspaceSelection('w1', ports)
    const second = coordinateWorkbenchWorkspaceSelection('w2', ports)
    const third = coordinateWorkbenchWorkspaceSelection('w1', ports)
    await Promise.all([first, second, third])

    expect(calls).toEqual([
      'explorer:w1', 'quick:w1', 'search:w1', 'replace:w1', 'documents:w1', 'close:w1:1', 'conflict:w1:1',
      'explorer:w2', 'quick:w2', 'search:w2', 'replace:w2', 'documents:w2', 'close:w2:2', 'conflict:w2:2',
      'explorer:w1', 'quick:w1', 'search:w1', 'replace:w1', 'documents:w1', 'close:w1:3', 'conflict:w1:3',
    ])
  })
})
