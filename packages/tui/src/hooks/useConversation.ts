import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { resolveHead, type PendingPermission } from '../permissionQueue.js'
import { badKeysForFailure, decideFailover, modelKey } from './failoverCore.js'
import os from 'node:os'
import type { UIMessage, ConversationState, UIToolCall } from '../types.js'
import { summarizeOutput, lineSummaryHidesContent } from '../components/toolSummary.js'
import { computeLineDiff, formatDiffText, EDIT_DIFF_CAP } from '../components/editDiff.js'
import { writeToolOutputFile } from '../toolOutputFile.js'
import {
  Conversation,
  runAgent,
  createFileTracker,
  createClientFromSettings,
  createModelClient,
  getProviderConfig,
  setModelInSettings,
  resolveModelSelection,
  resolveFailoverMode,
  buildSystemPrompt,
  findCompactionCut,
  applyCompaction,
  summarizeForCompaction,
  resolveContextWindow,
  modelNames,
  COMPACTION_THRESHOLD,
  DEFAULT_PROVIDER_ID,
  type ModelClient,
  type ToolRegistry,
  type FileReadTracker,
  type ResolvedSettings,
  type PermissionRequest,
  type PermissionVerdict,
  type ModelSelection,
  type ErrorCategory,
} from '@zuse/core'
import { getShellLabel, createSnapshotStore, type SnapshotStore } from '@zuse/tools'
import type { CommandContext } from '../commands/types.js'
import { parseInput, findCommand } from '../commands/registry.js'
import {
  autosaveSession,
  newSessionId,
  remapCheckpoints,
  type SessionCheckpoint,
} from '../commands/sessionStore.js'

/**
 * Edit 的行级 diff 超过 EDIT_DIFF_CAP 行被收口时,把「完整 diff 文本」落盘,返回临时文件路径;
 * 否则 undefined。与 Bash/Grep 落盘同理:完整 diff 是无磁盘归宿的计算产物,且 old/new 是本次
 * 编辑固定的历史记录、不会随文件变动而过期,落盘是正确的(不同于 Read 的输出有真文件可开)。
 */
function spillEditDiff(input: unknown, isError?: boolean): string | undefined {
  if (isError) return undefined
  const inp = (input ?? {}) as { old_string?: unknown; new_string?: unknown; file_path?: unknown }
  if (typeof inp.old_string !== 'string' || typeof inp.new_string !== 'string') return undefined
  const rows = computeLineDiff(inp.old_string, inp.new_string)
  if (rows.length <= EDIT_DIFF_CAP) return undefined
  const file = typeof inp.file_path === 'string' ? inp.file_path : ''
  return writeToolOutputFile('edit', formatDiffText(file, rows))
}

interface UseConversationOptions {
  maxTokens: number
  registry: ToolRegistry
  /** 工作目录：工具的相对路径据此解析。由入口一次性定好传入。 */
  cwd: string
  /** 解析后的设置，驱动权限闸门与 client 初始化。 */
  settings: ResolvedSettings
  /** --continue/--resume 预载的会话(Phase 10A)。id 沿用 = 同一会话延续写同一文件。 */
  initialSession?: { conversation: Conversation; id: string; createdAt: string; checkpoints?: SessionCheckpoint[] }
}

