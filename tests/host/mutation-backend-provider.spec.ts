import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_MUTATION_BACKEND_CAPABILITY,
  type WorkspaceMutationBackendProviderContext,
} from '../../src/host/capabilities.js'
import {
  MUTATION_BACKEND_ABI,
  type MutationBackend,
} from '../../src/host/mutation-backend.js'
import { workspaceMutationBackendProvider } from '../../src/host/mutation-backend-provider.js'

describe('workspace mutation backend provider', () => {
  it('disposes an async backend that resolves after its Cordis fiber is withdrawn', async () => {
    let resolveBackend!: (backend: MutationBackend) => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const pending = new Promise<MutationBackend>(resolve => { resolveBackend = resolve })
    const dispose = vi.fn(async () => {})
    const backend: MutationBackend = {
      descriptor: {
        abi: MUTATION_BACKEND_ABI,
        implementation: 'unavailable',
        confinement: 'backend-owned-handle-relative-v1',
        capabilities: { createFile: false, createDirectory: false, rename: false, delete: false },
      },
      async openWorkspace() { throw new Error('not used') },
      dispose,
    }
    const plugin = {
      name: 'test-workspace-mutation-backend-provider',
      inject: [] as string[],
      provide: WORKSPACE_MUTATION_BACKEND_CAPABILITY,
      apply(ctx: WorkspaceMutationBackendProviderContext) {
        return workspaceMutationBackendProvider(ctx, {}, () => {
          markStarted()
          return pending
        })
      },
    }
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, {})

    await started
    const teardown = fiber.dispose()
    resolveBackend(backend)
    await teardown

    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.get(WORKSPACE_MUTATION_BACKEND_CAPABILITY)).toBeUndefined()
  })
})
