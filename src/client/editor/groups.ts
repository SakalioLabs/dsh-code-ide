import type { DocumentIdentity, EditorTab } from '../documents/session.ts'

export const MAX_EDITOR_GROUPS = 4

export type EditorGroupSplitEdge = 'top' | 'right'
export type EditorGroupSplitAxis = 'horizontal' | 'vertical'
export type EditorGroupTabPlacement = 'before' | 'after'

export interface EditorGroupDocumentIdentity extends DocumentIdentity {}

export interface EditorGroup {
  readonly id: string
  readonly tabs: readonly EditorGroupDocumentIdentity[]
  readonly activePath?: string
}

export type EditorGroupLayout =
  | { readonly kind: 'group'; readonly groupId: string }
  | {
    readonly kind: 'split'
    readonly axis: EditorGroupSplitAxis
    readonly first: EditorGroupLayout
    readonly second: EditorGroupLayout
  }

export interface EditorGroupsSnapshot {
  readonly workspaceId?: string
  readonly workspaceEpoch: number
  readonly groups: readonly EditorGroup[]
  readonly layout?: EditorGroupLayout
  readonly activeGroupId?: string
}

export interface EditorGroupsDocuments {
  readonly workspaceId?: string
  readonly workspaceEpoch: number
  readonly tabs: readonly Pick<EditorTab, 'path' | 'lifecycleId'>[]
  readonly activePath?: string
}

export type EditorGroupActivateResult = 'applied' | 'not-needed' | 'stale'
export type EditorGroupDragResult = 'applied' | 'not-needed' | 'stale'
export type EditorGroupMoveResult = 'applied' | 'not-needed' | 'stale'
export type EditorGroupSplitResult =
  | { readonly kind: 'applied'; readonly groupId: string }
  | { readonly kind: 'not-needed' | 'stale' | 'group-limit' | 'source-would-empty' }

type Listener = () => void

interface EditorGroupDragTransaction {
  readonly source: EditorGroupDocumentIdentity
  readonly baseline: EditorGroupsSnapshot
}

const EMPTY_SNAPSHOT: EditorGroupsSnapshot = Object.freeze({
  workspaceEpoch: 0,
  groups: Object.freeze([]),
})

function lifecycleKey(identity: Pick<EditorGroupDocumentIdentity, 'lifecycleId'>): number {
  return identity.lifecycleId
}

function exactDocument(
  identity: EditorGroupDocumentIdentity,
  workspaceId: string,
  workspaceEpoch: number,
): boolean {
  return identity.workspaceId === workspaceId && identity.workspaceEpoch === workspaceEpoch
}

function groupLeaf(groupId: string): EditorGroupLayout {
  return { kind: 'group', groupId }
}

function replaceLeaf(
  node: EditorGroupLayout,
  groupId: string,
  replacement: EditorGroupLayout,
): EditorGroupLayout | undefined {
  if (node.kind === 'group') return node.groupId === groupId ? replacement : node
  const first = replaceLeaf(node.first, groupId, replacement)
  const second = replaceLeaf(node.second, groupId, replacement)
  if (first === undefined || second === undefined) return undefined
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

function pruneLayout(node: EditorGroupLayout, admitted: ReadonlySet<string>): EditorGroupLayout | undefined {
  if (node.kind === 'group') return admitted.has(node.groupId) ? node : undefined
  const first = pruneLayout(node.first, admitted)
  const second = pruneLayout(node.second, admitted)
  if (first === undefined) return second
  if (second === undefined) return first
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

function sameIdentity(a: EditorGroupDocumentIdentity, b: EditorGroupDocumentIdentity): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch
    && a.path === b.path && a.lifecycleId === b.lifecycleId
}

function sameGroup(a: EditorGroup, b: EditorGroup): boolean {
  return a.id === b.id && a.activePath === b.activePath && a.tabs.length === b.tabs.length
    && a.tabs.every((tab, index) => {
      const other = b.tabs[index]
      return other !== undefined && sameIdentity(tab, other)
    })
}

function sameLayout(a: EditorGroupLayout | undefined, b: EditorGroupLayout | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.kind !== b.kind) return false
  if (a.kind === 'group' && b.kind === 'group') return a.groupId === b.groupId
  return a.kind === 'split' && b.kind === 'split' && a.axis === b.axis
    && sameLayout(a.first, b.first) && sameLayout(a.second, b.second)
}

