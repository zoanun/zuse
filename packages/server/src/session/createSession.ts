import { homedir, release } from 'node:os'
import {
  loadSettings,
  installProxy,
  resolveModelSelection,
  resolveSmallModelSelection,
  getProviderConfig,
  getWebSearchConfig,
  createModelClient,
  buildSystemPrompt,
  loadPromptSections,
  type ModelClient,
  type Conversation,
  type ToolRegistry,
} from '@zuse/core'
import {
  createDefaultRegistry,
  createTodoWriteTool,
  getShellLabel,
  scanSkills,
  createSnapshotStore,
  cwdSlug,
} from '@zuse/tools'
import { SessionManager } from './SessionManager.js'
import { loadActivePersonaSync } from '../persona/personaStore.js'
import type { SnapshotStore, SessionCheckpoint } from './events.js'

export interface CreateSessionOpts {
  sessionId: string
  cwd: string
  /** 恢复用：预置对话历史（持久化恢复路径）。 */
  conversation?: Conversation
  /** 恢复用：预置 checkpoint 锚点。 */
  checkpoints?: SessionCheckpoint[]
  /** 恢复用：原始创建时间戳。 */
  createdAt?: string
  /** 注入用：协议/工厂单测传 fake client，离线不烧 token。缺省走 createModelClient。 */
  client?: ModelClient
  /** 注入用：测试可传假快照存储。缺省 createSnapshotStore(cwd)。 */
  snapshotStore?: SnapshotStore
  /** 恢复用：已有标题(manual/generated 或非空会话)→ 不再自动生成标题。 */
  titleAlreadySet?: boolean
  /**
   * 在默认 registry 建好后追加注册额外工具的回调（每会话调用一次）。daemon 用它把已连接的
   * MCP server 工具（B4）注册进每个会话的 registry —— 连接生命周期由 daemon 持有,这里只注册。
   */
  registerExtraTools?: (registry: ToolRegistry) => void
}

/**
 * 把 @zuse/core / @zuse/tools 的真件接成一个可工作的 SessionManager。
 * 镜像 TUI（index.tsx / useConversation.ts）的构造序列，但不碰 React、不 import tui。
 * client/snapshotStore 可注入以保持单测离线、无网络、无 git。
 */
export function createSession(opts: CreateSessionOpts): SessionManager {
  const { sessionId, cwd } = opts
  const settings = loadSettings()
  try {
    installProxy(settings)
  } catch (err) {
    // 与 TUI 一致：代理地址非法时降级直连并告警，不阻断会话构建。
    console.warn(`[zuse-server] 代理配置无效，已降级直连：${err instanceof Error ? err.message : String(err)}`)
  }

  const sel = resolveModelSelection(settings)
  const client = opts.client ?? createModelClient(getProviderConfig(settings, sel.providerId), sel.model)

  // 小模型(标题生成等):仅当配置了 settings.smallModel 且其 provider 有可用 key 时构建。
  // 任意一步失败都降级为"无小模型"(generateTitle 变 no-op、回退截断标题),绝不阻断会话构建。
  // 注入了 fake client 的离线测试不建真实小模型客户端。
  let titleClient: ModelClient | undefined
  let titleModel: string | undefined
  if (!opts.client) {
    const smallSel = resolveSmallModelSelection(settings)
    if (smallSel) {
      try {
        titleClient = createModelClient(getProviderConfig(settings, smallSel.providerId), smallSel.model)
        titleModel = smallSel.model
      } catch (err) {
        console.warn(`[zuse-server] smallModel 不可用,标题将回退截断:${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const home = homedir()
  // 注：MCP（B4）与 LSP（Lsp/LspInstall，B3）这类需进程池/连接生命周期的工具不在这里建 —— 由
  // daemon 持有其管理器，经下方的 registerExtraTools 接缝注册进每个会话的 registry。
  const registry = createDefaultRegistry({
    webSearch: getWebSearchConfig(settings),
    memoryProject: cwdSlug(cwd),
    skills: scanSkills(home, cwd),
  })

  // late-bind：TodoWrite.onUpdate 要回调到下面才构造的 manager（镜像 TUI 的 ref 套路）。
  let mgr!: SessionManager
  registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))
  // daemon-provided extra tools (B4 MCP server tools + B3 Lsp/LspInstall). Best-effort —
  // a bad registration must not break session construction.
  try { opts.registerExtraTools?.(registry) } catch (err) {
    console.warn(`[zuse-server] registerExtraTools 失败:${err instanceof Error ? err.message : String(err)}`)
  }
  // 注：Agent（子代理）工具由 SessionManager 构造时自行注册 —— 它需反向访问 manager 的
  // live client（failover 会热替换）/权限流/sessionAllow，放在 manager 内闭包最自然。
  // ScheduleWakeup（B2）仍未接 —— 它需要把唤醒消息注入会话的回调，建议并入 C1 cron 一起做。

  // Prompt sections = the read-only file layers (SYSTEM.md/ZUSE.md/MEMORY.md), plus the active
  // persona (M2) layered on top as one more `## section`. Persona switching takes effect on
  // newly-built sessions (the system prompt is fixed once a session exists).
  const sections = loadPromptSections(home, cwd)
  const persona = loadActivePersonaSync()
  if (persona) sections.push({ title: `Persona: ${persona.name}`, content: persona.content })
  const systemPrompt = buildSystemPrompt(
    {
      platform: process.platform,
      osVersion: release(),
      shell: getShellLabel(),
      cwd,
      date: new Date().toISOString().slice(0, 10),
    },
    sections,
    sel.model,
  )

  const snapshotStore = opts.snapshotStore ?? createSnapshotStore(cwd)

  mgr = new SessionManager({
    sessionId,
    cwd,
    client,
    registry,
    settings,
    systemPrompt,
    permissionPolicy: { interactive: true, config: settings.permissions },
    snapshotStore,
    providerId: sel.providerId,
    conversation: opts.conversation,
    checkpoints: opts.checkpoints,
    createdAt: opts.createdAt,
    titleClient,
    titleModel,
    titleAlreadySet: opts.titleAlreadySet,
  })
  return mgr
}
