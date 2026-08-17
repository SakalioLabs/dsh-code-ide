import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/host/plugin.js'

describe('Host plugin configuration', () => {
  it('derives a valid request cap at the maximum 64 MiB file limit', () => {
    const maxFileBytes = 64 * 1024 * 1024
    const config = resolveConfig({ maxFileBytes })
    expect(config.maxFileBytes).toBe(maxFileBytes)
    expect(config.maxRequestBytes).toBe(maxFileBytes * 6 + 64 * 1024)
  })

  it('publishes an independent bounded media streaming cap', () => {
    expect(resolveConfig({}).maxMediaBytes).toBe(512 * 1024 * 1024)
    expect(resolveConfig({ maxMediaBytes: 8 * 1024 * 1024 * 1024 }).maxMediaBytes)
      .toBe(8 * 1024 * 1024 * 1024)
    expect(() => resolveConfig({ maxMediaBytes: 0 })).toThrow('maxMediaBytes')
    expect(() => resolveConfig({ maxMediaBytes: 8 * 1024 * 1024 * 1024 + 1 })).toThrow('maxMediaBytes')
  })

  it('publishes bounded workspace-search defaults and validates their caps', () => {
    const config = resolveConfig({})
    expect(config).toMatchObject({
      maxSearchFileResults: 200,
      maxSearchTextResults: 500,
      maxSearchCandidates: 50_000,
      maxSearchRawBytes: 8 * 1024 * 1024,
      maxSearchPreviewBytes: 2 * 1024,
      maxSearchQueryBytes: 8 * 1024,
      maxSearchLineBytes: 1024 * 1024,
      maxSearchResponseBytes: 2 * 1024 * 1024,
      maxConcurrentSearches: 2,
      searchTimeoutMs: 30_000,
      searchTerminationGraceMs: 1_000,
    })
    expect(() => resolveConfig({ maxConcurrentSearches: 0 })).toThrow('maxConcurrentSearches')
    expect(() => resolveConfig({ maxSearchRawBytes: 64 * 1024 * 1024 + 1 })).toThrow('maxSearchRawBytes')
  })

  it('uses an independent bounded mutation request cap', () => {
    expect(resolveConfig({}).maxMutationRequestBytes).toBe(64 * 1024)
    expect(resolveConfig({}).maxMutationOperationIds).toBe(65_536)
    expect(resolveConfig({ maxMutationRequestBytes: 256 * 1024 }).maxMutationRequestBytes).toBe(256 * 1024)
    expect(() => resolveConfig({ maxMutationRequestBytes: 256 * 1024 + 1 })).toThrow('maxMutationRequestBytes')
    expect(() => resolveConfig({ maxMutationOperationIds: 262_145 })).toThrow('maxMutationOperationIds')
  })
})
