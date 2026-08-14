import { join } from 'node:path'
import {
  Conversation,
  ToolRegistry,
  appendAllowRule,
  decide,
  isMustConfirm,
  runAgent,
  resolveContextWindow,
  resolveVision,
  findCompactionCut,
  findCompactionCutByBudget,
  summarizeForCompaction,
  buildFallbackSummary,
  applyCompaction,
  emptyUsage,
  splitMemoryCandidates,
  estimateCompactionSavings,
  COMPACTION_THRESHOLD,
  TAIL_BUDGET_RATIO,
  createModelClient,
  getProviderConfig,
  chatModelNames,
  resolveFailoverMode,
  decideFailover,
  modelKey,
  badKeysForFailure,
  createFileTracker,
  MEMORY_INDEX_CAP,
  shouldConsolidateMemories,
  buildConsolidationPrompt,
  parseConsolidationOps,
  generateSessionTitle,
  steerFoldSuffix,
  genMsgId,
  INTERRUPT_MARKER,
  INTERRUPT_MARKER_TOOL_USE,
  type ModelClient,
  type Message,
  type MessageAttachment,
  type FileReadTracker,
  type ResolvedSettings,
  type ProviderConfig,
  type PermissionsConfig,
  type PermissionMode,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
  type ErrorCategory,
} from '@zuse/core'
import { openMemoryStore, renderMemoryMarkdown, applyMemoryConsolidation, cwdSlug } from '@zuse/tools'
import type {
  SessionEvent,
  SessionSnapshot,
  TodoItemLite,
  PendingPermissionLite,
  SessionCheckpoint,
  SnapshotStore,
} from './events.js'
import { SESSION_CAPABILITY_TOOLS, type SessionCapabilityContext } from './sessionCapabilities.js'
import { groupTodos } from '@zuse/protocol'
import type { SnapshotPart, SnapshotMessage, UploadedImageRef, PastedTextInput, UploadedFileRef } from '@zuse/protocol'
import type { CompactionMeta } from './sessionStore.js'
import { stripUserStamp, applyUserStamp } from './userStamp.js'
import { deliverToSession } from './deliver.js'

/** Default output token cap for a turn, used when no maxTokens option is provided. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384

/** Output cap for a single image-description round-trip (parsed fallback for non-vision models). */
const IMAGE_DESCRIPTION_MAX_TOKENS = 1024

/**
 * 单张图解析的墙钟上限。
 *
 * **不要写成「否则会永久挂起」** —— 那是错的：内置 client 已经套了 `StreamIdleGuard`
 * （`core/stream-idle.ts`，默认 120s 空闲即中断），流真断了自会报错。这个数的作用是把
 * 识图这一路收紧到 60s：它只是主回合的一个前置步骤，让用户为一张图干等两分钟不合理。
 *
 * **代价**：这是墙钟，不是空闲计时。一个持续吐字、只是慢的描述（自建 VL 模型 + 1024
 * tokens）会被它掐掉，而空闲守卫不会掐。本机 Qwen3-VL-32B 描述 40KB 截图实测约 5s，
 * 留了一个数量级余量；若将来有人接更慢的模型，该调的是这个数，不是删掉它。
 */
const IMAGE_DESCRIBE_TIMEOUT_MS = 60_000

/**
 * 失败原因带进模型上下文和 DOM 前的截断长度。
 *
 * `reason` 是 provider SDK 的原始 message，不可控：有些 OpenAI 兼容网关会把**整个请求体**
 * 回显在错误里 —— 而这个请求体里装着图片的 base64。不截断就会把几 MB 的串塞进下一回合的
 * 上下文、写进会话存档，还会在界面上撑破一行（`.note` 没有 word-break）。
 */
const IMAGE_FAILURE_REASON_CAP = 200

/**
 * waitUntilQuiescent 的轮询间隔:从 250ms 起步、每轮 ×1.5 退避到 5s 封顶。
 * 定长 250ms 在「模型排了个半小时后的唤醒」这种常态下要空转 7200 次 —— 那些轮询的结果
 * 提前就知道是 false。退避把 1 小时内的唤醒次数从 ~14400 降到 ~726，代价是静默判定最多晚
 * 5 秒(只影响 run 记录的 finishedAt 与 croner protect 的释放时刻，都无所谓)。
 */
const QUIESCENCE_POLL_MIN_MS = 250
const QUIESCENCE_POLL_MAX_MS = 5000

/** 同一会话最多同时在飞的后台 Agent 数。超限时启动钩子 throw，如实回喂模型。 */
const MAX_BACKGROUND_AGENTS = 5

/** 待投递的种类。 */
type InjectionKind = 'wakeup' | 'background'

/**
 * 待投递：将来会往本会话推一条消息的东西（自唤醒 B2、在飞的后台 Agent B1）。
 * 从会话的视角这两者是同一件事，所以合成一张表而不是每类一个字段 ——
 * 静默判据（hasPendingInjection）与生命周期作废（cancelInjections）各只有一处，
 * 加第三种待投递时不可能漏掉其中之一。
 *
 * **投递协议**：摘登记与投递必须在同一个同步块内完成，中间不得有 await。
 * waitUntilQuiescent 是轮询（每次检查之间必有 await），因此观测不到「已摘登记但回合
 * 尚未开始」的假静默窗口；submit() 的 `isThinking = true` 也是同步的（submit 开头、
 * 第一个 await 之前），接得上。投递前先看 delete() 的返回值：登记已不在表中 = 这条
 * 待投递已被作废，产出无处可去，直接丢弃。
 */
interface PendingInjection {
  kind: InjectionKind
  /** 展示名（background 用：面板要显示是哪个子代理在跑）。wakeup 不需要。 */
  label?: string
  /**
   * 作废时调用，用于释放这类待投递自己的资源。wakeup = clearTimeout；
   * background 为空函数 —— 按设计只丢弃投递、不中止在飞的子代理（它自带 10 轮上限），
   * 而「离开这张表」本身已经由 cancelInjections 统一做掉了。
   *
   * 刻意**必填**而不是可选：加第三种待投递的人必须正面回答「作废它意味着什么」，
   * 可选会让这个问题被静默跳过。
   */
  cancel: () => void
}

/**
 * Prompt sent to the auxiliary image model (parsed fallback): ask it to describe an image objectively
 * and completely so the non-vision main model can answer the user's question from the description.
 */
const IMAGE_PROMPT =
  '请客观、完整地描述这张图片的内容（包括文字、图表、界面、代码、人物特征等一切可见细节），以便另一个模型据此回答用户的问题。'

export interface PermissionPolicy {
  interactive: boolean
  config: PermissionsConfig
}

export interface SessionManagerOptions {
  sessionId: string
  cwd: string
  client: ModelClient
  registry: ToolRegistry
  settings: ResolvedSettings
  systemPrompt: string
  permissionPolicy: PermissionPolicy
  /** 会话类别标记：'cron' = 定时任务跑出的会话（从普通列表过滤）。缺省 = 普通会话。 */
  kind?: 'cron'
  snapshotStore: SnapshotStore
  conversation?: Conversation
  /** Pre-seed checkpoint anchors (e.g. restored from persistence, or for tests). Defaults to []. */
  checkpoints?: SessionCheckpoint[]
  /** Pre-seed compaction state (feature B), restored from persistence. Absent = never compacted. */
  compaction?: CompactionMeta
  createdAt?: string
  /** Max output tokens per turn. Defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxTokens?: number
  /** Provider id this session runs against. Initialises currentProviderId. Defaults to 'unknown'. */
  providerId?: string
  /**
   * Factory used to build the swapped client on failover. Defaults to core's
   * createModelClient. Injectable so offline tests can return a scripted fake
   * instead of a real provider client.
   */
  createClient?: (providerConfig: ProviderConfig, model: string) => ModelClient
  /**
   * Optional small-model client + model id for cheap auxiliary tasks (session title
   * generation). Built by createSession from settings.smallModel when configured;
   * absent → generateTitle() is a no-op (caller falls back to first-message truncation).
   */
  titleClient?: ModelClient
  titleModel?: string
  /** True when a title already exists (restored manual/generated record) → don't auto-generate. */
  titleAlreadySet?: boolean
  /**
   * Auxiliary vision-capable client + model for the PARSED fallback (I2): when the main model is
   * NOT vision-capable, each uploaded image is sent to this client to obtain a text description,
   * stored on the user message's attachment (route:'parsed'). expandAttachments then materializes
   * that description as a text block at send time — it is NOT baked into the ledger's user text.
   * Absent → images cannot be handled for a non-vision main model (submit emits an error and
   * refuses to send).
   */
  imageClient?: ModelClient
  imageModel?: string
  /**
   * Reads an uploaded image's bytes as base64 (parsed fallback constructs the image block from it).
   * Provided by startServer via UploadService.readBase64; SessionManager never touches the uploads dir.
   */
  readImageBase64?: (id: string) => Promise<{ data: string; mediaType: string }>
  /**
   * Send-time image-expansion hook forwarded to runAgent for BOTH image routes: for each message's
   * `attachments` it prepends route:'direct' → base64 image block, route:'parsed' → text block (the
   * stored description), onto a request-only copy. Provided by startServer; the ledger stays
   * base64-free. Absent → images cannot be materialized, so submit refuses to send an image turn.
   */
  expandAttachments?: (messages: Message[]) => Promise<Message[]>
}

interface Pending {
  req: PermissionRequest
  resolve: (v: PermissionVerdict) => void
  /**
   * 这张卡是「必须确认」档的吗？切全自主时**不能**替用户按掉它。
   * 见下面 setPermissionMode 里那段。
   */
  mustConfirm?: boolean
}

/** `[]` → `undefined`, else the array — collapses the "empty means omit this arg" dance at the
 *  submit() call sites (retry route-split, steer drain). */
function orUndef<T>(a: T[]): T[] | undefined {
  return a.length > 0 ? a : undefined
}

/** Display-only attachments for a `user-echo` bubble (mid-turn interjection / retry / idle-race resend).
 *  Images carry id/name/mediaType (route/description fill in from the authoritative snapshot); pasted
 *  carry route+text so the 📄 chip renders live before the snapshot round-trips. Numbering matches the
 *  client's optimistic `粘贴文本 #N`. */