function sameSnapshot(a: EditorGroupsSnapshot, b: EditorGroupsSnapshot): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceEpoch === b.workspaceEpoch
    && a.activeGroupId === b.activeGroupId && sameLayout(a.layout, b.layout)
    && a.groups.length === b.groups.length
    && a.groups.every((group, index) => {
      const other = b.groups[index]
      return other !== undefined && sameGroup(group, other)
    })
}

/**
 * Browser-local projection of open documents into at most four editor groups.
 * DocumentSessionStore remains the sole buffer/save/lifecycle authority.
 */
export class EditorGroupsStore {
  private snapshot: EditorGroupsSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<Listener>()
  private groupSequence = 0
  private dragTransaction: EditorGroupDragTransaction | undefined

  readonly getSnapshot = (): EditorGroupsSnapshot => this.snapshot

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private nextGroupId(): string {
    this.groupSequence += 1
    return `editor-group-${String(this.groupSequence)}`
  }

  private publish(next: EditorGroupsSnapshot): void {
    if (sameSnapshot(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of this.listeners) {
      try { listener() } catch { /* layout observers cannot roll back a committed transition */ }
    }
  }

  synchronize(documents: EditorGroupsDocuments): void {
    // A document-domain transition supersedes any presentation-only drag
    // preview. Reconcile from the pre-drag layout so no hidden tab can be
    // mistaken for a close.
    if (this.dragTransaction !== undefined) {
      const baseline = this.dragTransaction.baseline
      this.dragTransaction = undefined
      this.publish(baseline)
    }
    const { workspaceId, workspaceEpoch } = documents
    if (workspaceId === undefined) {
      this.publish(workspaceEpoch === 0 ? EMPTY_SNAPSHOT : {
        workspaceEpoch,
        groups: Object.freeze([]),
      })
      return
    }
    const live = documents.tabs.map((tab): EditorGroupDocumentIdentity => ({
      workspaceId,
      workspaceEpoch,
      path: tab.path,
      lifecycleId: tab.lifecycleId,
    }))
    if (this.snapshot.workspaceId !== workspaceId || this.snapshot.workspaceEpoch !== workspaceEpoch
      || this.snapshot.layout === undefined || this.snapshot.groups.length === 0) {
      const groupId = this.nextGroupId()
      const activePath = documents.activePath !== undefined
        && live.some(tab => tab.path === documents.activePath)
        ? documents.activePath
        : live[0]?.path
      this.publish({
        workspaceId,
        workspaceEpoch,
        groups: [{ id: groupId, tabs: live, ...(activePath === undefined ? {} : { activePath }) }],
        layout: groupLeaf(groupId),
        activeGroupId: groupId,
      })
      return
    }

    // A committed rename/rebase retains lifecycleId. Matching by path here would
    // misclassify it as close+open and append the document to the active group.
    const liveByLifecycle = new Map(live.map(identity => [lifecycleKey(identity), identity]))
    const assigned = new Set<number>()
    let groups = this.snapshot.groups.map((group): EditorGroup => {
      const tabs: EditorGroupDocumentIdentity[] = []
      const priorActive = group.tabs.find(tab => tab.path === group.activePath)
      for (const retained of group.tabs) {
        const key = lifecycleKey(retained)
        const current = liveByLifecycle.get(key)
        if (current === undefined || assigned.has(key)) continue
        assigned.add(key)
        tabs.push(current)
      }
      const rebasedActive = priorActive === undefined ? undefined : liveByLifecycle.get(lifecycleKey(priorActive))
      const activePath = rebasedActive !== undefined && tabs.some(tab => tab === rebasedActive)
        ? rebasedActive.path
        : tabs[0]?.path
      return { id: group.id, tabs, ...(activePath === undefined ? {} : { activePath }) }
    })

    if (groups.length > 1) groups = groups.filter(group => group.tabs.length > 0)
    if (groups.length === 0) {
      const groupId = this.nextGroupId()
      groups = [{ id: groupId, tabs: [] }]
    }
    const priorActive = groups.find(group => group.id === this.snapshot.activeGroupId)
    const appendGroup = priorActive ?? groups[0]!
    const additions = live.filter(identity => !assigned.has(lifecycleKey(identity)))
    if (additions.length > 0) {
      groups = groups.map(group => group.id === appendGroup.id
        ? { ...group, tabs: [...group.tabs, ...additions] }
        : group)
    }

    const globalActiveGroup = documents.activePath === undefined
      ? undefined
      : groups.find(group => group.tabs.some(tab => tab.path === documents.activePath))
    const globalActivePath = documents.activePath
    if (globalActiveGroup !== undefined && globalActivePath !== undefined
      && globalActiveGroup.activePath !== globalActivePath) {
      groups = groups.map(group => group.id === globalActiveGroup.id
        ? { ...group, activePath: globalActivePath }
        : group)
    }
    const activeGroup = globalActiveGroup ?? priorActive ?? groups[0]!
    const admitted = new Set(groups.map(group => group.id))
    const layout = pruneLayout(this.snapshot.layout, admitted) ?? groupLeaf(groups[0]!.id)
    this.publish({ workspaceId, workspaceEpoch, groups, layout, activeGroupId: activeGroup.id })
  }

  activate(groupId: string, identity: EditorGroupDocumentIdentity): EditorGroupActivateResult {
    const workspaceId = this.snapshot.workspaceId
    if (workspaceId === undefined || !exactDocument(identity, workspaceId, this.snapshot.workspaceEpoch)) return 'stale'
    const group = this.snapshot.groups.find(candidate => candidate.id === groupId)
    if (group === undefined || !group.tabs.some(tab => sameIdentity(tab, identity))) return 'stale'
    if (this.snapshot.activeGroupId === groupId && group.activePath === identity.path) return 'not-needed'
    const groups = this.snapshot.groups.map(candidate => candidate.id === groupId
      ? { ...candidate, activePath: identity.path }
      : candidate)
    this.publish({ ...this.snapshot, groups, activeGroupId: groupId })
    return 'applied'
  }

  /**
   * Starts a reversible layout preview for a native tab drag. The source tab
   * is temporarily removed from the projection, allowing its previous pane to
   * show the next tab or collapse while the exact baseline remains available
   * for drag cancellation.
   */
  beginTabDrag(source: EditorGroupDocumentIdentity): EditorGroupDragResult {
    const active = this.dragTransaction
    if (active !== undefined) {
      if (sameIdentity(active.source, source)) return 'not-needed'
      this.dragTransaction = undefined
      this.publish(active.baseline)
    }

    const workspaceId = this.snapshot.workspaceId
    if (workspaceId === undefined || this.snapshot.layout === undefined
      || !exactDocument(source, workspaceId, this.snapshot.workspaceEpoch)) return 'stale'
    const sourceGroup = this.snapshot.groups.find(group => group.tabs.some(tab => sameIdentity(tab, source)))
    if (sourceGroup === undefined) return 'stale'

    const baseline = this.snapshot
    let groups = baseline.groups.map((group): EditorGroup => {
      if (group.id !== sourceGroup.id) return group
      const sourceIndex = group.tabs.findIndex(tab => sameIdentity(tab, source))
      const tabs = group.tabs.filter(tab => !sameIdentity(tab, source))
      const activePath = group.activePath === source.path
        ? (tabs[Math.min(sourceIndex, tabs.length - 1)] ?? tabs[tabs.length - 1])?.path
        : group.activePath
      return { ...group, tabs, ...(activePath === undefined ? {} : { activePath }) }
    })
    // Keep one empty leaf only when there is no other pane to receive the
    // space. With two or more groups, an emptied source pane collapses now.
    if (groups.length > 1) groups = groups.filter(group => group.tabs.length > 0)
    const admitted = new Set(groups.map(group => group.id))
    const layout = pruneLayout(baseline.layout!, admitted) ?? groupLeaf(groups[0]!.id)
    const activeGroup = groups.find(group => group.id === baseline.activeGroupId) ?? groups[0]!
    this.dragTransaction = { source, baseline }
    this.publish({ ...baseline, groups, layout, activeGroupId: activeGroup.id })
    return 'applied'
  }

  /** Restores the exact pre-drag projection when no legal drop committed. */
  cancelTabDrag(source?: EditorGroupDocumentIdentity): EditorGroupDragResult {
    const active = this.dragTransaction
    if (active === undefined) return 'not-needed'
    if (source !== undefined && !sameIdentity(active.source, source)) return 'stale'
    this.dragTransaction = undefined
    this.publish(active.baseline)
    return 'applied'
  }

  moveTab(
    source: EditorGroupDocumentIdentity,
    targetGroupId: string,
    target: EditorGroupDocumentIdentity,
    placement: EditorGroupTabPlacement,
  ): EditorGroupMoveResult {
    const workspaceId = this.snapshot.workspaceId
    if (workspaceId === undefined || !exactDocument(source, workspaceId, this.snapshot.workspaceEpoch)
      || !exactDocument(target, workspaceId, this.snapshot.workspaceEpoch)) return 'stale'
    const drag = this.dragTransaction
    if (drag !== undefined && !sameIdentity(drag.source, source)) return 'stale'
    if (drag !== undefined && sameIdentity(drag.source, source)) {
      const targetGroup = this.snapshot.groups.find(group => group.id === targetGroupId
        && group.tabs.some(tab => sameIdentity(tab, target)))
      if (targetGroup === undefined || sameIdentity(source, target)) return 'stale'
      const groupsWithoutSource = this.snapshot.groups.map((group): EditorGroup => {
        const tabs = group.tabs.filter(tab => !sameIdentity(tab, source))
        if (tabs.length === group.tabs.length) return group
        return { ...group, tabs }
      })
      const groups = groupsWithoutSource.map((group): EditorGroup => {
        if (group.id !== targetGroupId) return group
        const tabs = [...group.tabs]
        const targetIndex = tabs.findIndex(tab => sameIdentity(tab, target))
        if (targetIndex < 0) return group
        tabs.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, source)
        return { ...group, tabs, activePath: source.path }
      })
      this.dragTransaction = undefined
      this.publish({ ...this.snapshot, groups, activeGroupId: targetGroupId })
      return 'applied'
    }
    const sourceGroup = this.snapshot.groups.find(group => group.tabs.some(tab => sameIdentity(tab, source)))
    const targetGroup = this.snapshot.groups.find(group => group.id === targetGroupId
      && group.tabs.some(tab => sameIdentity(tab, target)))
    if (sourceGroup === undefined || targetGroup === undefined) return 'stale'
    if (sameIdentity(source, target)) return 'not-needed'

    const targetIndex = targetGroup.tabs.findIndex(tab => sameIdentity(tab, target))
    const nextTarget = targetGroup.tabs.filter(tab => !sameIdentity(tab, source))
    const adjustedIndex = nextTarget.findIndex(tab => sameIdentity(tab, target))
    const insertionIndex = adjustedIndex + (placement === 'after' ? 1 : 0)
    nextTarget.splice(insertionIndex, 0, source)
    if (sourceGroup.id === targetGroup.id
      && sourceGroup.tabs.length === nextTarget.length
      && sourceGroup.tabs.every((tab, index) => sameIdentity(tab, nextTarget[index]!))) return 'not-needed'

    let groups = this.snapshot.groups.map(group => {
      if (group.id === targetGroup.id) return { ...group, tabs: nextTarget, activePath: source.path }
      if (group.id !== sourceGroup.id) return group
      const tabs = group.tabs.filter(tab => !sameIdentity(tab, source))
      const priorIndex = group.tabs.findIndex(tab => sameIdentity(tab, source))
      const activePath = group.activePath === source.path
        ? (tabs[Math.min(priorIndex, tabs.length - 1)] ?? tabs[tabs.length - 1])?.path
        : group.activePath
      return { ...group, tabs, ...(activePath === undefined ? {} : { activePath }) }
    })
    if (sourceGroup.id !== targetGroup.id && sourceGroup.tabs.length === 1) {
      groups = groups.filter(group => group.id !== sourceGroup.id)
    }
    const admitted = new Set(groups.map(group => group.id))
    const layout = pruneLayout(this.snapshot.layout!, admitted) ?? groupLeaf(targetGroup.id)
    this.publish({ ...this.snapshot, groups, layout, activeGroupId: targetGroup.id })
    return 'applied'
  }

