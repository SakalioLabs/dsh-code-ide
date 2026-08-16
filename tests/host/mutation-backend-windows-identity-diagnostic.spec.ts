import { lstatSync } from 'node:fs'
import { describe, it, vi } from 'vitest'

vi.mock('ffi-rs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ffi-rs')>()
  let rootPath: string | undefined
  return {
    ...actual,
    load: (...args: Parameters<typeof actual.load>) => {
      const call = args[0] as { funcName?: string, paramsValue?: unknown[] }
      if (call.funcName === 'CreateFileW') rootPath = call.paramsValue?.[0] as string
      const result = actual.load(...args)
      if (call.funcName === 'GetFileInformationByHandle' && result !== 0 && rootPath) {
        const pointer = call.paramsValue?.[1] as Parameters<typeof actual.createExternalBuffer>[0]
        const buffer = actual.createExternalBuffer(pointer, 52)
        const volume = BigInt(buffer.readUInt32LE(28))
        const index = (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48))
        const stat = lstatSync(rootPath, { bigint: true })
        console.error('identity', { native: { volume, index }, node: { dev: stat.dev, ino: stat.ino } })
      }
      return result
    },
  }
})

describe('identity diagnostic', () => {
  it('traces Node and native identities', async () => {
    const { createWindowsMutationBackend } = await import('../../src/host/mutation-backend-windows.js')
    const backend = await createWindowsMutationBackend()
    console.error('descriptor', backend.descriptor)
    await backend.dispose()
  })
})
