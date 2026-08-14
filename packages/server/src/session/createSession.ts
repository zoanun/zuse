import { homedir, release } from 'node:os'
import {
  loadSettings,
  loadTighteningRules,
  findProjectRoot,
  isTrustedRoot,
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
  type Message,
  type PermissionMode,
} from '@zuse/core'
import {
  createDefaultRegistry,
  getShellLabel,
  scanSkills,
  createSnapshotStore,
  cwdSlug,
  runStatusNote,
  type RunRegistry,
} from '@zuse/tools'
import { SessionManager } from './SessionManager.js'
import { loadActivePersonaSync } from '../persona/personaStore.js'
import { loadDisabledSkillsSync, skillsDisabledFile } from '../skill/skillStore.js'
import type { SnapshotStore, SessionCheckpoint } from './events.js'
import type { CompactionMeta } from './sessionStore.js'

export interface CreateSessionOpts {
  sessionId: string
  cwd: string
  /** 恢复用：预置对话历史（持久化恢复路径）。 */
  conversation?: Conversation
  /** 恢复用：预置 checkpoint 锚点。 */
  checkpoints?: SessionCheckpoint[]
  /** 恢复用：预置压缩元数据(feature B)——完整账本存盘,视图从它重建。 */
  compaction?: CompactionMeta
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
  /** run 注册表；给了才注册 `RunOutput` 工具（TUI 那条路径不给）。 */
  runs?: RunRegistry
  /**
   * I2 图片:视觉兜底用的辅助 client + model(主模型不支持视觉时,把图片描述成文本)。
   * 由 startServer 从 settings.imageModel 软降级构建;缺省 → 非视觉主模型无法处理图片。
   */
  imageClient?: ModelClient
  imageModel?: string
  /** I2:读取上传图片字节为 base64(解析兜底构造 image 块用)。由 startServer 经 UploadService 提供。 */
  readImageBase64?: (id: string) => Promise<{ data: string; mediaType: string }>
  /** I2:发送时的直传展开钩子(route==='direct' 的 attachments 读盘展开成 image 块)。由 startServer 提供。 */
  expandAttachments?: (messages: Message[]) => Promise<Message[]>
  /**
   * 非交互权限档位（cron 等无人看管会话）。给了即以 { interactive:false, config:{...settings.permissions,
   * defaultMode: permissionMode } } 建会话：ask→立即 deny(不卡死)，deny 表恒拦(硬底线)，defaultMode
   * 决定放行面。缺省(undefined) → 交互式 { interactive:true, config: settings.permissions }。
   */
  permissionMode?: PermissionMode
  /** 会话类别标记（透传给 SessionManager；'cron' 会从普通会话列表过滤）。 */
  kind?: 'cron'
}

/**
 * 把 @zuse/core / @zuse/tools 的真件接成一个可工作的 SessionManager。
 * 镜像 TUI（index.tsx / useConversation.ts）的构造序列，但不碰 React、不 import tui。
 * client/snapshotStore 可注入以保持单测离线、无网络、无 git。
 */
