import type { DocumentIdentity } from '../documents/session.ts'

export type PreviewMode = 'source' | 'preview'

export type PreviewModeIdentity = Readonly<Pick<
  DocumentIdentity,
  'workspaceId' | 'workspaceEpoch' | 'path' | 'lifecycleId'
>>

export type PreviewModeChangeResult = 'applied' | 'not-needed' | 'stale'

export interface PreviewModeSnapshot {
  /** Monotonic presentation-only revision for useSyncExternalStore. */
  readonly revision: number
  readonly liveIdentities: number
  readonly previewIdentities: number
}

type Listener = () => void

function identityKey(identity: PreviewModeIdentity): string {
  // A JSON tuple is unambiguous even when a Host-owned workspace id contains
  // separator characters. Path is intentionally absent: a committed rename
  // retains the same page-local document lifecycle and therefore its mode.
  return JSON.stringify([
    identity.workspaceId,
    identity.workspaceEpoch,
    identity.lifecycleId,
  ])
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const key of left) if (!right.has(key)) return false
  return true
}

/**
 * Page-local source/preview projection.
 *
 * DocumentSessionStore remains the sole buffer/save/lifecycle authority. This
 * registry admits only identities supplied by synchronize(), retains a mode
 * through path rebases, and drops state across close/reopen and workspace ABA.
 */
export class PreviewModeRegistry {
  private readonly listeners = new Set<Listener>()
  private live = new Set<string>()
  /** Source is the implicit default, so only explicit preview modes are kept. */
  private readonly previews = new Set<string>()
  private snapshot: PreviewModeSnapshot = Object.freeze({
    revision: 0,
    liveIdentities: 0,
    previewIdentities: 0,
  })

  readonly getSnapshot = (): PreviewModeSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(): void {
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      liveIdentities: this.live.size,
      previewIdentities: this.previews.size,
    })
    for (const listener of this.listeners) {
      try { listener() } catch { /* presentation observers cannot roll back a committed mode */ }
    }
  }

  synchronize(liveIdentities: readonly PreviewModeIdentity[]): void {
    const nextLive = new Set(liveIdentities.map(identityKey))
    const admissionChanged = !sameKeys(this.live, nextLive)
    let previewChanged = false
    for (const key of this.previews) {
      if (nextLive.has(key)) continue
      this.previews.delete(key)
      previewChanged = true
    }
    this.live = nextLive
    if (admissionChanged || previewChanged) this.publish()
  }

  /** Unknown or retired identities always project the safe source default. */
  get(identity: PreviewModeIdentity): PreviewMode {
    const key = identityKey(identity)
    return this.live.has(key) && this.previews.has(key) ? 'preview' : 'source'
  }

  set(identity: PreviewModeIdentity, mode: PreviewMode): PreviewModeChangeResult {
    const key = identityKey(identity)
    if (!this.live.has(key)) return 'stale'
    const current: PreviewMode = this.previews.has(key) ? 'preview' : 'source'
    if (current === mode) return 'not-needed'
    if (mode === 'preview') this.previews.add(key)
    else this.previews.delete(key)
    this.publish()
    return 'applied'
  }

  toggle(identity: PreviewModeIdentity): PreviewModeChangeResult {
    const key = identityKey(identity)
    if (!this.live.has(key)) return 'stale'
    if (this.previews.has(key)) this.previews.delete(key)
    else this.previews.add(key)
    this.publish()
    return 'applied'
  }
}
