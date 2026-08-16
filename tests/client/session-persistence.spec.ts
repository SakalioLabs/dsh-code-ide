import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/client/api.ts'
import { DocumentSessionStore } from '../../src/client/documents/session.ts'
import {
  encodeWorkbench,
  hydratePersistedWorkspace,
  MAX_PERSISTED_DIRTY_CODE_UNITS,
  SessionPersistence,
  WORKBENCH_SESSION_KEY,
  type ExclusiveLockPort,
  type PersistedWorkspaceV1,
  type StoragePort,
  type TimeoutPort,
} from '../../src/client/session/persistence.ts'

class MemoryStorage implements StoragePort {
  value: string | null = null
  getItem(key: string): string | null { expect(key).toBe(WORKBENCH_SESSION_KEY); return this.value }
  setItem(key: string, value: string): void { expect(key).toBe(WORKBENCH_SESSION_KEY); this.value = value }
}

class FakeTimeout implements TimeoutPort {
  callback: (() => void) | undefined
  set(callback: () => void): unknown { this.callback = callback; return callback }
  clear(handle: unknown): void { if (this.callback === handle) this.callback = undefined }
  run(): void { const callback = this.callback; this.callback = undefined; callback?.() }
}

class SharedExclusiveLock implements ExclusiveLockPort {
  held = false
  acquisitions = 0

  async acquire(): Promise<(() => Promise<void>) | undefined> {
    this.acquisitions += 1
    if (this.held) return undefined
    this.held = true
    let released = false
    return async () => {
      if (released) return
      released = true
      await Promise.resolve()
      this.held = false
    }
  }
}

class DeferredExclusiveLock implements ExclusiveLockPort {
  acquisitions = 0
  held = false
  private firstResolve: ((release: (() => void | Promise<void>) | undefined) => void) | undefined

  acquire(): Promise<(() => void | Promise<void>) | undefined> {
    this.acquisitions += 1
    if (this.acquisitions === 1) {
      return new Promise(resolve => { this.firstResolve = resolve })
    }
    if (this.held) return Promise.resolve(undefined)
    return Promise.resolve(this.take())
  }

  resolveFirst(): void {
    this.held = true
    this.firstResolve?.(this.release())
    this.firstResolve = undefined
  }

  private take(): () => Promise<void> {
    this.held = true
    return this.release()
  }

  private release(): () => Promise<void> {
    let released = false
    return async () => {
      if (released) return
      released = true
      await Promise.resolve()
      this.held = false
    }
  }
}

function populatedStore(): DocumentSessionStore {
  const store = new DocumentSessionStore()
  store.selectWorkspace('workspace')
  for (const [path, content] of [['clean.ts', 'clean\n'], ['dirty.ts', 'base\n']] as const) {
    const intent = store.beginOpen('workspace', path, path)!
    store.completeOpen(intent, { path, content, version: `version-${path}` })
  }
  const dirty = store.activeTab()!
  store.editDocument('workspace', dirty.path, dirty.lifecycleId, 'unsaved secret\n')
  return store
}

