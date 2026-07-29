import { createAppServer } from './http/appServer.js'
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
import { CronScheduler } from './cron/CronScheduler.js'
import { CronService } from './cron/CronService.js'
import { cronDir, loadTasks } from './cron/cronStore.js'
import { VoiceService } from './voice/VoiceService.js'
import { createSession } from './session/createSession.js'
import { DEFAULT_SESSION_ID, type ServerConfig } from './config.js'
import type { SessionManager } from './session/SessionManager.js'
import {
  loadSettings, resolveModelSelection, resolveContextWindow, resolveImageModelSelection,
  getProviderConfig, createModelClient, setModelInSettings, McpManager, type ToolRegistry, type ModelClient,
} from '@zuse/core'
import { makeExpandAttachments } from './upload/imageExpand.js'
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
  // User image uploads (I2): stored under the auth dir (alongside web-sessions), not the project.
  // Built before SessionService so its readBase64 can back the per-session image hooks below.
  const upload = new UploadService(join(cfg.authDir, 'uploads'))

  // Auxiliary vision model for the PARSED fallback (I2): when the main model can't see images, each
  // upload is described by this client and the text is baked into the prompt. Soft-degrade like the
  // small/title model — any failure (missing config, bad key) disables the fallback, never crashes.
  let imageClient: ModelClient | undefined
  let imageModel: string | undefined
  const settings = loadSettings()
  const imageSel = resolveImageModelSelection(settings)
  if (imageSel) {
    try {
      imageClient = createModelClient(getProviderConfig(settings, imageSel.providerId), imageSel.model)
      imageModel = imageSel.model
    } catch (err) {
      console.warn(`[zuse-server] imageModel 不可用，图片解析兜底将禁用：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // DIRECT route (vision main model): expand route:'direct' attachments to base64 image blocks at
  // send time. PARSED fallback reads bytes via readImageBase64. Both are backed by the UploadService.
  const expandAttachments = makeExpandAttachments(upload)
  const readImageBase64 = (id: string): Promise<{ data: string; mediaType: string }> => upload.readBase64(id)

  const sessionsDir = join(cfg.authDir, 'web-sessions')
  const service = new SessionService({
    dir: sessionsDir, cwd: cfg.cwd, registerExtraTools,
    imageClient, imageModel, readImageBase64, expandAttachments,
  })
  let sessionErr: string | undefined
  try {
    // Reuse a disk-persisted default if present; otherwise seed one. Tests inject
    // deps.session (a fake-client manager) — adopt it as the default.
    const existing = await service.getOrLoad(DEFAULT_SESSION_ID)
    if (!existing) {
      const mgr = deps.session ?? createSession({
        sessionId: DEFAULT_SESSION_ID, cwd: cfg.cwd, registerExtraTools,
        imageClient, imageModel, readImageBase64, expandAttachments,
      })
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

  // Cron 定时任务 (C1/C2)：调度器与 WS 平级驱动 SessionService；数据在 ~/.zuse/cron/。
  const cronDataDir = cronDir(cfg.authDir)
  const cronScheduler = new CronScheduler({ dir: cronDataDir, sessions: service })
  try { cronScheduler.setTasks(await loadTasks(cronDataDir)) } // 启动即调度已启用任务；漏触发不补(croner 从现在排)
  catch (err) { console.warn(`[zuse-server] cron 调度启动失败:${err instanceof Error ? err.message : String(err)}`) }
  const cronService = new CronService({ dir: cronDataDir, scheduler: cronScheduler, defaultCwd: cfg.cwd, sessions: service })

  // 语音 (V1/V2)：无状态,能力由 settings 的 sttModel/ttsModel 现读决定（未配置 → 前端隐藏按钮）。
  const voice = new VoiceService()

  const handler = makeRequestHandler({ auth, service, memory, search, persona, skill, usage, file, mcp: mcpService, cron: cronService, upload, voice, persistModel: (spec) => setModelInSettings(spec), devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir ?? defaultWebDir(), trustProxy: cfg.trustProxy ?? false })
  // A2:配了证书对就起 https(WS 随之变 wss —— 同一个 server 的 upgrade 事件)。
  const { server: httpServer, scheme } = createAppServer(handler, { cert: cfg.tlsCert, key: cfg.tlsKey })
  const ws = attachWsServer(httpServer, { auth, service, sessionErr })
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, () => resolve()))
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port
  const url = `${scheme}://${cfg.host}:${port}`
  // A2 启动横幅:按部署形态给对提示,不再对已加密的部署误报「明文」。
  if (scheme === 'https') {
    console.log(`[zuse-server] TLS 已启用 — ${url}`)
  } else if (cfg.trustProxy) {
    console.log('[zuse-server] 明文监听,信任前置代理的 X-Forwarded-Proto — 请确保只有隧道能连到这个端口')
  } else if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    console.warn(`[zuse-server] bound to ${cfg.host}:${port} — plaintext HTTP on a network interface. ` +
      'Use TLS (--tls-cert/--tls-key) or a tunnel (+ --trust-proxy); see docs/remote-access.md')
  }
  return {
    url,
    close: () => new Promise<void>((resolve) => {
      void mcp?.disconnectAll().catch(() => {})
      void lsp.dispose().catch(() => {})
      cronScheduler.close()
      httpServer.close(() => resolve())
      ws.closeAll()
      httpServer.closeAllConnections()
    }),
  }
}
