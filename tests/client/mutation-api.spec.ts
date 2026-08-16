import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  decodeMutationProviderResponse,
  decodeMutationReceipt,
  mutationApi,
  mutationResultMatchesRequest,
} from '../../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

const PROVIDER_EPOCH = '11111111-1111-4111-8111-111111111111'
const OPERATION_ID = '22222222-2222-4222-8222-222222222222'

describe('workspace mutation API decoding', () => {
  it('decodes an exact provider handshake and rejects capability drift', () => {
    const provider = {
      providerEpoch: PROVIDER_EPOCH,
      capabilities: { createFile: true, createDirectory: true, rename: true, delete: false },
    }
    expect(decodeMutationProviderResponse(provider)).toEqual(provider)
    expect(decodeMutationProviderResponse({ ...provider, extra: true })).toBeUndefined()
    expect(decodeMutationProviderResponse({
      ...provider, capabilities: { ...provider.capabilities, createFile: false, createDirectory: false },
    })).toEqual({
      ...provider, capabilities: { ...provider.capabilities, createFile: false, createDirectory: false },
    })
    expect(decodeMutationProviderResponse({
      ...provider, capabilities: { ...provider.capabilities, createFile: 'yes' },
    })).toBeUndefined()
    expect(decodeMutationProviderResponse({
      ...provider, capabilities: { ...provider.capabilities, replace: true },
    })).toBeUndefined()
    expect(decodeMutationProviderResponse({ ...provider, providerEpoch: 'x'.repeat(65) })).toBeUndefined()
  })

  it('decodes all receipt states with bounded exact nested values', () => {
    const expected = { providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID }
    expect(decodeMutationReceipt({ ...expected, state: 'queued' }, expected))
      .toEqual({ ...expected, state: 'queued' })
    expect(decodeMutationReceipt({ ...expected, state: 'running' }, expected))
      .toEqual({ ...expected, state: 'running' })
    expect(decodeMutationReceipt({ ...expected, state: 'expired' }, expected))
      .toEqual({ ...expected, state: 'expired' })
    expect(decodeMutationReceipt({
      ...expected,
      state: 'committed',
      result: { kind: 'file', path: 'src/new.ts', version: 'v1', refreshDirectories: ['src'] },
      warning: { code: 'PURGE_PENDING', message: 'Background cleanup is pending.' },
    }, expected)).toEqual({
      ...expected,
      state: 'committed',
      result: { kind: 'file', path: 'src/new.ts', version: 'v1', refreshDirectories: ['src'] },
      warning: { code: 'PURGE_PENDING', message: 'Background cleanup is pending.' },
    })
    expect(decodeMutationReceipt({
      ...expected,
      state: 'committed',
      result: {
        kind: 'directory', path: 'src/old', destinationPath: 'lib/new', version: 'v2',
        refreshDirectories: ['src', 'lib'],
      },
    }, expected)?.state).toBe('committed')
    expect(decodeMutationReceipt({
      ...expected,
      state: 'committed',
      result: { kind: 'directory', path: 'tmp', recursive: true, refreshDirectories: [''] },
    }, expected)?.state).toBe('committed')
    expect(decodeMutationReceipt({
      ...expected,
      state: 'notCommitted',
      error: { code: 'TARGET_EXISTS', message: 'The destination already exists.' },
    }, expected)).toEqual({
      ...expected,
      state: 'notCommitted',
      error: { code: 'TARGET_EXISTS', message: 'The destination already exists.' },
    })
    expect(decodeMutationReceipt({
      ...expected,
      state: 'recoveryRequired',
      error: { code: 'RECOVERY_REQUIRED', message: 'Check the operation status before continuing.' },
    }, expected)?.state).toBe('recoveryRequired')
  })

  it('rejects forged identities, paths, metadata, duplicate refresh paths and unknown fields', () => {
    const expected = { providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID }
    const committed = {
      ...expected,
      state: 'committed',
      result: { kind: 'file', path: 'src/new.ts', version: 'v1', refreshDirectories: ['src'] },
    }
    expect(decodeMutationReceipt({
      ...committed, operationId: '33333333-3333-4333-8333-333333333333',
    }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({ ...committed, injected: true }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({
      ...committed, result: { ...committed.result, path: '../outside' },
    }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({
      ...committed, result: { ...committed.result, version: '' },
    }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({
      ...committed, result: { ...committed.result, refreshDirectories: ['src', 'src'] },
    }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({
      ...committed, result: { ...committed.result, refreshDirectories: ['', 'a', 'b', 'c', 'd'] },
    }, expected)).toBeUndefined()
    expect(decodeMutationReceipt({
      ...expected, state: 'notCommitted', error: { code: 'X', message: 'failure', hostPath: 'C:/secret' },
    }, expected)).toBeUndefined()
  })

  it('checks committed resource identity against the admitted mutation', () => {
    const created = { kind: 'file' as const, path: 'a.ts', version: 'v1', refreshDirectories: [''] }
    expect(mutationResultMatchesRequest(created, { kind: 'createFile', path: 'a.ts' })).toBe(true)
    expect(mutationResultMatchesRequest(created, { kind: 'createDirectory', path: 'a.ts' })).toBe(false)
    const renamed = {
      kind: 'directory' as const,
      path: 'old',
      destinationPath: 'new',
      version: 'v2',
      refreshDirectories: [''],
    }
    expect(mutationResultMatchesRequest(renamed, {
      kind: 'rename', path: 'old', destinationPath: 'new', expected: { kind: 'directory', version: 'v1' },
    })).toBe(true)
    expect(mutationResultMatchesRequest(renamed, {
      kind: 'rename', path: 'old', destinationPath: 'other', expected: { kind: 'directory', version: 'v1' },
    })).toBe(false)
  })

  it('uses the exact endpoint and validates response identity for mutate and status', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providerEpoch: PROVIDER_EPOCH,
          capabilities: { createFile: true, createDirectory: true, rename: true, delete: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, state: 'committed',
          result: { kind: 'file', path: 'src/new.ts', version: 'v1', refreshDirectories: ['src'] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, state: 'running' }),
      })
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(mutationApi.provider(signal)).resolves.toMatchObject({ providerEpoch: PROVIDER_EPOCH })
    await expect(mutationApi.mutate({
      providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, workspaceId: 'workspace-1',
      mutation: { kind: 'createFile', path: 'src/new.ts' },
    }, signal)).resolves.toMatchObject({ state: 'committed' })
    await expect(mutationApi.status(PROVIDER_EPOCH, OPERATION_ID, signal)).resolves.toMatchObject({ state: 'running' })
    for (const call of fetch.mock.calls) {
      expect(call[0]).toBe('/dsh-code-ide/api/workspace-mutations/v1')
      expect(call[1].signal).toBe(signal)
    }
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({
      op: 'mutate', providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, workspaceId: 'workspace-1',
      mutation: { kind: 'createFile', path: 'src/new.ts' },
    })
    expect(JSON.parse(fetch.mock.calls[2]![1].body as string)).toEqual({
      op: 'status', providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID,
    })
  })

  it('rejects malformed 200 responses and invalid outbound paths before transport', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, state: 'committed',
        result: { kind: 'file', path: 'different.ts', version: 'v1', refreshDirectories: [''] },
      }),
    })
    vi.stubGlobal('fetch', fetch)
    await expect(mutationApi.mutate({
      providerEpoch: PROVIDER_EPOCH, operationId: OPERATION_ID, workspaceId: 'workspace-1',
      mutation: { kind: 'createFile', path: 'new.ts' },
    })).rejects.toMatchObject<ApiError>({ code: 'INVALID_RESPONSE', status: 502 })
    await expect(mutationApi.mutate({
      providerEpoch: PROVIDER_EPOCH,
      operationId: '33333333-3333-4333-8333-333333333333',
      workspaceId: 'workspace-1',
      mutation: { kind: 'createFile', path: '../outside' },
    })).rejects.toMatchObject<ApiError>({ code: 'INVALID_MUTATION_REQUEST', status: 400 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
