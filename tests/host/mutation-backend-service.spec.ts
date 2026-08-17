import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MUTATION_BACKEND_ABI,
  type MutationBackend,
  type MutationBackendExecution,
  type MutationBackendWorkspace,
  type OpenMutationBackendWorkspace,
} from '../../src/host/mutation-backend.js'
import { WorkspaceMutationService } from '../../src/host/workspace-mutations.js'
import { WorkspaceResources } from '../../src/host/workspace-resources.js'

describe('WorkspaceMutationService native backend boundary', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it('projects immutable capabilities and canonical segments through the injected backend', async () => {
    const canonicalTmp = await realpath(tmpdir())
    const root = await mkdtemp(join(canonicalTmp, 'dsh-native-backend-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const replacementRoot = await mkdtemp(join(canonicalTmp, 'dsh-native-backend-replacement-'))
    cleanups.push(async () => { await rm(replacementRoot, { recursive: true, force: true }) })
    let registeredRoot = root
    const executions: MutationBackendExecution[] = []
    const workspaceDispose = vi.fn(async () => {})
    const backendDispose = vi.fn(async () => {})
    const workspace: MutationBackendWorkspace = {
      workspaceId: 'workspace',
      execute: vi.fn(async request => {
        executions.push(request)
        return {
          state: 'committed' as const,
          evidence: {
            kind: 'createFile' as const,
            resourceKind: 'file' as const,
            version: 'created-version',
          },
        }
      }),
      dispose: workspaceDispose,
    }
    const opens: OpenMutationBackendWorkspace[] = []
    const backend: MutationBackend = {
      descriptor: {
        abi: MUTATION_BACKEND_ABI,
        implementation: 'windows-nt-handles',
        confinement: 'backend-owned-handle-relative-v1',
        capabilities: { createFile: true, createDirectory: false, rename: false, delete: false },
      },
      openWorkspace: vi.fn(async request => {
        opens.push(request)
        return workspace
      }),
      dispose: backendDispose,
    }
    const resources = new WorkspaceResources({
      list: () => [{ id: 'workspace', path: registeredRoot, title: 'Workspace' }],
    })
    const service = new WorkspaceMutationService(
      resources,
      { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      {},
      {},
      backend,
    )
    cleanups.push(async () => {
      await service.dispose()
      await backend.dispose()
      await resources.dispose()
    })

    await expect(service.provider()).resolves.toEqual({
      providerEpoch: service.providerEpoch,
      capabilities: { createFile: true, createDirectory: false, rename: false, delete: false },
    })
    const operationId = randomUUID()
    await expect(service.request({
      op: 'mutate',
      providerEpoch: service.providerEpoch,
      operationId,
      workspaceId: 'workspace',
      mutation: { kind: 'createFile', path: 'src/new.ts' },
    })).resolves.toEqual({
      providerEpoch: service.providerEpoch,
      operationId,
      state: 'committed',
      result: {
        kind: 'file',
        path: 'src/new.ts',
        version: 'created-version',
        refreshDirectories: ['src'],
      },
    })
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({ workspaceId: 'workspace', registeredRoot: root })
    expect(executions[0]?.operation).toEqual({ kind: 'createFile', path: { segments: ['src', 'new.ts'] } })

    registeredRoot = replacementRoot
    await expect(service.request({
      op: 'mutate',
      providerEpoch: service.providerEpoch,
      operationId: randomUUID(),
      workspaceId: 'workspace',
      mutation: { kind: 'createFile', path: 'must-not-run.ts' },
    })).rejects.toMatchObject({ code: 'WORKSPACE_IDENTITY_CHANGED' })
    expect(executions).toHaveLength(1)

    await service.dispose()
    expect(workspaceDispose).toHaveBeenCalledOnce()
    expect(backendDispose).not.toHaveBeenCalled()
  })
})
