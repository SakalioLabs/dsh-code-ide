import { describe, expect, it } from 'vitest'
import * as plugin from '../../src/index.js'

describe('Cordis package entrypoint', () => {
  it('keeps loader metadata beside apply instead of hiding it behind default', () => {
    // Harness Loader unwraps an ESM default export before Cordis sees the
    // module. Keep the root plugin metadata and child-component orchestration
    // together as one named export surface.
    expect('default' in plugin).toBe(false)
    expect(plugin.apply).toBeTypeOf('function')
    expect(plugin.inject).toEqual([])
    expect(plugin.WORKSPACE_SEARCH_CAPABILITY).toBe('dsh-code-ide.workspace-search.v1')
    expect(plugin.WORKSPACE_MUTATIONS_CAPABILITY).toBe('dsh-code-ide.workspace-mutations.v1')
    expect(plugin.WORKSPACE_MUTATIONS_ROUTE).toBe('/dsh-code-ide/api/workspace-mutations/v1')
    expect('WORKSPACE_RESOURCES_CAPABILITY' in plugin).toBe(false)
    expect(plugin.WorkspaceSearchService).toBeTypeOf('function')
    expect(plugin.searchTextContent).toBeTypeOf('function')
  })
})
