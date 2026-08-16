import {
  DEFAULT_MAX_INSPECT_TARGETS,
  type InspectResponse,
  type KnownObservationTarget,
  type ObservationSnapshot,
  type ObservationTarget,
} from '../../shared/workspace-observation.ts'

export interface ObservationApi {
  inspect(workspaceId: string, targets: readonly ObservationTarget[], signal?: AbortSignal): Promise<InspectResponse>
}

export interface VisibilityPort {
  isVisible(): boolean
  subscribe(listener: () => void): () => void
}

export interface SchedulerPort {
  every(milliseconds: number, listener: () => void): () => void
}

export interface WorkspaceInvalidation {
  target: KnownObservationTarget
  previous?: ObservationSnapshot
  current: ObservationSnapshot
  reason: 'changed' | 'manual'
}

export interface ObservationSubscription {
  refresh(options?: { emitAll?: boolean }): Promise<void>
  dispose(): void
}

export interface ObserveWorkspaceOptions {
  workspaceId: string
  getTargets: () => readonly KnownObservationTarget[]
  onInvalidations: (invalidations: readonly WorkspaceInvalidation[]) => void
  onObserved?: () => void
  onError?: (error: unknown) => void
}

export interface PollingWorkspaceObservationOptions {
  intervalMs?: number
  maxTargets?: number
  visibility?: VisibilityPort
  scheduler?: SchedulerPort
}

function targetKey(target: ObservationTarget): string {
  return `${target.kind}\0${target.path}`
}

function snapshotsEqual(left: ObservationSnapshot, right: ObservationSnapshot): boolean {
  if (left.kind !== right.kind || left.path !== right.path || left.state !== right.state) return false
  if (left.state === 'missing' || right.state === 'missing') return true
  if (left.version !== right.version) return false
  return left.kind !== 'file' || right.kind !== 'file' || left.size === right.size
}

function defaultVisibility(): VisibilityPort {
  return {
    isVisible: () => document.visibilityState !== 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

function defaultScheduler(): SchedulerPort {
  return {
    every: (milliseconds, listener) => {
      const handle = window.setInterval(listener, milliseconds)
      return () => { window.clearInterval(handle) }
    },
  }
}

function uniqueTargets(targets: readonly KnownObservationTarget[]): KnownObservationTarget[] {
  const output: KnownObservationTarget[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    const key = targetKey(target)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(target)
  }
  return output
}

/**
 * Bounded polling is an invalidation source, never the content authority.
 * Consumers must reconcile a changed file with read() and a directory with list().
 */
export class PollingWorkspaceObservationSource {
  private readonly intervalMs: number
  private readonly maxTargets: number
  private readonly visibility: VisibilityPort
  private readonly scheduler: SchedulerPort

  constructor(private readonly api: ObservationApi, options: PollingWorkspaceObservationOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2_000
    this.maxTargets = options.maxTargets ?? DEFAULT_MAX_INSPECT_TARGETS
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Observation interval must be a positive integer.')
    }
    if (!Number.isSafeInteger(this.maxTargets) || this.maxTargets <= 0) {
      throw new Error('Observation target limit must be a positive integer.')
    }
    this.visibility = options.visibility ?? defaultVisibility()
    this.scheduler = options.scheduler ?? defaultScheduler()
  }

  subscribe(options: ObserveWorkspaceOptions): ObservationSubscription {
    const previous = new Map<string, ObservationSnapshot>()
    let disposed = false
    let generation = 0
    let active: AbortController | undefined

    const refresh = async ({ emitAll = false }: { emitAll?: boolean } = {}): Promise<void> => {
      if (disposed || (!emitAll && !this.visibility.isVisible())) return
      if (active !== undefined && !emitAll) return
      const currentGeneration = ++generation
      active?.abort()
      const controller = new AbortController()
      active = controller
      const targets = uniqueTargets(options.getTargets())
      const wireTargets: ObservationTarget[] = targets.map(({ kind, path }) => ({ kind, path }))
      if (wireTargets.length === 0) {
        previous.clear()
        if (active === controller) active = undefined
        return
      }

      try {
        const snapshots: ObservationSnapshot[] = []
        for (let offset = 0; offset < wireTargets.length; offset += this.maxTargets) {
          const result = await this.api.inspect(
            options.workspaceId,
            wireTargets.slice(offset, offset + this.maxTargets),
            controller.signal,
          )
          snapshots.push(...result.snapshots)
        }
        if (disposed || controller.signal.aborted || generation !== currentGeneration) return
        const received = new Map(snapshots.map(snapshot => [targetKey(snapshot), snapshot]))
        const invalidations: WorkspaceInvalidation[] = []
        const retained = new Set<string>()

        for (const target of targets) {
          const key = targetKey(target)
          const snapshot = received.get(key)
          if (snapshot === undefined) throw new Error(`Inspect response omitted ${target.kind} target ${target.path}`)
          retained.add(key)
          const before = previous.get(key)
          const matchesKnownVersion = target.kind === 'file'
            && snapshot.state === 'present'
            && target.knownVersion !== undefined
            && snapshot.version === target.knownVersion
          const divergesFromKnownVersion = target.kind === 'file'
            && target.knownVersion !== undefined
            && (snapshot.state === 'missing' || snapshot.version !== target.knownVersion)
          const changed = before !== undefined && !snapshotsEqual(before, snapshot)
          if (emitAll || divergesFromKnownVersion || (changed && !matchesKnownVersion)) {
            invalidations.push({
              target,
              ...(before === undefined ? {} : { previous: before }),
              current: snapshot,
              reason: emitAll ? 'manual' : 'changed',
            })
          }
          previous.set(key, snapshot)
        }

        for (const key of previous.keys()) if (!retained.has(key)) previous.delete(key)
        options.onObserved?.()
        if (invalidations.length > 0) options.onInvalidations(invalidations)
      } catch (error) {
        if (!disposed && !controller.signal.aborted && generation === currentGeneration) options.onError?.(error)
      } finally {
        if (active === controller) active = undefined
      }
    }

    const stopInterval = this.scheduler.every(this.intervalMs, () => { void refresh() })
    const stopVisibility = this.visibility.subscribe(() => {
      if (this.visibility.isVisible()) void refresh()
      else {
        generation += 1
        active?.abort()
        active = undefined
      }
    })
    void refresh()

    return {
      refresh,
      dispose: () => {
        if (disposed) return
        disposed = true
        generation += 1
        active?.abort()
        active = undefined
        stopInterval()
        stopVisibility()
        previous.clear()
      },
    }
  }
}
