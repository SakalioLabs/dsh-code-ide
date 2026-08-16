import { WORKSPACE_RESOURCES_CAPABILITY, type WorkspaceResourcesProviderContext } from './capabilities.js'
import { WorkspaceResources } from './workspace-resources.js'

export interface WorkspaceResourcesProviderConfig {
  maxQueuedMutations: number
}

/** Own the internal root-identity cache and workspace-scoped mutation queues. */
export function workspaceResourcesProvider(
  ctx: WorkspaceResourcesProviderContext,
  config: WorkspaceResourcesProviderConfig,
): void {
  const resources = new WorkspaceResources(ctx.workspaceRegistry, {
    maxQueuedMutations: config.maxQueuedMutations,
  })
  ctx.effect(() => {
    const withdraw = ctx.provide(WORKSPACE_RESOURCES_CAPABILITY, resources) as () => void | Promise<void>
    return async () => {
      await withdraw()
      await resources.dispose()
    }
  }, 'dsh-code-ide: workspace-resources capability')
}

workspaceResourcesProvider.inject = ['workspaceRegistry']
workspaceResourcesProvider.provide = WORKSPACE_RESOURCES_CAPABILITY
