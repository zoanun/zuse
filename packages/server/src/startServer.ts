import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { attachWsServer } from './ws/wsServer.js'
import { SessionRegistry } from './session/SessionRegistry.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID, type ServerConfig } from './config.js'
import type { SessionManager } from './session/SessionManager.js'

export interface StartServerDeps {
  /** 注入用:测试传一个 fake-client session,跳过真件构建。 */
  session?: SessionManager
}

function defaultWebDir(): string {
  // packages/server/src/startServer.ts → ../../web/dist = packages/web/dist
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
}

export async function startServer(
  cfg: ServerConfig,
  deps: StartServerDeps = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const auth = new LocalPasswordAuth(new PasswordStore(cfg.authDir), cfg.tokenTtlSec)

  // 饱和构建一次单会话(内存态)。构建失败不崩 daemon:记日志、置 sessionErr,
  // /ws 连上回 error 帧,health/setup/login 仍可用。
  const registry = new SessionRegistry()
  let sessionErr: string | undefined
  try {
    registry.set(DEFAULT_SESSION_ID, deps.session ?? createSession(cfg.cwd))
  } catch (err) {
    sessionErr = err instanceof Error ? err.message : String(err)
    console.warn(`[zuse-server] session 构建失败:${sessionErr}(/ws 将回 error,health/login 仍可用)`)
  }

  const httpServer = createServer(makeRequestHandler({ auth, devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir ?? defaultWebDir() }))
  const ws = attachWsServer(httpServer, { auth, registry, sessionErr })
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, () => resolve()))
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn(`[zuse-server] bound to ${cfg.host}:${port} — plaintext HTTP on a network interface. Use a TLS tunnel (A2) for remote access.`)
  }
  return {
    url: `http://${cfg.host}:${port}`,
    close: () => new Promise<void>((resolve) => {
      httpServer.close(() => resolve())
      ws.closeAll()
      httpServer.closeAllConnections()
    }),
  }
}