interface UseConversationReturn {
  state: ConversationState
  /** 输入框的入口：分发斜杠命令，或发送一条消息。displayText 为折叠回显文本，pasteFiles 为粘贴 id→路径映射（仅 user 消息用）。 */
  submit: (input: string, displayText?: string, pasteFiles?: Record<number, string>) => Promise<void>
  clear: () => void
  /** 权限队列队头(当前显示的请求);null = 无弹框。派生自队列,App 渲染判断不变。 */
  pendingPermission: PermissionRequest | null
  /** 兑现队头。expectedHeadId 必须是调用方渲染快照里的队头 id(pendingPermissionId);
   *  与当前真实队头不符时丢弃 —— 防同一输入 chunk 的连发按键盲裁决未展示的请求。 */
  resolvePermission: (verdict: PermissionVerdict, expectedHeadId: string | null) => void
  /** 权限队列队头 id,与 pendingPermission 同源同帧;传回 resolvePermission 做身份校验。 */
  pendingPermissionId: string | null
  /** 权限队列总长(含队头)。>1 时对话框标题显示 (1/N)。 */
  permissionQueueLength: number
  /** 当前选中的模型名（用于 footer 展示与 /model 标星）。 */
  currentModel: string
  /** 当前选中的 provider id（与 currentModel 配对，用于 footer 展示 provider/model）。 */
  currentProviderId: string
  /** client 初始化失败时的错误信息。 */
  clientError: string | undefined
  /** 运行时切换 model；persist=true 时写盘。 */
  switchModel: (sel: ModelSelection, persist: boolean) => string
  /** /model 交互式选择器是否打开（打开时 App 渲染选择器、收起输入框）。 */
  modelSelectorOpen: boolean
  /** 选择器里回车确认：切换到目标模型（不写盘）并收起选择器。 */
  confirmModelSelection: (providerId: string, model: string, persist: boolean) => void
  /** 选择器里 Esc 取消：仅收起，不切换。 */
  closeModelSelector: () => void
  /** 本会话不可用标记(供 /model picker 灰显标注)。 */
  badModels: ReadonlyMap<string, ErrorCategory>
  /** 中断进行中的流式回合（Esc）。当前有回合在跑则 abort 并返回 true，否则 false。 */
  interrupt: () => boolean
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 把已提交账本映射成 UI 消息列表(/load 换入与 --continue 初始化共用)。 */
function uiMessagesFromConversation(conv: Conversation): UIMessage[] {
  return conv.getMessages().map((m) => ({
    id: generateId(),
    role: m.role,
    text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    isStreaming: false,
  }))
}

export function useConversation({
  maxTokens,
  registry,
  cwd,
  settings,
  initialSession,
}: UseConversationOptions): UseConversationReturn {
  // 已提交的历史 —— 每个回合重新发送的权威账本。
  // 放在 ref（而非 state）里：修改它不应触发重渲染，而且我们绝不希望
  // sendMessage 内部闭包拿到它的陈旧快照。
  const conversationRef = useRef<Conversation>(initialSession?.conversation ?? new Conversation())
  // 自动会话身份(Phase 10A):每回合提交后 autosave 到 auto/<cwd-slug>/<id>.json。
  // --continue/--resume 沿用被载入会话的 id(同一会话延续);/clear 换新 id。
  const sessionIdRef = useRef<string>(initialSession?.id ?? newSessionId())
  const sessionCreatedAtRef = useRef<string>(initialSession?.createdAt ?? new Date().toISOString())
  // 让将来的 Ctrl+C/Esc 处理器能够中断进行中的回合（signal 已经穿过
  // runAgent 接线到了每个工具里）。
  const abortRef = useRef<AbortController | null>(null)
  // 会话级的 read-before-edit 追踪器。放在 ref 里跨多次 submit 保留：
  // 在一条消息里 Read、在后续消息里 Edit 也认得这份"已读"记录。
  const trackerRef = useRef<FileReadTracker>(createFileTracker())
  // 会话当前工作目录。初值为入口定下的 cwd；Bash 的 cd 经 runAgent 的 onCwdChange
  // 回写到这里,使下一个回合接续上一回合结束时的目录（跨 submit 保留）。
  const cwdRef = useRef<string>(cwd)
  // 本会话权限覆盖层（allow_session/allow_persist 追加的规则），跨 submit 保留。
  const sessionAllowRef = useRef<string[]>([])
  // 权限请求 FIFO 队列。真相源放 ref:canUseTool 在 agent 循环的异步上下文里被调,
  // 不能依赖闭包里可能陈旧的 state;每次入队/兑现先改 ref 再同步 state 镜像驱动渲染。
  // UI 一次只显示队头;并发 ask(同轮只读批)各自入队、互不覆盖。
  const queueRef = useRef<PendingPermission[]>([])
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([])
  // 本会话判不可用的 provider/model(key=`pid/model` → 原因)。仅内存,进程重启即清。
  // 供 /model picker 灰显标注,以及 auto 模式选下家时跳过。
  const badModelsRef = useRef<Map<string, ErrorCategory>>(new Map())
  // 上一回合实测的窗口占用(input + cache 读,见 message-stop 处)。放 ref:
  // sendMessage 闭包要在下一回合开头读它判定自动压缩,state 快照会陈旧。
  const contextTokensRef = useRef<number | undefined>(undefined)
  // 影子 git 快照(Phase 12):每回合开始前打检查点,/revert 据此回滚。懒建一次。
  const snapshotRef = useRef<SnapshotStore | null>(null)
  if (!snapshotRef.current) snapshotRef.current = createSnapshotStore(cwd)
  // 本会话的检查点列表(随 autosave 写进 SessionRecord v3;--continue/--resume 带回)。
  const checkpointsRef = useRef<SessionCheckpoint[]>(initialSession?.checkpoints ?? [])

  // client ref —— 持有当前激活的 ModelClient，支持运行时热替换。
  // 用 ref 而非 state：client 本身是外部可变对象，不需要触发重渲染。
  const clientRef = useRef<ModelClient | null>(null)
  // 当前选中的模型名，用于 footer 与 /model 列表。
  const [currentModel, setCurrentModel] = useState<string>('unknown')
  // 当前选中的 provider id，与 currentModel 配对，供 /model 列表精确标星（重名模型不误标）。
  const [currentProviderId, setCurrentProviderId] = useState<string>('unknown')
  // client 初始化失败时的错误信息（首次 effect 里设置）。
  const [clientError, setClientError] = useState<string | undefined>(undefined)
  // /model 交互式选择器是否打开；打开时 App 渲染选择器、收起输入框。
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)

