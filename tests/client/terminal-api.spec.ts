import { describe, expect, it } from 'vitest'
import { decodeTerminalServerMessage } from '../../src/client/api.ts'

describe('decodeTerminalServerMessage', () => {
  it('accepts only the version-one terminal server frames', () => {
    expect(decodeTerminalServerMessage({ type: 'output', data: 'hello' })).toEqual({ type: 'output', data: 'hello' })
    expect(decodeTerminalServerMessage({ type: 'error', message: 'failed' })).toEqual({ type: 'error', message: 'failed' })
    expect(decodeTerminalServerMessage({ type: 'exit', code: 7, signal: 'SIGTERM' })).toEqual({
      type: 'exit', code: 7, signal: 'SIGTERM',
    })
    expect(decodeTerminalServerMessage({ type: 'exit' })).toEqual({ type: 'exit' })
  })

  it('rejects malformed and misleading frames instead of trusting a TypeScript cast', () => {
    expect(decodeTerminalServerMessage(null)).toBeUndefined()
    expect(decodeTerminalServerMessage([])).toBeUndefined()
    expect(decodeTerminalServerMessage({ type: 'output', data: 4 })).toBeUndefined()
    expect(decodeTerminalServerMessage({ type: 'exit', code: 1.5 })).toBeUndefined()
    expect(decodeTerminalServerMessage({ type: 'exit', signal: 9 })).toBeUndefined()
    expect(decodeTerminalServerMessage({ type: 'unknown', data: 'hello' })).toBeUndefined()
  })
})
