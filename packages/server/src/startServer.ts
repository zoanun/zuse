import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { attachWsServer } from './ws/wsServer.js'
import { SessionService } from './session/SessionService.js'
import { MemoryService } from './memory/MemoryService.js'
import { SearchService } from './search/SearchService.js'
import { PersonaService } from './persona/PersonaService.js'
import { SkillService } from './skill/SkillService.js'
import { UsageService } from './usage/UsageService.js'
import { FileService } from './file/FileService.js'
import { McpService } from './mcp/McpService.js'
import { UploadService } from './upload/UploadService.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID, type ServerConfig } from './config.js'
import type { SessionManager } from './session/SessionManager.js'
import {
  loadSettings, resolveModelSelection, resolveContextWindow, McpManager, type ToolRegistry,
} from '@zuse/core'
import { LspManager, createLspTool, createLspInstallTool } from '@zuse/tools'

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

  // MCP servers (B4/M4): the daemon owns ONE McpManager (spawning per session would be wasteful).
  // Its tools register into every session's registry via registerExtraTools — which always reads
  // the CURRENT `mcp`, so a live reconnect (M4) is picked up by newly-created sessions without a
  // server restart. ctxWindow is fixed (model selection); reconnect re-reads settings.mcpServers.
  let mcp: McpManager | undefined
  let mcpFailed: Array<{ name: string; error: string }> = []
  const sel = resolveModelSelection(loadSettings())
  const ctxWindow = resolveContextWindow(loadSettings(), sel.providerId, sel.model)
  // Lsp/LspInstall (B3): the daemon owns ONE LspManager (a language-server process pool, like the
  // single McpManager) — spawning per session would be wasteful. `new LspManager()` is cheap: it
  // spawns nothing until the Lsp tool's first use. Disposed on shutdown (see close()).
  const lsp = new LspManager()
  // Always set: no-ops until `mcp` is connected, so a reconnect that establishes it later still
  // feeds tools into subsequent sessions. Best-effort — a bad registration never breaks a session.
  const registerExtraTools = (registry: ToolRegistry): void => {
    mcp?.registerTools(registry, ctxWindow)
    registry.register(createLspTool(lsp))
    registry.register(createLspInstallTool())
  }

  // Tear down + reconnect from current settings. Used at startup and by POST /api/mcp/reconnect.
  // Already-built sessions keep their tool set (registry is fixed at creation); new chats pick up
  // the change. Absent/failed config never crashes the daemon.
  const reconnectMcp = async (): Promise<void> => {
    if (mcp) { await mcp.disconnectAll().catch(() => {}); mcp = undefined }
    mcpFailed = []
    const servers = loadSettings().mcpServers
    if (!servers || Object.keys(servers).length === 0) return
    const m = new McpManager()
    try {
      const { connected, failed } = await m.connectAll(servers)
      mcpFailed = failed
      for (const f of failed) console.warn(`[zuse-server] MCP "${f.name}" 连接失败:${f.error}`)
      if (connected.length > 0) {
        mcp = m
        console.warn(`[zuse-server] MCP 已连接:${connected.join(', ')}`)
      } else {
        await m.disconnectAll().catch(() => {})
      }
    } catch (err) {
      console.warn(`[zuse-server] MCP 连接异常:${err instanceof Error ? err.message : String(err)}`)
      await m.disconnectAll().catch(() => {})
    }
  }
  await reconnectMcp()

  // Reconnect a SINGLE server (per-row ↻ in the panel). Removed-from-settings → just disconnect.
  const reconnectOneMcp = async (name: string): Promise<void> => {
    const config = loadSettings().mcpServers?.[name]
    mcpFailed = mcpFailed.filter((f) => f.name !== name)
    if (!config) { await mcp?.disconnectServer(name).catch(() => {}); return }
    if (!mcp) mcp = new McpManager()
    try {
      await mcp.connectServer(name, config)
      console.warn(`[zuse-server] MCP "${name}" 已重连`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      mcpFailed.push({ name, error: msg })
      console.warn(`[zuse-server] MCP "${name}" 重连失败:${msg}`)
    }
  }

  // Multi-session service over the web-sessions store dir. Construction never
  // throws (no session is built here). Seed a DEFAULT session at boot so /ws
  // keeps working for clients that connect without a `?session=` query — the
  // existing single-session behaviour. Seeding can throw (real client build);
  // on failure we record sessionErr → /ws returns an error frame, while
  // health/setup/login stay up.
  const sessionsDir = join(cfg.authDir, 'web-sessions')
  const service = new SessionService({ dir: sessionsDir, cwd: cfg.cwd, registerExtraTools })
  let sessionErr: string | undefined
  try {
    // Reuse a disk-persisted default if present; otherwise seed one. Tests inject
    // deps.session (a fake-client manager) — adopt it as the default.
    const existing = await service.getOrLoad(DEFAULT_SESSION_ID)
    if (!existing) {
      const mgr = deps.session ?? createSession({ sessionId: DEFAULT_SESSION_ID, cwd: cfg.cwd, registerExtraTools })
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
  // Token usage dashboard (M5): aggregates the same web-sessions store the SessionService writes.
  const usage = new UsageService(sessionsDir)
  // 跨会话历史搜索 (S4): 扫同一个 web-sessions 存储目录。
  const search = new SearchService({ dir: sessionsDir })
  // Read-only project file browser (M7), rooted at the daemon's cwd.
  const file = new FileService(cfg.cwd)
  // User image uploads (I2): stored under the auth dir (alongside web-sessions), not the project.
  const upload = new UploadService(join(cfg.authDir, 'uploads'))
  // Skill management (M3): scans ~/.zuse/skills + project .zuse/skills under the daemon's cwd.
  const skill = new SkillService({ cwd: cfg.cwd })
  // MCP management view (M4): merges configured servers with live status/tools; reconnect lets the
  // panel apply config changes without a server restart. Getters read the current manager state.
  const mcpService = new McpService({
    connectedServers: () => mcp?.servers ?? [],
    failed: () => mcpFailed,
    reconnect: reconnectMcp,
    reconnectServer: reconnectOneMcp,
  })

  const httpServer = createServer(makeRequestHandler({ auth, service, memory, search, persona, skill, usage, file, mcp: mcpService, upload, devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir ?? defaultWebDir() }))
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
      void mcp?.disconnectAll().catch(() => {})
      void lsp.dispose().catch(() => {})
      httpServer.close(() => resolve())
      ws.closeAll()
      httpServer.closeAllConnections()
    }),
  }
}
