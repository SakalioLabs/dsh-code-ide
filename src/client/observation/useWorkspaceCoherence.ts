import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { KnownObservationTarget } from '../../shared/workspace-observation.ts'
import { fileApi } from '../api.ts'
import {
  PollingWorkspaceObservationSource,
  type ObservationSubscription,
  type WorkspaceInvalidation,
} from './source.ts'

export interface WorkspaceCoherenceOptions {
  workspaceId: string | undefined
  /** Monotonic page selection identity; distinguishes W1 -> W2 -> W1 ABA. */
  workspaceEpoch: number
  targets: readonly KnownObservationTarget[]
  onInvalidations: (workspaceId: string, workspaceEpoch: number, invalidations: readonly WorkspaceInvalidation[]) => void
  onObserved?: (workspaceId: string, workspaceEpoch: number) => void
  onError?: (workspaceId: string, workspaceEpoch: number, error: unknown) => void
}

/** Thin React ownership adapter around the transport-agnostic observation source. */
export function useWorkspaceCoherence(options: WorkspaceCoherenceOptions): { refreshVisible: () => void } {
  const source = useMemo(() => new PollingWorkspaceObservationSource(fileApi), [])
  const latest = useRef(options)
  const subscription = useRef<{ workspaceId: string; workspaceEpoch: number; value: ObservationSubscription }>()
  latest.current = options

  useEffect(() => {
    subscription.current?.value.dispose()
    subscription.current = undefined
    if (options.workspaceId === undefined) return
    const subscribedWorkspaceId = options.workspaceId
    const subscribedWorkspaceEpoch = options.workspaceEpoch
    const current = source.subscribe({
      workspaceId: subscribedWorkspaceId,
      getTargets: () => latest.current.workspaceId === subscribedWorkspaceId
        && latest.current.workspaceEpoch === subscribedWorkspaceEpoch ? latest.current.targets : [],
      onInvalidations: (invalidations) => {
        if (latest.current.workspaceId === subscribedWorkspaceId
          && latest.current.workspaceEpoch === subscribedWorkspaceEpoch) {
          latest.current.onInvalidations(subscribedWorkspaceId, subscribedWorkspaceEpoch, invalidations)
        }
      },
      onObserved: () => {
        if (latest.current.workspaceId === subscribedWorkspaceId
          && latest.current.workspaceEpoch === subscribedWorkspaceEpoch) {
          latest.current.onObserved?.(subscribedWorkspaceId, subscribedWorkspaceEpoch)
        }
      },
      onError: (error) => {
        if (latest.current.workspaceId === subscribedWorkspaceId
          && latest.current.workspaceEpoch === subscribedWorkspaceEpoch) {
          latest.current.onError?.(subscribedWorkspaceId, subscribedWorkspaceEpoch, error)
        }
      },
    })
    subscription.current = {
      workspaceId: subscribedWorkspaceId,
      workspaceEpoch: subscribedWorkspaceEpoch,
      value: current,
    }
    return () => {
      current.dispose()
      if (subscription.current?.value === current) subscription.current = undefined
    }
  }, [options.workspaceEpoch, options.workspaceId, source])

  const refreshVisible = useCallback(() => {
    const current = subscription.current
    if (current !== undefined && current.workspaceId === latest.current.workspaceId
      && current.workspaceEpoch === latest.current.workspaceEpoch) {
      void current.value.refresh({ emitAll: true })
    }
  }, [])
  return { refreshVisible }
}