  splitTab(
    source: EditorGroupDocumentIdentity,
    targetGroupId: string,
    edge: EditorGroupSplitEdge,
  ): EditorGroupSplitResult {
    const workspaceId = this.snapshot.workspaceId
    if (workspaceId === undefined || this.snapshot.layout === undefined
      || !exactDocument(source, workspaceId, this.snapshot.workspaceEpoch)) return { kind: 'stale' }
    const drag = this.dragTransaction
    if (drag !== undefined && !sameIdentity(drag.source, source)) return { kind: 'stale' }
    if (drag !== undefined && sameIdentity(drag.source, source)) {
      if (this.snapshot.groups.length >= MAX_EDITOR_GROUPS) return { kind: 'group-limit' }
      const targetGroup = this.snapshot.groups.find(group => group.id === targetGroupId)
      if (targetGroup === undefined) return { kind: 'stale' }
      // A single document in the only group has nowhere distinct to move; do
      // not create a permanent empty pane merely to preserve the drag target.
      if (targetGroup.tabs.length === 0 && this.snapshot.groups.length === 1) {
        return { kind: 'source-would-empty' }
      }
      const groupId = this.nextGroupId()
      const newGroup: EditorGroup = { id: groupId, tabs: [source], activePath: source.path }
      const axis: EditorGroupSplitAxis = edge === 'right' ? 'horizontal' : 'vertical'
      const original = groupLeaf(targetGroupId)
      const added = groupLeaf(groupId)
      const split: EditorGroupLayout = edge === 'right'
        ? { kind: 'split', axis, first: original, second: added }
        : { kind: 'split', axis, first: added, second: original }
      const layout = replaceLeaf(this.snapshot.layout, targetGroupId, split)
      if (layout === undefined) return { kind: 'stale' }
      this.dragTransaction = undefined
      this.publish({
        ...this.snapshot,
        groups: [...this.snapshot.groups, newGroup],
        layout,
        activeGroupId: groupId,
      })
      return { kind: 'applied', groupId }
    }
    if (this.snapshot.groups.length >= MAX_EDITOR_GROUPS) return { kind: 'group-limit' }
    const sourceGroup = this.snapshot.groups.find(group => group.tabs.some(tab => sameIdentity(tab, source)))
    const targetGroup = this.snapshot.groups.find(group => group.id === targetGroupId)
    if (sourceGroup === undefined || targetGroup === undefined) return { kind: 'stale' }
    if (sourceGroup.tabs.length <= 1) return { kind: 'source-would-empty' }

    const remaining = sourceGroup.tabs.filter(tab => !sameIdentity(tab, source))
    const priorIndex = sourceGroup.tabs.findIndex(tab => sameIdentity(tab, source))
    const sourceActivePath = sourceGroup.activePath === source.path
      ? (remaining[Math.min(priorIndex, remaining.length - 1)] ?? remaining[remaining.length - 1])?.path
      : sourceGroup.activePath
    const groupId = this.nextGroupId()
    const newGroup: EditorGroup = { id: groupId, tabs: [source], activePath: source.path }
    const groups = this.snapshot.groups.map(group => group.id === sourceGroup.id
      ? { ...group, tabs: remaining, ...(sourceActivePath === undefined ? {} : { activePath: sourceActivePath }) }
      : group)
    groups.push(newGroup)
    const axis: EditorGroupSplitAxis = edge === 'right' ? 'horizontal' : 'vertical'
    const original = groupLeaf(targetGroupId)
    const added = groupLeaf(groupId)
    const split: EditorGroupLayout = edge === 'right'
      ? { kind: 'split', axis, first: original, second: added }
      : { kind: 'split', axis, first: added, second: original }
    const layout = replaceLeaf(this.snapshot.layout, targetGroupId, split)
    if (layout === undefined) return { kind: 'stale' }
    this.publish({ ...this.snapshot, groups, layout, activeGroupId: groupId })
    return { kind: 'applied', groupId }
  }
}
