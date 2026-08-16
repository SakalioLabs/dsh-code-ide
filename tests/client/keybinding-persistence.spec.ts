import { describe, expect, it, vi } from 'vitest'
import {
  KEYBINDING_SETTINGS_LOCK_NAME,
  KEYBINDING_SETTINGS_SCHEMA,
  KEYBINDING_SETTINGS_STORAGE_KEY,
  MAX_KEYBINDING_SETTINGS_RAW_CODE_UNITS,
  MAX_PERSISTED_KEYBINDING_ENTRIES,
  KeybindingPersistenceController,
  createBrowserKeybindingPersistence,
  decodePersistedKeybindingSettingsV1,
  encodePersistedKeybindingSettingsV1,
  type LockPort,
  type PersistedKeybindingSettingsV1,
  type StorageEventPort,
  type StoragePort,
} from '../../src/client/commands/keybinding-persistence.ts'
import type { UserKeybindingInput } from '../../src/client/commands/keybindings.ts'
import { CommandRegistry } from '../../src/client/commands/registry.ts'

class MemoryStorage implements StoragePort {
  reads = 0
  readonly writes: string[] = []
  getError: Error | undefined
  setError: Error | undefined

  constructor(public raw: string | null = null) {}

  getItem(key: string): string | null {
    expect(key).toBe(KEYBINDING_SETTINGS_STORAGE_KEY)
    this.reads += 1
    if (this.getError !== undefined) throw this.getError
    return this.raw
  }

  setItem(key: string, value: string): void {
    expect(key).toBe(KEYBINDING_SETTINGS_STORAGE_KEY)
    if (this.setError !== undefined) throw this.setError
    this.raw = value
    this.writes.push(value)
  }
}

class ImmediateLock implements LockPort {
  readonly names: string[] = []
  error: Error | undefined

  async runExclusive<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    this.names.push(name)
    if (this.error !== undefined) throw this.error
    return await callback()
  }
}

class SharedExclusiveLock implements LockPort {
  private tail: Promise<void> = Promise.resolve()
  readonly names: string[] = []

  async runExclusive<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
    this.names.push(name)
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await callback() } finally { release() }
  }
}

class DeferredLock implements LockPort {
  callback: (() => unknown | Promise<unknown>) | undefined
  private releaseLock: (() => void) | undefined

  async runExclusive<T>(_name: string, callback: () => T | Promise<T>): Promise<T> {
    this.callback = callback
    await new Promise<void>(resolve => { this.releaseLock = resolve })
    return await callback()
  }

  release(): void { this.releaseLock?.() }
}

class DelayedUnwindLock implements LockPort {
  private readonly callbackCompletedPromise: Promise<void>
  private callbackCompletedResolve!: () => void
  private releaseLock: (() => void) | undefined

  constructor() {
    this.callbackCompletedPromise = new Promise<void>(resolve => { this.callbackCompletedResolve = resolve })
  }

  async runExclusive<T>(_name: string, callback: () => T | Promise<T>): Promise<T> {
    const result = await callback()
    this.callbackCompletedResolve()
    await new Promise<void>(resolve => { this.releaseLock = resolve })
    return result
  }

  async callbackCompleted(): Promise<void> { await this.callbackCompletedPromise }
  release(): void { this.releaseLock?.() }
}

