import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_CAPABILITY,
  WORKSPACE_FILES_CAPABILITY,
  WORKSPACE_MUTATIONS_CAPABILITY,
  WORKSPACE_RESOURCES_CAPABILITY,
  WORKSPACE_SEARCH_CAPABILITY,
} from '../../src/host/capabilities.js'
import type {
  HostWebRoute,
  HostWebServer,
  HostWebUpgradeRoute,
  HostSubprocessRuntime,
  HostWorkspaceRegistry,
} from '../../src/host/contracts.js'
import { WorkspaceFileService } from '../../src/host/filesystem.js'
import { ideGateway } from '../../src/host/gateway.js'
import { apply, inject, name } from '../../src/host/plugin.js'
import { TerminalHost } from '../../src/host/terminal.js'
import { WorkspaceSearchService } from '../../src/host/search.js'
import { workspaceSearchProvider } from '../../src/host/search-provider.js'
import { terminalProvider } from '../../src/host/terminal-provider.js'
import { workspaceFilesProvider } from '../../src/host/workspace-files-provider.js'
import { WorkspaceMutationService } from '../../src/host/workspace-mutations.js'
import { workspaceMutationBackendProvider } from '../../src/host/mutation-backend-provider.js'
import { workspaceMutationsGateway } from '../../src/host/workspace-mutations-gateway.js'
import { workspaceMutationsProvider } from '../../src/host/workspace-mutations-provider.js'
import { WorkspaceResources } from '../../src/host/workspace-resources.js'
import { workspaceResourcesProvider } from '../../src/host/workspace-resources-provider.js'

// Cordis exposes FiberState as a const enum, so there is no runtime enum object.
const CORDIS_PENDING_STATE = 0

class TrackingWebServer implements HostWebServer {
  readonly routes = new Set<HostWebRoute>()
  readonly upgrades = new Set<HostWebUpgradeRoute>()

  constructor(private readonly events: string[]) {}

  register(route: HostWebRoute): () => void {
    this.routes.add(route)
    this.events.push(`http:${route.kind}:register`)
    return () => {
      if (this.routes.delete(route)) this.events.push(`http:${route.kind}:remove`)
    }
  }

  registerUpgrade(route: HostWebUpgradeRoute): () => void {
    this.upgrades.add(route)
    this.events.push('upgrade:register')
    return () => {
      if (this.upgrades.delete(route)) this.events.push('upgrade:remove')
    }
  }
}

async function settle(ctx: Context, plugin: unknown): Promise<void> {
  const runtime = ctx.registry.get(plugin as never)
  if (runtime === undefined) return
  await Promise.all([...runtime.fibers].map(fiber => fiber.await()))
}

