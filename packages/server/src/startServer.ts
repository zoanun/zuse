import { createAppServer } from './http/appServer.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { generateSetupToken, isExposedDeployment } from './auth/setupToken.js'
import { PasswordStore } from './auth/passwordStore.js'
import { LocalPasswordAuth } from './auth/authProvider.js'
import { makeRequestHandler } from './http/server.js'
import { buildHostPolicy } from './http/originGuard.js'
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
  loadSettings, resolveModelSelection, resolveContextWindow, resolveImageModelSelection, validateRules, parseRule,
  getProviderConfig, createModelClient, setModelInSettings, McpManager, type ToolRegistry, type ModelClient,
} from '@zuse/core'
import { makeExpandAttachments } from './upload/imageExpand.js'
import { LspManager, createLspTool, createLspInstallTool, RunRegistry, spawnShellCommand, killTree, createDefaultRegistry } from '@zuse/tools'

export interface StartServerDeps {
  /** 注入用:测试传一个 fake-client session,跳过真件构建。 */
  session?: SessionManager
  /**
   * 启动时是否连接 settings.mcpServers 里的 MCP server。缺省 true（真实 daemon 的行为）。
   *
   * 测试必须传 false。此前不可关：`await reconnectMcp()` 在启动路径上无条件跑，于是每个
   * 调 startServer 的单测都要去连**开发者本机真实配置的** MCP server —— 实测 startServer
   * 因此耗时 4.1s（两个 `npx -y <pkg>` 冷启动 + 网络），撞上 vitest 默认的 5000ms 超时线，
   * 造成 wsServer.test.ts 整片随机红。单测不该读开发者的个人配置，更不该依赖 npm registry 可达。
   *
   * 注意这只关**启动时的首次连接**；M4 面板的运行时重连端点不受影响。
   */
  connectMcp?: boolean
}

/**
 * 权限规则体检 —— 启动时把有问题的规则**逐字**打出来。
 *
 * ## 为什么必须有,以及为什么只告警不抛
 *
 * 非法规则在权限层是**静默丢弃**的（`matchesRule` 遇到解析失败就 `return false`），
 * 于是一条打错的 deny = 没有这条 deny，而用户看到的是「我配了啊」。实测本机 15 个
 * MCP 工具里 14 个带连字符，在修 `parseRule` 之前**一条能生效的规则都写不出来**。
 *
 * **不抛**:`loadSettings()` 在 daemon 启动、每建会话、**每个 `/api/models` 请求**
 * 上都会调，抛在那里等于 daemon 起不来 —— 而用户改配置的唯一图形入口正是它托管的
 * Web UI。把「部分安全降级」换成「整机不可用 + 自救入口一并没了」，代价不对等。
 *
 * **已知没覆盖到的**（照实写，别假装解决了）:
 * - 启动横幅会被后续日志刷掉。把它搬进会话状态、让 UI 常驻提示，是下一步。
 * - 非交互的 cron 会话看不到任何提示，而 cron 的默认档正是 `bypass` ——
 *   恰好是 deny 表唯一兜底的那一档。
 */
/**
 * 探测用的 registry 里**没有**、但运行期真实存在的工具名。
 *
 * `createDefaultRegistry()` 不带 opts 时会漏掉按配置启用的那几个（WebSearch / Skill），
 * 而 Agent / TodoWrite 是**会话级**的（`SESSION_CAPABILITY_TOOLS`，需要 manager 的
 * live client 才能构造，探测阶段拿不到）。
 *
 * **这是「同一个概念写两处」，本来该避免** —— 之所以还是写了，是因为另一条路
 * （为了体检去构造一个完整会话）代价大得多。**防漂移的办法是测试**：
 * `ruleCheckWiring.test.ts` 断言「内置默认规则集不产生任何告警」——
 * 谁加了新工具、或改了默认规则，那条会红，会被引到这里来。
 */
const TOOLS_NOT_IN_PROBE_REGISTRY = ['Agent', 'TodoWrite', 'WebSearch', 'Skill']