function echoAttachments(images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]): MessageAttachment[] | undefined {
  const atts: MessageAttachment[] = [
    ...(images ?? []).map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType })),
    ...(pastedTexts ?? []).map((p, idx) => ({ id: p.id, name: `粘贴文本 #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text })),
    ...(files ?? []).map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const })),
  ]
  return atts.length > 0 ? atts : undefined
}

export class SessionManager {
  private readonly sessionId: string
  private conversation: Conversation
  private client: ModelClient
  private readonly registry: ToolRegistry
  private readonly settings: ResolvedSettings
  private systemPrompt: string
  private policy: PermissionPolicy
  /** 会话类别（'cron' 或 undefined）。SessionService.persist 据此写入 SessionRecord.kind。 */
  private readonly kind?: 'cron'
  private readonly snapshotStore: SnapshotStore
  private readonly createdAt: string
  private readonly maxTokens: number

  private cwd: string
  private currentProviderId = 'unknown'
  /** Models marked bad this session: key `${providerId}/${model}` → why. Feeds decideFailover. */
  private readonly badModels = new Map<string, ErrorCategory>()
  private readonly createClient: (providerConfig: ProviderConfig, model: string) => ModelClient
  /** Small-model client + model for title generation; undefined when smallModel unset. */
  private readonly titleClient: ModelClient | undefined
  private readonly titleModel: string | undefined
  /** Parsed-fallback image model (I2): describes images for a non-vision main model. */
  private readonly imageClient: ModelClient | undefined
  private readonly imageModel: string | undefined
  /** Reads an uploaded image as base64 (parsed fallback); injected, uploads dir stays server-owned. */
  private readonly readImageBase64: ((id: string) => Promise<{ data: string; mediaType: string }>) | undefined
  /** Send-time image-expansion hook for the direct route; forwarded to runAgent. */
  private readonly expandAttachments: ((messages: Message[]) => Promise<Message[]>) | undefined
  /** A title exists (generated or manual) → don't auto-generate again. */
  private titleSettled = false
  /** A title-generation call is in flight → don't start a second one. */
  private titlePending = false
  private abort: AbortController | null = null
  // Mid-turn steers awaiting delivery. `echoed` = a "↪ 插话" bubble was already shown for it (it was
  // folded into a tool_result then re-queued after a Stop), so the idle-drain re-delivers it without
  // a second echo. Per-item (not a turn-level flag) so a turn can hold a mix of echoed/un-echoed
  // steers — e.g. one folded early + one queued during the final pure-text reply — each echoed once.
  private readonly steerQueue: { text: string; echoed: boolean; messageId?: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }[] = []
  private todos: TodoItemLite[] = []
  /** Shadow-git checkpoint anchors recorded per turn (Phase 12); drives revert(). */
  private checkpoints: SessionCheckpoint[] = []
  /**
   * Feature B compaction state, or null when never compacted. The full ledger (this.conversation)
   * is never folded; this metadata drives the transient per-turn LLM view built in
   * buildContextView(). Persisted + restored so the view survives a daemon restart.
   */
  private compaction: CompactionMeta | null = null
  /** Guards against concurrent memory-consolidation passes (fire-and-forget). */
  private consolidating = false
  private contextTokens: number | undefined = undefined
  private ineffectiveCompaction = 0
  private totalUsage: Usage | undefined = undefined
  private isThinking = false
  /** 待投递注册表（自唤醒 + 在飞的后台 Agent）。见 PendingInjection 的注释。 */
  private pendingInjections = new Map<symbol, PendingInjection>()
  /** 唤醒链的截止时刻（epoch ms）。null = 不限 —— 普通聊天会话即为 null，cron 会话由 fire() 设。 */
  private wakeupDeadline: number | null = null
  // Bumped by reset() ("new chat"). A running turn captures it at start and checks it before its
  // post-turn tail (idle-drain). If reset() ran mid-turn the epoch differs, so the tail bails
  // instead of re-populating the freshly-cleared state.
  private turnEpoch = 0
  private readonly pending = new Map<string, Pending>()
  private permSeq = 0
  /** In-memory session permission overlay (extra allow rules). Persisted across turns. */
  private readonly sessionAllow: string[] = []
  /**
   * ONE FileReadTracker for the whole session (matches the TUI's per-session tracker).
   * Passed to every runAgent turn and reused for the compaction memory flush so
   * read-before-write (the optimistic lock) survives across turns — otherwise runAgent
   * would allocate a fresh tracker per turn (agent.ts: `opts.tracker ?? createFileTracker()`)
   * and forget what was read last turn.
   */
  private readonly tracker: FileReadTracker = createFileTracker()

  private readonly listeners = new Set<(e: SessionEvent) => void>()

  /**
   * 会话诞生时的权限档。reset()（「新对话」）复位到它。
   *
   * 必须构造时**存下来**，不能事后回读 `this.settings.permissions.defaultMode` ——
   * setPermissionMode 就地改的正是那个字段，回读只会拿到用户最后一次点的档，
   * 「新对话复位」就成了空操作。
   */
  private readonly bootPermissionMode: PermissionMode
  /** 全自主档下被自动放行的调用数（含子代理内部的）。常驻横幅的诚实计数。 */
  private autoAllowedCount = 0

  constructor(opts: SessionManagerOptions) {
    // Spec §9's "client uninitialised → emit error, reject" row is unreachable by
    // construction: client is a required (non-null) constructor arg, so no runtime guard.
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.client = opts.client
    this.registry = opts.registry
    this.settings = opts.settings
    this.systemPrompt = opts.systemPrompt
    this.policy = opts.permissionPolicy
    this.bootPermissionMode = opts.permissionPolicy.config.defaultMode
    this.kind = opts.kind
    this.snapshotStore = opts.snapshotStore
    this.conversation = opts.conversation ?? new Conversation()
    this.checkpoints = opts.checkpoints ?? []
    this.compaction = opts.compaction ?? null
    this.createdAt = opts.createdAt ?? new Date().toISOString()
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    this.currentProviderId = opts.providerId ?? 'unknown'
    this.createClient = opts.createClient ?? createModelClient
    this.titleClient = opts.titleClient
    this.titleModel = opts.titleModel
    this.imageClient = opts.imageClient
    this.imageModel = opts.imageModel
    this.readImageBase64 = opts.readImageBase64
    this.expandAttachments = opts.expandAttachments
    this.titleSettled = !!opts.titleAlreadySet
    // Initialise totalUsage from the conversation only if there is prior usage.
    // Conversation.totalUsage always returns a Usage object (never undefined), so
    // we leave totalUsage as undefined when the conversation is brand-new (all zeros).
    const usage = this.conversation.totalUsage
    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.totalUsage = usage
    }

    // Register session-scoped tools (Agent, TodoWrite, ScheduleWakeup) from the capability list. They wire here,
    // not in createSession, because they need manager-private state — the live client, the
    // permission flow, the shared sessionAllow, the todo sink (see SessionCapabilityContext for
    // per-field semantics). The `registry.get(name)` guard keeps this idempotent (a re-used
    // registry already holding a tool isn't double-registered).
    const capabilityCtx: SessionCapabilityContext = {
      registry: this.registry,
      getClient: () => this.client,
      getSystemPrompt: () => this.systemPrompt,
      settings: this.settings,
      sessionAllow: this.sessionAllow,
      canUseTool: this.canUseTool,
      onAutoAllow: this.onAutoAllow,
      setTodos: (todos) => this.setTodos(todos),
      scheduleWakeup: (delayMs, message) => this.scheduleWakeup(delayMs, message),
      startBackgroundAgent: (description) => this.startBackgroundAgent(description),
    }
    for (const make of SESSION_CAPABILITY_TOOLS) {
      const tool = make(capabilityCtx)
      if (this.registry.get(tool.name)) {
        // Fresh registries never hit this. If the name is already taken — e.g. an extra tool
        // from registerExtraTools (which now runs before this loop) claimed it — skip but warn:
        // silently shadowing a built-in session tool would be undebuggable.
        console.warn(`[zuse-server] 会话工具 ${tool.name} 名称已被占用，跳过内置注册（可能被 registerExtraTools 的工具遮蔽）`)
        continue
      }
      this.registry.register(tool)
    }
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        // A bad listener must not break orchestration.
      }
    }
  }

  /** Test-only hook used by unit tests to drive emit() before submit() exists. */
  private _emitForTest(e: SessionEvent): void {
    this.emit(e)
  }

  /**
   * Tear a turn down before runAgent runs (pre-send bail paths in submit()): clear the
   * thinking/abort state, optionally emit a leading event (e.g. 'aborted'), emit turn-end, then —
   * unless this is a resend — drain any queued steer as its own follow-up turn. Mirrors the
   * post-turn finally + idle-drain tail. Callers that must emit BEFORE the state reset (e.g. the
   * non-vision 'error' bail) emit it themselves and pass preEmit=undefined.
   */
  private async endTurnEarly(preEmit: SessionEvent | undefined, isResend: boolean): Promise<void> {
    this.isThinking = false
    this.abort = null
    if (preEmit) this.emit(preEmit)
    this.emit({ type: 'turn-end' })
    if (!isResend) await this.drainSteerAsFollowUp()
  }

  /** Test-only seam: seed contextTokens high to exercise the pre-turn auto-compaction trigger. */
  private _setContextTokensForTest(n: number): void {
    this.contextTokens = n
  }

  // （曾有 `setPermissionPolicy(p) { this.policy = p }` —— 2026-08-14 删。零调用方，
  //   连测试都没有，而且它是个**陷阱**：`createSession` 写的是 `config: settings.permissions`
  //   （无 spread），所以 `policy.config` 与 `this.settings.permissions` 是**同一个对象**；
  //   紧邻的 `setPermissionMode` 注释专门论证了「为什么必须就地写、不能替换对象」——
  //   判定链两条入口（runAgent 捕获的 this.settings / canUseTool 读的 this.policy.config）
  //   都得看到新值。而这个方法干的恰恰是整个替换 `this.policy`，一调别名就断，
  //   表现为「权限档改了一半」。删的是一个名字看起来最该用的错误 API。）

  /** 当前权限档。交互式会话下 policy.config **就是** settings.permissions，两者恒同。 */
  getPermissionMode(): PermissionMode {
    return this.policy.config.defaultMode
  }

  /**
   * 切换本会话的权限档（界面上的「询问 / 自动接受编辑 / 全自主」）。会话级，不落盘。
   *
   * 【为什么必须就地写、不能替换对象】createSession 的交互式分支写的是
   * `config: settings.permissions`（**没有 spread**），于是 `policy.config` 与
   * `this.settings.permissions` 是**同一个对象**。判定链有两条入口都要看到新值：
   *   - 交互回合：runAgent 捕获 `this.settings` 对象引用，permission.decide() 每次现读
   *     `settings.permissions.defaultMode`；
   *   - canUseTool 的非交互分支：读 `this.policy.config`。
   * 就地改一处，两条自动同步。若改成 `this.settings = { ...this.settings, permissions: {…} }`，
   * 别名被打断 —— 交互路径读新值、policy.config 还指着旧对象，静默分叉。
   * `settings` 字段的 `readonly` 是刻意保留的：它让上面那种写法编译不过。
   */
  setPermissionMode(mode: PermissionMode): void {
    // 非交互（cron）会话拒绝切换。它的 permissions 是**克隆**的（createSession 的
    // 非交互分支带 spread），改 settings.permissions 根本传不到 policy.config；
    // 而 wsServer 接受任意 ?session=<id>，一个被网页接管的 cron 会话若能被切档，
    // 等于让无人值守的定时任务遵守某人几周前随手点的 UI 开关。
    if (!this.policy.interactive) {
      throw new Error('该会话为非交互会话（如定时任务），不支持切换权限模式')
    }
    if (this.settings.permissions.defaultMode === mode) return
    this.settings.permissions.defaultMode = mode

    // 切到全自主时，已 park 在 this.pending 的权限卡要一并结算为 allow：切换对**在飞**的
    // 判定立即生效（decide 每次现读），但已经停在 canUseTool 里等人点的那张卡不会被重新判定 ——
    // 不结算的话，用户按下「全自主」后屏幕上那张卡还杵着等他点，正是他按这个开关想摆脱的东西。
    // 写法与 reset() 里结算 'deny' 的那段同款。反方向（切回询问）不需要回溯：
    // 已经放行跑掉的调用追不回来，也不该把新的确认凭空补出来。
    if (mode === 'bypass') {
      for (const [id, p] of this.pending) {
        // **「必须确认」档的卡片不能被这次切换按掉。**
        //
        // `decide()` 那边已经把这一档排在 bypass 之前了，但那只挡住**新**的调用；
        // 屏上**已经在等**的卡片走的是这条路 —— 上层替用户按了「允许」，
        // 于是只测 `decide()` 的用例会绿、而真系统漏。这正是本仓那句
        // 「测试绿 ≠ 能用」的教科书形状，独立评审就是这么抓出来的。
        if (p.mustConfirm === true) continue
        p.resolve('allow')
        this.emit({ type: 'permission-resolved', id, verdict: 'allow' })
        // 这些也要计入横幅：它们**正在**问你，是这次切换替你按掉的 —— 恰恰是「你少点了
        // 多少次确认」里最实在的那几次。它们走不到 onAutoAllow（闸门早已放行进了 ask
        // 分支、在这里等结果），漏加的话真浏览器上会看到「按下全自主、卡片消失、数字不动」。
        this.autoAllowedCount++
        // **逐条删，不能 `clear()`。** 原来这里是循环后一把 clear —— 加了上面那条
        // `continue` 之后，被跳过的卡会**既不被结算、又被清出待决表**：
        // 那个回合从此永远挂在 canUseTool 的 await 上，而用户再也点不到那张卡。
        // 我的测试就是这么抓到的（「卡片被移出了待决表 —— 用户再也点不到它」）。
        this.pending.delete(id)
      }
    }
    this.emit({ type: 'permission-mode-changed', mode, autoAllowedCount: this.autoAllowedCount })
  }

  /**
   * 全自主档决定性地放行了一次调用（core 的闸门回调，子代理内部的调用也走这里）。
   * 只在「换成询问档就会被拦下来问」时计数 —— 否则只读工具、allow 表里的调用也会被算进去，
   * 横幅上那个数字就不再是「你少点了多少次确认」，而是一个没人看得懂的活跃度指标。
   */
  private onAutoAllow = (toolName: string, specifier: string | null): void => {
    const tool = this.registry.get(toolName)
    if (!tool) return
    // 反事实：把档位换成 'default'（询问）重跑一次纯函数判定。decide 无副作用，可随便算。
    const asked = decide(
      tool,
      specifier,
      { ...this.settings, permissions: { ...this.settings.permissions, defaultMode: 'default' } },
      this.sessionAllow,
      this.cwd,
    ).decision
    if (asked === 'allow') return
    this.autoAllowedCount++
    this.emit({ type: 'permission-mode-changed', mode: this.getPermissionMode(), autoAllowedCount: this.autoAllowedCount })
  }

  /** 当前模型的上下文窗口大小(token);供前端算 ctx 占用百分比。 */
  private ctxWindow(): number {
    return resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
  }

  getConversation(): Conversation {
    return this.conversation
  }

  /** Feature B: current compaction state (summary + cut), or null. Persisted by SessionService. */
  getCompaction(): CompactionMeta | null {
    return this.compaction
  }

  /**
   * The conversation to send to the LLM this turn (feature B). With no compaction it IS the full
   * ledger (unchanged behavior). With compaction it's a transient view
   * `[framed summary, ...ledger.slice(cutIndex)]`, rebuilt each turn. applyCompaction seeds the
   * view with the ledger's usage, so we re-seed it to zero: the turn's usage then lands only on
   * the view and submit() folds it back onto the ledger, which stays the authoritative tally.
   */
  private buildContextView(): Conversation {
    const c = this.compaction
    if (c === null) return this.conversation
    // Pass emptyUsage() into applyCompaction so it stamps the framed view directly — avoids the extra
    // deep-clone (framed.getMessages()) that previously existed only to reset totalUsage to zero.
    return applyCompaction(this.conversation, c.summaryText, c.cutIndex, emptyUsage())
  }

  getCheckpoints(): SessionCheckpoint[] {
    return [...this.checkpoints]
  }

  getCreatedAt(): string {
    return this.createdAt
  }

  /** 会话类别（'cron' 或 undefined）。SessionService.persist 据此写入 SessionRecord.kind。 */
  getKind(): 'cron' | undefined {
    return this.kind
  }

  getModelId(): string {
    return this.client.getModel()
  }

  /**
   * Kick off small-model title generation from the first user message text, ONCE
   * per session. Triggered by submit() the moment the message is sent — it runs in
   * parallel with the turn (no wait for the assistant reply) and, on success, emits
   * `title-changed` so connected clients update live. Fire-and-forget; never throws.
   *
   * Guarded by titleSettled (a title already exists — incl. restored sessions) and
   * titlePending (a call is in flight). A failed/empty generation leaves titleSettled
   * false so a later message can retry; deriveTitle remains the persisted fallback.
   */
  private kickTitleGeneration(text: string): void {
    if (this.titleSettled || this.titlePending) return
    if (!this.titleClient || !this.titleModel) return
    if (!text.trim()) return
    this.titlePending = true
    void (async () => {
      try {
        const title = await generateSessionTitle(this.titleClient!, this.titleModel!, text)
        if (title) {
          this.titleSettled = true
          this.emit({ type: 'title-changed', title })
        }
      } catch {
        // value-add only; never surface
      } finally {
        this.titlePending = false
      }
    })()
  }

  // （曾有 `markTitleSettled()` —— 2026-08-14 删。注释写着「Test/seed hook」但**零调用方**，
  //   连测试都没有 —— 注释在说谎。它的职责已经被 `createSession` 的 `titleAlreadySet` 接管。）

  getState(): SessionSnapshot {
    const pendingPermissions: PendingPermissionLite[] = [...this.pending.entries()].map(([id, p]) => ({
      id,
      req: p.req,
    }))
    return {
      sessionId: this.sessionId,
      isThinking: this.isThinking,
      model: this.client.getModel(),
      modelProviderId: this.currentProviderId,
      cwd: this.cwd,
      totalUsage: this.totalUsage,
      contextTokens: this.contextTokens,
      contextWindow: this.ctxWindow(),
      todos: this.todos,
      backgroundAgents: this.backgroundAgentLabels(),
      pendingPermissions,
      permissionMode: this.getPermissionMode(),
      // 非交互会话（cron）切了也不生效 —— 见 setPermissionMode 的注释。前端据此隐藏控件，
      // 而不是让它显示一个点了没反应（或更糟：显示了一个假档位）的开关。
      permissionModeEditable: this.policy.interactive,
      autoAllowedCount: this.autoAllowedCount,
      messageCount: this.conversation.length,
      messages: this.projectMessages(),
      checkpoints: this.checkpoints.map((c) => ({ id: c.hash, label: c.label })),
    }
  }

  /**
   * Project the committed conversation into wire-shaped SnapshotMessages so a late-
   * joining client can render the full history on attach. Each ContentBlock maps to a
   * SnapshotPart; unknown block kinds are skipped (a message with no mappable blocks
   * still emits {role, parts:[]} to preserve user/assistant ordering). tool_result blocks
   * carry no tool name in the core ContentBlock, so name is '' here.
   */
  private projectMessages(): SnapshotMessage[] {
    const out: SnapshotMessage[] = []
    this.conversation.getMessages().forEach(({ id, role, content, steer, attachments, interrupt }, i) => {
      // A message is an interrupt marker if it carries the structural flag (new messages) OR its
      // content is exactly a marker text (legacy: markers committed before the flag existed — this
      // keeps historical sessions rendering as a system notice instead of leaking the raw marker text
      // now that the web side is flag-only). The text-content match is a bounded migration bridge.
      const isInterrupt = interrupt === true || content.some((b) => b.type === 'text' && (b.text === INTERRUPT_MARKER || b.text === INTERRUPT_MARKER_TOOL_USE))
      const parts: SnapshotPart[] = []
      for (const block of content) {
        if (block.type === 'text') {
          // Interrupt-marker text is model-facing ledger scaffolding (staged so the model sees the
          // turn was cut short), not display content — the SnapshotMessage's `interrupt` flag already
          // tells the client to render this as a system notice, so omit the raw marker text as a part.
          if (isInterrupt && (block.text === INTERRUPT_MARKER || block.text === INTERRUPT_MARKER_TOOL_USE)) continue
          // Fix A: submit() prefixes the model's userText with `[YYYY-MM-DD HH:MM] `; that
          // prefix lives in the committed ledger, so restoring user messages from the snapshot
          // would surface it (the live path renders raw text). Strip exactly that one leading
          // pattern, and only from user text — never touch assistant text. (Image descriptions are
          // no longer baked into user text — both routes materialize via expandAttachments at send
          // time — so there is no <uploaded-images> block to strip here anymore.)
          const text = role === 'user' ? stripUserStamp(block.text) : block.text
          parts.push({ kind: 'text', text })
        } else if (block.type === 'tool_use') {
          parts.push({ kind: 'tool-use', id: block.id, name: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          let output = Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : String(block.content)
          // Strip any steer injection folded into this tool_result by EXACT text (from the message's
          // structural `steer` field, not by sniffing) so the scaffolding doesn't show in the card.
          for (const s of steer ?? []) output = output.split(steerFoldSuffix(s)).join('')
          parts.push({ kind: 'tool-result', id: block.tool_use_id, name: '', output, isError: block.is_error ?? false })
        }
        // Unknown block kinds are intentionally skipped.
      }
      // Fix B: a checkpoint anchors before a user turn, so its messageIndex == this user
      // message's ledger index. Attach the hash so the web can render a per-message revert.
      // Match by index regardless of role (only user turns will match by construction).
      const checkpointId = this.checkpoints.find((c) => c.messageIndex === i)?.hash
      // Carry the message's image attachments (route/description; no base64) so the client can render
      // an image thumbnail row. Structurally identical to protocol's MessageAttachment → assign directly.
      out.push({ id, role, parts, interrupt: isInterrupt || undefined, checkpointId, attachments })
      // Emit each folded steer as its own "↪ 插话" bubble after the carrier message. Driven by the
      // structural `steer` field — a message that merely CONTAINS the marker text (e.g. a Read of
      // steer.ts) has no such field and is left untouched. Give each bubble a stable id derived from
      // the carrier message's id (they have no ledger id of their own).
      ;(steer ?? []).forEach((s, n) => out.push({ id: `${id}#steer${n}`, role: 'user', parts: [{ kind: 'text', text: s }], steer: true }))
    })
    return out
  }

  /**
   * Resolve a pending interactive permission request.
   * Argument order: (id, verdict) — id first. Note: the sibling TUI API uses
   * verdict-first order; callers must not swap the arguments.
   */
  resolvePermission(id: string, verdict: PermissionVerdict): void {
    // NOTE on session-scope: a verdict of allow_session/allow_persist makes core's
    // gateAndRunTool push the matched rule into this.sessionAllow (the same array we
    // pass to runAgent every turn), so the rule auto-allows identical calls for the rest
    // of the session. allow_persist additionally writes the rule to disk via
    // `persistAllowRule` below — which writes to THIS SESSION's root, not the daemon's.
    if (verdict !== 'allow' && verdict !== 'deny' && verdict !== 'allow_session' && verdict !== 'allow_persist') return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(verdict)
    this.emit({ type: 'permission-resolved', id, verdict })
  }

  /**
   * 「总是允许」落盘 —— **写到本会话自己的目录，不是 daemon 的项目根**。
   *
   * ## 为什么要覆盖 core 的缺省
   *
   * core 的缺省是 `appendAllowRule(rule)`（`agent.ts`），它内部走
   * `findProjectRoot()`，而那个函数是从 **daemon 进程的 cwd** 往上找的，与会话无关。
   * 于是：在 `D:\别的项目` 里开的会话，用户点一次「总是允许」，规则被写进
   * **zuse 仓库自己的** `.zuse/settings.local.json`，从此**对所有会话永久生效**。
   *
   * 这不是「配置不够新」，是**静默的权限累积**：用户以为自己在给「这个项目」放行，
   * 实际是给所有项目、永久放行。而按钮上写的是「总是允许」——
   * 对「总是」的合理理解是「在这个项目里总是」。
   *
   * ## 只改写、不改读（刻意的分步）
   *
   * 读路径（`loadSettings()`）本轮**不动**。独立评审指出：让会话根的
   * `.zuse/settings.json` 成为受信配置层会**造出一个新的、更大的洞** ——
   * 那个文件**不在 .gitignore 里**（只有 `.local.*` 是），也就是随仓库分发的。
   * 而它能设 `permissions.defaultMode: "bypass"`（关掉全部 deny/ask）和
   * `providers.default.baseURL`（把整段对话导向别人的 endpoint）。
   * 「clone 一个仓库 → 在里面开会话」就成了一条提权 + 外传的路。
   * 那需要一道显式的「信任这个目录」闸，是独立的一轮。
   *
   * 先修写这一半：它是两者中**更严重**的那个（安全阀被静默拆掉并扩散
   * vs 安全阀没生效），且**零兼容性破坏、不引入任何信任边界**。
   */
  private persistAllowRule(rule: string): void {
    try {
      appendAllowRule(rule, join(this.cwd, '.zuse', 'settings.local.json'))
    } catch (err) {
      // 会话目录可能不可写（只读挂载、无权限）。**不要静默吞掉** ——
      // 用户点了「总是允许」却什么都没发生，下次还会再弹，而他不知道为什么。
      // 规则仍然在 sessionAllow 里（core 已经 push 过），所以本会话内照常生效。
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[zuse] 「总是允许」没能写入 ${this.cwd}：${msg}。本条规则只在当前会话内有效。`)
    }
  }

  /** Provided to runAgent. Only invoked for 'ask'-classified tool calls. Must be concurrency-safe. */
  private canUseTool = (req: PermissionRequest): Promise<PermissionVerdict> => {
    if (!this.policy.interactive) {
      // Non-interactive: delegate to core's canonical decide() so that:
      // - Bash compound commands are subcommand-split (no prefix-bypass of "safe && evil")
      // - deny list is honored (deny has higher priority than allow)
      // - defaultMode / bypass are respected
      // No human is attached, so anything not auto-allowed (ask) becomes deny.
      const tool = this.registry.get(req.toolName)
      if (!tool) return Promise.resolve('deny')
      const settings = { ...this.settings, permissions: this.policy.config }
      const { decision } = decide(tool, req.specifier, settings, [], this.cwd)
      return Promise.resolve(decision === 'allow' ? 'allow' : 'deny')
    }
    // Interactive: park the request; a connected client will resolve it via resolvePermission().
    // NOTE: pending requests are NOT torn down when a client disconnects — by design, a
    // dropped client's request stays pending and is resolved on reconnect. Teardown is
    // intentionally deferred to the session-lifecycle / transport layer.
    const id = `perm-${++this.permSeq}`
    return new Promise<PermissionVerdict>((resolve) => {
      this.pending.set(id, { req, resolve, mustConfirm: isMustConfirm(req.toolName, req.specifier, this.cwd) })
      this.emit({ type: 'permission-request', id, req })
    })
  }

  /**
   * Queue a mid-turn steer message; runAgent consumes it after each tool batch. A steer carrying
   * attachments (images/pastedTexts) can't fold into a running tool_result, so it rides along
   * un-folded and is delivered as its own follow-up turn once the current turn ends (see
   * consumeSteer's filter and drainSteerAsFollowUp) — reusing submit's existing attachment
   * handling instead of duplicating it here.
   */
  steer(text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[], opts?: { messageId?: string }): void {
    const trimmed = text.trim()
    const hasAttachments = (images?.length ?? 0) > 0 || (pastedTexts?.length ?? 0) > 0 || (files?.length ?? 0) > 0
    // An empty text-only interjection is a no-op — but an attachments-only one still has something
    // to deliver, so only bail when there's neither text nor attachments.
    if (trimmed === '' && !hasAttachments) return
    this.steerQueue.push({ text: trimmed, echoed: false, messageId: opts?.messageId, images, pastedTexts, files })
  }

  /** Cheap liveness check — true while a turn is running. Lets callers avoid a full getState()
   *  projection just to read this flag (e.g. the ws steer/idle routing). */
  isBusy(): boolean {
    return this.isThinking
  }

  /** Abort the in-flight turn, if any. Returns true if a turn was aborted. */
  interrupt(): boolean {
    // 在飞的后台 Agent 跑在**本回合的** signal 上（runAgent 把回合 signal 放进 ToolContext，
    // Agent 工具原样传给子代理），所以 abort 就是把它们一起打断了 —— 它们的产出确实无处可去。
    //
    // 必须显式作废，不能指望回调自己识别：core 把 abort 转成 error 事件后 **return 而不是 throw**
    // （agent.ts 的 `if (errored) … return`），于是 executeSubAgent() 是 **resolve** 的，
    // 完成回调走的是成功分支。不摘登记的话，用户按下停止 → 会话已闲 → submit() → 平白起一整轮
    // 新的模型回合，把整个上下文重发一遍。用户按那个键正是为了别再花钱。
    //
    // 只作废 background：待触发的自唤醒是个定时器，与本回合的 signal 无关，
    // 停止当前回合不该顺手取消它。
    this.cancelInjections('background')
    if (this.abort) {
      this.abort.abort()
      return true
    }
    return false
  }

  /**
   * "New chat": forget the conversation and ALL transient turn state while keeping the
   * environment (model client, tool registry, settings, systemPrompt, cwd, provider). Any
   * in-flight turn is interrupted first so it stops dirtying state we are about to clear.
   * After clearing, emits a todos-update with an empty list so connected clients drop their
   * todos panel; future snapshots will report messageCount 0, so no extra event is needed
   * for the conversation itself (the frontend resets its message view locally).
   */
  reset(): void {
    // Abort any running turn BEFORE clearing — an in-progress turn would otherwise keep
    // writing into the conversation/usage/checkpoints we are about to throw away.
    this.interrupt()

    // Settle any parked permission prompts with 'deny' BEFORE dropping them. interrupt()'s
    // abort signal does not reach canUseTool's awaited promise, so merely clearing this.pending
    // would orphan the resolve handle and hang the aborted turn's async stack forever (its
    // finally never runs → this.abort stays dirty). Resolving 'deny' lets the gate return a
    // decline so the turn unwinds naturally against the already-aborted signal.
    for (const [id, p] of this.pending) {
      p.resolve('deny')
      this.emit({ type: 'permission-resolved', id, verdict: 'deny' })
    }
    this.pending.clear()

    this.conversation = new Conversation()
    this.todos = []
    this.totalUsage = undefined
    this.contextTokens = undefined
    this.checkpoints = []
    this.steerQueue.length = 0
    // 待投递与唤醒额度都要清：待投递不清，旧会话的自唤醒/后台 Agent 产出会打到这个全新的空会话上；
    // 额度不清，被人接管并「新对话」的 cron 会话会永久留着一个早已过期的 deadline，
    // 此后每次 scheduleWakeup 都返回 false（真正的封顶兜底是 fire() 的 finally→release）。
    this.cancelAllInjections()
    this.wakeupDeadline = null
    this.sessionAllow.length = 0
    this.badModels.clear()
    this.ineffectiveCompaction = 0
    // Feature B: compaction is now a separate field (not inside the ledger), so clearing the
    // conversation no longer erases it — a fresh session would otherwise inherit the old summary.
    this.compaction = null
    this.isThinking = false
    // Invalidate any in-flight turn's post-turn tail: its finally/drain run async AFTER this reset,
    // and would otherwise re-queue the discarded steer + re-emit the old todos onto the blank session.
    this.turnEpoch++

    // 权限档复位到会话诞生时的档。本方法已经清了 sessionAllow（上面那行）—— 也就是说
    // 「新对话应当丢弃本会话累积的放行」本就是它的价值取向；把 UI 上点出来的全自主留下来，
    // 与那条取向直接矛盾，而且是往「安全姿态被静默保留」的方向矛盾。
    // 只在交互式会话上做：非交互会话的档位由 policy.config 决定，settings 那份从来不参与判定。
    if (this.policy.interactive && this.settings.permissions.defaultMode !== this.bootPermissionMode) {
      this.settings.permissions.defaultMode = this.bootPermissionMode
    }
    this.autoAllowedCount = 0
    this.emit({ type: 'permission-mode-changed', mode: this.getPermissionMode(), autoAllowedCount: 0 })

    this.emit({ type: 'todos-update', todos: [] })
  }

  /**
   * True when the last measured context usage crossed the compaction threshold and we're not in an
   * ineffective-compaction backoff. SYNC so callers can gate the await — a no-op turn then stays
   * fully synchronous up to `this.abort = controller`, preserving interrupt()'s ordering.
   */
  private overContextThreshold(): boolean {
    const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
    return (this.contextTokens ?? 0) > windowSize * COMPACTION_THRESHOLD && this.ineffectiveCompaction < 2
  }

  /** Run one auto-compaction, surfacing the result as a memory-notice; a failure is warned and
   *  swallowed (never blocks a turn). Callers gate with overContextThreshold() first. */
  private async maybeAutoCompact(signal?: AbortSignal): Promise<void> {
    try {
      this.emit({ type: 'memory-notice', text: await this.compact(signal) })
    } catch (err) {
      if (signal?.aborted) return   // user Stop mid-compaction — the turn already emits 'aborted'; no scary warning
      this.emit({ type: 'warning', message: `auto-compaction failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /**
   * Manual compaction (web `/compact`). Unlike the auto path this ignores the context threshold —
   * the user asked for it. Locks the composer for the duration (turn-start/turn-end, so a concurrent
   * submit is rejected) and is Stop-interruptible (its AbortController is this.abort while running).
   * Result surfaces as a memory-notice; a failure warns; an interrupt emits 'aborted'.
   */
  async compactNow(): Promise<void> {
    if (this.isThinking) { this.emit({ type: 'warning', message: '回合进行中,无法手动压缩' }); return }
    this.isThinking = true
    this.emit({ type: 'turn-start', isResend: false })
    const controller = new AbortController()
    this.abort = controller
    try {
      this.emit({ type: 'memory-notice', text: await this.compact(controller.signal) })
    } catch (err) {
      if (controller.signal.aborted) this.emit({ type: 'aborted' })
      else this.emit({ type: 'warning', message: `压缩失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      this.isThinking = false
      this.abort = null
      this.emit({ type: 'turn-end' })
    }
  }

  /**
   * Failover core, shared by submit()'s post-turn resend and compact()'s summarize retry: mark the
   * current model bad for `cat`, pick the next available model in the same provider, and hot-swap
   * this.client to it. Returns {fromModel, toModel, reason} on success, or null when there is no
   * target (dialog failover mode, or every model already bad). Does NOT emit — the caller emits
   * 'failover' / 'model-select-needed' as appropriate.
   */
  private failoverToNext(cat: ErrorCategory): { fromModel: string; toModel: string; reason: string } | null {
    const pid = this.currentProviderId
    const fromModel = this.client.getModel()
    // chatModelNames 而非 modelNames：降级绝不能挑中 ocr/tts/embedding 这类没有对话调用路径的
    // 模型（真实事故：切到 qwen3.5-ocr，会话此后每句话都回 `{"text":"..."}`）。见 settings.ts。
    const models = chatModelNames(this.settings.providers[pid])
    // Mark bad: auth invalidates the whole provider (shared key); others only this model.
    for (const k of badKeysForFailure(pid, fromModel, cat, models)) {
      this.badModels.set(k, k === modelKey(pid, fromModel) ? cat : 'auth')
    }
    const action = decideFailover({
      category: cat,
      mode: resolveFailoverMode(this.settings),
      providerId: pid,
      models,
      currentModel: fromModel,
      bad: new Set(this.badModels.keys()),
    })
    if (action.kind !== 'retry') return null
    this.client = this.createClient(getProviderConfig(this.settings, pid), action.model)
    const reason = cat === 'auth' ? 'API key invalid' : cat === 'quota' ? 'quota exhausted' : 'model unavailable'
    return { fromModel, toModel: action.model, reason }
  }

  async compact(signal?: AbortSignal): Promise<string> {
    const prevCut = this.compaction?.cutIndex ?? 0
    const prevSummary = this.compaction?.summaryText
    // Find the cut on the current in-context view ([summary?, ...ledger.slice(prevCut)]), not on
    // the full ledger — we compact what the model actually sees.
    const viewMessages = this.buildContextView().getMessages()

    // Tail-budget protection scaled to the context window; falls back to a fixed
    // turn count when the budget path finds no cut.
    const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
    const tailBudgetChars = Math.round(windowSize * COMPACTION_THRESHOLD * TAIL_BUDGET_RATIO * 4)
    const viewCut = findCompactionCutByBudget(viewMessages, tailBudgetChars) ?? findCompactionCut(viewMessages)
    if (viewCut === null) return 'History too short; nothing to compact.'

    // viewMessages[0] is the prior summary when already compacted (foldStart=1); the new turns to
    // fold are viewMessages[foldStart..viewCut). If that's empty there's nothing new to summarize —
    // bail BEFORE emitting compaction events or re-running the summary, so a no-op /compact doesn't
    // burn a model call, re-store the (possibly stale/fallback) summary, or misreport "已压缩".
    const foldStart = this.compaction !== null ? 1 : 0
    if (viewCut - foldStart <= 0) return '没有新内容需要压缩(距上次压缩以来没有足够的新消息)。'

    const keptCount = viewMessages.length - viewCut   // recent messages kept verbatim after the cut
    this.emit({ type: 'compaction-start', keep: keptCount })

    // TodoWrite state injected into the summary prompt so Pending Items survives.
    const todoIcons: Record<TodoItemLite['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }
    // 分组必须进摘要，否则压缩之后模型就忘了分组，下一次 TodoWrite 退回平表 ——
    // 用户看到的是「分了几组，聊着聊着组没了」。格式与 TodoWrite 的回显完全一致
    // （同一个 groupTodos + 同样的 `[组名]` 分段），别在这儿另发明一套。
    const todoState = this.todos.length > 0
      ? groupTodos(this.todos)
          .flatMap(({ group, items }) => [
            ...(group === undefined ? [] : [`[${group}]`]),
            ...items.map((t) => `${todoIcons[t.status]} ${t.content}`),
          ])
          .join('\n')
      : undefined

    // Iterative summary: fold only the NEW turns since the last summary (viewMessages[foldStart..
    // viewCut); foldStart computed above). When a prior summary exists it occupies viewMessages[0].
    const toSummarize = viewMessages.slice(foldStart, viewCut)
    // Summarize WITH failover (B): on a quota/auth/unavailable error, swap to the next available
    // model (exactly what a turn does) and retry, instead of silently degrading. Only when no model
    // can serve it do we drop to the deterministic fallback — and flag it (A) below so the notice
    // isn't misreported as a clean success.
    let raw: string
    let usedFallback = false
    for (;;) {
      try {
        raw = await summarizeForCompaction(
          this.client,
          toSummarize,
          { model: this.client.getModel(), max_tokens: this.maxTokens },
          signal,
          prevSummary,
          todoState,
          { throwOnError: true },
        )
        break
      } catch (err) {
        if (signal?.aborted) throw err   // user Stop — let the caller surface 'aborted', don't degrade
        const cat = (err as { category?: ErrorCategory } | null)?.category
        const fo = cat && cat !== 'other' ? this.failoverToNext(cat) : null
        if (fo) {
          this.emit({ type: 'failover', fromModel: fo.fromModel, toModel: fo.toModel, reason: fo.reason })
          continue   // retry the summary on the newly-swapped model
        }
        // No model left / non-failover error. Feed the mechanical summary viewMessages[0..viewCut) —
        // i.e. INCLUDE the prior summary at viewMessages[0] (when foldStart=1). The model path carries
        // it via the prevSummary arg; the fallback has no such arg, so slicing from foldStart would
        // silently drop all earlier summarized context. slice(0, viewCut) == toSummarize when foldStart=0.
        raw = buildFallbackSummary(viewMessages.slice(0, viewCut), todoState)
        usedFallback = true
        break
      }
    }

    const { summary, candidates } = splitMemoryCandidates(raw)

    // Debounce: track savings; consecutive ineffective compactions disable auto-trigger.
    const savings = estimateCompactionSavings(viewMessages, viewCut, summary.length)
    if (savings.savingsRatio < 0.1) this.ineffectiveCompaction++
    else this.ineffectiveCompaction = 0

    // Translate the view-coordinate cut to a full-ledger index and store it as metadata — the
    // ledger is never folded. viewMessages[foldStart..] correspond to ledger[prevCut..].
    this.compaction = { summaryText: summary, cutIndex: prevCut + (viewCut - foldStart) }
    // Window usage is unknown post-compaction (next turn measures it); clear it so the
    // stale value cannot re-trigger auto-compaction.
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })
    // No checkpoint remap: the full ledger never folds, so checkpoint indices stay stable.

    // Memory flush (Phase 13): the summary request also extracted persistent facts;
    // persist them via the Memory tool. Failure is silent — flush is value-add and must
    // never drag down compaction itself (D5). Port of useConversation's flush block.
    let flushed = 0
    const memTool = this.registry.get('Memory')
    if (memTool && candidates.length > 0) {
      // Reuse the session-scoped tracker (one abort signal shared across the whole
      // flush; the signal is flush-scoped, not per-save).
      const flushSignal = new AbortController().signal
      for (const c of candidates) {
        try {
          const res = await memTool.run(
            { action: 'save', type: c.type, content: c.content, hook: c.hook },
            { cwd: this.cwd, signal: flushSignal, tracker: this.tracker, setCwd: () => {} },
          )
          if (!res.isError) flushed++
        } catch {
          // Flush is best-effort; one bad candidate must never break the rest.
        }
      }
    }

    // NOTE: reloading MEMORY.md into systemPrompt after compaction is deferred (the
    // server's systemPrompt is built by the transport/owner, not here).

    const flushSuffix = flushed > 0 ? `;已存 ${flushed} 条记忆` : ''
    // 只报事实,不报误导的"节省百分比"——那个比例(estimateCompactionSavings)只反映被折叠旧历史
    // 自身的收缩,不是总上下文降幅(保留的近期消息 + 系统提示才是剩余大头)。真实降幅看上下文计量条。
    // Fold count excludes the prior summary at viewMessages[0] (foldStart=1 on 2nd+ compaction),
    // so it reports real old messages folded, not viewCut which counts that summary too.
    const foldedCount = viewCut - foldStart
    const msg = `上下文已压缩:折叠 ${foldedCount} 条旧消息为摘要,保留最近 ${keptCount} 条${flushSuffix}`
    this.emit({ type: 'compaction-done', summaryText: summary })
    // A: only degrade to the mechanical summary when no model could serve it — and say so, so the
    // "已压缩" notice above isn't mistaken for a clean, model-generated summary.
    if (usedFallback) {
      this.emit({ type: 'warning', message: '⚠ 摘要生成失败(所有可用模型均不可用),已用机械兜底摘要,质量较差;模型恢复后可重新 /compact。' })
    }
    return msg
  }

  /**
   * Parsed fallback (I2): describe ONE image via the auxiliary image client. Sends a single message
   * carrying the image block + IMAGE_PROMPT + the user's question, collects the streamed text
   * (throwing on an error event, mirroring title.ts's collect loop), and returns the trimmed
   * description. Callers guard on imageClient/readImageBase64 presence; the `!` asserts are safe there.
   */
  private async describeImage(
    data: string,
    mediaType: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const request: Message[] = [{
      role: 'user',
      id: genMsgId(),
      content: [
        { type: 'image', source: { type: 'base64', mediaType, data } },
        { type: 'text', text: `${IMAGE_PROMPT}\n\n用户的问题：${question}` },
      ],
    }]
    let out = ''
    // 墙钟：底层 StreamIdleGuard 已有 120s 空闲兜底（stream-idle.ts），所以这里**不是**
    // 「否则永久挂起」，而是把识图这一路的反馈收紧到 60s —— 它只是主回合里的一个前置步骤，
    // 让用户为一张图干等两分钟不合理。代价写明：这是**墙钟**不是空闲计时，一个健康但慢的
    // 描述（自建 VL 模型 + 1024 tokens）会被它掐掉。本机 40KB 截图实测约 5s，留了一个数量级。
    const timeout = new AbortController()
    // 已经 abort 的 signal 不会再触发 'abort' 事件 —— 只 addEventListener 会**静默漏掉**它，
    // 于是用户按停之后才起跑的那张图仍会发出请求，把整个回合多拖 60s。
    // 同一个坑 stream-idle.ts:44 早就踩过并写对了，这里照抄它的形状。
    const onOuterAbort = (): void => timeout.abort()
    if (signal?.aborted) timeout.abort()
    else signal?.addEventListener('abort', onOuterAbort, { once: true })
    // 超时与「用户按停」必须分得开：前者是故障、要告诉用户，后者是用户自己的动作。
    // 用标志位而不是事后查 `timeout.signal.aborted` —— abort 会让 client 走它自己的
    // 中断分支 yield 一个 error 事件，循环是**抛出**退出的，事后那行代码根本到不了。
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; timeout.abort() }, IMAGE_DESCRIBE_TIMEOUT_MS)
    try {
      const events = this.imageClient!.sendMessages(
        request,
        { model: this.imageModel!, max_tokens: IMAGE_DESCRIPTION_MAX_TOKENS },
        undefined,
        timeout.signal,
      )
      for await (const e of events) {
        if (e.type === 'text-delta') out += e.text
        else if (e.type === 'error') throw new Error(e.message)
      }
    } catch (err) {
      // 超时时把 SDK 那句无信息量的 "Request was aborted." 换成人话 —— 否则用户看到的
      // 原因和自己按停时一模一样，又回到「分不清到底发生了什么」。
      if (timedOut) throw new Error(`识图模型 ${IMAGE_DESCRIBE_TIMEOUT_MS / 1000}s 内没有返回`)
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
    if (timedOut) throw new Error(`识图模型 ${IMAGE_DESCRIBE_TIMEOUT_MS / 1000}s 内没有返回`)
    return out.trim()
  }

  /**
   * Run ONE user turn: drive runAgent and forward its stream as SessionEvents
   * (tool output forwarded RAW — no truncation/spill; that is the frontend's job),
   * then emit usage/context, and always emit turn-end in finally.
   */
  async submit(text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[], opts?: { isResend?: boolean; echo?: boolean; messageId?: string }): Promise<void> {
    // Reject EXTERNAL concurrent submits while a turn runs. An isResend call is a
    // RECURSIVE re-entry from inside submit (failover resend) and must be allowed.
    if (this.isThinking && !opts?.isResend) {
      throw new Error('A turn is already in progress')
    }
    this.isThinking = true
    const epoch = this.turnEpoch // if reset() bumps this mid-turn, the post-turn tail below bails
    this.emit({ type: 'turn-start', isResend: !!opts?.isResend })
    // A steer that raced past turn-end is delivered as a normal turn (ws layer), but the client took
    // the steer path and rendered no bubble — echo it so its transient "queued" preview resolves.
    if (opts?.echo) this.emit({ type: 'user-echo', text, messageId: opts?.messageId ?? genMsgId(), attachments: echoAttachments(images, pastedTexts, files) })

    // Publish the abort controller SYNCHRONOUSLY, before any await below, so the Stop button works
    // during the pre-send / background-compaction waits too (interrupt() checks this.abort).
    const controller = new AbortController()
    this.abort = controller

    // Title generation fires the moment a message is sent (not on turn-end): generate
    // from this text in parallel with the turn, so the sidebar title updates without
    // waiting for the assistant reply. Guarded to run once per session; resends skip.
    if (!opts?.isResend) this.kickTitleGeneration(text)

    // Auto-compaction: the PRIMARY trigger is post-response (awaited before turn-end — see below), so
    // the next turn usually starts already compacted. This PRE-send call is the FALLBACK for a last
    // turn that ended over-threshold without compacting (restored session's first turn, or after an
    // ineffective-compaction backoff reset). Signal-bound so Stop can cancel it. Resends skip.
    if (!opts?.isResend && this.overContextThreshold()) await this.maybeAutoCompact(controller.signal)
    // If the user hit Stop DURING that pre-send compaction, end the turn cleanly here instead of
    // falling into runAgent with an already-aborted signal (which would emit a 'warning', not
    // 'aborted', leaving the web's "正在压缩…" notice stuck). 'aborted' clears that notice.
    if (controller.signal.aborted) {
      // A steer queued DURING that pre-send compaction must not linger in the queue — it would
      // otherwise fold into a later, unrelated turn (the exact bleed idle-drain prevents).
      // endTurnEarly drains it as its own follow-up turn, same as the post-turn path.
      await this.endTurnEarly({ type: 'aborted' }, !!opts?.isResend)
      return
    }

    // Image routing (I2): both routes are now materialized by ONE mechanism — expandAttachments at
    // send time — so the ledger's user text stays the user's original question (base64-free, no baked
    // descriptions). The split only decides the route tag stored on each attachment:
    //  - vision → DIRECT: attachments route:'direct'; expandAttachments reads each to a native image
    //    block on the request-only copy.
    //  - non-vision → PARSED fallback: each image is described by the auxiliary imageClient and the
    //    description is stored on the attachment (route:'parsed'); expandAttachments materializes it
    //    as a text block at send time. With no imageClient/readImageBase64 → cannot handle → error.
    // Either route needs expandAttachments wired; without it the image would be silently dropped, so
    // we refuse to send. No images → userAttachments stays undefined and the turn runs as before.
    let userAttachments: MessageAttachment[] | undefined
    // expandAttachments is forwarded UNCONDITIONALLY (not gated on this turn carrying new images):
    // history messages carry attachments too and must be re-materialized EVERY turn, or a follow-up
    // turn would silently drop the images from earlier turns. It is a no-op on messages without
    // attachments, so always forwarding is safe.
    const expandFn = this.expandAttachments
    if (images && images.length > 0) {
      const vision = resolveVision(this.settings, this.currentProviderId, this.client.getModel())
      if (vision) {
        // #8: without the expand hook wired, the direct route can't turn attachments into image
        // blocks — the image would be silently dropped. Refuse to send and surface an error instead
        // (mirrors the non-vision missing-dependency bail below).
        if (!this.expandAttachments) {
          this.emit({ type: 'error', message: '图片直传未就绪：服务未接线附件展开(expandAttachments)', category: 'other' })
          await this.endTurnEarly(undefined, !!opts?.isResend)
          return
        }
        userAttachments = images.map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType, route: 'direct' as const }))
      } else if (!this.imageClient || !this.readImageBase64) {
        // Non-vision main model and no parse fallback wired → cannot handle the image. Refuse to send.
        // Emit the error BEFORE the state reset (preserves prior ordering), then endTurnEarly tears down.
        this.emit({ type: 'error', message: '当前模型不支持图片，且未配置图片解析模型', category: 'other' })
        await this.endTurnEarly(undefined, !!opts?.isResend)
        return
      } else {
        // Describe each image via the auxiliary model, all in parallel (results aligned by index).
        // A single image's failure records an error string as its description (not aborting the
        // others). controller.signal 传给每一个 describeImage，它在内部与自己的墙钟合成一个
        // 派生 signal（见 describeImage）—— 用户按停仍然取消整批，但每张图另有 60s 上限。
        //
        // 失败**必须冒到用户面前**。真实事故：两张图里第二张解析失败，代码把异常吞掉换成
        // 一句「(图片解析失败)」塞给模型 —— 模型把这七个字当成图片内容，照着第一张图和聊天
        // 历史编了个说法，界面上看起来是一次完全正常的回答。用户事后问「它到底看见图没有，
        // 我没法判断」—— 这正是问题：**沉默让用户无从分辨模型看没看见**。
        // 所以这里收集失败原因，逐张具名 warning；描述里也带上原因，让模型知道那是错误而非内容。
        // 按图片下标记录，不是按失败先后 —— 这些 catch 是并行完成的，push 顺序取决于谁先挂，
        // 而警告的全部意义就是告诉用户「是哪几张」，顺序跟着界面上的顺序才读得懂。
        const failures: (string | undefined)[] = new Array(images.length).fill(undefined)
        const descriptions = await Promise.all(images.map((im, idx) =>
          this.readImageBase64!(im.id)
            .then(({ data, mediaType }) => this.describeImage(data, mediaType, text, controller.signal))
            .catch((err: unknown) => {
              const raw = err instanceof Error ? err.message : String(err)
              const reason = raw.length > IMAGE_FAILURE_REASON_CAP
                ? raw.slice(0, IMAGE_FAILURE_REASON_CAP) + '…'
                : raw
              failures[idx] = reason
              return `(图片解析失败：${reason})`
            }),
        ))
        // 中断导致的失败不算故障，不该弹警告 —— 是用户自己按的停。
        const failedList = images
          .map((im, idx) => ({ name: im.name, reason: failures[idx] }))
          .filter((f): f is { name: string; reason: string } => f.reason !== undefined)
        if (failedList.length > 0 && !controller.signal.aborted) {
          this.emit({
            type: 'warning',
            message: `以下图片解析失败，模型没有看到它们的内容：${
              failedList.map((f) => `「${f.name}」（${f.reason}）`).join('、')
            }`,
          })
        }
        // #5: the parallel describe round-trips just awaited above may have straddled a Stop. Re-check
        // the abort signal BEFORE building the context view / entering runAgent — otherwise a Stop
        // during description would fall through into a turn against an already-aborted signal (which
        // emits a bare 'warning', not 'aborted'). Mirror the pre-send compaction abort guard.
        if (controller.signal.aborted) {
          await this.endTurnEarly({ type: 'aborted' }, !!opts?.isResend)
          return
        }
        // Descriptions are NOT baked into user text; they ride the attachment (route:'parsed') and
        // expandAttachments materializes them as a text block at send time — same pipeline as direct.
        userAttachments = images.map((i, idx) => ({
          id: i.id, name: i.name, mediaType: i.mediaType, route: 'parsed' as const, description: descriptions[idx],
        }))
      }
    }

    // Pasted long text (I5a): each staged segment becomes a route:'pasted' attachment carrying the
    // full text inline. No vision/imageClient branching — expandAttachments materializes them as a
    // labeled text block at send time (same pipeline as images). Merge onto any image attachments.
    if (pastedTexts && pastedTexts.length > 0) {
      const pastedAtts: MessageAttachment[] = pastedTexts
        .filter((p) => (p.text ?? '').trim() !== '')
        .map((p, idx) => ({
          id: p.id, name: `粘贴文本 #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text,
        }))
      if (pastedAtts.length > 0) userAttachments = [...(userAttachments ?? []), ...pastedAtts]
    }

    // Uploaded files (I5b): each ref becomes a route:'file' attachment (id/name/mediaType only —
    // no text/description). expandAttachments materializes the path note at send time (same
    // pipeline as images/pastedTexts). Merge onto any image/pasted attachments.
    if (files && files.length > 0) {
      const fileAtts: MessageAttachment[] = files.map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const }))
      userAttachments = [...(userAttachments ?? []), ...fileAtts]
    }

    // Build the LLM context view AFTER auto-compaction (which may have updated this.compaction).
    // With no compaction this returns the full ledger itself (unchanged behavior); otherwise a
    // transient [summary, ...tail] view whose new tail is folded back into the ledger after the
    // turn. viewPreLen marks the view's length before runAgent appends this turn's messages.
    const conversation = this.buildContextView()
    const viewPreLen = conversation.length

    // Runtime self-awareness: append the LIVE model + context window to the (cached) system prompt
    // so the model always knows its current runtime. Overrides stale knowledge from earlier in the
    // chat — e.g. after an automatic failover swapped the model, or if the window was misstated.
    // Stable between failovers, so the system block stays byte-identical turn-to-turn (cache-friendly)
    // and only changes when the model actually does. (Surface web/tui lives in this.systemPrompt.)
    const windowK = Math.round(this.ctxWindow() / 1000)
    const systemWithRuntime =
      `${this.systemPrompt}\n\n## Current runtime (authoritative)\n` +
      `Model: ${this.client.getModel()}\n` +
      `Context window: ~${windowK}k tokens.\n` +
      `Trust these over any model name or context-window size mentioned earlier in this conversation — ` +
      `earlier values can be stale (e.g. after an automatic model failover).\n\n` +
      // Environment self-awareness (B): tell the model HOW images reach it, so it never has to guess
      // its own vision capability (unreliable) or claim it "can't see images". Static → cache-friendly.
      `## 图片输入\n` +
      `用户可以上传图片。zuse 会按当前模型的能力处理：若模型支持视觉，图片会作为原生图像内容直接发给你，你能直接看到并分析；` +
      `若不支持，zuse 会用单独配置的图像解析模型把图片转成文字描述后随消息提供给你（标注为「由图像解析模型转述，非用户原话」，多图会编号为「图片1／图片2…」）。` +
      `两种情况下用户界面都显示他们上传的原图缩略图。因此当消息附带图片或图片描述时，直接据此作答，不要声称自己无法接收图片。`

    // Checkpoint (Phase 12): snapshot the workspace BEFORE the turn. fire-and-forget;
    // failure degrades to no checkpoint for this turn (D5). The hash is awaited at
    // turn end. Resends skip — the original send's snapshot is the correct anchor.
    // Index into the FULL ledger (never folded → stable), not the transient view.
    const checkpointIndex = this.conversation.length
    const trackAt = new Date().toISOString()
    const trackPromise: Promise<string | null> = opts?.isResend
      ? Promise.resolve(null)
      : this.snapshotStore.track().catch(() => null)

    let accumulated = ''
    let assistantStarted = false
    let lastInputTokens: number | undefined
    // Failover decision: the error branch only RECORDS the category here; the swap/
    // resend runs after the loop ends (never re-enter runAgent inside its own for-await).
    let failoverDecision: ErrorCategory | null = null
    // Set right before the recursive resend so the OUTER finally does not emit a second
    // turn-end (the nested submit already emitted one).
    let resent = false

    try {
      for await (const event of runAgent({
        conversation,
        client: this.client,
        registry: this.registry,
        userText: applyUserStamp(text),
        userMessageId: opts?.messageId,
        userAttachments,
        expandAttachments: expandFn,
        config: { model: this.client.getModel(), max_tokens: this.maxTokens, system: systemWithRuntime },
        cwd: this.cwd,
        signal: controller.signal,
        settings: this.settings,
        // Session-scoped tracker (see field decl): keeps read-before-write across turns.
        tracker: this.tracker,
        // NOTE: sessionAllow accumulates across turns. core's gateAndRunTool mutates the
        // SAME array we pass here (push on allow_session/allow_persist), and we pass the
        // stable this.sessionAllow every turn — so allow_session rules persist for the session.
        sessionAllow: this.sessionAllow,
        onPersistAllow: (rule) => this.persistAllowRule(rule),
        onCwdChange: (next: string) => {
          this.cwd = next
          this.emit({ type: 'cwd-change', cwd: next })
        },
        consumeSteer: () => {
          // Attachments can't fold into a running tool_result — only fold TEXT-ONLY steers; leave
          // attachment-bearing items queued for drainSteerAsFollowUp (delivered as a fresh turn).
          const isFoldable = (s: { images?: unknown[]; pastedTexts?: unknown[]; files?: unknown[] }) => !(s.images?.length || s.pastedTexts?.length || s.files?.length)
          const foldable = this.steerQueue.filter(isFoldable)
          if (foldable.length === 0) return null
          // A foldable (attachment-less) item always has non-empty text (steer() only enqueues an
          // attachment-less item when its text is non-empty), so no empty-string guard is needed.
          const combined = foldable.map((s) => s.text).join('\n')
          // Keep only the attachment-bearing items queued; the folded text-only ones are consumed now.
          this.steerQueue.splice(0, this.steerQueue.length, ...this.steerQueue.filter((s) => !isFoldable(s)))
          // Folded into a tool_result: echo it now (after the tool cards the client just received)
          // as a "↪ 插话" bubble. Server-driven so it lands at the real injection point, not
          // optimistically mid-stream where it would split the reply.
          this.emit({ type: 'user-echo', text: combined, steer: true, messageId: foldable[0]?.messageId ?? genMsgId() })
          return combined
        },
        canUseTool: this.canUseTool,
        onAutoAllow: this.onAutoAllow,
      })) {
        switch (event.type) {
          case 'message-start':
            assistantStarted = true
            accumulated = ''
            this.emit({ type: 'message-start', id: event.id, model: event.model })
            break
          case 'text-delta':
            accumulated += event.text
            this.emit({ type: 'text-delta', text: event.text })
            break
          case 'tool-use':
            this.emit({ type: 'tool-use', id: event.id, name: event.name, input: event.input, invalid_args: event.invalid_args })
            break
          case 'tool-result':
            this.emit({ type: 'tool-result', id: event.id, name: event.name, output: event.output, is_error: event.is_error })
            break
          case 'message-stop':
            lastInputTokens = event.usage.input_tokens + (event.usage.cache_read_input_tokens ?? 0)
            this.emit({ type: 'message-stop', stop_reason: event.stop_reason, usage: event.usage })
            break
          case 'warning':
            this.emit({ type: 'warning', message: event.message })
            break
          case 'error': {
            if (controller.signal.aborted) { this.emit({ type: 'aborted' }); break }
            const cat: ErrorCategory = (event.category as ErrorCategory | undefined) ?? 'other'
            // Only consider failover when nothing has streamed yet: quota/auth/unavailable
            // all surface at stream open. A mid-stream error only shows (resending would
            // duplicate emitted content). Record now; act after the loop.
            const preStream = accumulated === '' && !assistantStarted
            if (preStream && cat !== 'other') failoverDecision = cat
            else this.emit({ type: 'error', message: event.message, category: cat })
            break
          }
        }
      }
      // "Empty interrupt": Stop landed before anything was generated (no text, no tool-use) — runAgent
      // has nothing to commit, so there is no preserved turn to show. Restore the user's original text
      // to the input box (CC-style rewind) instead of leaving a hollow turn in the ledger. Detected
      // by observing the OUTCOME directly: runAgent commits nothing on an empty interrupt, so the
      // view length is unchanged from viewPreLen. A Stop that lands AFTER content streamed leaves the
      // length grown: runAgent already committed the partial reply + synthesized interrupted
      // tool_results + "[Request interrupted by user]" marker, so that turn is preserved, not rewound.
      // (Reading the committed length avoids re-deriving core's "has content" predicate here — no drift.)
      // Epoch guard: reset() ("new chat") interrupts the turn AND swaps in a fresh session. That is an
      // empty interrupt too, but the user wants a CLEAN new chat — so don't resurrect the old prompt
      // into the fresh composer. If reset ran (epoch changed), skip the restore-input.
      const interrupted = this.turnEpoch === epoch && controller.signal.aborted
      if (interrupted && conversation.length === viewPreLen) {
        // Empty interrupt → rewind the untouched input; the ledger + todos are left as they were.
        this.emit({ type: 'restore-input', text })
      } else if (interrupted) {
        // Non-empty interrupt: the turn ran (and may have built a plan) before the user bailed. The
        // todo list is ephemeral "current plan" state, not a durable side effect — drop it so an
        // abandoned in-flight plan doesn't linger (mirrors hermes-agent's clear-on-interrupt). The
        // conversation itself (partial reply + interrupt marker) is preserved, unchanged.
        if (this.todos.length > 0) this.setTodos([])
      }

      this.contextTokens = lastInputTokens ?? this.contextTokens
      // Feature B: if we ran against a transient compacted view, fold the turn's new tail back into
      // the full ledger (never folded) and carry the turn's usage onto it. When there was no
      // compaction, `conversation` IS the ledger — runAgent already appended to it, so skip. The
      // view was seeded with zero usage, so its totalUsage equals exactly this turn's usage.
      // Epoch guard: reset() ("new chat") mid-turn swaps in a fresh this.conversation, which makes
      // `conversation !== this.conversation` true even with no compaction. Without this guard the
      // (now-committed, since we preserve interrupted turns) tail would fold onto the post-reset
      // session — a ghost of the discarded chat. If reset ran, the turn is void: skip the fold-back
      // and let its tail vanish with the orphaned pre-reset conversation.
      if (this.turnEpoch === epoch && conversation !== this.conversation) {
        // sliceMessages clones only the turn's new tail; getMessages().slice would deep-clone the
        // whole compacted view (summary + kept tail) every post-compaction turn just to drop it.
        for (const m of conversation.sliceMessages(viewPreLen)) this.conversation.append(m)
        this.conversation.addUsage(conversation.totalUsage)
      }
      this.totalUsage = this.conversation.totalUsage
      this.emit({ type: 'usage-update', totalUsage: this.totalUsage })
      this.emit({ type: 'context-update', contextTokens: this.contextTokens, contextWindow: this.ctxWindow() })

      // Record the checkpoint (Phase 12): only if track() succeeded. Even an errored
      // turn records — the snapshot anchors "before this turn", so checkpointIndex ==
      // ledger length and revert's truncation degrades to a no-op while the file roll-
      // back undoes the half-finished turn. await usually returns immediately.
      const hash = await trackPromise
      if (hash) {
        const label = text.replace(/\s+/g, ' ').trim().slice(0, 80)
        // The checkpoint anchors before this turn's user message (checkpointIndex == its ledger
        // index — see Fix B in projectMessages), so read the message's id back off the ledger rather
        // than trusting opts?.messageId, which is absent whenever the client didn't supply one
        // (runAgent then mints its own id via genMsgId() and that's what actually landed in the ledger).
        const anchorMessageId = this.conversation.getMessages()[checkpointIndex]?.id ?? genMsgId()
        this.checkpoints.push({ messageIndex: checkpointIndex, hash, at: trackAt, label, anchorMessageId })
        this.emit({ type: 'checkpoint-recorded', id: hash, messageIndex: checkpointIndex, anchorMessageId, label })
      }

      // Failover: the for-await has ended (client returned), so it is safe to swap
      // the client and resend. Shares failoverToNext() with compaction's summarize retry.
      if (failoverDecision) {
        const cat = failoverDecision
        const fo = this.failoverToNext(cat)
        if (fo) {
          this.emit({ type: 'failover', fromModel: fo.fromModel, toModel: fo.toModel, reason: fo.reason })
          // The new model's window may be much smaller. The failed turn committed nothing
          // (history unchanged), so the prior input_tokens still estimate occupancy: if it
          // overflows the new window threshold, compact first so the resend keeps context.
          const newWindow = resolveContextWindow(this.settings, this.currentProviderId, fo.toModel)
          if (this.contextTokens && this.contextTokens > newWindow * COMPACTION_THRESHOLD) {
            await this.maybeAutoCompact()   // shares the emit/error contract with the pre-send & post-response triggers
          }
          // The resend's runAgent reads this.client.getModel() (the new model). Resend — carrying
          // this turn's images (#2): the failed turn committed nothing, so the new model must receive
          // the same attachments or the image is silently lost across the swap. submit re-runs
          // resolveVision on the NEW model, so a vision↔non-vision swap re-routes correctly.
          this.abort = null
          resent = true
          // Thread the ORIGINAL messageId through the resend: the failed attempt committed nothing,
          // so the resent user message must keep the front-end-minted id (approach B) — otherwise it
          // lands in the ledger under a fresh genMsgId, and the turn's checkpoint anchorMessageId no
          // longer matches the client's live optimistic bubble (its per-message revert can't attach).
          await this.submit(text, images, pastedTexts, files, { isResend: true, messageId: opts?.messageId })
        } else {
          // dialog mode / auth / no available next model: hand off to client model picker.
          const reasonText = cat === 'auth' ? 'API key invalid' : cat === 'quota' ? 'quota exhausted' : 'model unavailable'
          this.emit({ type: 'model-select-needed', reason: reasonText })
        }
      }

      // Auto-compaction PRIMARY trigger: this turn's usage is now measured, so compact in the
      // post-response window if we crossed the threshold. AWAITED here (still inside isThinking=true,
      // before the finally emits turn-end) so it holds mutual exclusion — revert()/retry()/compactNow
      // are all isThinking-guarded, so none can interleave and clobber this.compaction. The next send
      // then starts already compacted. Skip on a failover resend (nested submit ran its own turn) and
      // when the turn was aborted (Stop) — a just-aborted turn must not spawn a spurious "正在压缩…"
      // notice + failure warning. Signal-bound so a Stop during the summary round-trip cancels it.
      if (!resent && !controller.signal.aborted && this.overContextThreshold()) {
        await this.maybeAutoCompact(controller.signal)
      }

      // Memory consolidation (Phase 13, lightweight autoDream): after a real turn (not a
      // resend that re-enters submit), maybe run a background tidy of the memory index.
      // fire-and-forget — failure is fully silent, it must never become a new failure point.
      if (!resent) void this.maybeConsolidateMemories()
    } catch (err) {
      if (controller.signal.aborted) this.emit({ type: 'aborted' })
      else this.emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    } finally {
      this.isThinking = false
      this.abort = null
      // On a failover resend the nested submit already emitted turn-end; suppress the
      // outer one to avoid a double turn-end. isThinking/abort resets are idempotent.
      if (!resent) this.emit({ type: 'turn-end' })
    }

    // reset() ("new chat") ran mid-turn → this turn's transient tail targets state that's already
    // been thrown away; drop it so it can't resurrect the old steer queue.
    if (this.turnEpoch !== epoch) return

    // Idle-drain (Phase 2, cc-haha's model): consumeSteer drains the queue at tool-batch boundaries,
    // so a steer sent during a PURE-TEXT reply (no tool_result to fold into) is still queued at turn
    // end. Deliver it now as its OWN fresh turn — addressed right after this reply — instead of
    // letting it bleed into a later, unrelated turn's tool batch. Runs after the finally (isThinking
    // reset) so the recursive submit starts clean. Skipped on a failover resend (the outer call drains).
    if (!opts?.isResend) await this.drainSteerAsFollowUp()
  }

  /**
   * Deliver any steer still queued at turn end as its OWN fresh follow-up turn, so a queued steer
   * never lingers to fold into a later, unrelated turn. Shared by the post-turn idle-drain and the
   * pre-send-compaction abort path (submit()). Delivery is merged (one follow-up turn), but the echo
   * is per-item: each not-yet-echoed steer opens a NORMAL user bubble, while steers already shown as
   * "↪ 插话" bubbles (folded then re-queued after a Stop) are re-delivered WITHOUT a second echo.
   * No-op when the queue is empty.
   *
   * NOTE: on the re-delivered (already-echoed) path submit() writes the steer to the ledger as an
   * ordinary user message, so a reload renders a plain bubble while the live view kept the earlier
   * "↪ 插话" fold bubble — a known live-vs-reload styling divergence, not a correctness issue.
   */
  private async drainSteerAsFollowUp(): Promise<void> {
    if (this.steerQueue.length === 0) return
    const items = this.steerQueue.splice(0)
    const unechoed = items.filter((s) => !s.echoed)
    // The drained batch is delivered as ONE follow-up ledger message (below), so it needs ONE
    // stable id — shared by the optimistic echo (if any) and the eventual submit() so the live
    // bubble and the persisted message agree. Prefer an unechoed item's client-supplied id (it's
    // the one actually rendering a NEW bubble here); fall back to any item's id, else mint one.
    const messageId = unechoed[0]?.messageId ?? items[0]?.messageId ?? genMsgId()
    if (unechoed.length > 0) {
      // Carry the interjection's attachments on the echo so the follow-up bubble shows its chip/thumbnail
      // live (not just after a reload); filter empty text so an attachment-only interjection doesn't
      // echo a blank/newline-only string.
      const echoText = unechoed.map((s) => s.text).filter((t) => t !== '').join('\n')
      const echoImages = unechoed.flatMap((s) => s.images ?? [])
      const echoPasted = unechoed.flatMap((s) => s.pastedTexts ?? [])
      const echoFiles = unechoed.flatMap((s) => s.files ?? [])
      this.emit({ type: 'user-echo', text: echoText, messageId, attachments: echoAttachments(echoImages, echoPasted, echoFiles) })
    }
    // Merge any attachments carried by the drained items onto this follow-up submit — reuses
    // submit's existing image/pastedText/file handling instead of duplicating it here.
    const text = items.map((s) => s.text).filter((t) => t !== '').join('\n')
    const images = items.flatMap((s) => s.images ?? [])
    const pastedTexts = items.flatMap((s) => s.pastedTexts ?? [])
    const files = items.flatMap((s) => s.files ?? [])
    await this.submit(text, orUndef(images), orUndef(pastedTexts), orUndef(files), { messageId })
  }

  /**
   * Switch the active model (manual model picker / model-select-needed handoff).
   * Rebuilds the client against the chosen provider/model. getState().model reflects
   * client.getModel(), so no extra bookkeeping is needed. No persist — session-scoped.
   */
  switchModel(providerId: string, model: string): void {
    // Rebuild the client, but never let a bad provider/model desync the client's optimistic Header:
    // on failure keep the old client/provider and surface the error, then ALWAYS emit the
    // authoritative model-changed (new model on success, unchanged old on failure) so the client's
    // optimistic value is corrected either way.
    try {
      this.client = this.createClient(getProviderConfig(this.settings, providerId), model)
      this.currentProviderId = providerId
    } catch (err) {
      this.emit({ type: 'error', message: `切换模型失败：${err instanceof Error ? err.message : String(err)}` })
    }
    this.emit({ type: 'model-changed', model: this.client.getModel(), providerId: this.currentProviderId })
  }

  /**
   * Mirror the model's todo list into session state and notify subscribers. The TodoWrite
   * tool's onUpdate is wired to this method by the session-capability list: the constructor
   * builds a SessionCapabilityContext whose setTodos points here, and createTodoWriteTool
   * receives it as onUpdate (see sessionCapabilities.ts / SESSION_CAPABILITY_TOOLS).
   */
  setTodos(todos: TodoItemLite[]): void {
    this.todos = todos
    this.emit({ type: 'todos-update', todos })
  }

  /**
   * 登记一个后台 Agent（B1），返回「完成时调用」的结果回调。
   *
   * 登记的意义有二：让会话静默判据（waitUntilQuiescent → cron 定稿 run 记录）看得见
   * 它在飞；以及让生命周期作废（reset/release/delete）能丢掉它的产出。
   *
   * 超并发上限时 **throw** —— 调用方（Agent 工具的后台分支）会把它冒给 core 的
   * runOneTool，转成 isError 回喂模型，与 B2 唤醒链到顶时同一套路数：如实告知，不静默吞。
   */
  startBackgroundAgent(description: string): (result: string) => void {
    if (this.countInjections('background') >= MAX_BACKGROUND_AGENTS) {
      throw new Error(`本会话已有 ${MAX_BACKGROUND_AGENTS} 个后台 Agent 在跑，等一个完成再派新的。`)
    }
    const token = Symbol('background')
    // cancel 刻意为空：按设计只丢弃投递、不中止在飞的子代理 —— 真中止要把可取消句柄
    // 从 packages/tools（TUI 与 server 共用）一路传出来，而子代理自带 10 轮上限，不值。
    this.pendingInjections.set(token, { kind: 'background', cancel: () => {}, label: description })
    this.emitBackgroundAgents()
    return (result: string) => {
      // 先摘登记再投递：见 PendingInjection 的「投递协议」。
      if (!this.pendingInjections.delete(token)) return  // 已被作废：产出无处可去
      // 广播必须在投递**之前**：deliverToSession 可能同步起一整轮回合，
      // 那之后再报「少了一个」会晚于回合内的一串事件，前端面板看着像慢了半拍。
      this.emitBackgroundAgents()
      deliverToSession(this, `🔔 后台 Agent "${description}" 完成:\n${result}`, {
        onError: (m) => this.emit({ type: 'warning', message: `后台 Agent 通知投递失败:${m}` }),
      })
    }
  }

  /**
   * 安排一次自唤醒：delayMs 后把 message 投进本会话并驱动一轮。
   *
   * 定时器归 manager 而不是工具闭包：取消的时机全落在会话的生命周期事件上
   * （reset() 开新对话、release()、delete()），闭包够不着那些点，一旦漏取消，
   * 旧会话的唤醒会打到一个已经换了内容甚至已经销毁的会话上。
   *
   * **同时只保留一个** —— 新的顶掉旧的（沿用 ScheduleWakeup 工具的既有语义）。
   * 返回 false = 被 deadline 拒绝（cron 唤醒链额度用完）；调用方要把这件事回给模型，不能静默吞掉。
   */
  scheduleWakeup(delayMs: number, message: string): boolean {
    if (this.wakeupDeadline !== null && Date.now() + delayMs > this.wakeupDeadline) return false
    this.cancelWakeup()
    const token = Symbol('wakeup')
    const timer = setTimeout(() => {
      // 先摘登记再投递：见 PendingInjection 的「投递协议」。这里不看 delete() 的返回值 ——
      // 已被作废意味着 clearTimeout 已经跑过，本回调压根不会执行。
      this.pendingInjections.delete(token)
      // 前缀沿用 TUI：一眼能看出这轮不是人发的。
      deliverToSession(this, `⏰ 定时唤醒: ${message}`, {
        onError: (m) => this.emit({ type: 'warning', message: `定时唤醒投递失败:${m}` }),
      })
    }, delayMs)
    // daemon 不该因为一个待触发的唤醒而无法退出。
    timer.unref?.()
    this.pendingInjections.set(token, { kind: 'wakeup', cancel: () => clearTimeout(timer) })
    return true
  }

  /**
   * 作废待投递：给定 kind 则只作废该类，省略则全部。**所有作废都从这里走**，
   * 这样「哪些事件会让待投递失效」是一份可穷举的清单，而不是散在各处的 delete。
   */
  private cancelInjections(kind?: InjectionKind): void {
    let droppedBackground = false
    for (const [token, inj] of this.pendingInjections) {
      if (kind !== undefined && inj.kind !== kind) continue
      inj.cancel()
      this.pendingInjections.delete(token)
      if (inj.kind === 'background') droppedBackground = true
    }
    if (droppedBackground) this.emitBackgroundAgents()
  }

  /** 在飞的后台 Agent 展示名。前端面板的**唯一**真相源（见 SessionSnapshot.backgroundAgents）。 */
  backgroundAgentLabels(): string[] {
    const out: string[] = []
    for (const inj of this.pendingInjections.values()) {
      if (inj.kind === 'background') out.push(inj.label ?? 'sub-agent')
    }
    return out
  }

  /** 集合变了就整份广播（与 todos-update 同形）。 */
  private emitBackgroundAgents(): void {
    this.emit({ type: 'background-agents', labels: this.backgroundAgentLabels() })
  }

  /**
   * 仅作废自唤醒。唯一调用点是 scheduleWakeup 的「新的顶掉旧的」—— 它只该顶掉唤醒，
   * 不该顺手清掉在飞的后台 Agent 登记。会话生命周期上的作废走 cancelAllInjections()。
   */
  cancelWakeup(): void {
    this.cancelInjections('wakeup')
  }

  /**
   * 作废**所有**待投递。调用点：本类的 reset()（开新对话）与 SessionService 的
   * release()/delete()（会话离开 registry —— 那些产出既不落盘也送不到任何客户端）。
   */
  cancelAllInjections(): void {
    this.cancelInjections()
  }

  /** 有任何待投递？—— waitUntilQuiescent 的静默判据之一。 */
  hasPendingInjection(): boolean {
    return this.pendingInjections.size > 0
  }

  private countInjections(kind: InjectionKind): number {
    let n = 0
    for (const inj of this.pendingInjections.values()) if (inj.kind === kind) n++
    return n
  }

  /** 有自唤醒待触发？（单槽语义的观测点；静默判据用 hasPendingInjection。） */
  hasPendingWakeup(): boolean {
    return this.countInjections('wakeup') > 0
  }

  /** 给本会话的唤醒链设截止时刻（cron 用）。null = 不限。 */
  setWakeupDeadline(at: number | null): void {
    this.wakeupDeadline = at
  }

  /**
   * 等到会话静默：当前无回合在跑 **且** 无待投递（自唤醒、在飞的后台 Agent）；或越过 deadline。
   *
   * cron 用它把 run 记录的定稿推迟到整条唤醒链结束 —— 否则 summary/finishedAt 描述的
   * 不是这个会话实际做过的事。用轮询而非事件订阅：唤醒到点是一个 setTimeout，没有对应的
   * 会话事件可订阅，为它新造一个事件类型不值。
   */
  async waitUntilQuiescent(deadline: number): Promise<void> {
    let wait = QUIESCENCE_POLL_MIN_MS
    while (Date.now() < deadline) {
      if (!this.isBusy() && !this.hasPendingInjection()) return
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 1.5, QUIESCENCE_POLL_MAX_MS)
    }
  }

  /**
   * Resolve a checkpoint's ledger truncation index: prefer the stable anchorMessageId (survives
   * index drift from compaction/revert), fall back to the stored messageIndex for legacy
   * checkpoints persisted before anchorMessageId existed. (Message.id is always a non-empty
   * string, so findIndex on an absent anchorMessageId simply returns -1 → fallback.)
   */
  private resolveCheckpointIndex(cp: SessionCheckpoint, msgs: Message[]): number {
    const byId = msgs.findIndex((m) => m.id === cp.anchorMessageId)
    return byId >= 0 ? byId : cp.messageIndex
  }

  /**
   * Revert to a checkpoint (Phase 12, /revert): roll the workspace back FIRST, then
   * truncate the ledger — if restore() throws, the ledger must stay intact (files did
   * not roll back, so neither can history). Drops checkpoints at/after the revert point
   * and clears the measured context (next turn re-measures). No-op on unknown id.
   * Mirrors useConversation's revertToCheckpoint.
   */
  async revert(checkpointId: string): Promise<void> {
    // Reject a revert while a turn is streaming (mirrors submit()/retry()). The in-flight
    // runAgent loop holds a captured `conversation` ref and, at turn-end, pushes a checkpoint
    // and overwrites totalUsage/contextTokens from that ledger — so truncating state out from
    // under it here would resurrect the reverted turn and desync checkpoints/usage. retry()
    // already guards before it calls revert(), so this never blocks the retry path.
    if (this.isThinking) throw new Error('A turn is already in progress')
    const cp = this.checkpoints.find((c) => c.hash === checkpointId)
    if (!cp) return
    await this.snapshotStore.restore(cp.hash)
    const conv = this.conversation
    const msgs = conv.getMessages()
    // Resolve the truncation point by id first — messageIndex can drift (e.g. compaction folds
    // reset ledger positions in ways this checkpoint didn't observe) while the anchor message's id
    // is stable. Legacy checkpoints (persisted before anchorMessageId existed) have no id: fall
    // back to the stored index.
    const cut = this.resolveCheckpointIndex(cp, msgs)
    this.conversation = Conversation.fromJSON({
      version: 1,
      messages: msgs.slice(0, cut),
      // Cost ledger, not window ledger: money already spent does not un-spend on revert.
      totalUsage: conv.totalUsage,
    })
    // Checkpoints at/after the revert point are invalidated (incl. same-index error-turn ones).
    this.checkpoints = this.checkpoints.filter((c) => c.messageIndex < cut)
    // Feature B: if the revert truncated to before the compaction boundary, the stored summary/cut
    // no longer describe the (now-shorter) ledger — drop it so the next turn's view is the full
    // remaining ledger (which re-compacts if still too large).
    if (this.compaction && cut <= this.compaction.cutIndex) this.compaction = null
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })
    // Notify clients a revert happened so they can re-sync (wsServer re-pushes a fresh
    // snapshot on this event). Emitted only on the success path — the unknown-id case
    // early-returned above without touching any state.
    this.emit({ type: 'reverted', checkpointId })
  }

  /**
   * Retry the last user turn (web "retry"): revert to that turn's checkpoint — rolling the
   * workspace back and dropping the turn from the ledger — then re-submit the same text from
   * the clean state. This is the safe semantics when the turn changed code: the next attempt
   * starts from the same point, not on top of half-applied edits. No-op when there is no user
   * turn or no checkpoint anchoring it; throws if a turn is already running (mirrors submit()).
   */
  async retry(): Promise<void> {
    if (this.isThinking) throw new Error('A turn is already in progress')
    // Use the LAST checkpoint — it anchors the most recent real user turn. Do NOT scan for the
    // last role:'user' message: tool_result blocks are committed as role:'user' too, so that
    // would land on a tool result (which has no checkpoint) and silently no-op.
    const cp = this.checkpoints[this.checkpoints.length - 1]
    if (!cp) return
    // Resolve by id first (stable across index drift), fall back to the stored index for legacy
    // checkpoints persisted before anchorMessageId existed.
    const msgs = this.conversation.getMessages()
    const userMsg = msgs[this.resolveCheckpointIndex(cp, msgs)]
    if (!userMsg || userMsg.role !== 'user') return
    // Recover the original prompt: join text blocks, strip submit()'s `[YYYY-MM-DD HH:MM] ` prefix.
    const text = stripUserStamp(userMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    // #3 / I5a: recover the turn's attachments so retry re-attaches them. Split by route: image
    // attachments (direct/parsed) → images param (re-routed via resolveVision); pasted → pastedTexts
    // param (never sent through the image path — no disk file exists for them). Recovered BEFORE the
    // empty-text bail so an attachment-only turn (empty text) is still retryable.
    const atts = userMsg.attachments ?? []
    // Split the reverted turn's attachments back by route: images (direct/parsed) re-route via
    // resolveVision; pasted → pastedTexts; file → files (never a disk file to re-route, only the ref).
    const images: UploadedImageRef[] | undefined = orUndef(
      atts.filter((a) => a.route !== 'pasted' && a.route !== 'file').map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType })),
    )
    const pastedTexts: PastedTextInput[] | undefined = orUndef(
      atts.filter((a) => a.route === 'pasted').map((a) => ({ id: a.id, text: a.text ?? '' })),
    )
    const filesR: UploadedFileRef[] | undefined = orUndef(
      atts.filter((a) => a.route === 'file').map((a) => ({ id: a.id, name: a.name, mediaType: a.mediaType })),
    )
    // Nothing to retry only when there is neither text NOR any attachment.
    if (text.trim() === '' && !images && !pastedTexts && !filesR) return
    // Keep the retried message's identity: it's the SAME logical user turn being re-attempted,
    // just re-anchored on a clean checkpoint — so reuse userMsg.id rather than minting a fresh one.
    const messageId = userMsg.id
    await this.revert(cp.hash)   // rolls files back + truncates the ledger to before this turn
    // The revert snapshot dropped the question; submit re-adds it to the ledger but emits no
    // "user message" event, so clients wouldn't show it until a reconnect. Echo it now (with its
    // attachments) so the re-submitted question reappears immediately (mirrors send()'s optimistic add).
    this.emit({ type: 'user-echo', text, messageId, attachments: echoAttachments(images, pastedTexts, filesR) })
    await this.submit(text, images, pastedTexts, filesR, { messageId })      // fresh attempt from the clean checkpoint
  }

  /**
   * Background memory consolidation (Phase 13, lightweight autoDream): when the memory
   * index is near its cap and ≥24h since the last run, send ONE tool-less request asking
   * the model to emit DELETE/SAVE op lines, then apply them deterministically. Guarded by
   * a consolidating flag; fully fire-and-forget — every failure is swallowed, it must
   * never become a new failure point. Emits memory-notice instead of the TUI's UI notify.
   * Port of useConversation's maybeConsolidateMemories (deps come from @zuse/tools + core,
   * not @zuse/tui — server already depends on @zuse/tools).
   */
  private async maybeConsolidateMemories(): Promise<void> {
    if (this.consolidating) return
    this.consolidating = true
    let store: ReturnType<typeof openMemoryStore> | null = null
    try {
      store = openMemoryStore()
      const rows = store.all()
      if (rows.length === 0) return
      const projection = renderMemoryMarkdown(rows)
      // 巩固的**取数范围**必须是「当前项目 ∪ 全局」，不能是全库。
      // 结果统一按 slug 落地（applyMemoryConsolidation 下方），而 SAVE 协议里没有 project 字段 ——
      // 模型看得见每条属于哪个项目，却没办法把它表达出来。用全库取数，
      // 一次巩固就会把别的项目的记忆改挂到本会话的项目名下、源行删除，且 catch{} 全吞无痕迹。
      // 触发判据仍看全局投影（容量闸本来就是全局预算），只有喂给模型的清单收窄。
      const slug = cwdSlug(this.cwd)
      const scoped = store.allForProject(slug)
      if (scoped.length === 0) return
      // 水位**按项目**记：否则「全局超限是因为项目 B、而我人在 A」时，A 白跑一趟
      // 却把 24h 防抖设上了，B 永远轮不到。
      const watermarkKey = `consolidated_at:${slug}`
      const lastRunAt = store.getMeta(watermarkKey)
      if (!shouldConsolidateMemories({ projectionChars: projection.length, indexCap: MEMORY_INDEX_CAP, lastRunAt })) {
        return
      }
      // Write the watermark first: even a failed run is debounced for 24h (debounce
      // wins over success — we never want this to nag every turn).
      store.setMeta(watermarkKey, new Date().toISOString())
      const prompt = buildConsolidationPrompt(scoped)
      store.close()
      store = null // do not hold the sqlite connection during the model request
      this.emit({ type: 'memory-notice', text: 'Memory index near capacity; consolidating in background…' })
      let text = ''
      for await (const e of this.client.sendMessages(
        [{ role: 'user', id: genMsgId(), content: [{ type: 'text', text: prompt }] }],
        { model: this.client.getModel(), max_tokens: Math.min(this.maxTokens, 2000) },
      )) {
        if (e.type === 'text-delta') text += e.text
        else if (e.type === 'error') return
      }
      const ops = parseConsolidationOps(text)
      if (ops.deletes.length === 0 && ops.saves.length === 0) {
        this.emit({ type: 'memory-notice', text: 'Memory consolidation: model judged no changes needed.' })
        return
      }
      const { saved, deleted } = applyMemoryConsolidation(ops, cwdSlug(this.cwd))
      this.emit({ type: 'memory-notice', text: `Memory consolidated: ${saved} merged/added, ${deleted} removed.` })
    } catch {
      // Consolidation is value-add; any failure must not become a new failure point.
    } finally {
      store?.close()
      this.consolidating = false
    }
  }
}
