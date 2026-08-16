import { describe, it, vi } from 'vitest'

vi.mock('ffi-rs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ffi-rs')>()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      console.error('ffi.open', args[0])
      return actual.open(...args)
    },
    load: (...args: Parameters<typeof actual.load>) => {
      const call = args[0] as { funcName?: string }
      try {
        const result = actual.load(...args)
        console.error('ffi.load', call.funcName, typeof result === 'object' ? '<object>' : result)
        return result
      } catch (error) {
        console.error('ffi.load error', call.funcName, error)
        throw error
      }
    },
  }
})

describe('diagnostic', () => {
  it('traces native backend creation', async () => {
    const { createWindowsMutationBackend } = await import('../../src/host/mutation-backend-windows.js')
    const backend = await createWindowsMutationBackend()
    console.error('descriptor', backend.descriptor)
    await backend.dispose()
  })
})