  // 系统提示词在挂载时拼一次：身份提示词 + 真实运行环境（平台/shell/目录/日期）。
  // 没有环境块时模型只能凭训练惯性假设 Unix，在 Windows 上张口就 pwd/ls 而报错。
  // cwd 整个会话不变，故只随它记忆；环境随机器而变，所以不同系统拼出的内容不同。
  const systemPrompt = useMemo(
    () =>
      buildSystemPrompt({
        platform: process.platform,
        osVersion: os.release(),
        shell: getShellLabel(),
        cwd,
        date: new Date().toISOString().slice(0, 10),
      }),
    [cwd],
  )

  // 首次挂载时按 settings 创建 client。settings 在整个会话生命周期内不变，
  // 所以空依赖数组即可（不用随 settings 重建）。
  useEffect(() => {
    try {
      clientRef.current = createClientFromSettings(settings)
      setCurrentModel(clientRef.current.getModel())
      setCurrentProviderId(resolveModelSelection(settings).providerId)
    } catch (err) {
      setClientError(err instanceof Error ? err.message : '初始化客户端失败')
    }
  }, []) // 空依赖：settings 在整个会话生命周期内不变，仅首次挂载运行一次

  // 渲染视图。镜像会话内容，外加流式期间任何进行中（尚未提交）的气泡。
  // --continue/--resume 预载会话时,初始列表直接由账本重建(惰性初始化只跑一次)。
  const [state, setState] = useState<ConversationState>(() => ({
    messages: initialSession ? uiMessagesFromConversation(initialSession.conversation) : [],
    isThinking: false,
    totalUsage: initialSession ? initialSession.conversation.totalUsage : undefined,
    contextTokens: undefined,
    generation: 0,
  }))

  // 小辅助函数：按 id 不可变地更新某一条消息。
  const patch = useCallback((id: string, fn: (m: UIMessage) => UIMessage) => {
    setState((prev) => ({ ...prev, messages: prev.messages.map((m) => (m.id === id ? fn(m) : m)) }))
  }, [])

  // 上下文压缩(Phase 10B):摘要替换老历史,保留最近回合。/compact 手动调;
  // sendMessage 在占用越过阈值时自动调。失败抛出 —— 原账本不动,绝不半压。
  // 只换账本不动屏幕:state.messages 是显示层 scrollback,压缩前的对话仍可回看。
  const compactConversation = useCallback(async (): Promise<string> => {
    const conv = conversationRef.current
    const cut = findCompactionCut(conv.getMessages())
    if (cut === null) return '历史太短,无需压缩。'
    const client = clientRef.current
    if (!client) throw new Error('客户端未初始化,无法压缩。')
    const before = conv.length
    const summary = await summarizeForCompaction(client, conv.getMessages().slice(0, cut), {
      model: client.getModel(),
      max_tokens: maxTokens,
    })
    conversationRef.current = applyCompaction(conv, summary, cut)
    // 检查点联动(Phase 12):被折叠区间的检查点失效删除,保留区间的下标重映射。
    checkpointsRef.current = remapCheckpoints(checkpointsRef.current, cut)
    // 压缩后窗口占用未知(下一回合实测),先清掉,免得旧值再次触发自动压缩。
    contextTokensRef.current = undefined
    setState((prev) => ({ ...prev, contextTokens: undefined }))
    return `已压缩:账本 ${before} → ${conversationRef.current.length} 条消息(前 ${cut} 条折叠为摘要)。`
  }, [maxTokens])

