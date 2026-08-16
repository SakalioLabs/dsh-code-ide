export interface WorkspaceSelectionPort {
  selectWorkspace(workspaceId: string | undefined): void
}

export interface DocumentWorkspaceSelectionPort extends WorkspaceSelectionPort {
  getSnapshot(): {
    readonly activeWorkspaceId?: string
    readonly activeWorkspaceEpoch: number
  }
}

export interface EditorCloseWorkspaceSelectionPort {
  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean | void
}

export interface DocumentConflictWorkspaceSelectionPort {
  selectWorkspace(workspaceId: string | undefined, workspaceEpoch: number): boolean | void
}

export interface AsyncWorkspaceSelectionPort {
  selectWorkspace(workspaceId: string | undefined): Promise<void>
}

export interface WorkbenchWorkspaceSelectionPorts {
  readonly explorer: AsyncWorkspaceSelectionPort
  readonly documents: DocumentWorkspaceSelectionPort
  readonly editorClose: EditorCloseWorkspaceSelectionPort
  readonly documentConflict: DocumentConflictWorkspaceSelectionPort
  readonly quickOpen: WorkspaceSelectionPort
  readonly workspaceSearch: WorkspaceSelectionPort
  readonly workspaceReplace: WorkspaceSelectionPort
}

/**
 * Admit one workspace transition to every page-owned domain synchronously.
 * The Explorer promise represents only its initial root load; the controller
 * advances its identity before returning it, so a batched W1 -> W2 -> W1 still
 * reaches every domain and advances their ABA fences.
 */
export function coordinateWorkbenchWorkspaceSelection(
  workspaceId: string | undefined,
  ports: WorkbenchWorkspaceSelectionPorts,
): Promise<void> {
  const explorerReady = ports.explorer.selectWorkspace(workspaceId)
  ports.quickOpen.selectWorkspace(workspaceId)
  ports.workspaceSearch.selectWorkspace(workspaceId)
  ports.workspaceReplace.selectWorkspace(workspaceId)
  ports.documents.selectWorkspace(workspaceId)
  const identity = ports.documents.getSnapshot()
  ports.editorClose.selectWorkspace(identity.activeWorkspaceId, identity.activeWorkspaceEpoch)
  ports.documentConflict.selectWorkspace(identity.activeWorkspaceId, identity.activeWorkspaceEpoch)
  return explorerReady
}
