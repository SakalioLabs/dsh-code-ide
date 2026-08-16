import type { ReadFileResponse, WriteFileResponse } from '../contracts.ts'
import { reconcileDocuments } from '../observation/reconciler.ts'
import type { WorkspaceInvalidation } from '../observation/source.ts'
import {
  CANONICAL_DOCUMENT_LINE_ENDING,
  materializeEditableText,
  normalizeEditableText,
  type DocumentLineEnding,
} from './text-content.ts'
import {
  DocumentSessionStore,
  type CommittedRenameDocumentRecovery,
  type DocumentDeleteCommitResult,
  type EditorTab,
  type DocumentMutationImpact,
  type DocumentRenameCommitResult,
  type DocumentIdentity,
  type ReloadDocumentIntent,
  type RevertDocumentIntent,
  type SaveDocumentIntent,
} from './session.ts'

export interface DocumentFilePort {
  read(workspaceId: string, path: string): Promise<ReadFileResponse>
  write(workspaceId: string, path: string, content: string, expectedVersion: string | undefined): Promise<WriteFileResponse>
}

export type SaveResult = 'saved' | 'not-needed' | 'conflict' | 'failed' | 'unknown' | 'stale'
export type RevertResult = 'reverted' | 'not-needed' | 'failed' | 'stale'

export const SAVE_ALL_MAX_CONCURRENCY = 4

export type SaveAllBlocker =
  | 'read-only'
  | 'deleted'
  | 'unknown-save'
  | 'pending-save'
  | 'pending-reload'
  | 'pending-conflict'
  | 'mutation-lease'
  | 'not-dirty'
  | 'closed-or-replaced'
  | 'ambiguous-path'
  | 'not-saveable'

export type SaveAllPathResult =
  | {
    readonly path: string
    readonly lifecycleId: number
    readonly status: Exclude<SaveResult, 'not-needed'>
  }
  | {
    readonly path: string
    readonly lifecycleId: number
    readonly status: 'blocked'
    readonly blockers: readonly SaveAllBlocker[]
  }

