import type * as http from 'node:http'
import type * as https from 'node:https'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthProvider } from '../auth/authProvider.js'
import type { SessionService } from '../session/SessionService.js'
import type { SessionManager } from '../session/SessionManager.js'
import type { ServerMessage } from '@zuse/protocol'
import { parseCookies } from '../http/cookies.js'
import { SESSION_COOKIE, DEFAULT_SESSION_ID } from '../config.js'
import { applyClientMessage } from './clientMessage.js'
import { guardRequest, type HostPolicy } from '../http/originGuard.js'

export interface WsServerDeps {
  auth: AuthProvider
  service: SessionService
  /** Set when session-service construction failed at startup; connections get an error frame. */
  sessionErr?: string
  /** Host / Origin 白名单。可选（不传则不挂闸）；理由同 `RequestHandlerDeps.hostPolicy`。 */
  hostPolicy?: HostPolicy
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

export function attachWsServer(httpServer: http.Server | https.Server, deps: WsServerDeps): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Only handle /ws; leave other paths for any other upgrade handlers.
    if (url.pathname !== '/ws') return

    // **upgrade 事件不经过 HTTP 的 `handle()`**（那是 requestListener），
    // 所以 Host/Origin 闸必须在这里重复一遍 —— 漏了的话 rebinding 页面照样能开 WS，
    // 而 WS 那头是整个会话流（发消息、跑工具）。放在 cookie 校验**之前**：
    // 先判「你是谁家的页面」，再判「你有没有票」。
    //
    // 这里 `checkOrigin` 恒为 true，但**不要求 Origin 必须存在**：浏览器在 WS 握手时
    // 总是发 Origin，所以「缺 Origin」只可能来自非浏览器客户端 —— 而非浏览器伪造
    // Origin 是零成本的，强制要求它存在换不到任何安全性，只会打死脚本客户端和现有测试。
    // 挡 rebinding 的是同一次调用里的 Host 闸。
    if (deps.hostPolicy) {
      const rejected = guardRequest(req, deps.hostPolicy, { checkOrigin: true })
      if (rejected) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n' +
            rejected.message,
        )
        socket.destroy()
        return
      }
    }

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
          sendJson(ws, { type: 'error', code: 'session_not_found', message: `session unavailable: ${deps.sessionErr}` })
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
          sendJson(ws, { type: 'error', code: 'session_not_found', message: `session unavailable: no session "${sessionId}"` })
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
    // For a revert, push the authoritative (truncated) snapshot FIRST, then the `reverted`
    // event. The reducer appends a "reverted to checkpoint" notice when it sees the event;
    // applySnapshot replaces messages wholesale, so the old snapshot-AFTER-event order wiped
    // that notice every time. Snapshot-then-event lands the notice on top of the fresh state.
    if (e.type === 'reverted') sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })
    sendJson(ws, { type: 'event', event: e })
  })
  sendJson(ws, { type: 'snapshot', snapshot: mgr.getState() })

  ws.on('message', (data, isBinary) => {
    if (isBinary) return // binary frames reserved for V1 (audio)
    applyClientMessage(mgr, data.toString(), (message) => sendJson(ws, { type: 'error', message }))
  })
  ws.on('close', unsub)
}
