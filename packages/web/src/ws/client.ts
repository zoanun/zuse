import type { ClientMessage, ServerMessage } from '@zuse/protocol'
import type { Connection } from '../state/types.js'

export interface WsClientOptions {
  url: string
  onMessage: (m: ServerMessage) => void
  onStatus: (s: Connection) => void
  /** Injectable for tests; defaults to the global WebSocket. */
  makeSocket?: (url: string) => WebSocket
  /** Auto-reconnect with backoff on close (default true). */
  reconnect?: boolean
}

export interface WsClient {
  connect(): void
  send(msg: ClientMessage): void
  close(): void
}

export function createWsClient(opts: WsClientOptions): WsClient {
  const make = opts.makeSocket ?? ((u: string) => new WebSocket(u))
  const reconnect = opts.reconnect !== false
  let ws: WebSocket | null = null
  let closed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function connect(): void {
    closed = false
    opts.onStatus('connecting')
    ws = make(opts.url)
    ws.onopen = () => { attempts = 0; opts.onStatus('live') }
    ws.onmessage = (e: MessageEvent) => {
      let msg: ServerMessage
      try { msg = JSON.parse(String((e as { data: unknown }).data)) as ServerMessage } catch { return }
      opts.onMessage(msg)
    }
    ws.onclose = () => {
      opts.onStatus('down')
      ws = null
      if (reconnect && !closed) {
        attempts++
        const delay = Math.min(1000 * attempts, 5000)
        timer = setTimeout(connect, delay)
      }
    }
    ws.onerror = () => { /* close will follow */ }
  }

  return {
    connect,
    send(msg: ClientMessage) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)) },
    close() { closed = true; if (timer) clearTimeout(timer); if (ws) ws.close() },
  }
}