function reportBadPermissionRules(registerExtraTools: (r: ToolRegistry) => void): void {
  try {
    // 拿一份**当前真实**的工具名单（内置 + 已连上的 MCP + LSP）。用一个一次性 registry
    // 探一下就行 —— 它不起任何进程。
    const probe = createDefaultRegistry()
    try { registerExtraTools(probe) } catch { /* 探测失败就退化成只查「解析得了吗」 */ }
    const knownTools = [...probe.list().map((t) => t.name), ...TOOLS_NOT_IN_PROBE_REGISTRY]
    const perms = loadSettings().permissions
    const lines: string[] = []
    for (const table of ['deny', 'ask', 'allow'] as const) {
      for (const bad of validateRules(perms[table], knownTools)) {
        lines.push(
          bad.problem === 'unparsable'
            ? `  permissions.${table}: "${bad.rule}" —— 格式不对（应是 Tool 或 Tool(限定符)）`
            : `  permissions.${table}: "${bad.rule}" —— 找不到名为 "${parseRule(bad.rule)?.tool}" 的工具` +
              `（若它来自尚未连上的 MCP server，可以忽略）`,
        )
      }
    }
    if (lines.length === 0) return
    // **warn 不是 log**：这些规则以为自己在生效，实际一条都没生效。
    console.warn('[zuse-server] ⚠ 有权限规则不会生效（写错的规则是被静默丢弃的）：')
    for (const l of lines) console.warn(l)
    console.warn('[zuse-server]   deny 里的规则失效 = 该拦的没拦，而且不会有任何运行期提示。')
  } catch (err) {
    // 体检本身绝不能拦住启动。
    console.warn(`[zuse-server] 权限规则体检失败：${err instanceof Error ? err.message : String(err)}`)
  }
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
  // 只跳过启动时的首次连接；上面 reconnectMcp 本体不变，M4 面板的运行时重连照常可用。
  if (deps.connectMcp !== false) await reconnectMcp()

  // 权限规则体检。**必须在这里（MCP 连完之后）跑** —— 工具集这时才齐，
  // 否则每条 MCP 规则都会被误报成「找不到这个工具」。
  reportBadPermissionRules(registerExtraTools)

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

  // run 服务的注册表（步骤 2）。**在这里 new 一次、经 deps 传下去** —— 不做模块级单例，
  // 理由见 RequestHandlerDeps.runs 的注释。`spawn`/`killTree` 从 proc 层原样接过来，
  // 不在这里另写一套：那两个函数里压着一堆 Windows 的坑（怎么挑 shell、Volta 的递归守卫、
  // 杀进程树的两条平台分支），重写一份必然漏掉一半。
  const runs = new RunRegistry({
    deps: {
      spawn: (command, opts) => spawnShellCommand(command, { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) }),
      killTree,
    },
  })
  // Host / Origin 白名单：挡 DNS rebinding 与跨站写入（见 http/originGuard.ts 的「两把锁」）。
  // 证书路径也喂进去 —— DNS SAN 自动进白名单，否则 docs/remote-access.md 里两条直连 TLS
  // 的配方会当场坏掉（用户没配 --allowed-host 却本该能用）。
  const hostPolicy = buildHostPolicy({ host: cfg.host, allowedHosts: cfg.allowedHosts, tlsCertPath: cfg.tlsCert })

  // 一次性 setup token（见 `auth/setupToken.ts`）：暴露形态下才有，回环形态刻意为空。
  // 挡的是「局域网/隧道那头的任意人抢先设口令 → login → POST /api/runs 任意命令」，
  // 那条链 curl 就能走完，Host/Origin 两把锁**够不着**（它们只约束浏览器）。
  const exposed = isExposedDeployment(cfg)
  const setupToken = exposed ? generateSetupToken() : undefined
  const setupTokenPath = join(cfg.authDir, 'setup-token')
  const alreadyConfigured = await auth.isConfigured()
  if (setupToken !== undefined && !alreadyConfigured) {
    // **落盘是必需的第二条取回途径。** nohup / systemd / Windows 服务形态看不到 stderr，
    // 而「找不回来就重启」在那里是死循环 —— 重启只换一个同样看不见的新 token。
    //
    // **别把 0600 当成跨账户的保护 —— 在 Windows 上它是 no-op。** 实测：chmod 0600
    // 之后 `icacls` 仍是 `BUILTIN\Users:(I)(RX)`（node 只把 chmod 映射到只读属性，不碰 DACL）。
    // 真正在保护默认 authDir 的是 `%USERPROFILE%\.zuse` 继承来的 ACL。
    // **authDir 被指到 ACL 更宽的地方（ProgramData / 共享盘 / CI workdir）时这层保护为零。**
    // 写入时就带 mode，别先建再 chmod —— POSIX 上那中间有一个 umask 窗口。
    try {
      writeFileSync(setupTokenPath, setupToken + '\n', { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(setupTokenPath, 0o600) } catch { /* 文件已存在时 mode 不生效，补一刀；windows 上是 no-op */ }
    } catch (err) {
      console.warn(`[zuse-server] setup token 落盘失败(${setupTokenPath}):${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (alreadyConfigured && existsSync(setupTokenPath)) {
    // 清理陈旧文件 —— **但只在「口令已设」时清**。
    //
    // 评审实测过一个被这行删掉的真实场景：同机两个 daemon 共用默认 `~/.zuse`，
    // 后起的那个（本机形态）会把先起的那个（暴露形态）**正在用的活 token 文件**删掉。
    // 那恰好打死了落盘存在的唯一理由 —— headless 形态看不到横幅，文件没了就永久取不回。
    //
    // 条件收紧到 `alreadyConfigured` 之后是安全的：共用 authDir 的实例共用同一份
    // `web-auth.json`，口令一旦设上，**所有**实例的 token 都已经不可能再被用到
    // （setup 路由第一件事就是 `isConfigured() → 409`，排在 token 校验之前）。
    try { rmSync(setupTokenPath, { force: true }) } catch { /* best-effort */ }
  }

  const handler = makeRequestHandler({ auth, service, runs, memory, search, persona, skill, usage, file, mcp: mcpService, cron: cronService, upload, voice, persistModel: (spec) => setModelInSettings(spec), devPage: true, tokenTtlSec: cfg.tokenTtlSec, webDir: cfg.webDir ?? defaultWebDir(), trustProxy: cfg.trustProxy ?? false, hostPolicy, ...(setupToken !== undefined ? { setupToken } : {}) })
  // A2:配了证书对就起 https(WS 随之变 wss —— 同一个 server 的 upgrade 事件)。
  const { server: httpServer, scheme } = createAppServer(handler, { cert: cfg.tlsCert, key: cfg.tlsKey })
  // hostPolicy 不能漏：upgrade 事件不经过 HTTP handler，漏了的话 rebinding 页面
  // 开不了 HTTP 却开得了 WS —— 而 WS 那头是整个会话流（发消息、跑工具）。
  const ws = attachWsServer(httpServer, { auth, service, sessionErr, hostPolicy })
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
  // Host 白名单的状态必须打出来 —— 被闸门拒绝的用户（尤其隧道用户）只有这一行和
  // 403 里的提示两个线索。裸 `*` 是把这次防护整个关掉，必须是 warn 不是 log。
  // setup token 必须打在横幅上 —— 它是用户拿到它的**第一条**途径（第二条是 authDir 里的文件）。
  // 用 warn（stderr）与其他安全横幅一致。
  if (setupToken !== undefined && !alreadyConfigured) {
    console.warn(`[zuse-server] setup token: ${setupToken}`)
    console.warn(`[zuse-server]   首次设置口令要贴这串（也存在 ${setupTokenPath}）。这台 daemon 对外可达，没有它任何人都能抢先设口令。`)
  } else if (!exposed && !alreadyConfigured) {
    // 判据只看启动参数，**看不见另一个进程里的 cloudflared**。这是 spec §2.1 列出的
    // 残留漏报，只能靠这一行提示兜底：用户加了 --allowed-host 之后判据就认得出来了。
    console.log('[zuse-server] 提示:若你把它放在隧道 / 反向代理后面，请加 --allowed-host <域名> —— 那既是浏览器访问的必要条件，也会启用 setup token 保护')
  }
  if (hostPolicy.anyName) {
    console.warn('[zuse-server] ⚠ --allowed-host * :已关闭 Host 白名单，任何域名都能打到这个端口（DNS rebinding 防护失效）')
  } else if (hostPolicy.names.length > 0) {
    console.log(`[zuse-server] 允许的域名:${hostPolicy.names.join(', ')}（回环名与 IP 字面量始终允许）`)
  }
  return {
    url,
    close: () => new Promise<void>((resolve) => {
      void mcp?.disconnectAll().catch(() => {})
      void lsp.dispose().catch(() => {})
      cronScheduler.close()
      // **不能漏。** 漏了的话 daemon 关停会留下**孤儿子进程**：片段档还有 300 秒墙钟兜底，
      // 而项目档（步骤 4）是 `wallClockMs: null` + `onDetach: 'keep'` —— 一个 dev server
      // 会永远活着占着端口，而本仓每次改 web 都要重启 daemon。
      // 这条是评估「跑整个项目」时顺带查出来的：`closeAll()` 此前全仓只有测试在调。
      // `disposeAll` 而不是 `closeAll`：后者只发信号，两级宽限定时器会在 3s/6s 后
      // 各醒一次，对着已经没人管的 run 再 signal 一遍，还吊着事件循环。
      runs.disposeAll()
      httpServer.close(() => resolve())
      ws.closeAll()
      httpServer.closeAllConnections()
    }),
  }
}