describe('workbench persistence codec', () => {
  it('stores dirty recovery bytes but never stores clean source or runtime operation state', () => {
    const raw = encodeWorkbench(populatedStore().getSnapshot(), 'writer', 10)
    const parsed = JSON.parse(raw) as { workspaces: { tabs: Record<string, unknown>[] }[] }
    const tabs = parsed.workspaces[0]!.tabs
    const clean = tabs.find(tab => tab.path === 'clean.ts')!
    const dirty = tabs.find(tab => tab.path === 'dirty.ts')!
    expect(clean).toEqual({ path: 'clean.ts', name: 'clean.ts', dirty: false })
    expect(dirty).toMatchObject({ path: 'dirty.ts', dirty: true, content: 'unsaved secret\n', version: 'version-dirty.ts' })
    expect(raw).not.toContain('"pendingSaveId"')
    expect(raw).not.toContain('"externalState"')
    expect(raw).not.toContain('"unknownSave"')
  })

  it('never serializes lost-save runtime evidence into the recovery wire format', () => {
    const store = populatedStore()
    const tab = store.activeTab()!
    const save = store.beginSave('workspace', tab.path)!
    store.failSave(save, 'response lost', 'unknown')
    const raw = encodeWorkbench(store.getSnapshot(), 'writer', 10)
    expect(store.activeTab()?.unknownSave).toMatchObject({ content: 'unsaved secret\n' })
    expect(raw).not.toContain('unknownSave')
    expect(raw).not.toContain('saveOutcome')
  })

  it('fails the whole snapshot instead of truncating an oversized dirty buffer', () => {
    const store = populatedStore()
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'x'.repeat(MAX_PERSISTED_DIRTY_CODE_UNITS + 1))
    expect(() => encodeWorkbench(store.getSnapshot(), 'writer', 10)).toThrow(/nothing was truncated/i)
  })

  it('blocks every invalid or future wire value from schedule and flush', async () => {
    const values = [
      '{bad json',
      JSON.stringify({ schema: 1, writerId: 'bad', savedAt: 0, workspaces: [{ workspaceId: '', tabs: [] }] }),
      JSON.stringify({ schema: 99, workspaces: [] }),
      'x'.repeat(3 * 1024 * 1024 + 1),
    ]
    for (const value of values) {
      const storage = new MemoryStorage()
      storage.value = value
      const persistence = new SessionPersistence({ storage, lock: new SharedExclusiveLock() })
      expect(persistence.load().kind).toMatch(/invalid|future/)
      expect(persistence.isFormatWritable()).toBe(false)
      expect(await persistence.startExclusiveWriter()).toBe(true)
      persistence.schedule(populatedStore().getSnapshot())
      expect(persistence.flush()).toBe(false)
      expect(storage.value).toBe(value)
      persistence.dispose()
    }
  })

  it('exports the current exact invalid raw and reclassifies again before reset', async () => {
    const storage = new MemoryStorage()
    storage.value = '{first corrupt value'
    const lock = new SharedExclusiveLock()
    const owner = new SessionPersistence({ storage, lock, writerId: 'owner', now: () => 42 })
    const nonOwner = new SessionPersistence({ storage, lock })
    expect(owner.load()).toMatchObject({ kind: 'invalid', resettable: true })
    expect(await owner.startExclusiveWriter()).toBe(true)
    expect(await nonOwner.startExclusiveWriter()).toBe(false)
    expect(() => nonOwner.exportInvalidRaw()).toThrow(/current workbench recovery writer/i)

    storage.value = '{current corrupt value'
    const exported = owner.exportInvalidRaw()
    expect(exported.raw).toBe('{current corrupt value')
    storage.value = encodeWorkbench(populatedStore().getSnapshot(), 'other', 41)
    const validRaw = storage.value
    const validExport = owner.exportInvalidRaw()
    expect(validExport).toMatchObject({ kind: 'valid', raw: validRaw })
    expect(owner.resetInvalid(validExport.raw, populatedStore().getSnapshot())).toMatchObject({ status: 'valid', raw: validRaw })
    expect(storage.value).toBe(validRaw)
    expect(owner.isFormatWritable()).toBe(false)
    expect(owner.resumeValidRecovery(validRaw)).toBe(true)
    expect(storage.value).toBe(validRaw)
    expect(owner.isFormatWritable()).toBe(true)
    owner.dispose()
  })

  it('atomically replaces only the reviewed invalid raw and stays blocked on write failure', async () => {
    let failSet = true
    const storage = new MemoryStorage()
    storage.value = '{corrupt'
    const guardedStorage: StoragePort = {
      getItem: key => storage.getItem(key),
      setItem: (key, value) => {
        if (failSet) throw new DOMException('quota', 'QuotaExceededError')
        storage.setItem(key, value)
      },
    }
    const persistence = new SessionPersistence({ storage: guardedStorage, lock: new SharedExclusiveLock(), writerId: 'owner' })
    persistence.load()
    expect(await persistence.startExclusiveWriter()).toBe(true)
    const exported = persistence.exportInvalidRaw()
    const snapshot = populatedStore().getSnapshot()

    expect(() => persistence.resetInvalid(exported.raw, snapshot)).toThrow(/could not durably replace/i)
    expect(storage.value).toBe(exported.raw)
    expect(persistence.isFormatWritable()).toBe(false)

    failSet = false
    expect(persistence.resetInvalid(exported.raw, snapshot)).toEqual({ status: 'saved' })
    expect(storage.value).toContain('unsaved secret\\n')
    expect(persistence.isFormatWritable()).toBe(true)
    persistence.dispose()
  })

  it('coalesces writes and flushes the latest snapshot', async () => {
    const storage = new MemoryStorage()
    const timeout = new FakeTimeout()
    const statuses: string[] = []
    const persistence = new SessionPersistence({
      storage, timeout, lock: new SharedExclusiveLock(), writerId: 'writer', now: () => 42,
      onStatus: status => { statuses.push(status.kind) },
    })
    expect(await persistence.startExclusiveWriter()).toBe(true)
    const store = populatedStore()
    persistence.schedule(store.getSnapshot())
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'latest\n')
    persistence.schedule(store.getSnapshot())
    timeout.run()
    expect(storage.value).toContain('latest\\n')
    expect(statuses).toEqual(['idle', 'pending', 'pending', 'saved'])
    persistence.dispose()
  })

  it('retains recovery records for workspaces not currently registered by Harness', () => {
    const retained: PersistedWorkspaceV1 = {
      workspaceId: 'temporarily-missing',
      tabs: [{ path: 'protected.ts', name: 'protected.ts', dirty: true, content: 'local\n', version: 'v1' }],
    }
    const parsed = JSON.parse(encodeWorkbench(populatedStore().getSnapshot(), 'writer', 10, [retained])) as {
      workspaces: PersistedWorkspaceV1[]
    }
    expect(parsed.workspaces.find(workspace => workspace.workspaceId === 'temporarily-missing')).toEqual({
      ...retained,
      tabs: [{ ...retained.tabs[0], eol: '\n' }],
    })
  })

  it('round-trips canonical dirty content with CRLF metadata and upgrades old schema-1 bytes', async () => {
    const store = new DocumentSessionStore()
    store.selectWorkspace('workspace')
    const open = store.beginOpen('workspace', 'a.ts', 'a.ts')!
    store.completeOpen(open, { path: 'a.ts', content: 'base\r\n', version: 'v1' })
    const tab = store.activeTab()!
    store.editDocument('workspace', tab.path, tab.lifecycleId, 'local\nchange\n')

    const encoded = encodeWorkbench(store.getSnapshot(), 'writer', 10)
    expect(JSON.parse(encoded).workspaces[0].tabs[0]).toMatchObject({
      content: 'local\nchange\n', eol: '\r\n', dirty: true,
    })
    const storage = new MemoryStorage()
    storage.value = encoded
    const loaded = new SessionPersistence({ storage }).load()
    expect(loaded).toMatchObject({
      kind: 'ready', workbench: { workspaces: [{ tabs: [{ content: 'local\nchange\n', eol: '\r\n' }] }] },
    })
    if (loaded.kind !== 'ready') throw new Error('expected ready recovery')
    const hydrated = await hydratePersistedWorkspace(loaded.workbench.workspaces[0]!, async (_workspace, path) => ({
      path, content: 'base\r\n', version: 'v1',
    }))
    expect(hydrated.documents[0]).toMatchObject({
      content: 'local\nchange\n', baselineContent: 'base\n',
      lineEnding: '\r\n', baselineLineEnding: '\r\n', dirty: true,
    })

    storage.value = JSON.stringify({
      schema: 1, writerId: 'old', savedAt: 1,
      workspaces: [{
        workspaceId: 'workspace',
        tabs: [{ path: 'old.ts', name: 'old.ts', dirty: true, content: 'old\r\nlocal\r\n', version: 'v1' }],
      }],
    })
    expect(new SessionPersistence({ storage }).load()).toMatchObject({
      kind: 'ready',
      workbench: { workspaces: [{ tabs: [{ content: 'old\nlocal\n', eol: '\r\n' }] }] },
    })

    const eolOnly: PersistedWorkspaceV1 = {
      workspaceId: 'workspace',
      tabs: [{ path: 'eol.ts', name: 'eol.ts', dirty: true, content: 'same\n', version: 'v1', eol: '\r\n' }],
    }
    const recoveredEol = await hydratePersistedWorkspace(eolOnly, async (_workspace, path) => ({
      path, content: 'same\n', version: 'v1',
    }))
    expect(recoveredEol.documents[0]).toMatchObject({
      content: 'same\n', baselineContent: 'same\n',
      lineEnding: '\r\n', baselineLineEnding: '\n', dirty: true,
    })
    const recoveredStore = new DocumentSessionStore()
    recoveredStore.selectWorkspace('workspace')
    recoveredStore.restoreWorkspace('workspace', recoveredEol.documents)
    expect(recoveredStore.beginSave('workspace', 'eol.ts')).toMatchObject({
      content: 'same\n', lineEnding: '\r\n', expectedVersion: 'v1',
      baselineContent: 'same\n', baselineLineEnding: '\n',
    })
  })

  it('survives storage access and quota failures without mutating editor state', async () => {
    const getFailure: StoragePort = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError') },
      setItem: () => {},
    }
    expect(new SessionPersistence({ storage: getFailure }).load()).toMatchObject({ kind: 'invalid' })

    const status = vi.fn()
    const setFailure: StoragePort = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError') },
    }
    const store = populatedStore()
    const before = store.activeTab()!.content
    const persistence = new SessionPersistence({ storage: setFailure, lock: new SharedExclusiveLock(), onStatus: status })
    expect(await persistence.startExclusiveWriter()).toBe(true)
    persistence.schedule(store.getSnapshot())
    expect(persistence.flush()).toBe(false)
    expect(store.activeTab()!.content).toBe(before)
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))
    persistence.dispose()
  })

  it('allows only one page to publish recovery and never lets a stale non-owner erase dirty bytes', async () => {
    const storage = new MemoryStorage()
    const lock = new SharedExclusiveLock()
    const owner = new SessionPersistence({ storage, lock, writerId: 'owner' })
    const stalePage = new SessionPersistence({ storage, lock, writerId: 'stale' })
    expect(await owner.startExclusiveWriter()).toBe(true)
    expect(await stalePage.startExclusiveWriter()).toBe(false)

    owner.schedule(populatedStore().getSnapshot())
    expect(owner.flush()).toBe(true)
    expect(storage.value).toContain('unsaved secret\\n')

    const staleStore = new DocumentSessionStore()
    staleStore.selectWorkspace('workspace')
    stalePage.schedule(staleStore.getSnapshot())
    expect(stalePage.flush()).toBe(false)
    expect(storage.value).toContain('unsaved secret\\n')
    owner.dispose()
    await vi.waitFor(() => { expect(lock.held).toBe(false) })
    expect(await stalePage.startExclusiveWriter()).toBe(true)
    stalePage.schedule(staleStore.getSnapshot())
    expect(stalePage.flush()).toBe(true)
    expect(storage.value).not.toContain('unsaved secret\\n')
    stalePage.dispose()
  })

  it('serializes a StrictMode-style stale acquisition so the live setup ultimately owns the lock', async () => {
    const lock = new DeferredExclusiveLock()
    const persistence = new SessionPersistence({ storage: new MemoryStorage(), lock })
    const staleStart = persistence.startExclusiveWriter()
    persistence.dispose()
    const liveStart = persistence.startExclusiveWriter()
    lock.resolveFirst()

    expect(await staleStart).toBe(false)
    expect(await liveStart).toBe(true)
    expect(lock.acquisitions).toBe(2)
    expect(lock.held).toBe(true)
    persistence.dispose()
    await vi.waitFor(() => { expect(lock.held).toBe(false) })
  })
})

