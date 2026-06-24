import type * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionRegistry } from '../session/SessionRegistry.js'
import type { ServerMessage } from '@zuse/protocol'
import { parseCookies } from '../http/cookies.js'
import { SESSION_COOKIE, DEFAULT_SESSION_ID } from '../config.js'

export interface WsServerDeps {
  auth: AuthProvider
  registry: SessionRegistry
  /** Set when session construction failed at startup; connections get an error frame. */
  sessionErr?: string
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

export function attachWsServer(httpServer: http.Server, deps: WsServerDeps): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    // Only handle /ws; leave other paths for any other upgrade handlers.
    if (pathname !== '/ws') return

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!deps.auth.verifyToken(token ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)

      const mgr = deps.registry.get(DEFAULT_SESSION_ID)
      if (deps.sessionErr || !mgr) {
        sendJson(ws, { type: 'error', message: `session unavailable: ${deps.sessionErr ?? 'no session'}` })
        return
      }

      // Live events → event frames. Snapshot first so a late joiner has current state.
      const unsub = mgr.subscribe((e) => sendJson(ws, { type: 'event', event: e }))
      sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })

      ws.on('message', (_data, _isBinary) => {
        // Uplink dispatch wired in Task 5. Binary frames are reserved for V1 (audio).
      })
      ws.on('close', unsub)
    })
  })

  return {
    closeAll() {
      for (const client of wss.clients) client.terminate()
    },
  }
}