/** Exact, invocation-scoped report. Results preserve the captured tab order. */
export interface SaveAllSummary {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly totalDirty: number
  readonly attempted: number
  readonly saved: number
  readonly blocked: number
  readonly conflicts: number
  readonly failed: number
  readonly unknown: number
  readonly stale: number
  readonly results: readonly SaveAllPathResult[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isPathOrDescendant(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function rebasePath(path: string, source: string, destination: string): string {
  return path === source ? destination : `${destination}${path.slice(source.length)}`
}

type DocumentRead = ReadFileResponse & { readonly lineEnding?: DocumentLineEnding }

/** Read-only presentations are bounded Host projections, never editable buffers. */
function canonicalRead(result: ReadFileResponse): DocumentRead {
  if (result.readOnlyPresentation !== undefined) return result
  const normalized = normalizeEditableText(result.content)
  return { ...result, content: normalized.content, lineEnding: normalized.lineEnding }
}

/**
 * Framework-neutral application service. It is the sole owner of document I/O
 * workflows; the store validates every completion against its captured intent.
 */
export class DocumentController {
  constructor(
    readonly store: DocumentSessionStore,
    private readonly files: DocumentFilePort,
  ) {}

  async open(
    workspaceId: string,
    path: string,
    name: string,
    acceptCompletion?: () => boolean,
  ): Promise<boolean> {
    if (this.store.isPathMutationLeased(workspaceId, path)
      && !this.store.session(workspaceId).tabs.some(tab => tab.path === path)) return false
    const intent = this.store.beginOpen(workspaceId, path, name)
    if (intent === undefined) return true
    try {
      const result = canonicalRead(await this.files.read(workspaceId, path))
      if (acceptCompletion !== undefined && !acceptCompletion()) return false
      return this.store.completeOpen(intent, result)
    } catch (error) {
      if (!this.store.isWorkspaceEpoch(intent.workspaceId, intent.workspaceEpoch)) return false
      throw error
    }
  }

  async openCommittedCreate(
    operationId: string,
    workspaceId: string,
    path: string,
    name: string,
  ): Promise<boolean> {
    const existing = this.store.session(workspaceId).tabs.some(tab => tab.path === path)
    const intent = this.store.beginCommittedCreateOpen(operationId, workspaceId, path, name)
    if (intent === undefined) return existing && this.store.activateDocument(workspaceId, path)
    try {
      const result = canonicalRead(await this.files.read(workspaceId, path))
      return this.store.completeOpen(intent, result)
    } catch (error) {
      if (!this.store.isWorkspaceEpoch(intent.workspaceId, intent.workspaceEpoch)) return false
      throw error
    }
  }

  private async executeSave(intent: SaveDocumentIntent): Promise<Exclude<SaveResult, 'not-needed'>> {
    const materialized = materializeEditableText(intent.content, intent.lineEnding)
    try {
      const result = await this.files.write(intent.workspaceId, intent.path, materialized, intent.expectedVersion)
      return this.store.completeSave(intent, result.version) ? 'saved' : 'stale'
    } catch (error) {
      if (errorCode(error) === 'VERSION_CONFLICT') {
        return this.store.failSave(intent, errorMessage(error), 'conflict') ? 'conflict' : 'stale'
      }
      // A lost HTTP response cannot prove that a Host write did not commit.
      try {
        const rawDisk = await this.files.read(intent.workspaceId, intent.path)
        if (rawDisk.readOnlyPresentation === undefined && rawDisk.content === materialized) {
          return this.store.completeSave(intent, rawDisk.version) ? 'saved' : 'stale'
        }
        if (rawDisk.readOnlyPresentation === undefined && rawDisk.version === intent.expectedVersion
          && intent.baselineContent !== undefined
          && intent.baselineLineEnding !== undefined
          && rawDisk.content === materializeEditableText(intent.baselineContent, intent.baselineLineEnding)) {
          return this.store.failSave(intent, errorMessage(error), 'failed') ? 'failed' : 'stale'
        }
        return this.store.failSave(
          intent,
          'The save response was lost and disk content differs. Check the file before retrying.',
          'unknown',
        ) ? 'unknown' : 'stale'
      } catch {
        return this.store.failSave(
          intent,
          'The save response was lost. Its disk outcome is unknown; local edits remain protected.',
          'unknown',
        ) ? 'unknown' : 'stale'
      }
    }
  }

  async save(workspaceId: string, path: string): Promise<SaveResult> {
    const intent = this.store.beginSave(workspaceId, path)
    return intent === undefined ? 'not-needed' : await this.executeSave(intent)
  }

  private async executeRevert(intent: RevertDocumentIntent): Promise<Exclude<RevertResult, 'not-needed'>> {
    try {
      const result = canonicalRead(await this.files.read(intent.workspaceId, intent.path))
      if (this.store.completeRevert(intent, result)) return 'reverted'
      this.store.finishRevertFailure(intent)
      return 'stale'
    } catch (error) {
      return this.store.finishRevertFailure(intent, errorMessage(error)) ? 'failed' : 'stale'
    }
  }

  /** Explicitly replace one exact active dirty buffer with an authoritative disk read. */
  async revert(identity: DocumentIdentity): Promise<RevertResult> {
    const intent = this.store.beginRevert(identity)
    return intent === undefined ? 'not-needed' : await this.executeRevert(intent)
  }

  private saveAllBlockers(workspaceId: string, captured: Pick<EditorTab, 'path' | 'lifecycleId'>): SaveAllBlocker[] {
    const matches = this.store.session(workspaceId).tabs.filter(tab => tab.path === captured.path)
    const tab = matches.find(candidate => candidate.lifecycleId === captured.lifecycleId)
    if (tab === undefined) return ['closed-or-replaced']
    const blockers: SaveAllBlocker[] = []
    if (matches.length !== 1) blockers.push('ambiguous-path')
    if (tab.readOnlyPresentation !== undefined) blockers.push('read-only')
    if (tab.externalState === 'deleted') blockers.push('deleted')
    if (tab.saveOutcome === 'unknown') blockers.push('unknown-save')
    if (tab.pendingSaveId !== undefined) blockers.push('pending-save')
    if (tab.pendingReloadId !== undefined) blockers.push('pending-reload')
    if (tab.pendingConflictId !== undefined) blockers.push('pending-conflict')
    if (this.store.isPathMutationLeased(workspaceId, tab.path)) blockers.push('mutation-lease')
    if (!tab.dirty) blockers.push('not-dirty')
    return blockers
  }

  /** Save every dirty editable text tab captured from the active workspace. */
  async saveAll(): Promise<SaveAllSummary | undefined> {
    const snapshot = this.store.getSnapshot()
    const workspaceId = snapshot.activeWorkspaceId
    if (workspaceId === undefined) return undefined
    const workspaceEpoch = snapshot.activeWorkspaceEpoch
    const captured = this.store.session(workspaceId).tabs
      .filter(tab => tab.dirty)
      .map(tab => ({ path: tab.path, lifecycleId: tab.lifecycleId }))
    const results = new Array<SaveAllPathResult | undefined>(captured.length)
    const pending: { index: number; intent: SaveDocumentIntent }[] = []

    // Reserve every eligible save before starting I/O. A queued item therefore
    // cannot silently drift into another document transaction while it waits.
    for (const [index, document] of captured.entries()) {
      const blockers = this.saveAllBlockers(workspaceId, document)
      if (blockers.length > 0) {
        results[index] = { ...document, status: 'blocked', blockers }
        continue
      }
      const intent = this.store.beginSave(workspaceId, document.path)
      if (intent !== undefined && intent.lifecycleId === document.lifecycleId) {
        pending.push({ index, intent })
        continue
      }
      const currentBlockers = this.saveAllBlockers(workspaceId, document)
      results[index] = {
        ...document,
        status: 'blocked',
        blockers: currentBlockers.length > 0 ? currentBlockers : ['not-saveable'],
      }
    }

    let cursor = 0
    const workers = Array.from({ length: Math.min(SAVE_ALL_MAX_CONCURRENCY, pending.length) }, async () => {
      while (cursor < pending.length) {
        const work = pending[cursor++]
        if (work === undefined) continue
        results[work.index] = {
          path: work.intent.path,
          lifecycleId: work.intent.lifecycleId,
          status: await this.executeSave(work.intent),
        }
      }
    })
    await Promise.all(workers)

    const exactResults = results.filter((result): result is SaveAllPathResult => result !== undefined)
    const count = (status: SaveAllPathResult['status']): number =>
      exactResults.filter(result => result.status === status).length
    return {
      workspaceId,
      workspaceEpoch,
      totalDirty: captured.length,
      attempted: pending.length,
      saved: count('saved'),
      blocked: count('blocked'),
      conflicts: count('conflict'),
      failed: count('failed'),
      unknown: count('unknown'),
      stale: count('stale'),
      results: exactResults,
    }
  }

  async reconcileUnknownSave(workspaceId: string, path: string, lifecycleId: number): Promise<void> {
    try {
      const rawDisk = await this.files.read(workspaceId, path)
      if (rawDisk.readOnlyPresentation !== undefined) {
        throw new Error('The disk resource is no longer an editable UTF-8 text file.')
      }
      const disk = normalizeEditableText(rawDisk.content)
      this.store.reconcileSaveOutcome(workspaceId, path, lifecycleId, {
        rawContent: rawDisk.content,
        content: disk.content,
        lineEnding: disk.lineEnding,
        version: rawDisk.version,
      })
    } catch (error) {
      if (errorCode(error) === 'NOT_FOUND') this.store.reconcileMissingSaveOutcome(workspaceId, path, lifecycleId)
      else throw error
    }
  }

  async recreateDeleted(workspaceId: string, path: string): Promise<SaveResult> {
    const intent = this.store.beginRecreateDeleted(workspaceId, path)
    if (intent === undefined) return 'not-needed'
    try {
      // `undefined` is the Host's create-if-absent contract. A collision must
      // never replace content that appeared after the deletion.
      const materialized = materializeEditableText(intent.content, intent.lineEnding)
      const result = await this.files.write(intent.workspaceId, intent.path, materialized, undefined)
      return this.store.completeRecreateDeleted(intent, result.version) ? 'saved' : 'stale'
    } catch (error) {
      const code = errorCode(error)
      if (code === 'VERSION_CONFLICT' || code === 'DESTINATION_EXISTS' || code === 'EXPECTED_VERSION_REQUIRED') {
        return this.store.failRecreateDeleted(intent, errorMessage(error), 'conflict') ? 'conflict' : 'stale'
      }
      try {
        const disk = await this.files.read(intent.workspaceId, intent.path)
        if (disk.readOnlyPresentation === undefined
          && disk.content === materializeEditableText(intent.content, intent.lineEnding)) {
          return this.store.completeRecreateDeleted(intent, disk.version) ? 'saved' : 'stale'
        }
        return this.store.failRecreateDeleted(
          intent,
          'The recreate response was lost and another resource now occupies this path. Local content was not overwritten.',
          'conflict',
        ) ? 'conflict' : 'stale'
      } catch (readError) {
        if (errorCode(readError) === 'NOT_FOUND') {
          return this.store.failRecreateDeleted(intent, errorMessage(error), 'failed') ? 'failed' : 'stale'
        }
        return this.store.failRecreateDeleted(
          intent,
          'The recreate response was lost. Its disk outcome is unknown; local content remains protected.',
          'unknown',
        ) ? 'unknown' : 'stale'
      }
    }
  }

  inspectRenameMutation(
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): DocumentMutationImpact {
    return this.store.inspectRenameMutation(workspaceId, sourcePath, destinationPath, sourceKind, sourceVersion)
  }

  commitCreateMutation(workspaceId: string, workspaceEpoch: number, targetPath: string): boolean {
    return this.store.commitCreateMutation(workspaceId, workspaceEpoch, targetPath)
  }

  async recoverCommittedRename(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
  ): Promise<boolean> {
    if (!this.store.canRecoverCommittedRename(
      workspaceId,
      workspaceEpoch,
      sourcePath,
      destinationPath,
    )) return false
    const affected = this.store.session(workspaceId).tabs
      .filter(tab => isPathOrDescendant(tab.path, sourcePath))
      .map(tab => ({
        sourcePath: tab.path,
        destinationPath: rebasePath(tab.path, sourcePath, destinationPath),
        lifecycleId: tab.lifecycleId,
        localRevision: tab.localRevision,
        lineEnding: tab.lineEnding ?? CANONICAL_DOCUMENT_LINE_ENDING,
      }))
    const recoveries = new Array<CommittedRenameDocumentRecovery>(affected.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, affected.length) }, async () => {
      while (cursor < affected.length) {
        const index = cursor++
        const document = affected[index]
        if (document === undefined) continue
        try {
          const disk = canonicalRead(await this.files.read(workspaceId, document.destinationPath))
          recoveries[index] = {
            sourcePath: document.sourcePath,
            lifecycleId: document.lifecycleId,
            localRevision: document.localRevision,
            lineEnding: document.lineEnding,
            disk: {
              state: 'present',
              content: disk.content,
              version: disk.version,
              ...(disk.lineEnding === undefined ? {} : { lineEnding: disk.lineEnding }),
              ...(disk.readOnlyPresentation === undefined
                ? {}
                : { readOnlyPresentation: disk.readOnlyPresentation }),
            },
          }
        } catch (error) {
          if (errorCode(error) !== 'NOT_FOUND') throw error
          recoveries[index] = {
            sourcePath: document.sourcePath,
            lifecycleId: document.lifecycleId,
            localRevision: document.localRevision,
            lineEnding: document.lineEnding,
            disk: { state: 'missing' },
          }
        }
      }
    })
    await Promise.all(workers)
    return this.store.recoverCommittedRenameDocuments(
      workspaceId, workspaceEpoch, sourcePath, destinationPath, recoveries,
    )
  }

  commitRenameMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    destinationPath: string,
    resourceKind: 'file' | 'directory',
    expectedVersion: string,
    freshVersion: string,
    preserveRecoveredVersions = false,
  ): DocumentRenameCommitResult {
    return this.store.commitRenameMutation(
      workspaceId,
      workspaceEpoch,
      sourcePath,
      destinationPath,
      resourceKind,
      expectedVersion,
      freshVersion,
      preserveRecoveredVersions,
    )
  }

