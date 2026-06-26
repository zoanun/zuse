import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { attachWsServer } from './ws/wsServer.js'
import { SessionService } from './session/SessionService.js'
import { MemoryService } from './memory/MemoryService.js'
import { PersonaService } from './persona/PersonaService.js'
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

  // Multi-session service over the web-sessions store dir. Construction never
  // throws (no session is built here). Seed a DEFAULT session at boot so /ws
  // keeps working for clients that connect without a `?session=` query — the
  // existing single-session behaviour. Seeding can throw (real client build);
  // on failure we record sessionErr → /ws returns an error frame, while
  // health/setup/login stay up.
  const service = new SessionService({ dir: join(cfg.authDir, 'web-sessions'), cwd: cfg.cwd })
  let sessionErr: string | undefined
  try {
    // Reuse a disk-persisted default if present; otherwise seed one. Tests inject
    // deps.session (a fake-client manager) — adopt it as the default.
    const existing = await service.getOrLoad(DEFAULT_SESSION_ID)
    if (!existing) {
      const mgr = deps.session ?? createSession({ sessionId: DEFAULT_SESSION_ID, cwd: cfg.cwd })
      await service.adopt(DEFAULT_SESSION_ID, mgr)
    }
  } catch (err) {
    sessionErr = err instanceof Error ? err.message : String(err)
    console.warn(`[zuse-server] session 构建失败:${sessionErr}(/ws 将回 error,health/login 仍可用)`)
  }

  // Memory CRUD service (M1). Construction is lazy (the db opens on first use,
  // defaulting to ~/.zuse/memory.db — shared with the agent's consolidation), so
  // it does not throw here. Wrapped defensively all the same: a memory failure
  // must never crash the daemon (chat stays up), mirroring the sessionErr path.
  let memory: MemoryService
  try {
    memory = new MemoryService()
  } catch (err) {
    const memErr = err instanceof Error ? err.message : String(err)
    console.warn(`[zuse-server] memory service 构建失败:${memErr}(记忆面板将不可用,聊天仍可用)`)
    // Still hand a service to the handler; its lazy open will retry/fail per request
    // (the route swallows the error) rather than taking the whole daemon down.
    memory = new MemoryService()
  }

  const persona = new PersonaService()

  const httpServer = createServer(makeRequestHandler({ auth, service, memory, persona, devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir ?? defaultWebDir() }))
  const ws = attachWsServer(httpServer, { auth, service, sessionErr })
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