describe('Cordis child-component lifecycle', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(await realpath(tmpdir()), 'dsh-code-ide-lifecycle-'))
    await writeFile(join(workspaceRoot, 'index.html'), '<!doctype html>')
  })

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3 })
  })

  it('withdraws routes before provider cleanup and recreates them after services return', async () => {
    const events: string[] = []
    const webServer = new TrackingWebServer(events)
    const registry: HostWorkspaceRegistry = {
      list: () => [{ id: 'fixture', path: workspaceRoot, title: 'Fixture' }],
    }
    const ctx = new Context()
    let removeWebServer = ctx.provide('webServer', webServer)
    let removeRegistry = ctx.provide('workspaceRegistry', registry)
    const subprocess: HostSubprocessRuntime = {
      async resolveExecutable() { throw new Error('not used') },
      spawn() { throw new Error('not used') },
    }
    let removeSubprocess = ctx.provide('subprocess', subprocess)
    const originalFilesDispose = WorkspaceFileService.prototype.dispose
    const originalTerminalDispose = TerminalHost.prototype.dispose
    const originalSearchDispose = WorkspaceSearchService.prototype.dispose
    const originalMutationsDispose = WorkspaceMutationService.prototype.dispose
    const originalResourcesDispose = WorkspaceResources.prototype.dispose
    const filesDispose = vi.spyOn(WorkspaceFileService.prototype, 'dispose').mockImplementation(async function () {
      events.push('files:dispose')
      await originalFilesDispose.call(this)
    })
    const terminalDispose = vi.spyOn(TerminalHost.prototype, 'dispose').mockImplementation(async function () {
      events.push('terminal:dispose')
      await originalTerminalDispose.call(this)
    })
    const searchDispose = vi.spyOn(WorkspaceSearchService.prototype, 'dispose').mockImplementation(async function () {
      events.push('search:dispose')
      await originalSearchDispose.call(this)
    })
    const mutationsDispose = vi.spyOn(WorkspaceMutationService.prototype, 'dispose').mockImplementation(async function () {
      events.push('mutations:dispose')
      await originalMutationsDispose.call(this)
    })
    const resourcesDispose = vi.spyOn(WorkspaceResources.prototype, 'dispose').mockImplementation(async function () {
      events.push('resources:dispose')
      await originalResourcesDispose.call(this)
    })

    const rootFiber = ctx.plugin({ name, inject, apply }, {
      staticRoot: workspaceRoot,
      terminalShell: process.execPath,
      terminalArgs: [],
    })

    try {
      await rootFiber
      await settle(ctx, workspaceMutationBackendProvider)
      await settle(ctx, workspaceResourcesProvider)
      await settle(ctx, workspaceFilesProvider)
      await settle(ctx, workspaceMutationsProvider)
      await settle(ctx, terminalProvider)
      await settle(ctx, workspaceSearchProvider)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(ctx.get(WORKSPACE_RESOURCES_CAPABILITY)).toBeInstanceOf(WorkspaceResources)
      expect(ctx.get(WORKSPACE_FILES_CAPABILITY)).toBeInstanceOf(WorkspaceFileService)
      expect(ctx.get(WORKSPACE_MUTATIONS_CAPABILITY)).toBeInstanceOf(WorkspaceMutationService)
      expect(ctx.get(TERMINAL_CAPABILITY)).toBeInstanceOf(TerminalHost)
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeInstanceOf(WorkspaceSearchService)
      expect(webServer.routes.size).toBe(2)
      expect([...webServer.routes]).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'exact', path: '/dsh-code-ide/api/workspace-mutations/v1' }),
        expect.objectContaining({ kind: 'prefix', path: '/dsh-code-ide' }),
      ]))
      expect(webServer.upgrades.size).toBe(1)

      await removeWebServer()
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(webServer.routes.size).toBe(0)
      expect(webServer.upgrades.size).toBe(0)
      expect(ctx.get(WORKSPACE_FILES_CAPABILITY)).toBeInstanceOf(WorkspaceFileService)
      expect(ctx.get(WORKSPACE_MUTATIONS_CAPABILITY)).toBeInstanceOf(WorkspaceMutationService)
      expect(ctx.get(TERMINAL_CAPABILITY)).toBeInstanceOf(TerminalHost)
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeInstanceOf(WorkspaceSearchService)

      removeWebServer = ctx.provide('webServer', webServer)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(webServer.routes.size).toBe(2)
      expect(webServer.upgrades.size).toBe(1)

      await removeSubprocess()
      await settle(ctx, workspaceSearchProvider)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(ctx.get(WORKSPACE_FILES_CAPABILITY)).toBeInstanceOf(WorkspaceFileService)
      expect(ctx.get(TERMINAL_CAPABILITY)).toBeInstanceOf(TerminalHost)
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeUndefined()
      expect(webServer.routes.size).toBe(1)
      expect([...webServer.routes][0]).toMatchObject({ kind: 'exact' })
      expect(webServer.upgrades.size).toBe(0)

      removeSubprocess = ctx.provide('subprocess', subprocess)
      await settle(ctx, workspaceSearchProvider)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeInstanceOf(WorkspaceSearchService)
      expect(webServer.routes.size).toBe(2)
      expect(webServer.upgrades.size).toBe(1)

      events.length = 0
      const oldEpoch = (ctx.get(WORKSPACE_MUTATIONS_CAPABILITY) as WorkspaceMutationService).providerEpoch
      await removeRegistry()
      await settle(ctx, workspaceResourcesProvider)
      await settle(ctx, workspaceFilesProvider)
      await settle(ctx, workspaceMutationsProvider)
      await settle(ctx, terminalProvider)
      await settle(ctx, workspaceSearchProvider)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      const gatewayFiber = [...ctx.registry.get(ideGateway)!.fibers][0]
      expect(gatewayFiber?.state).toBe(CORDIS_PENDING_STATE)
      expect(ctx.get(WORKSPACE_FILES_CAPABILITY)).toBeUndefined()
      expect(ctx.get(WORKSPACE_MUTATIONS_CAPABILITY)).toBeUndefined()
      expect(ctx.get(WORKSPACE_RESOURCES_CAPABILITY)).toBeUndefined()
      expect(ctx.get(TERMINAL_CAPABILITY)).toBeUndefined()
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeUndefined()
      expect(webServer.routes.size).toBe(0)
      expect(webServer.upgrades.size).toBe(0)
      expect(events.indexOf('http:prefix:remove')).toBeGreaterThanOrEqual(0)
      expect(events.indexOf('http:exact:remove')).toBeGreaterThanOrEqual(0)
      expect(events.indexOf('upgrade:remove')).toBeGreaterThanOrEqual(0)
      expect(events.indexOf('files:dispose')).toBeGreaterThan(events.indexOf('http:prefix:remove'))
      expect(events.indexOf('mutations:dispose')).toBeGreaterThan(events.indexOf('http:exact:remove'))
      expect(events.indexOf('resources:dispose')).toBeGreaterThan(events.indexOf('http:prefix:remove'))
      expect(events.indexOf('resources:dispose')).toBeGreaterThan(events.indexOf('http:exact:remove'))
      expect(events.indexOf('terminal:dispose')).toBeGreaterThan(events.indexOf('upgrade:remove'))
      expect(events.indexOf('search:dispose')).toBeGreaterThan(events.indexOf('http:prefix:remove'))

      removeRegistry = ctx.provide('workspaceRegistry', registry)
      await settle(ctx, workspaceResourcesProvider)
      await settle(ctx, workspaceFilesProvider)
      await settle(ctx, workspaceMutationsProvider)
      await settle(ctx, terminalProvider)
      await settle(ctx, workspaceSearchProvider)
      await settle(ctx, ideGateway)
      await settle(ctx, workspaceMutationsGateway)
      expect(ctx.get(WORKSPACE_FILES_CAPABILITY)).toBeInstanceOf(WorkspaceFileService)
      expect(ctx.get(WORKSPACE_MUTATIONS_CAPABILITY)).toBeInstanceOf(WorkspaceMutationService)
      expect((ctx.get(WORKSPACE_MUTATIONS_CAPABILITY) as WorkspaceMutationService).providerEpoch).not.toBe(oldEpoch)
      expect(ctx.get(TERMINAL_CAPABILITY)).toBeInstanceOf(TerminalHost)
      expect(ctx.get(WORKSPACE_SEARCH_CAPABILITY)).toBeInstanceOf(WorkspaceSearchService)
      expect(webServer.routes.size).toBe(2)
      expect(webServer.upgrades.size).toBe(1)
    } finally {
      await rootFiber.dispose()
      await removeRegistry()
      await removeSubprocess()
      await removeWebServer()
      filesDispose.mockRestore()
      terminalDispose.mockRestore()
      searchDispose.mockRestore()
      mutationsDispose.mockRestore()
      resourcesDispose.mockRestore()
    }
  })
})
