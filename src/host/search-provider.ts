import { WORKSPACE_SEARCH_CAPABILITY, type WorkspaceSearchProviderContext } from './capabilities.js'
import { WorkspaceSearchService, type WorkspaceSearchOptions } from './search.js'

export type WorkspaceSearchProviderConfig = Omit<WorkspaceSearchOptions, 'logger'>

/** Own the v1 bounded workspace-search capability independently from HTTP. */
export function workspaceSearchProvider(
  ctx: WorkspaceSearchProviderContext,
  config: WorkspaceSearchProviderConfig,
): void {
  const search = new WorkspaceSearchService(ctx.workspaceRegistry, ctx.subprocess, {
    ...config,
    logger: ctx.logger,
  })
  ctx.effect(() => {
    const withdraw = ctx.provide(WORKSPACE_SEARCH_CAPABILITY, search) as () => void | Promise<void>
    return async () => {
      await withdraw()
      await search.dispose()
    }
  }, 'dsh-code-ide: workspace-search capability')
}

workspaceSearchProvider.inject = ['workspaceRegistry', 'subprocess']
workspaceSearchProvider.provide = WORKSPACE_SEARCH_CAPABILITY
