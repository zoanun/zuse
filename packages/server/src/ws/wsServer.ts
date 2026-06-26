import type * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionService } from '../session/SessionService.js'
import type { SessionManager } from '../session/SessionManager.js'
import type { ServerMessage } from '@zuse/protocol'
import { parseCookies } from '../http/cookies.js'
import { SESSION_COOKIE, DEFAULT_SESSION_ID } from '../config.js'
import { applyClientMessage } from './clientMessage.js'

export interface WsServerDeps {
  auth: AuthProvider
  service: SessionService
  /** Set when session-service construction failed at startup; connections get an error frame. */
  sessionErr?: string
}

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  // Guard the send: a throwing/failed send on one connection must not break the
  // manager's emit loop (which fans out to every subscriber) or other connections.
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  } catch {
    // Dropped/failing socket — ignore; the manager and peers carry on.
  }
}

export function attachWsServer(httpServer: http.Server, deps: WsServerDeps): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Only handle /ws; leave other paths for any other upgrade handlers.
    if (url.pathname !== '/ws') return

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!deps.auth.verifyToken(token ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Resolve the target session id from `?session=<id>` (T6's query-parsing,
    // folded into T4). Absent → DEFAULT_SESSION_ID, which startServer seeds at
    // boot, so the existing single-session clients keep working unchanged.
    const sessionId = url.searchParams.get('session') ?? DEFAULT_SESSION_ID

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)

      // getOrLoad is async (it may hit disk); resolve it before wiring the socket.
      void (async () => {
        if (deps.sessionErr) {
          sendJson(ws, { type: 'error', message: `session unavailable: ${deps.sessionErr}` })
          return
        }
        let mgr: SessionManager | null
        try {
          mgr = await deps.service.getOrLoad(sessionId)
        } catch {
          // safeId throws synchronously on a malformed/traversal id. Without this
          // catch the rejection is unhandled and the socket hangs forever; instead
          // send an error frame (and do not wireSocket).
          sendJson(ws, { type: 'error', message: 'invalid session id' })
          return
        }
        if (!mgr) {
          sendJson(ws, { type: 'error', message: `session unavailable: no session "${sessionId}"` })
          return
        }
        wireSocket(ws, mgr)
      })()
    })
  })

  return {
    closeAll() {
      // terminate() does not synchronously fire 'close', so per-connection unsub
      // may not run here — fine because the whole session registry is torn down
      // with the process. Revisit if a SessionManager ever outlives a restart.
      for (const client of wss.clients) client.terminate()
    },
  }
}

/** Wire a resolved manager to a connected socket: subscribe, snapshot, uplink. */
function wireSocket(ws: WebSocket, mgr: SessionManager): void {
  // Live events → event frames, then a one-shot snapshot of current state.
  // NOTE: subscribe-then-snapshot can interleave a live delta ahead of the
  // snapshot if a turn is already in flight at connect. Acceptable for F3
  // (single in-memory session, no turn running at connect in practice);
  // revisit when multi-client mid-turn join becomes real (S1/S2).
  const unsub = mgr.subscribe((e) => {
    // Forward the event, then — for a revert — re-push a fresh snapshot so this
    // connection re-syncs to the truncated conversation/checkpoints. Snapshot-after-
    // event is fine: the reducer treats `reverted` as just a notice, and the snapshot
    // carries the authoritative post-revert state.
    sendJson(ws, { type: 'event', event: e })
    if (e.type === 'reverted') sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })
  })
  sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })

  ws.on('message', (data, isBinary) => {
    if (isBinary) return // binary frames reserved for V1 (audio)
    applyClientMessage(mgr, data.toString(), (message) => sendJson(ws, { type: 'error', message }))
  })
  ws.on('close', unsub)
}
