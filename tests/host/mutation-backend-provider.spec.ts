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
import {
  createPlatformMutationBackend,
  type PlatformMutationBackendFactories,
  workspaceMutationBackendProvider,
} from '../../src/host/mutation-backend-provider.js'

function testBackend(implementation: MutationBackend['descriptor']['implementation']): MutationBackend {
  const fullMutation = implementation === 'windows-nt-handles'
  return {
    descriptor: {
      abi: MUTATION_BACKEND_ABI,
      implementation,
      confinement: fullMutation
        ? 'backend-owned-handle-relative-v1'
        : 'trusted-local-dirfd-relative-v1',
      capabilities: {
        createFile: true,
        createDirectory: true,
        rename: fullMutation,
        delete: fullMutation,
      },
    },
    async openWorkspace() { throw new Error('not used') },
    async dispose() {},
  }
}

const CURRENT_PLATFORM_IMPLEMENTATION = process.platform === 'win32' && process.arch === 'x64'
  ? 'windows-nt-handles'
  : process.platform === 'linux' && process.arch === 'x64'
    ? 'linux-openat2-handles'
    : process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')
      ? 'darwin-openat-handles'
      : undefined

describe('workspace mutation backend provider', () => {
  it.runIf(CURRENT_PLATFORM_IMPLEMENTATION !== undefined)(
    'loads the probed backend for the current supported platform without silently falling back',
    async () => {
      const backend = await createPlatformMutationBackend()
      try {
        expect(backend.descriptor).toMatchObject({
          implementation: CURRENT_PLATFORM_IMPLEMENTATION,
          capabilities: process.platform === 'win32'
            ? { createFile: true, createDirectory: true, rename: true, delete: true }
            : { createFile: true, createDirectory: true, rename: false, delete: false },
        })
      } finally {
        await backend.dispose()
      }
    },
  )

  it.each([
    ['win32', 'win32', 'windows-nt-handles'],
    ['linux', 'linux', 'linux-openat2-handles'],
    ['darwin', 'darwin', 'darwin-openat-handles'],
  ] as const)('selects only the %s backend factory', async (platform, selected, implementation) => {
    const factories: PlatformMutationBackendFactories = {
      win32: vi.fn(() => testBackend('windows-nt-handles')),
      linux: vi.fn(() => testBackend('linux-openat2-handles')),
      darwin: vi.fn(() => testBackend('darwin-openat-handles')),
    }

    const backend = await createPlatformMutationBackend(platform, factories)

    expect(backend.descriptor.implementation).toBe(implementation)
    expect(factories[selected]).toHaveBeenCalledOnce()
    for (const [name, factory] of Object.entries(factories)) {
      if (name !== selected) expect(factory).not.toHaveBeenCalled()
    }
  })

  it('fails closed on unsupported platforms and backend load or probe errors', async () => {
    const factories: PlatformMutationBackendFactories = {
      win32: vi.fn(() => testBackend('windows-nt-handles')),
      linux: vi.fn(async () => { throw new Error('native probe failed') }),
      darwin: vi.fn(() => testBackend('darwin-openat-handles')),
    }

    await expect(createPlatformMutationBackend('aix', factories)).resolves.toMatchObject({
      descriptor: { implementation: 'unavailable', capabilities: {
        createFile: false, createDirectory: false, rename: false, delete: false,
      } },
    })
    await expect(createPlatformMutationBackend('linux', factories)).resolves.toMatchObject({
      descriptor: { implementation: 'unavailable', capabilities: {
        createFile: false, createDirectory: false, rename: false, delete: false,
      } },
    })
    expect(factories.win32).not.toHaveBeenCalled()
    expect(factories.darwin).not.toHaveBeenCalled()
  })

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
    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin(plugin, {})

    await started
    const teardown = fiber.dispose()
    resolveBackend(backend)
    await teardown

    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.get(WORKSPACE_MUTATION_BACKEND_CAPABILITY)).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
      'dsh-code-ide: structural mutation backend unavailable (%s, platform=%s, arch=%s)',
      'WORKSPACE_MUTATION_BACKEND_UNAVAILABLE',
      process.platform,
      process.arch,
    )
  })
})