  const sendMessage = useCallback(
    async (text: string, displayText?: string, pasteFiles?: Record<number, string>, opts?: { isResend?: boolean }) => {
      // client 尚未初始化（effect 还未运行或初始化失败）。
      if (!clientRef.current) {
        setState((prev) => ({ ...prev, error: '客户端未初始化' }))
        return
      }

      // 乐观更新：立刻显示用户这一回合。displayText 存在时供滚动区折叠回显，text 始终为全文发模型。
      // pasteFiles 仅供渲染层把标签包成 OSC-8 链接，不影响发给模型的全文。
      // 重发(降级后自动重试)不再压新 user 气泡——失败回合没提交,原气泡仍在屏。
      if (!opts?.isResend) {
        const userMessage: UIMessage = { id: generateId(), role: 'user', text, displayText, pasteFiles, isStreaming: false }
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, userMessage],
          isThinking: true,
        }))
      } else {
        setState((prev) => ({ ...prev, isThinking: true }))
      }

      // 自动压缩(Phase 10B):上一回合实测占用越过窗口阈值 → 先压缩再发送。
      // 重发(failover)跳过:刚失败的回合没增加占用,且重发要快。压缩失败不阻断
      // 发送 —— 提示后照常发(可能炸窗,但「拒发」比「可能炸」更打断工作流)。
      if (!opts?.isResend) {
        // 窗口按「当前实际在用的 model」解析(模型级 → provider 级 → 缺省 512k)。
        const windowSize = resolveContextWindow(
          settings,
          currentProviderId,
          clientRef.current.getModel(),
        )
        if ((contextTokensRef.current ?? 0) > windowSize * COMPACTION_THRESHOLD) {
          const notifyCompact = (msg: string): void =>
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, { id: generateId(), role: 'system', text: msg, isStreaming: false }],
            }))
          notifyCompact(`上下文占用超过窗口 ${Math.round(COMPACTION_THRESHOLD * 100)}%,自动压缩中…`)
          try {
            notifyCompact(await compactConversation())
          } catch (err) {
            notifyCompact(`自动压缩失败,本回合按原历史发送:${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      // 账本引用必须在自动压缩「之后」取:compactConversation 会把 conversationRef.current
      // 整体换成新 Conversation,先取会让本回合发送/提交/autosave 全落在被换下的旧对象上
      // ——压缩等于没压,且本回合的交换从后续账本里丢失。
      const conversation = conversationRef.current

      // 检查点(Phase 12):回合开始前给工作区打影子快照。fire-and-forget 发起,
      // 失败降级为本回合无检查点(D5);hash 到回合结束记录检查点时再 await(通常早已
      // settle)。重发跳过 —— 失败回合没提交,首发时打的快照仍是本回合的正确锚点。
      const checkpointIndex = conversation.length
      const trackAt = new Date().toISOString()
      const trackPromise: Promise<string | null> = opts?.isResend
        ? Promise.resolve(null)
        : snapshotRef.current!.track().catch(() => null)

      const controller = new AbortController()
      abortRef.current = controller

      // 每回合的流式状态。Agent 可能经历多个模型回合（text -> tool -> text...），
      // 所以我们在每个 message-start 时新建一个助手气泡，并把每个 tool_use id
      // 映射到它在屏幕上的工具气泡。
      let currentAssistantId: string | null = null
      let accumulated = ''
      const toolBubbleId: Record<string, string> = {}
      // 记下每个工具调用的名字与入参,tool-result 时据此判定是否需要把超长输出落盘(见下)。
      // 入参必须留底:Grep 的 output_mode 决定摘要是 files / 计数行,空 input 会误判模式。
      const toolName: Record<string, string> = {}
      const toolInput: Record<string, unknown> = {}
      let lastInputTokens: number | undefined
      // 降级决策:error 分支只「记下」,绝不在 for-await 内重入 sendMessage;循环结束后才执行。
      let failoverDecision: ErrorCategory | null = null

      // 本回合是否以错误收场(showError 真正展示过):决定是否在回合末尾追加
      // 「可用 /revert 撤销本回合文件改动」的提示(Phase 12,spec D6 的轻量替代)。
      let turnErrored = false

      // 把错误渲染成行内消息气泡：能接到当前助手气泡就替换其文本，否则新开一条。
      // 错误属于本回合的 scrollback，不再用会跨轮残留的粘性 state.error。
      const showError = (msg: string): void => {
        turnErrored = true
        const aid = currentAssistantId
        setState((prev) => ({
          ...prev,
          messages: aid
            ? prev.messages.map((m) =>
                m.id === aid ? { ...m, isStreaming: false, text: `错误：${msg}` } : m,
              )
            : [
                ...prev.messages,
                { id: generateId(), role: 'assistant', text: `错误：${msg}`, isStreaming: false },
              ],
        }))
      }

      // Esc 中断：把任何进行中的气泡定格（停掉 spinner），追加一行暗色「已中断」通知。
      // 与 showError 分开——中断是用户主动行为，不该渲染成红色错误。
      const showAborted = (): void => {
        setState((prev) => ({
          ...prev,
          messages: [
            ...prev.messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
            { id: generateId(), role: 'system', text: '⏹ 已中断', isStreaming: false },
          ],
        }))
      }

      try {
        for await (const event of runAgent({
          conversation,
          client: clientRef.current,
          registry,
          userText: text,
          config: {
            model: clientRef.current.getModel(),
            max_tokens: maxTokens,
            system: systemPrompt,
          },
          cwd: cwdRef.current,
          signal: controller.signal,
          tracker: trackerRef.current,
          settings,
          sessionAllow: sessionAllowRef.current,
          onCwdChange: (next: string) => {
            cwdRef.current = next
          },
          canUseTool: (req: PermissionRequest) =>
            new Promise<PermissionVerdict>((resolve) => {
              queueRef.current = [...queueRef.current, { id: generateId(), req, resolve }]
              setPermissionQueue(queueRef.current)
            }),
        })) {
          if (event.type === 'message-start') {
            const id = generateId()
            currentAssistantId = id
            accumulated = ''
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, { id, role: 'assistant', text: '', isStreaming: true }],
            }))
          } else if (event.type === 'text-delta') {
            accumulated += event.text
            const id = currentAssistantId
            if (id) patch(id, (m) => ({ ...m, text: accumulated }))
          } else if (event.type === 'tool-use') {
            // 模型在这一回合说完了，并请求调用一个工具。
            const aid = currentAssistantId
            const tid = generateId()
            toolBubbleId[event.id] = tid
            toolName[event.id] = event.name
            toolInput[event.id] = event.input
            const tool = { name: event.name, input: event.input, status: 'running' as const }
            setState((prev) => ({
              ...prev,
              messages: [
                ...prev.messages.map((m) => (m.id === aid ? { ...m, isStreaming: false } : m)),
                { id: tid, role: 'tool', text: '', isStreaming: true, tool },
              ],
            }))
          } else if (event.type === 'tool-result') {
            const tid = toolBubbleId[event.id]
            if (tid) {
              // 输出超出行内展示上限(summarizeOutput 给出 moreCount>0)时,把完整输出落盘,
              // UI 渲染可 ctrl+点击的文件路径。判定用纯函数、落盘在 setState 外完成,
              // 避免 React 重复调用 updater 时重复写盘。
              const name = toolName[event.id] ?? ''
              const probe: UIToolCall = {
                name,
                input: toolInput[event.id] ?? {},
                status: 'done',
                isError: event.is_error,
                output: event.output,
              }
              const summary = summarizeOutput(probe)
              // preview(Bash 类)与 files(Glob/Grep 文件清单)被截断时,都把完整输出落盘,
              // 让「… +N」那行可 ctrl+点击查看全体内容。
              const truncated =
                (summary.kind === 'preview' || summary.kind === 'files') && summary.moreCount > 0
              // Grep content/count 有命中时摘要为单行计数,完整命中内容被隐藏,同样落盘供链接。
              const hides = summary.kind === 'line' && lineSummaryHidesContent(probe)
              // Edit 的行级 diff 超过上限被收口时,落盘完整 diff 文本(内容来自 old/new,不是 event.output)。
              const outputFile =
                name === 'Edit'
                  ? spillEditDiff(toolInput[event.id], event.is_error)
                  : truncated || hides
                    ? writeToolOutputFile(name, event.output)
                    : undefined
              patch(tid, (m) => ({
                ...m,
                isStreaming: false,
                tool: m.tool
                  ? {
                      ...m.tool,
                      status: 'done',
                      isError: event.is_error,
                      output: event.output,
                      outputFile,
                      // 记下该工具运行时的会话 cwd(cwdRef 经 onCwdChange 实时镜像 Bash cd 后的目录)。
                      // 否则文件清单链接会拿入口 cwd 拼相对路径,cd 之后指向错误目录。
                      cwd: cwdRef.current,
                    }
                  : m.tool,
              }))
            }
          } else if (event.type === 'message-stop') {
            // 完整上下文规模 = 新输入 + 缓存命中读取。两家 client 的 input_tokens 已归一为「不含缓存」，
            // 这里加回 cache_read 才是真实窗口占用，否则开缓存的 Anthropic 会显著偏低、软上限永不触发。
            lastInputTokens = event.usage.input_tokens + (event.usage.cache_read_input_tokens ?? 0)
            const id = currentAssistantId
            const usage = event.usage
            if (id) patch(id, (m) => ({ ...m, isStreaming: false, usage }))
          } else if (event.type === 'warning') {
            setState((prev) => ({
              ...prev,
              messages: [
                ...prev.messages,
                { id: generateId(), role: 'system', text: event.message, isStreaming: false },
              ],
            }))
          } else if (event.type === 'error') {
            // 中断引发的错误（abort 经 runAgent 以 error 事件透出时）不渲染成错误。
            if (controller.signal.aborted) {
              showAborted()
            } else {
              const cat: ErrorCategory = event.category ?? 'other'
              // 只在「还没吐出任何文本」时才考虑降级:额度/认证错误都发生在开流阶段,满足;
              // 流到一半才报错则只提示(重发会重复内容)。决策记下,循环结束后执行。
              const preStream = accumulated === '' && currentAssistantId === null
              if (preStream && cat !== 'other') failoverDecision = cat
              else showError(event.message)
            }
          }
        }

        // 回合结束。runAgent 此时已把整个回合提交进账本（成功时）或什么都
        // 没提交（出错时），所以直接从它读取总计。
        contextTokensRef.current = lastInputTokens ?? contextTokensRef.current
        setState((prev) => ({
          ...prev,
          isThinking: false,
          totalUsage: conversation.totalUsage,
          contextTokens: lastInputTokens ?? prev.contextTokens,
        }))

        // 记录检查点(Phase 12):track 成功才记。出错回合也记 —— 快照是「回合开始前」
        // 的锚点,此时 checkpointIndex == 账本长度,/revert 的截断退化为 no-op、
        // 文件回滚正是「撤销出错回合的半截改动」。await 通常立即返回(track 早已 settle)。
        const checkpointHash = await trackPromise
        if (checkpointHash) {
          checkpointsRef.current = [
            ...checkpointsRef.current,
            {
              messageIndex: checkpointIndex,
              hash: checkpointHash,
              at: trackAt,
              label: text.replace(/\s+/g, ' ').trim().slice(0, 80),
            },
          ]
        }

        // 自动保存(Phase 10A):回合提交后写盘,fire-and-forget——autosave 失败
        // 不能打断对话(空会话在 store 层跳过;出错回合未提交,重写同内容无害)。
        void autosaveSession(
          sessionIdRef.current,
          cwd,
          conversation,
          sessionCreatedAtRef.current,
          checkpointsRef.current,
        ).catch(() => {})

        // 出错收场且有检查点:点一句 /revert,把「要不要撤销半截文件改动」的决定权
        // 交给用户(有意不自动回滚 —— 出错 ≠ 用户想丢掉半成品,spec D6)。
        if (turnErrored && checkpointHash) {
          setState((prev) => ({
            ...prev,
            messages: [
              ...prev.messages,
              { id: generateId(), role: 'system', text: '本回合的文件改动可用 /revert 撤销。', isStreaming: false },
            ],
          }))
        }

        // 降级:此时 for-await 已结束(client 已 return),安全地切模型/弹框。
        if (failoverDecision) {
          const cat = failoverDecision
          const pid = currentProviderId
          // 用 clientRef.current.getModel() 而非闭包里的 currentModel:auto 连环降级时,
          // 递归 sendMessage 是同一闭包实例(currentModel 是陈旧的初始值),而 clientRef 已被
          // 热替换,getModel() 才是本回合真正在用、刚失败的那个 model。
          const failedModel = clientRef.current?.getModel() ?? currentModel
          const models = modelNames(settings.providers[pid])
          // 1) 标坏(auth 标整个 provider 的所有 model)。
          for (const k of badKeysForFailure(pid, failedModel, cat, models)) {
            badModelsRef.current.set(k, k === modelKey(pid, failedModel) ? cat : 'auth')
          }
          // 2) 决策。
          const reasonText = cat === 'auth' ? 'API key 失效' : cat === 'quota' ? '额度耗尽' : '模型不可用'
          const action = decideFailover({
            category: cat,
            mode: resolveFailoverMode(settings),
            providerId: pid,
            models,
            currentModel: failedModel,
            bad: new Set(badModelsRef.current.keys()),
          })
          // 系统通知内联(不调用 print:它定义在本 useCallback 之后,放进依赖数组会 TDZ)。
          const notify = (msg: string): void =>
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, { id: generateId(), role: 'system', text: msg, isStreaming: false }],
            }))
          if (action.kind === 'retry') {
            notify(`${reasonText},已切换到 ${pid}/${action.model} 重试`)
            // 同 provider 内热替换 client(persist=false,currentProviderId 不变)。不复用 switchModel:
            // 它定义在本 useCallback 之后,放进依赖数组会 TDZ;这里是其无写盘的子集。
            clientRef.current = createModelClient(getProviderConfig(settings, pid), action.model)
            setCurrentModel(action.model)
            // 重发的 runAgent 用 clientRef.current.getModel() 取新模型,直接重发即可。
            abortRef.current = null
            await sendMessage(text, undefined, undefined, { isResend: true })
            return
          }
          // dialog:弹框,picker 据 badModelsRef 灰显标注。
          notify(`${reasonText},请选择其他模型`)
          setModelSelectorOpen(true)
        }
      } catch (err) {
        // abort 多半以抛出 AbortError 的形式中断循环；按中断而非错误处理。
        if (controller.signal.aborted) {
          showAborted()
        } else {
          showError(err instanceof Error ? err.message : '未知错误')
        }
        setState((prev) => ({ ...prev, isThinking: false }))
      } finally {
        abortRef.current = null
      }
    },
    [maxTokens, registry, patch, cwd, settings, systemPrompt, currentProviderId, currentModel, compactConversation],
  )

  const clear = useCallback(() => {
    conversationRef.current.clear()
    // 换新会话 id(Phase 10A):清掉的历史保留在旧文件里(仍可 --resume 回来),
    // 新对话写新文件,不覆写旧会话。
    sessionIdRef.current = newSessionId()
    sessionCreatedAtRef.current = new Date().toISOString()
    contextTokensRef.current = undefined
    checkpointsRef.current = [] // 新会话从零开始;影子仓库不清(历史 commit 无害)
    // 整体替换消息 → 自增 generation 令 <Static> remount，不再沿用旧会话的高水位。
    setState((prev) => ({
      messages: [],
      isThinking: false,
      totalUsage: undefined,
      contextTokens: undefined,
      generation: prev.generation + 1,
    }))
  }, [])

  // 用户在对话框按键 → 兑现队头(allow_session/allow_persist 连带清扫同 rule 项),
  // 下一项自动顶上。
  // expectedHeadId 校验:输入层对同一 stdin chunk 的多个按键同步循环派发(见
  // input/stdin.ts),重渲染要等同步块结束 —— 按住 Enter/Esc 会在同一渲染窗口连调
  // 本函数,不校验的话第二次会盲裁决用户还没看到的下一项。id 来自调用方渲染快照,
  // 与真实队头不符即丢弃(下一帧对话框会带新 id 重新出现)。
  // 先更新队列再调 resolver:这是防御性顺序 —— resolve 的 await 延续按规范走微任务,
  // 本不会同步重入,但 PendingPermission.resolve 的类型允许任意同步回调(测试就传
  // 同步函数),不依赖微任务时序的写法更稳、也更易推理。
  const resolvePermission = useCallback((verdict: PermissionVerdict, expectedHeadId: string | null) => {
    if (queueRef.current[0]?.id !== expectedHeadId) return
    const { settled, rest } = resolveHead(queueRef.current, verdict)
    queueRef.current = rest
    setPermissionQueue(rest)
    for (const p of settled) p.resolve(verdict)
  }, [])

  // 向对话记录追加一条本地通知（斜杠命令的输出）。
  const print = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, { id: generateId(), role: 'system', text, isStreaming: false }],
    }))
  }, [])

  // 换入一个已加载的会话，并据其历史重建 UI 列表。
  const load = useCallback((conv: Conversation) => {
    conversationRef.current = conv
    // 换入的账本与现有检查点下标对不上,清空(/resume 路径由 adoptSession 重新填入)。
    checkpointsRef.current = []
    // 同 clear：换入新会话属于整体替换，自增 generation 强制 <Static> remount，
    // 否则换入的历史会被旧高水位从头截断。
    setState((prev) => ({
      messages: uiMessagesFromConversation(conv),
      isThinking: false,
      totalUsage: conv.totalUsage,
      contextTokens: undefined,
      generation: prev.generation + 1,
    }))
  }, [])

  // /resume 载入自动会话:换入账本 + 接管会话身份(后续 autosave 续写同一文件)。
  // 与 /load 命名存档不同——后者是只读快照,不接管 id(autosave 仍写当前自动会话)。
  const adoptSession = useCallback(
    (conv: Conversation, id: string, createdAt: string, checkpoints: SessionCheckpoint[] = []) => {
      load(conv)
      sessionIdRef.current = id
      sessionCreatedAtRef.current = createdAt
      // 检查点随会话身份一起接管(影子仓库在盘上,跨进程 hash 仍有效)。
      checkpointsRef.current = checkpoints
    },
    [load],
  )

  // 回滚到检查点(Phase 12,/revert):文件先回、账本后截 —— restore 抛错时账本
  // 必须原样(文件没回去,账本更不能动)。截断后清 FileReadTracker(旧 mtime 记录
  // 对不上回滚后的文件,会让 read-before-edit 误判「读过」)。
  const revertToCheckpoint = useCallback(
    async (cp: SessionCheckpoint): Promise<string> => {
      await snapshotRef.current!.restore(cp.hash)
      const conv = conversationRef.current
      const before = conv.length
      conversationRef.current = Conversation.fromJSON({
        version: 1,
        messages: conv.getMessages().slice(0, cp.messageIndex),
        // 成本账非窗口账:已花的钱不因回滚消失(与压缩同一原则)。
        totalUsage: conv.totalUsage,
      })
      // 回滚点之后的检查点全部失效(含同 index 的出错回合检查点)。
      checkpointsRef.current = checkpointsRef.current.filter((c) => c.messageIndex < cp.messageIndex)
      trackerRef.current = createFileTracker()
      contextTokensRef.current = undefined
      // 回滚到会话起点 = 账本清空:对齐 /clear 语义换新会话 id,旧文件保留旧历史
      //(否则 autosave 的空会话跳过会让旧文件残留已回滚的账本,--continue 又复活它)。
      if (conversationRef.current.length === 0) {
        sessionIdRef.current = newSessionId()
        sessionCreatedAtRef.current = new Date().toISOString()
      }
      setState((prev) => ({
        messages: uiMessagesFromConversation(conversationRef.current),
        isThinking: false,
        totalUsage: conversationRef.current.totalUsage,
        contextTokens: undefined,
        generation: prev.generation + 1,
      }))
      void autosaveSession(
        sessionIdRef.current,
        cwd,
        conversationRef.current,
        sessionCreatedAtRef.current,
        checkpointsRef.current,
      ).catch(() => {})
      return (
        `已回滚到 ${cp.at.slice(0, 16).replace('T', ' ')} 的检查点(账本 ${before} → ` +
        `${conversationRef.current.length} 条)。影子仓库保留全部历史,误滚可再 /revert 到更近的检查点。`
      )
    },
    [cwd],
  )

  // 运行时热替换 client，支持不清空对话历史地切换模型。
  // persist=true 时同步写入本地层 settings.local.json。
  const switchModel = useCallback(
    (sel: ModelSelection, persist: boolean): string => {
      try {
        const provider = getProviderConfig(settings, sel.providerId)
        clientRef.current = createModelClient(provider, sel.model)
        setCurrentModel(sel.model)
        setCurrentProviderId(sel.providerId)
        if (persist) {
          // 扁平默认 provider（registry 里没有 'default' 条目）只存裸模型名：
          // 回读时 resolveModelSelection 仍映射回同一选择，避免写成 "default/x" 污染合成的 models 列表。
          const isFlatDefault =
            sel.providerId === DEFAULT_PROVIDER_ID && !settings.providers[sel.providerId]
          setModelInSettings(isFlatDefault ? sel.model : `${sel.providerId}/${sel.model}`)
        }
        return `已切换到 ${sel.providerId}/${sel.model}${persist ? '（已写盘）' : ''}`
      } catch (err) {
        return `切换失败：${err instanceof Error ? err.message : String(err)}`
      }
    },
    [settings],
  )

  // 选择器里回车确认：切换到目标模型，persist 由选项栏的 --save 复选框带过来(勾选则写盘)；
  // 收起选择器，并把切换结果作为一条系统通知打印出来（与直输路径输出一致）。
  // 选择器候选只来自已声明模型，选中即合法，无需复刻直输路径那套未知模型校验。
  const confirmModelSelection = useCallback(
    (providerId: string, model: string, persist: boolean) => {
      setModelSelectorOpen(false)
      print(switchModel({ providerId, model }, persist))
    },
    [switchModel, print],
  )

  // 选择器里 Esc 取消：仅收起，不切换、不打印。
  const closeModelSelector = useCallback(() => {
    setModelSelectorOpen(false)
  }, [])

  // 中断进行中的流式回合（Esc）。signal 早已穿过 runAgent 接到每个工具，abort 后
  // 循环会以抛出 / error 事件结束，并由上面的 showAborted 收尾。无回合在跑则返回 false，
  // 让上层把 Esc 改作他用（如回到底部）。
  const interrupt = useCallback((): boolean => {
    const controller = abortRef.current
    if (!controller) return false
    controller.abort()
    return true
  }, [])

  // 输入框唯一的入口：一条斜杠命令，或一条聊天消息。
  // displayText 为折叠回显文本，pasteFiles 为粘贴 id→路径映射；仅非命令路径传入。
  const submit = useCallback(
    async (input: string, displayText?: string, pasteFiles?: Record<number, string>) => {
      const parsed = parseInput(input)
      if (!parsed) {
        await sendMessage(input, displayText, pasteFiles)
        return
      }
      const cmd = findCommand(parsed.name)
      if (!cmd) {
        print(`未知命令 /${parsed.name}。输入 /help 查看可用命令。`)
        return
      }
      const ctx: CommandContext = {
        args: parsed.args,
        print,
        clear,
        conversation: conversationRef.current,
        load,
        adoptSession,
        cwd,
        compact: compactConversation,
        checkpoints: [...checkpointsRef.current],
        checkpointDiff: (cp) => snapshotRef.current!.diffStat(cp.hash),
        revertToCheckpoint,
        settings,
        currentModel,
        currentProviderId,
        switchModel,
        openModelSelector: () => setModelSelectorOpen(true),
        registry,
      }
      try {
        await cmd.run(ctx)
      } catch (err) {
        print(`错误：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [
      sendMessage,
      print,
      clear,
      load,
      adoptSession,
      cwd,
      compactConversation,
      revertToCheckpoint,
      settings,
      currentModel,
      currentProviderId,
      switchModel,
      registry,
    ],
  )

  return {
    state,
    submit,
    clear,
    pendingPermission: permissionQueue[0]?.req ?? null,
    resolvePermission,
    pendingPermissionId: permissionQueue[0]?.id ?? null,
    permissionQueueLength: permissionQueue.length,
    currentModel,
    currentProviderId,
    clientError,
    switchModel,
    modelSelectorOpen,
    confirmModelSelection,
    closeModelSelector,
    badModels: badModelsRef.current,
    interrupt,
  }
}
