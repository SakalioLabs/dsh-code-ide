import {
  WORKSPACE_MUTATION_BACKEND_CAPABILITY,
  type WorkspaceMutationBackendProviderContext,
} from './capabilities.js'
import { createUnavailableMutationBackend, type MutationBackend } from './mutation-backend.js'

export type MutationBackendFactory = () => MutationBackend | Promise<MutationBackend>

function createPlatformMutationBackend(): MutationBackend | Promise<MutationBackend> {
  if (process.platform !== 'win32') return createUnavailableMutationBackend()
  return import('./mutation-backend-windows.js').then(
    async module => await module.createWindowsMutationBackend(),
    () => createUnavailableMutationBackend(),
  )
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
