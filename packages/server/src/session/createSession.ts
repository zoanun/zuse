import { homedir, release } from 'node:os'
import {
  loadSettings,
  installProxy,
  resolveModelSelection,
  getProviderConfig,
  getWebSearchConfig,
  createModelClient,
  buildSystemPrompt,
  loadPromptSections,
  type ModelClient,
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
import type { SnapshotStore } from './events.js'
import { DEFAULT_SESSION_ID } from '../config.js'

export interface CreateSessionDeps {
  /** 注入用：协议/工厂单测传 fake client，离线不烧 token。缺省走 createModelClient。 */
  client?: ModelClient
  /** 注入用：测试可传假快照存储。缺省 createSnapshotStore(cwd)。 */
  snapshotStore?: SnapshotStore
}

/**
 * 把 @zuse/core / @zuse/tools 的真件接成一个可工作的 SessionManager。
 * 镜像 TUI（index.tsx / useConversation.ts）的构造序列，但不碰 React、不 import tui。
 * client/snapshotStore 可注入以保持单测离线、无网络、无 git。
 */
export function createSession(cwd: string, deps: CreateSessionDeps = {}): SessionManager {
  const settings = loadSettings()
  try {
    installProxy(settings)
  } catch (err) {
    // 与 TUI 一致：代理地址非法时降级直连并告警，不阻断会话构建。
    console.warn(`[zuse-server] 代理配置无效，已降级直连：${err instanceof Error ? err.message : String(err)}`)
  }

  const sel = resolveModelSelection(settings)
  const client = deps.client ?? createModelClient(getProviderConfig(settings, sel.providerId), sel.model)

  const home = homedir()
  // 注：LSP（Lsp/LspInstall）与 MCP 工具 F3 不接 —— 比 TUI registry 少这几样。
  // 它们需各自的进程池/连接生命周期管理，留作 follow-up；F3 单会话能真聊不依赖它们。
  const registry = createDefaultRegistry({
    webSearch: getWebSearchConfig(settings),
    memoryProject: cwdSlug(cwd),
    skills: scanSkills(home, cwd),
  })

  // late-bind：TodoWrite.onUpdate 要回调到下面才构造的 manager（镜像 TUI 的 ref 套路）。
  let mgr!: SessionManager
  registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))
  // 注：Agent / ScheduleWakeup 工具 F3 不接 —— 二者需反向访问 manager 的 live client
  // （failover 会热替换），且非聊天必需，显式留作 follow-up。

  const systemPrompt = buildSystemPrompt(
    {
      platform: process.platform,
      osVersion: release(),
      shell: getShellLabel(),
      cwd,
      date: new Date().toISOString().slice(0, 10),
    },
    loadPromptSections(home, cwd),
    sel.model,
  )

  const snapshotStore = deps.snapshotStore ?? createSnapshotStore(cwd)

  mgr = new SessionManager({
    sessionId: DEFAULT_SESSION_ID,
    cwd,
    client,
    registry,
    settings,
    systemPrompt,
    permissionPolicy: { interactive: true, config: settings.permissions },
    snapshotStore,
    providerId: sel.providerId,
  })
  return mgr
}
