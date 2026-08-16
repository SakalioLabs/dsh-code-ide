import { describe, expect, it } from 'vitest'
import type { MutationRecoveryRecord, ProtocolMutationResult } from '../../src/client/mutations/controller.ts'
import {
  MAX_MUTATION_RECOVERY_CODE_UNITS,
  MutationRecoveryPersistence,
  WORKSPACE_MUTATION_RECOVERY_KEY,
  createDurableMutationRecoveryPort,
  rebindMutationRecoveryRecord,
  type MutationRecoveryStoragePort,
} from '../../src/client/mutations/recovery.ts'

const PROVIDER = '11111111-1111-4111-8111-111111111111'
const OPERATION = '22222222-2222-4222-8222-222222222222'

class MemoryStorage implements MutationRecoveryStoragePort {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

function record(operationId = OPERATION): MutationRecoveryRecord {
  return {
    providerEpoch: PROVIDER,
    workspaceId: 'workspace-a',
    workspaceEpoch: 7,
    operationId,
    draft: {
      kind: 'rename',
      source: { path: 'src/old.ts', type: 'file', version: 'v1' },
      name: 'new.ts',
    },
  }
}

const result: ProtocolMutationResult = {
  kind: 'file',
  path: 'src/old.ts',
  destinationPath: 'src/new.ts',
  version: 'v2',
  refreshDirectories: ['src'],
}

describe('MutationRecoveryPersistence', () => {
  it('checkpoints prepared, unknown and committed phases before exact applied cleanup', () => {
    const storage = new MemoryStorage()
    const persistence = new MutationRecoveryPersistence({ storage, now: () => 123 })
    expect(() => persistence.prepared(record())).toThrow(/does not own/u)

    persistence.setWritable(true)
    persistence.prepared(record())
    expect(persistence.load()).toMatchObject({
      kind: 'ready', value: { phase: 'prepared', savedAt: 123, record: { operationId: OPERATION } },
    })

    persistence.unknown(record(), { code: 'MUTATION_OUTCOME_UNKNOWN', message: 'response lost' })
    expect(persistence.load()).toMatchObject({ kind: 'ready', value: { phase: 'unknown' } })

    persistence.committed(record(), result)
    expect(persistence.load()).toMatchObject({
      kind: 'ready', value: { phase: 'committed', result: { destinationPath: 'src/new.ts' } },
    })

    persistence.applied(record())
    expect(persistence.load()).toEqual({ kind: 'empty' })
  })

  it('requires a durable workbench flush before admission and before clearing a committed checkpoint', () => {
    const storage = new MemoryStorage()
    const persistence = new MutationRecoveryPersistence({ storage })
    persistence.setWritable(true)
    let flush = false
    const durable = createDurableMutationRecoveryPort(persistence, () => flush)

    expect(() => durable.prepared(record())).toThrow(/pre-mutation/u)
    expect(persistence.load()).toEqual({ kind: 'empty' })

    flush = true
    durable.prepared(record())
    durable.committed(record(), result)
    flush = false
    expect(() => durable.applied(record())).toThrow(/committed/u)
    expect(persistence.load()).toMatchObject({ kind: 'ready', value: { phase: 'committed' } })

    flush = true
    durable.applied(record())
    expect(persistence.load()).toEqual({ kind: 'empty' })
  })

  it('does not let a stale callback erase another operation', () => {
    const storage = new MemoryStorage()
    const persistence = new MutationRecoveryPersistence({ storage })
    persistence.setWritable(true)
    const current = record('33333333-3333-4333-8333-333333333333')
    persistence.prepared(current)

    expect(() => persistence.prepared(record())).toThrow(/checkpoint is active/u)
    expect(() => persistence.notCommitted(record())).toThrow(/different mutation/u)
    expect(persistence.load()).toMatchObject({
      kind: 'ready', value: { record: { operationId: current.operationId } },
    })
  })

  it('does not regress a committed checkpoint back to unknown', () => {
    const storage = new MemoryStorage()
    const persistence = new MutationRecoveryPersistence({ storage })
    persistence.setWritable(true)
    persistence.prepared(record())
    persistence.committed(record(), result)
    expect(() => persistence.unknown(record(), { code: 'LATE', message: 'late callback' })).toThrow(/predecessor/u)
    expect(persistence.load()).toMatchObject({ kind: 'ready', value: { phase: 'committed' } })
  })

  it('round-trips protocol UUID versions through recovery and explicitly acknowledges unresolved predecessors', () => {
    const storage = new MemoryStorage()
    const persistence = new MutationRecoveryPersistence({ storage })
    persistence.setWritable(true)
    const versionSeven = {
      ...record(),
      providerEpoch: '11111111-1111-7111-8111-111111111111',
    }
    persistence.prepared(versionSeven)
    persistence.unknown(versionSeven, { code: 'MANUAL', message: 'manual review' })
    expect(new MutationRecoveryPersistence({ storage }).load()).toMatchObject({
      kind: 'ready', value: { phase: 'unknown', record: { providerEpoch: versionSeven.providerEpoch } },
    })
    persistence.acknowledged(versionSeven)
    expect(persistence.load()).toEqual({ kind: 'empty' })

    persistence.prepared(versionSeven)
    persistence.acknowledged(versionSeven)
    expect(persistence.load()).toEqual({ kind: 'empty' })
  })

  it('fails closed for future, malformed and oversized records', () => {
    for (const raw of [
      JSON.stringify({ schema: 2 }),
      JSON.stringify({ schema: 1, phase: 'prepared', savedAt: 1, record: { operationId: OPERATION } }),
      'x'.repeat(MAX_MUTATION_RECOVERY_CODE_UNITS + 1),
    ]) {
      const storage = new MemoryStorage()
      storage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, raw)
      const persistence = new MutationRecoveryPersistence({ storage })
      expect(['future', 'invalid']).toContain(persistence.load().kind)
      persistence.setWritable(true)
      expect(() => persistence.prepared(record())).toThrow(/does not own/u)
      expect(storage.getItem(WORKSPACE_MUTATION_RECOVERY_KEY)).toBe(raw)
    }
  })

  it('resets only a still-invalid checkpoint for the current writer owner', () => {
    const storage = new MemoryStorage()
    storage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, '{bad json')
    const persistence = new MutationRecoveryPersistence({ storage })

    expect(persistence.load()).toMatchObject({ kind: 'invalid', resettable: true })
    expect(persistence.canResetInvalid()).toBe(false)
    expect(() => persistence.resetInvalid()).toThrow(/does not own/u)

    persistence.setWritable(true)
    expect(persistence.canResetInvalid()).toBe(true)
    expect(persistence.resetInvalid()).toEqual({ status: 'reset' })
    expect(storage.getItem(WORKSPACE_MUTATION_RECOVERY_KEY)).toBeNull()
    expect(persistence.canResetInvalid()).toBe(false)
    expect(() => persistence.prepared(record())).not.toThrow()
  })

