import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, isTrustedLocalRequest } from '../../src/host/trust.js'

describe('local IDE request trust', () => {
  it('accepts same-origin loopback authorities', () => {
    expect(isTrustedLocalRequest({
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      },
    })).toBe(true)
  })

  it('rejects LAN, rebinding, and cross-site requests', () => {
    expect(isTrustedLocalRequest({ headers: { host: '192.168.1.20:3080' } })).toBe(false)
    expect(isTrustedLocalRequest({ headers: { host: 'attacker.example:3080' } })).toBe(false)
    expect(isTrustedLocalRequest({
      headers: { host: 'localhost:3080', origin: 'https://attacker.example' },
    })).toBe(false)
    expect(isTrustedLocalRequest({
      headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' },
    })).toBe(false)
  })

  it('recognizes only loopback hostnames', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.20.30.40')).toBe(true)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
  })
})