  inspectDeleteMutation(
    workspaceId: string,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): DocumentMutationImpact {
    return this.store.inspectDeleteMutation(workspaceId, sourcePath, resourceKind, sourceVersion)
  }

  commitDeleteMutation(
    workspaceId: string,
    workspaceEpoch: number,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    expectedVersion: string,
  ): DocumentDeleteCommitResult {
    return this.store.commitDeleteMutation(workspaceId, workspaceEpoch, sourcePath, resourceKind, expectedVersion)
  }

  acquireRenameMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    destinationPath: string,
    sourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): boolean {
    return this.store.acquireRenameMutationLease(
      operationId, workspaceId, sourcePath, destinationPath, sourceKind, sourceVersion,
    )
  }

  acquireCreateMutationLease(operationId: string, workspaceId: string, targetPath: string): boolean {
    return this.store.acquireCreateMutationLease(operationId, workspaceId, targetPath)
  }

  acquireDeleteMutationLease(
    operationId: string,
    workspaceId: string,
    sourcePath: string,
    resourceKind: 'file' | 'directory',
    sourceVersion: string,
  ): boolean {
    return this.store.acquireDeleteMutationLease(operationId, workspaceId, sourcePath, resourceKind, sourceVersion)
  }

  releaseMutationLease(operationId: string): boolean {
    return this.store.releaseMutationLease(operationId)
  }

  restoreMutationLease(operationId: string, workspaceId: string, prefixes: readonly string[]): boolean {
    return this.store.restoreMutationLease(operationId, workspaceId, prefixes)
  }

  private async reload(intent: ReloadDocumentIntent): Promise<void> {
    try {
      const result = canonicalRead(await this.files.read(intent.workspaceId, intent.path))
      this.store.completeReload(intent, result)
    } catch (error) {
      this.store.markReloadFailure(intent, errorMessage(error))
    }
  }

  async reconcileFileInvalidations(
    workspaceId: string,
    invalidations: readonly WorkspaceInvalidation[],
  ): Promise<void> {
    const previous = this.store.session(workspaceId).tabs
    const reconciled = reconcileDocuments(previous, invalidations)
    if (reconciled.tabs.some((tab, index) => tab !== previous[index])) {
      this.store.updateWorkspaceTabs(workspaceId, () => reconciled.tabs)
    }
    const reloads: Promise<void>[] = []
    for (const reload of reconciled.reloads) {
      const intent = this.store.beginReload(workspaceId, reload.path, reload.expectedVersion)
      if (intent !== undefined) reloads.push(this.reload(intent))
    }
    await Promise.all(reloads)
  }
}
