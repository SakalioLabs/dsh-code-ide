import {
  WORKSPACE_MUTATION_BACKEND_CAPABILITY,
  WORKSPACE_MUTATIONS_CAPABILITY,
  WORKSPACE_RESOURCES_CAPABILITY,
  type WorkspaceMutationsProviderContext,
} from './capabilities.js'
import { WorkspaceMutationService, type WorkspaceMutationServiceOptions } from './workspace-mutations.js'

export type WorkspaceMutationsProviderConfig = WorkspaceMutationServiceOptions

/** Own workspace-mutations.v1 independently from its exact HTTP route. */
export function workspaceMutationsProvider(
  ctx: WorkspaceMutationsProviderContext,
  config: WorkspaceMutationsProviderConfig,
): void {
  const mutations = new WorkspaceMutationService(
    ctx[WORKSPACE_RESOURCES_CAPABILITY],
    ctx.logger,
    config,
    {},
    ctx[WORKSPACE_MUTATION_BACKEND_CAPABILITY],
  )
  ctx.effect(() => {
    const withdraw = ctx.provide(WORKSPACE_MUTATIONS_CAPABILITY, mutations) as () => void | Promise<void>
    return async () => {
      await withdraw()
      await mutations.dispose()
    }
  }, 'dsh-code-ide: workspace-mutations capability')
}

workspaceMutationsProvider.inject = [WORKSPACE_RESOURCES_CAPABILITY, WORKSPACE_MUTATION_BACKEND_CAPABILITY]
workspaceMutationsProvider.provide = WORKSPACE_MUTATIONS_CAPABILITY
