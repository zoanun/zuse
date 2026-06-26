import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@zuse/protocol'
import { createWsClient } from './client.js'

// Minimal fake WebSocket capturing sends and exposing event triggers.
class FakeWS {
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {}
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3; this.onclose?.() }
}

describe('createWsClient', () => {
  it('parses incoming frames and forwards to onMessage', () => {
    const got: ServerMessage[] = []
    let ws!: FakeWS
    const client = createWsClient({
      url: 'ws://x/ws',
      onMessage: (m) => got.push(m),
      onStatus: () => {},
      makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket },
    })
    client.connect()
    ws.onopen!()
    ws.onmessage!({ data: JSON.stringify({ type: 'snapshot', snapshot: { sessionId: 'd', isThinking: false, model: 'm', cwd: '/', totalUsage: undefined, contextTokens: 1, contextWindow: 2, todos: [], pendingPermissions: [], messageCount: 0, messages: [], checkpoints: [] } }) })
    expect(got).toHaveLength(1)
    expect(got[0]!.type).toBe('snapshot')
  })

  it('ignores malformed frames without throwing', () => {
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => { throw new Error('should not be called') }, onStatus: () => {}, makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket } })
    client.connect(); ws.onopen!()
    expect(() => ws.onmessage!({ data: 'not json' })).not.toThrow()
  })

  it('send() encodes a ClientMessage as JSON', () => {
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => {}, onStatus: () => {}, makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket } })
    client.connect(); ws.onopen!()
    client.send({ type: 'send', text: 'hi' })
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'send', text: 'hi' })
  })

  it('reports status on open/close', () => {
    const statuses: string[] = []
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => {}, onStatus: (s) => statuses.push(s), makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket }, reconnect: false })
    client.connect()
    expect(statuses).toContain('connecting')
    ws.onopen!(); expect(statuses).toContain('live')
    ws.close(); expect(statuses).toContain('down')
  })

  it('connect() while already connected tears down the prior socket', () => {
    const sockets: FakeWS[] = []
    const client = createWsClient({
      url: 'ws://x/ws',
      onMessage: () => {},
      onStatus: () => {},
      makeSocket: (u) => { const s = new FakeWS(u); sockets.push(s); return s as unknown as WebSocket },
    })
    client.connect(); sockets[0]!.onopen!()
    client.connect()
    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.readyState).toBe(3) // old socket was closed
  })

  it('reconnect(url) tears down the old socket and opens the new url', () => {
    const sockets: FakeWS[] = []
    const client = createWsClient({
      url: 'ws://x/ws?session=a',
      onMessage: () => {},
      onStatus: () => {},
      makeSocket: (u) => { const s = new FakeWS(u); sockets.push(s); return s as unknown as WebSocket },
    })
    client.connect(); sockets[0]!.onopen!()
    client.reconnect('ws://x/ws?session=b')
    expect(sockets).toHaveLength(2)
    expect(sockets[0]!.readyState).toBe(3) // old socket closed
    expect(sockets[1]!.url).toBe('ws://x/ws?session=b')
  })

  it('send() before the socket is open is a no-op', () => {
    let ws!: FakeWS
    const client = createWsClient({ url: 'ws://x/ws', onMessage: () => {}, onStatus: () => {}, makeSocket: (u) => { ws = new FakeWS(u); return ws as unknown as WebSocket } })
    client.connect()
    ws.readyState = 0 // CONNECTING
    client.send({ type: 'send', text: 'hi' })
    expect(ws.sent).toHaveLength(0)
  })
})