export function createSession(opts: CreateSessionOpts): SessionManager {
  const { sessionId, cwd } = opts
  const settings = loadSettings()

  // **会话所在项目的收紧规则也要生效。**
  //
  // `loadSettings()` 锚在 **daemon 进程的 cwd**（`findProjectRoot()` 从那儿往上找），
  // 与会话无关。于是在 `D:\别的项目` 里开的会话，吃的是 zuse 仓库那份配置 ——
  // 那个项目在自己 `.zuse/settings.json` 里写的 `deny` **一条都不生效**。
  //
  // 这里**只并 deny/ask，不并 allow / defaultMode / providers**。原因不是偷懒：
  // `.zuse/settings.json` **不在 .gitignore 里**（只有 `.local.*` 是），是随仓库分发的。
  // 完整加载会让「clone 一个仓库 → 在里面开会话」变成一条提权 + 外传的路
  //（那个文件能设 `defaultMode:"bypass"` 关掉你全部护栏，能设 `providers.default.baseURL`
  // 把整段对话导向别人的 endpoint）。**只收紧则不存在这个问题** ——
  // 恶意仓库最多把自己的会话卡死，碰不到你的护栏。放宽那一半要一道显式的信任闸，单独一轮。
  const sessionRoot = findProjectRoot(cwd)
  const tightening = loadTighteningRules(sessionRoot)
  if (tightening.deny.length > 0 || tightening.ask.length > 0) {
    settings.permissions = {
      ...settings.permissions,
      deny: [...settings.permissions.deny, ...tightening.deny],
      ask: [...settings.permissions.ask, ...tightening.ask],
    }
    console.log(
      `[zuse-server] 会话 ${sessionId} 采用了 ${sessionRoot} 的收紧规则：` +
      `deny +${tightening.deny.length}，ask +${tightening.ask.length}`,
    )
  }

  // **放宽**的那一半：只有这个目录被**显式信任过**才读。
  // 未信任时这里什么都不做 —— 会话照常跑，只是不吃那个项目的 allow / model / providers。
  // `loadSettings({ root })` 走的是与 daemon 根完全相同的三层合并，
  // 所以「信任之后」的语义就是「像在那个项目里跑 daemon 一样」，没有第二套规则要记。
  const rootTrusted = sessionRoot !== findProjectRoot() && isTrustedRoot(sessionRoot)
  if (rootTrusted) {
    try {
      const projectSettings = loadSettings({ root: sessionRoot })
      Object.assign(settings, projectSettings)
      // 收紧规则在上面已经并过；重新赋值 settings 会把它们冲掉，这里补回来。
      settings.permissions = {
        ...projectSettings.permissions,
        deny: [...projectSettings.permissions.deny, ...tightening.deny],
        ask: [...projectSettings.permissions.ask, ...tightening.ask],
      }
      console.log(`[zuse-server] 会话 ${sessionId} 采用了受信目录 ${sessionRoot} 的完整配置`)
    } catch (err) {
      // 与上面同理：受信目录里一份写坏的配置不该让建会话 500，也不该静默回退成
      // 「daemon 的配置」—— 那会让「写坏配置」变成一条改变生效配置的路。
      console.warn(
        `[zuse-server] 受信目录 ${sessionRoot} 的配置读不了，本会话沿用全局配置：` +
        `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
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
  // M3:启停状态存在 ~/.zuse/skills-disabled.json,扫盘后按名字滤掉禁用的。每次新会话重读 ——
  // 故面板里的启停在下一个新聊天生效(与 MCP「开着的会话工具集不变」同约束)。
  const disabledSkills = loadDisabledSkillsSync(skillsDisabledFile(home))
  const registry = createDefaultRegistry({
    webSearch: getWebSearchConfig(settings),
    memoryProject: cwdSlug(cwd),
    skills: scanSkills(home, cwd).filter((s) => !disabledSkills.has(s.name)),
  })

  // daemon-provided extra tools (B4 MCP server tools + B3 Lsp/LspInstall). Best-effort —
  // a bad registration must not break session construction.
  try { opts.registerExtraTools?.(registry) } catch (err) {
    console.warn(`[zuse-server] registerExtraTools 失败:${err instanceof Error ? err.message : String(err)}`)
  }
  // 注：会话级工具（Agent 子代理 + TodoWrite）由 SessionManager 构造时经能力清单
  // （SESSION_CAPABILITY_TOOLS）统一注册 —— 它们需反向访问 manager 的 live client（failover
  // 会热替换）/权限流/sessionAllow/todo 汇聚点，放在 manager 内构造最自然。

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
      surface: 'web', // daemon serves the web UI — keeps the model from giving TUI-only advice
    },
    sections,
    sel.model,
  )

  const snapshotStore = opts.snapshotStore ?? createSnapshotStore(cwd)

  // §8(b)：每回合往**发给模型的那份副本**里追加一行后台命令现状。
  //
  // **绝不能走 `applyUserStamp`。** 那条路有 4 个消费者：拼进去的话用户气泡里会出现
  // 自己没打过的字、**会话标题会变成 run 状态**、点 retry 会把这段状态当用户原话重发
  // 并反复叠加。`expandAttachments` 是**请求专用副本** —— 不进账本、不进标题、不进搜索、
  // 不被 retry 重发，且每回合按当时状态重算（旧回合不会留下过期的「运行中」）。
  //
  // 为什么在这里包而不是在 startServer 包：那边的 expandAttachments 是**跨会话共享**的
  // 一个实例，拿不到 sessionId，包不出「本会话的 run」。
  const runs = opts.runs
  const baseExpand = opts.expandAttachments
  const expandWithRunStatus = runs
    ? async (messages: Message[]): Promise<Message[]> => {
        const out = baseExpand ? await baseExpand(messages) : messages
        const note = runStatusNote(runs.list().filter((r) => r.sessionId === sessionId))
        if (!note) return out
        const last = out[out.length - 1]
        if (!last || last.role !== 'user') return out
        // 只动最后一条 user 消息，且是**副本**（baseExpand 的契约就是返回新副本；
        // 没有 baseExpand 时这里自己拷一层，绝不 mutate 账本里的消息）。
        const copy = [...out]
        copy[copy.length - 1] = {
          ...last,
          content: [...last.content, { type: 'text' as const, text: `\n\n${note}` }],
        }
        return copy
      }
    : baseExpand

  const mgr = new SessionManager({
    sessionId,
    // 有 run 注册表才注册 RunOutput（TUI 那条路径没有 run 服务）。
    ...(opts.runs ? { runs: opts.runs } : {}),
    cwd,
    client,
    registry,
    settings,
    systemPrompt,
    permissionPolicy: opts.permissionMode
      ? { interactive: false, config: { ...settings.permissions, defaultMode: opts.permissionMode } }
      : { interactive: true, config: settings.permissions },
    kind: opts.kind,
    snapshotStore,
    providerId: sel.providerId,
    conversation: opts.conversation,
    checkpoints: opts.checkpoints,
    compaction: opts.compaction,
    createdAt: opts.createdAt,
    titleClient,
    titleModel,
    titleAlreadySet: opts.titleAlreadySet,
    // I2 图片:startServer 建好后经会话构造链透传;缺省则各能力自然降级(见 SessionManager)。
    imageClient: opts.imageClient,
    imageModel: opts.imageModel,
    readImageBase64: opts.readImageBase64,
    expandAttachments: expandWithRunStatus,
  })
  return mgr
}