class StorageEvents implements StorageEventPort {
  private readonly listeners = new Map<string, Set<() => void>>()

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => { listeners.delete(listener) }
  }

  emit(key = KEYBINDING_SETTINGS_STORAGE_KEY): void {
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  count(key = KEYBINDING_SETTINGS_STORAGE_KEY): number {
    return this.listeners.get(key)?.size ?? 0
  }
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${String(index)}`
}

function input(commandId = 'workbench.test', key = 'p'): UserKeybindingInput {
  return { commandId, sequence: [{ primary: true, key }] }
}

function persisted(overrides: Partial<PersistedKeybindingSettingsV1> = {}): PersistedKeybindingSettingsV1 {
  return {
    schema: 1,
    revision: 3,
    writerId: 'writer-other',
    updatedAt: 30,
    userBindings: [],
    unboundDefaults: [],
    ...overrides,
  }
}

function parseStorage(storage: MemoryStorage): PersistedKeybindingSettingsV1 {
  expect(storage.raw).not.toBeNull()
  return decodePersistedKeybindingSettingsV1(JSON.parse(storage.raw ?? 'null'))
}

describe('keybinding settings wire format', () => {
  it('strictly decodes, canonicalizes and deeply freezes schema 1', () => {
    const decoded = decodePersistedKeybindingSettingsV1({
      schema: 1,
      revision: 4,
      writerId: 'writer-a',
      updatedAt: 40,
      userBindings: [{
        id: 'binding-a',
        commandId: 'workbench.test',
        sequence: [
          { primary: true, shift: false, key: ' ' },
          { ctrl: true, key: 'Enter' },
        ],
        platforms: ['linux', 'mac'],
        when: [{ key: 'mode', equals: 'editing' }, { key: 'enabled', equals: true }],
      }],
      unboundDefaults: [{ commandId: 'workbench.test', bindingId: 'primary' }],
    })

    expect(decoded).toMatchObject({ schema: 1, revision: 4, writerId: 'writer-a', updatedAt: 40 })
    expect(decoded.userBindings[0]).toMatchObject({
      id: 'binding-a',
      platforms: ['linux', 'mac'],
    })
    expect(decoded.userBindings[0]?.sequence).toHaveLength(2)
    expect(decoded.userBindings[0]?.sequence[0]).toEqual({ primary: true, key: ' ' })
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.userBindings)).toBe(true)
    expect(Object.isFrozen(decoded.userBindings[0])).toBe(true)
    expect(Object.isFrozen(decoded.userBindings[0]?.sequence)).toBe(true)
    expect(Object.isFrozen(decoded.userBindings[0]?.sequence[0])).toBe(true)
    expect(Object.isFrozen(decoded.userBindings[0]?.when?.[0])).toBe(true)
    expect(Object.isFrozen(decoded.unboundDefaults[0])).toBe(true)
    expect(decodePersistedKeybindingSettingsV1(JSON.parse(encodePersistedKeybindingSettingsV1(decoded))))
      .toEqual(decoded)
  })

  it('rejects unknown keys at every wire level and never overwrites corrupt data', async () => {
    const baseline = {
      schema: 1,
      revision: 1,
      writerId: 'writer-a',
      updatedAt: 10,
      userBindings: [{
        id: 'binding-a', commandId: 'workbench.test', sequence: [{ primary: true, key: 'p' }],
        when: [{ key: 'mode', equals: 'editing' }],
      }],
      unboundDefaults: [{ commandId: 'workbench.test', bindingId: 'primary' }],
    }
    const cases: unknown[] = [
      { ...baseline, extra: true },
      { ...baseline, userBindings: [{ ...baseline.userBindings[0], extra: true }] },
      {
        ...baseline,
        userBindings: [{ ...baseline.userBindings[0], sequence: [{ primary: true, key: 'p', extra: true }] }],
      },
      {
        ...baseline,
        userBindings: [{ ...baseline.userBindings[0], sequence: [{ primary: true, key: 'Dead' }] }],
      },
      {
        ...baseline,
        userBindings: [{ ...baseline.userBindings[0], when: [{ key: 'mode', equals: 'editing', extra: true }] }],
      },
      { ...baseline, unboundDefaults: [{ ...baseline.unboundDefaults[0], extra: true }] },
    ]

    for (const candidate of cases) {
      const storage = new MemoryStorage(JSON.stringify(candidate))
      const controller = new KeybindingPersistenceController({
        storage, lock: new ImmediateLock(), createId: ids('writer-local', 'binding-local'),
      })
      expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
      expect(controller.getStatus()).toMatchObject({ kind: 'readOnly' })
      await expect(controller.add(input())).resolves.toMatchObject({ status: 'read-only' })
      expect(storage.writes).toHaveLength(0)
    }
  })

  it('treats future, malformed, oversized and over-budget documents as empty read-only state', () => {
    const overBudget = persisted({
      unboundDefaults: Array.from({ length: MAX_PERSISTED_KEYBINDING_ENTRIES + 1 }, (_, index) => ({
        commandId: 'workbench.test', bindingId: `binding-${String(index)}`,
      })),
    })
    const cases = [
      JSON.stringify({ schema: KEYBINDING_SETTINGS_SCHEMA + 1, anything: 'newer' }),
      '{not-json',
      'x'.repeat(MAX_KEYBINDING_SETTINGS_RAW_CODE_UNITS + 1),
      JSON.stringify(overBudget),
    ]

    for (const raw of cases) {
      const controller = new KeybindingPersistenceController({
        storage: new MemoryStorage(raw), lock: new ImmediateLock(), createId: ids('writer-local'),
      })
      expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
      expect(controller.getStatus()).toMatchObject({ kind: 'readOnly' })
    }
  })

  it('treats context clauses outside the injected workbench allowlist as corrupt and read-only', async () => {
    const storage = new MemoryStorage(JSON.stringify(persisted({
      userBindings: [{
        id: 'binding-a', commandId: 'workbench.test',
        sequence: [{ primary: true, key: 'p' }],
        when: [{ key: 'futureContext', equals: true }],
      }],
    })))
    const controller = new KeybindingPersistenceController({
      storage,
      lock: new ImmediateLock(),
      contextSchema: { mode: ['editing'], enabled: 'boolean' },
      createId: ids('writer-local', 'binding-local'),
    })
    expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
    expect(controller.getStatus()).toMatchObject({ kind: 'readOnly', message: expect.stringContaining('not admitted') })
    await expect(controller.add(input())).resolves.toMatchObject({ status: 'read-only' })
    expect(storage.writes).toHaveLength(0)
  })
})

describe('KeybindingPersistenceController mutations', () => {
  it('replaces a default with one user binding and tombstone in a single locked write', async () => {
    const storage = new MemoryStorage()
    const lock = new ImmediateLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, now: () => 10, createId: ids('writer-local', 'binding-replacement'),
    })
    await expect(controller.replaceDefault('workbench.open', 'primary', {
      commandId: 'workbench.open', sequence: [{ primary: true, key: 'o' }],
    })).resolves.toEqual({ status: 'saved' })
    expect(storage.writes).toHaveLength(1)
    expect(lock.names).toEqual([KEYBINDING_SETTINGS_LOCK_NAME])
    expect(parseStorage(storage)).toMatchObject({
      revision: 1,
      userBindings: [{ id: 'binding-replacement', commandId: 'workbench.open' }],
      unboundDefaults: [{ commandId: 'workbench.open', bindingId: 'primary' }],
    })
  })

  it('runs every valid mutation under a short lock and stamps only changed writes', async () => {
    const storage = new MemoryStorage()
    const lock = new ImmediateLock()
    const controller = new KeybindingPersistenceController({
      storage,
      lock,
      now: () => 100,
      createId: ids('writer-local', 'binding-a', 'binding-b'),
    })
    const listener = vi.fn()
    controller.subscribe(listener)
    const initialValue = controller.getValue()
    const initialStatus = controller.getStatus()
    expect(initialStatus).toBe(controller.getStatus())

    await expect(controller.add({
      commandId: 'workbench.test',
      sequence: [{ primary: true, key: ' ' }],
      platforms: ['windows'],
      when: [{ key: 'editing', equals: true }],
    })).resolves.toEqual({ status: 'saved' })
    let wire = parseStorage(storage)
    expect(wire).toMatchObject({ schema: 1, revision: 1, writerId: 'writer-local', updatedAt: 100 })
    expect(wire.userBindings[0]).toMatchObject({ id: 'binding-a', commandId: 'workbench.test' })
    expect(controller.getValue()).not.toBe(initialValue)
    expect(controller.getValue()).toBe(controller.getValue())
    expect(Object.isFrozen(controller.getValue())).toBe(true)
    expect(Object.isFrozen(controller.getValue().userBindings)).toBe(true)

    await expect(controller.replace('binding-a', input('workbench.test', 's')))
      .resolves.toEqual({ status: 'saved' })
    wire = parseStorage(storage)
    expect(wire.revision).toBe(2)
    expect(wire.userBindings[0]).toMatchObject({ id: 'binding-a', sequence: [{ primary: true, key: 's' }] })
    await expect(controller.replace('binding-a', input('workbench.test', 's')))
      .resolves.toEqual({ status: 'unchanged' })
    expect(storage.writes).toHaveLength(2)

    await expect(controller.unbindDefault('workbench.test', 'primary')).resolves.toEqual({ status: 'saved' })
    await expect(controller.unbindDefault('workbench.test', 'primary')).resolves.toEqual({ status: 'unchanged' })
    expect(parseStorage(storage).revision).toBe(3)
    await expect(controller.resetCommand('workbench.test')).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ revision: 4, userBindings: [], unboundDefaults: [] })
    await expect(controller.resetAll()).resolves.toEqual({ status: 'unchanged' })

    await expect(controller.add(input('workbench.other', 'o'))).resolves.toEqual({ status: 'saved' })
    await expect(controller.remove('missing')).resolves.toEqual({ status: 'unchanged' })
    await expect(controller.remove('binding-b')).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ revision: 6, userBindings: [] })
    expect(storage.writes).toHaveLength(6)
    expect(lock.names).toHaveLength(10)
    expect(lock.names.every(name => name === KEYBINDING_SETTINGS_LOCK_NAME)).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(listener.mock.calls.length).toBeGreaterThan(storage.writes.length)
    expect(controller.getStatus()).toBe(initialStatus)
  })

  it('enforces the individual and aggregate 512-entry budgets without changing wire state', async () => {
    const full = persisted({
      revision: 9,
      unboundDefaults: Array.from({ length: MAX_PERSISTED_KEYBINDING_ENTRIES }, (_, index) => ({
        commandId: 'workbench.test', bindingId: `default-${String(index)}`,
      })),
    })
    const storage = new MemoryStorage(JSON.stringify(full))
    const controller = new KeybindingPersistenceController({
      storage, lock: new ImmediateLock(), createId: ids('writer-local', 'binding-local'),
    })
    const before = storage.raw

    await expect(controller.add(input())).resolves.toMatchObject({ status: 'failed' })
    expect(controller.getStatus()).toMatchObject({ kind: 'error', message: expect.stringContaining('512') })
    expect(controller.getValue().unboundDefaults).toHaveLength(MAX_PERSISTED_KEYBINDING_ENTRIES)
    expect(storage.raw).toBe(before)
    expect(storage.writes).toHaveLength(0)
  })

  it('prefixes browser UUID ids so a UUID beginning with a digit remains resolver-valid', async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000')
    try {
      const storage = new MemoryStorage()
      const controller = new KeybindingPersistenceController({ storage, lock: new ImmediateLock() })
      await expect(controller.add(input())).resolves.toEqual({ status: 'saved' })
      const wire = parseStorage(storage)
      expect(wire.writerId).toBe('kb-00000000-0000-4000-8000-000000000000')
      expect(wire.userBindings[0]?.id).toBe('kb-00000000-0000-4000-8000-000000000000')
      expect(wire.userBindings[0]?.id).toMatch(/^[A-Za-z][A-Za-z0-9._-]*$/u)
    } finally {
      randomUuid.mockRestore()
    }
  })

  it('loads valid settings but remains explicitly read-only when Web Locks are unavailable', async () => {
    const storage = new MemoryStorage(JSON.stringify(persisted({
      userBindings: [{ id: 'binding-a', ...input() }],
    })))
    const events = new StorageEvents()
    const controller = new KeybindingPersistenceController({
      storage, storageEvents: events, createId: ids('writer-local', 'binding-local'),
    })
    expect(events.count()).toBe(0)
    controller.startSync()
    controller.startSync()
    expect(events.count()).toBe(1)

    expect(controller.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-a'])
    expect(controller.getStatus()).toMatchObject({ kind: 'readOnly', message: expect.stringContaining('Web Lock') })
    await expect(controller.add(input())).resolves.toMatchObject({ status: 'read-only' })
    expect(storage.writes).toHaveLength(0)

    storage.raw = JSON.stringify(persisted({
      revision: 4,
      userBindings: [{ id: 'binding-b', ...input('workbench.other', 'o') }],
    }))
    events.emit()
    expect(controller.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-b'])
    expect(controller.getStatus()).toMatchObject({ kind: 'readOnly' })
    expect(controller.canDispatch()).toBe(true)
    controller.dispose()
    expect(events.count()).toBe(0)
  })

  it('reloads latest after subscribing so a pre-start cross-page event cannot be lost', () => {
    const storage = new MemoryStorage(JSON.stringify(persisted({
      revision: 1,
      userBindings: [{ id: 'binding-a', ...input() }],
    })))
    const events = new StorageEvents()
    const controller = new KeybindingPersistenceController({
      storage, lock: new ImmediateLock(), storageEvents: events,
      createId: ids('writer-local'),
    })

    storage.raw = JSON.stringify(persisted({
      revision: 2,
      userBindings: [{ id: 'binding-b', ...input('workbench.other', 'o') }],
    }))
    events.emit()
    expect(controller.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-a'])

    controller.startSync()

    expect(events.count()).toBe(1)
    expect(controller.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-b'])
  })

  it('treats a null-key storage event from localStorage.clear as a settings reset', () => {
    const storage = new MemoryStorage(JSON.stringify(persisted({
      userBindings: [{ id: 'binding-a', ...input() }],
    })))
    const listeners = new Set<(event: StorageEvent) => void>()
    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.add(listener)
      },
      removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.delete(listener)
      },
    })
    vi.stubGlobal('navigator', {})
    try {
      const controller = createBrowserKeybindingPersistence()
      controller.startSync()
      expect(controller.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-a'])

      storage.raw = null
      for (const listener of listeners) listener({ key: null } as StorageEvent)

      expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
      expect(controller.canDispatch()).toBe(true)
      controller.dispose()
      expect(listeners.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serializes pages, reloads latest under lock, and refreshes from storage events', async () => {
    const storage = new MemoryStorage()
    const lock = new SharedExclusiveLock()
    const events = new StorageEvents()
    const first = new KeybindingPersistenceController({
      storage, lock, storageEvents: events, now: () => 10,
      createId: ids('writer-first', 'binding-first'),
    })
    const second = new KeybindingPersistenceController({
      storage, lock, storageEvents: events, now: () => 20,
      createId: ids('writer-second', 'binding-second'),
    })
    first.startSync()
    second.startSync()

    await Promise.all([
      first.add(input('workbench.first', 'f')),
      second.add(input('workbench.second', 's')),
    ])
    const wire = parseStorage(storage)
    expect(wire.revision).toBe(2)
    expect(wire.userBindings.map(binding => binding.id)).toEqual(['binding-first', 'binding-second'])
    expect(second.getValue().userBindings).toHaveLength(2)
    expect(first.getValue().userBindings).toHaveLength(1)

    events.emit()
    expect(first.getValue().userBindings.map(binding => binding.id)).toEqual(['binding-first', 'binding-second'])
    expect(first.getStatus()).toMatchObject({ kind: 'ready' })
    expect(events.count()).toBe(2)
    const finalFirstValue = first.getValue()
    first.dispose()
    expect(events.count()).toBe(1)
    storage.raw = JSON.stringify(persisted())
    events.emit()
    expect(first.getValue()).toBe(finalFirstValue)
  })

  it('turns a future storage event into sticky empty read-only state', async () => {
    const storage = new MemoryStorage(JSON.stringify(persisted({
      userBindings: [{ id: 'binding-a', ...input() }],
    })))
    const events = new StorageEvents()
    const controller = new KeybindingPersistenceController({
      storage, lock: new ImmediateLock(), storageEvents: events,
      createId: ids('writer-local', 'binding-local'),
    })
    controller.startSync()
    storage.raw = JSON.stringify({ schema: 2, future: true })
    events.emit()

    expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
    expect(controller.getStatus()).toMatchObject({ kind: 'readOnly', message: expect.stringContaining('newer') })
    await expect(controller.add(input())).resolves.toMatchObject({ status: 'read-only' })
    expect(storage.writes).toHaveLength(0)

    storage.raw = JSON.stringify(persisted({ userBindings: [{ id: 'binding-b', ...input() }] }))
    events.emit()
    expect(controller.getValue()).toEqual({ userBindings: [], unboundDefaults: [] })
    expect(controller.getStatus()).toMatchObject({ kind: 'readOnly' })
  })

  it('reports quota, storage and lock failures without publishing the attempted value', async () => {
    const initial = persisted({
      revision: 7,
      userBindings: [{ id: 'binding-existing', ...input('workbench.existing', 'e') }],
    })
    const storage = new MemoryStorage(JSON.stringify(initial))
    const lock = new ImmediateLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, now: () => 100,
      createId: ids('writer-local', 'binding-quota', 'binding-storage', 'binding-recovered'),
    })
    const original = controller.getValue()

    storage.setError = new Error('QuotaExceededError')
    await expect(controller.add(input('workbench.quota', 'q'))).resolves.toMatchObject({
      status: 'failed', message: expect.stringContaining('QuotaExceededError'),
    })
    expect(controller.getStatus()).toMatchObject({ kind: 'error' })
    expect(controller.getValue()).toBe(original)
    expect(parseStorage(storage).revision).toBe(7)

    storage.setError = undefined
    storage.getError = new Error('storage blocked')
    await expect(controller.add(input('workbench.storage', 's'))).resolves.toMatchObject({
      status: 'failed', message: expect.stringContaining('storage blocked'),
    })
    expect(controller.getValue()).toBe(original)
    storage.getError = undefined

    lock.error = new Error('lock failed')
    await expect(controller.add(input('workbench.lock', 'l'))).resolves.toMatchObject({
      status: 'failed', message: expect.stringContaining('lock failed'),
    })
    expect(controller.getValue()).toBe(original)
    lock.error = undefined

    await expect(controller.add(input('workbench.recovered', 'r'))).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ revision: 8, writerId: 'writer-local' })
    expect(controller.getStatus()).toMatchObject({ kind: 'ready' })
  })

  it('isolates subscribers, rejects invalid edits atomically, and fences disposal', async () => {
    const storage = new MemoryStorage()
    const controller = new KeybindingPersistenceController({
      storage, lock: new ImmediateLock(), createId: ids('writer-local', 'binding-local'),
    })
    controller.subscribe(() => { throw new Error('broken subscriber') })

    await expect(controller.add({ ...input(), extra: true } as UserKeybindingInput))
      .resolves.toMatchObject({ status: 'failed' })
    expect(storage.writes).toHaveLength(0)
    controller.dispose()
    controller.dispose()
    await expect(controller.add(input())).resolves.toMatchObject({ status: 'read-only' })
    expect(storage.writes).toHaveLength(0)
  })

  it('settles lock-waiting edits on dispose and never writes when the lock later opens', async () => {
    const storage = new MemoryStorage()
    const lock = new DeferredLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, createId: ids('writer-local', 'binding-local'),
    })
    const pending = controller.add(input())
    await vi.waitFor(() => { expect(lock.callback).toBeTypeOf('function') })

    controller.dispose()

    await expect(pending).resolves.toEqual({
      status: 'read-only', message: 'Keybinding persistence is disposed.',
    })
    expect(storage.writes).toHaveLength(0)
    lock.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(storage.writes).toHaveLength(0)
  })

  it('does not misreport a committed edit when dispose races the lock promise unwind', async () => {
    const storage = new MemoryStorage()
    const lock = new DelayedUnwindLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, createId: ids('writer-local', 'binding-local'),
    })
    const pending = controller.add(input())
    await lock.callbackCompleted()
    expect(storage.writes).toHaveLength(1)

    controller.dispose()
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    lock.release()
    await expect(pending).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ revision: 1 })
  })

  it('settles an invalid-settings reset waiting for a lock when disposed', async () => {
    const storage = new MemoryStorage(JSON.stringify({ schema: 2, future: true }))
    const lock = new DeferredLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, createId: ids('writer-local'),
    })
    const pending = controller.resetInvalidSettings()
    await vi.waitFor(() => { expect(lock.callback).toBeTypeOf('function') })

    controller.dispose()

    await expect(pending).resolves.toEqual({
      status: 'read-only', message: 'Keybinding persistence is disposed.',
    })
    lock.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(storage.writes).toHaveLength(0)
  })

  it('preserves a committed invalid-settings reset outcome across dispose', async () => {
    const storage = new MemoryStorage(JSON.stringify({ schema: 2, future: true }))
    const lock = new DelayedUnwindLock()
    const controller = new KeybindingPersistenceController({
      storage, lock, now: () => 5, createId: ids('writer-local'),
    })
    const pending = controller.resetInvalidSettings()
    await lock.callbackCompleted()
    expect(storage.writes).toHaveLength(1)

    controller.dispose()
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    lock.release()
    await expect(pending).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ schema: 1, revision: 1 })
  })

  it('blocks defaults for future data and only an explicit locked invalid reset restores dispatch', async () => {
    const storage = new MemoryStorage(JSON.stringify({ schema: 2, future: true }))
    const settings = new KeybindingPersistenceController({
      storage, lock: new ImmediateLock(), now: () => 50,
      createId: ids('writer-local'),
    })
    const registry = new CommandRegistry(() => undefined, 'windows', { settings })
    registry.register({
      id: 'workbench.safeDefault', title: 'Safe default',
      defaultKeybindings: [{ id: 'primary', sequence: [{ primary: true, key: 'p' }] }],
      run: () => undefined,
    })
    const event = { key: 'p', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(registry.keybindings.store.getSnapshot()).toMatchObject({
      dispatchBlocked: true, canResetInvalid: true,
      persistence: { kind: 'readOnly' },
    })
    expect(registry.commandForKeyboardEvent(event)).toBeUndefined()
    expect(registry.keybindings.acceptKeyboardEvent(event)).toEqual({ kind: 'none', consume: false })
    await expect(registry.keybindings.resetAll()).resolves.toMatchObject({ status: 'read-only' })

    await expect(registry.keybindings.resetInvalidSettings()).resolves.toEqual({ status: 'saved' })
    expect(parseStorage(storage)).toMatchObject({ schema: 1, revision: 1, userBindings: [], unboundDefaults: [] })
    expect(registry.keybindings.store.getSnapshot()).toMatchObject({
      dispatchBlocked: false, canResetInvalid: false,
      persistence: { kind: 'ready' },
    })
    expect(registry.commandForKeyboardEvent(event)).toBe('workbench.safeDefault')
    await registry.dispose()
  })
})