  it('revalidates reset confirmation, preserves valid recovery, and stays blocked after removal failure', () => {
    const storage = new MemoryStorage()
    storage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, JSON.stringify({ schema: 2 }))
    const persistence = new MutationRecoveryPersistence({ storage })
    expect(persistence.load()).toMatchObject({ kind: 'future', resettable: true })
    persistence.setWritable(true)

    const current = record('33333333-3333-4333-8333-333333333333')
    const valid = new MutationRecoveryPersistence({ storage })
    valid.setWritable(true)
    storage.removeItem(WORKSPACE_MUTATION_RECOVERY_KEY)
    valid.prepared(current)
    valid.unknown(current, { code: 'MANUAL_REVIEW', message: 'check the workspace' })

    expect(persistence.resetInvalid()).toMatchObject({ status: 'refused' })
    expect(storage.getItem(WORKSPACE_MUTATION_RECOVERY_KEY)).toContain(current.operationId)
    expect(() => persistence.unknown(current, {
      code: 'MANUAL_REVIEW',
      message: 'still preserved and writable by the current owner',
    })).not.toThrow()

    const failingStorage = new MemoryStorage()
    failingStorage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, 'malformed')
    failingStorage.removeItem = () => { throw new DOMException('blocked', 'SecurityError') }
    const failing = new MutationRecoveryPersistence({ storage: failingStorage })
    expect(failing.load()).toMatchObject({ kind: 'invalid', resettable: true })
    failing.setWritable(true)
    expect(() => failing.resetInvalid()).toThrow(/could not be cleared/u)
    expect(failing.canResetInvalid()).toBe(true)
    expect(() => failing.prepared(record())).toThrow(/does not own/u)
  })

  it('rejects noncanonical paths and unknown response fields', () => {
    const storage = new MemoryStorage()
    storage.setItem(WORKSPACE_MUTATION_RECOVERY_KEY, JSON.stringify({
      schema: 1,
      phase: 'committed',
      savedAt: 1,
      record: {
        ...record(),
        draft: { kind: 'delete', source: { path: '../outside', type: 'file', version: 'v1' } },
      },
      result: { ...result, extra: true },
    }))
    expect(new MutationRecoveryPersistence({ storage }).load()).toMatchObject({ kind: 'invalid' })
  })

  it('rebinds only the runtime workspace epoch after exact workspace selection', () => {
    expect(rebindMutationRecoveryRecord(record(), 42)).toEqual({ ...record(), workspaceEpoch: 42 })
    expect(() => rebindMutationRecoveryRecord(record(), -1)).toThrow(/epoch/u)
  })
})