describe('persisted workspace hydration', () => {
  const workspace: PersistedWorkspaceV1 = {
    workspaceId: 'workspace',
    activePath: 'dirty.ts',
    tabs: [
      { path: 'clean.ts', name: 'clean.ts', dirty: false },
      { path: 'dirty.ts', name: 'dirty.ts', dirty: true, content: 'local\n', version: 'v1' },
      { path: 'deleted.ts', name: 'deleted.ts', dirty: true, content: 'protected\n', version: 'old' },
    ],
  }

  it('uses Host reads for clean authority and never overwrites recovered dirty bytes', async () => {
    const result = await hydratePersistedWorkspace(workspace, async (_workspaceId, path) => {
      if (path === 'clean.ts') return { path, content: 'fresh disk\n', version: 'v9' }
      if (path === 'dirty.ts') return { path, content: 'external disk\n', version: 'v2' }
      throw new ApiError({ code: 'NOT_FOUND', message: 'missing' }, 404)
    })
    expect(result.activePath).toBe('dirty.ts')
    expect(result.documents[0]).toMatchObject({ content: 'fresh disk\n', baselineContent: 'fresh disk\n', version: 'v9', dirty: false })
    expect(result.documents[1]).toMatchObject({ content: 'local\n', version: 'v1', dirty: true, externalState: 'modified' })
    expect(result.documents[2]).toMatchObject({ content: 'protected\n', version: 'old', dirty: true, externalState: 'deleted' })
  })

  it('collapses recovered dirty state to clean when disk already equals the buffer', async () => {
    const one: PersistedWorkspaceV1 = {
      workspaceId: 'workspace', tabs: [{ path: 'a.ts', name: 'a.ts', dirty: true, content: 'same\n', version: 'v1' }],
    }
    const result = await hydratePersistedWorkspace(one, async (_workspaceId, path) => ({ path, content: 'same\n', version: 'v1' }))
    expect(result.documents[0]).toMatchObject({ content: 'same\n', baselineContent: 'same\n', dirty: false })
  })

  it('hydrates the active tab first with bounded concurrency while preserving tab order', async () => {
    const order: string[] = []
    const many: PersistedWorkspaceV1 = {
      workspaceId: 'workspace',
      activePath: 'c.ts',
      tabs: ['a.ts', 'b.ts', 'c.ts'].map(path => ({ path, name: path, dirty: false })),
    }
    const result = await hydratePersistedWorkspace(many, async (_workspaceId, path) => {
      order.push(path)
      return { path, content: path, version: `version-${path}` }
    }, 1)
    expect(order).toEqual(['c.ts', 'a.ts', 'b.ts'])
    expect(result.documents.map(document => document.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })
})
