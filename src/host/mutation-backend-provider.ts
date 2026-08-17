import {
  WORKSPACE_MUTATION_BACKEND_CAPABILITY,
  type WorkspaceMutationBackendProviderContext,
} from './capabilities.js'
import { createUnavailableMutationBackend, type MutationBackend } from './mutation-backend.js'

export type MutationBackendFactory = () => MutationBackend | Promise<MutationBackend>

export interface PlatformMutationBackendFactories {
  readonly win32: MutationBackendFactory
  readonly linux: MutationBackendFactory
  readonly darwin: MutationBackendFactory
}

const PLATFORM_BACKEND_FACTORIES: PlatformMutationBackendFactories = Object.freeze({
  win32: async () => await import('./mutation-backend-windows.js')
    .then(async module => await module.createWindowsMutationBackend()),
  linux: async () => await import('./mutation-backend-linux.js')
    .then(async module => await module.createLinuxMutationBackend()),
  darwin: async () => await import('./mutation-backend-darwin.js')
    .then(async module => await module.createDarwinMutationBackend()),
})

/** Select exactly one platform backend and fail closed on load or probe errors. */
export async function createPlatformMutationBackend(
  platform: NodeJS.Platform = process.platform,
  factories: PlatformMutationBackendFactories = PLATFORM_BACKEND_FACTORIES,
): Promise<MutationBackend> {
  const factory = platform === 'win32'
    ? factories.win32
    : platform === 'linux'
      ? factories.linux
      : platform === 'darwin'
        ? factories.darwin
        : undefined
  if (factory === undefined) return createUnavailableMutationBackend()
  try {
    return await factory()
  } catch {
    return createUnavailableMutationBackend()
  }
}

function isPromiseLike(value: MutationBackend | Promise<MutationBackend>): value is Promise<MutationBackend> {
  return typeof value === 'object' && value !== null && 'then' in value
}

function inactiveEffect(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'INACTIVE_EFFECT'
}

async function installBackend(
  ctx: WorkspaceMutationBackendProviderContext,
  backend: MutationBackend,
): Promise<void> {
  if (backend.descriptor.implementation === 'unavailable') {
    ctx.logger.warn(
      'dsh-code-ide: structural mutation backend unavailable (%s, platform=%s, arch=%s)',
      'WORKSPACE_MUTATION_BACKEND_UNAVAILABLE',
      process.platform,
      process.arch,
    )
  }
  try {
    ctx.effect(() => {
      const withdraw = ctx.provide(WORKSPACE_MUTATION_BACKEND_CAPABILITY, backend) as () => void | Promise<void>
      return async () => {
        await withdraw()
        await backend.dispose()
      }
    }, 'dsh-code-ide: workspace mutation native backend')
  } catch (error) {
    await backend.dispose()
    if (!inactiveEffect(error)) throw error
  }
}

/**
 * Owns the native containment boundary as an independent reversible effect.
 * Platform implementations replace only this factory; the receipt service
 * reacts through its injected coeffect and never probes native state itself.
 *
 * This must stay non-constructible: Cordis treats ordinary function
 * declarations as class plugins, whose constructor return value is not the
 * async setup effect. An arrow function keeps native probing in the fiber's
 * awaited loading transaction.
 */
export const workspaceMutationBackendProvider = (
  ctx: WorkspaceMutationBackendProviderContext,
  _config: Record<string, never>,
  createBackend: MutationBackendFactory = createPlatformMutationBackend,
): Promise<void> => {
  let created: MutationBackend | Promise<MutationBackend>
  try {
    created = createBackend()
  } catch {
    created = createUnavailableMutationBackend()
  }
  if (!isPromiseLike(created)) return installBackend(ctx, created)
  return Promise.resolve(created).then(
    async backend => await installBackend(ctx, backend),
    async () => await installBackend(ctx, createUnavailableMutationBackend()),
  )
}

workspaceMutationBackendProvider.inject = [] as string[]
workspaceMutationBackendProvider.provide = WORKSPACE_MUTATION_BACKEND_CAPABILITY
