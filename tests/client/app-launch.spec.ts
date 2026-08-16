import { describe, expect, it } from 'vitest'
import { readAppLaunchOptions, selectInitialWorkspace } from '../../src/client/App.tsx'

describe('embedded app launch', () => {
  it('reads only the explicit embedded flag and a non-empty workspace id', () => {
    expect(readAppLaunchOptions('?embedded=1&workspaceId=%20workspace-b%20')).toEqual({
      embedded: true,
      requestedWorkspaceId: 'workspace-b',
    })
    expect(readAppLaunchOptions('?embedded=true&workspaceId=%20')).toEqual({ embedded: false })
  })

  it('keeps mutation recovery as the strongest workspace fence', () => {
    expect(selectInitialWorkspace({
      registeredWorkspaceIds: new Set(['recovery', 'requested']),
      mutationRecoveryWorkspace: 'recovery',
      requestedWorkspaceId: 'requested',
      persistedActiveWorkspace: 'requested',
    })).toBe('recovery')
  })

  it('selects a registered explicit workspace before persisted and ambient state', () => {
    expect(selectInitialWorkspace({
      registeredWorkspaceIds: new Set(['requested', 'persisted', 'ambient']),
      requestedWorkspaceId: 'requested',
      persistedActiveWorkspace: 'persisted',
      currentWorkspaceId: 'ambient',
    })).toBe('requested')
  })

  it('fails closed when an explicit workspace is not registered', () => {
    expect(selectInitialWorkspace({
      registeredWorkspaceIds: new Set(['persisted', 'ambient', 'first']),
      requestedWorkspaceId: 'missing',
      persistedActiveWorkspace: 'persisted',
      currentWorkspaceId: 'ambient',
      firstWorkspaceId: 'first',
    })).toBeUndefined()
  })

  it('uses only registered fallbacks when no workspace was explicitly requested', () => {
    expect(selectInitialWorkspace({
      registeredWorkspaceIds: new Set(['ambient', 'first']),
      persistedActiveWorkspace: 'stale',
      currentWorkspaceId: 'ambient',
      firstWorkspaceId: 'first',
    })).toBe('ambient')
  })
})
