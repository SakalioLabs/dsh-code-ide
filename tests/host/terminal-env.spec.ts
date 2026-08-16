import { describe, expect, it } from 'vitest'
import { sanitizeTerminalEnv } from '../../src/host/terminal.js'

describe('terminal environment sanitization', () => {
  it('drops credentials and Harness internals while retaining ordinary shell state', () => {
    const env = sanitizeTerminalEnv({
      PATH: '/bin',
      HOME: '/home/user',
      DEEPSEEK_API_KEY: 'secret',
      npm_token: 'secret',
      DSH_SESSION_ID: 'internal',
      dsh_private: 'internal',
    })
    expect(env.PATH).toBe('/bin')
    expect(env.HOME).toBe('/home/user')
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.npm_token).toBeUndefined()
    expect(env.DSH_SESSION_ID).toBeUndefined()
    expect(env.dsh_private).toBeUndefined()
    expect(env.TERM).toBe('xterm-256color')
  })
})
