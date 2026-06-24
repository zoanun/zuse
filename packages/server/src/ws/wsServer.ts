import type * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { AuthProvider } from '../auth/authProvider.js'
import { parseCookies } from '../http/cookies.js'
import { SESSION_COOKIE } from '../config.js'

export function attachWsServer(httpServer: http.Server, deps: { auth: AuthProvider }): { closeAll(): void } {
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
      // Echo stub; F3 replaces with SessionManager wiring.
      ws.on('message', (data) => ws.send(`echo: ${data.toString()}`))
    })
  })

  return {
    closeAll() {
      for (const client of wss.clients) client.terminate()
    },
  }
}
