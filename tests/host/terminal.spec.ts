import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { TerminalHost } from '../../src/host/terminal.js'

function request(): IncomingMessage {
  return {
    method: 'GET',
    url: '/dsh-code-ide/terminal?workspaceId=workspace-fixture',
    headers: {},
  } as IncomingMessage
}

function captureSocket(): { socket: PassThrough; response(): string; finished(): Promise<void> } {
  const socket = new PassThrough()
  const chunks: Buffer[] = []
  socket.on('data', chunk => { chunks.push(Buffer.from(chunk as Buffer)) })
  return {
    socket,
    response: () => Buffer.concat(chunks).toString('utf8'),
    finished: async () => {
      if (socket.writableFinished) return
      await new Promise<void>(resolve => { socket.once('finish', resolve) })
    },
  }
}

describe('TerminalHost capacity', () => {
  it('reserves maxSessions capacity across concurrent workspace handshakes', async () => {
    const entered = Promise.withResolvers<void>()
    const rootLookup = Promise.withResolvers<never>()
    const host = new TerminalHost({
      list: () => [{ id: 'workspace-fixture', path: '/workspace', title: 'Fixture' }],
    }, {
      shell: 'unused',
      shellArgs: [],
      maxMessageBytes: 1024,
      maxInputBytes: 1024,
      maxBufferedBytes: 1024,
      maxSessions: 1,
      logger: { warn() {}, error() {}, info() {}, debug() {} },
    }, {
      resolveWorkspaceRoot: async () => {
        entered.resolve()
        return await rootLookup.promise
      },
    })

    const firstSocket = captureSocket()
    const first = host.upgrade(request(), firstSocket.socket, Buffer.alloc(0))
    await entered.promise

    const secondSocket = captureSocket()
    await host.upgrade(request(), secondSocket.socket, Buffer.alloc(0))
    await secondSocket.finished()
    expect(secondSocket.response()).toContain('HTTP/1.1 429')

    rootLookup.reject(new Error('release the pending reservation'))
    await first
    await firstSocket.finished()
    expect(firstSocket.response()).toContain('HTTP/1.1 409')

    const afterReleaseSocket = captureSocket()
    await host.upgrade(request(), afterReleaseSocket.socket, Buffer.alloc(0))
    await afterReleaseSocket.finished()
    expect(afterReleaseSocket.response()).toContain('HTTP/1.1 409')
    expect(afterReleaseSocket.response()).not.toContain('HTTP/1.1 429')
  })
})
