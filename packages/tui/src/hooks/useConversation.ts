import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import os from 'node:os'
import type { UIMessage, ConversationState, UIToolCall } from '../types.js'
import { summarizeOutput } from '../components/toolSummary.js'
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
  buildSystemPrompt,
  DEFAULT_PROVIDER_ID,
  type ModelClient,
  type ToolRegistry,
  type FileReadTracker,
  type ResolvedSettings,
  type PermissionRequest,
  type PermissionVerdict,
  type ModelSelection,
} from '@zuse/core'
import { getShellLabel } from '@zuse/tools'
import type { CommandContext } from '../commands/types.js'
import { parseInput, findCommand } from '../commands/registry.js'

interface UseConversationOptions {
  maxTokens: number
  registry: ToolRegistry
  /** 工作目录：工具的相对路径据此解析。由入口一次性定好传入。 */
  cwd: string
  /** 解析后的设置，驱动权限闸门与 client 初始化。 */
  settings: ResolvedSettings
}

interface UseConversationReturn {
  state: ConversationState
  /** 输入框的入口：分发斜杠命令，或发送一条消息。 */
  submit: (input: string) => Promise<void>
  clear: () => void
  pendingPermission: PermissionRequest | null
  resolvePermission: (verdict: PermissionVerdict) => void
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
  /** 中断进行中的流式回合（Esc）。当前有回合在跑则 abort 并返回 true，否则 false。 */
  interrupt: () => boolean
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useConversation({
  maxTokens,
  registry,
  cwd,
  settings,
}: UseConversationOptions): UseConversationReturn {
  // 已提交的历史 —— 每个回合重新发送的权威账本。
  // 放在 ref（而非 state）里：修改它不应触发重渲染，而且我们绝不希望
  // sendMessage 内部闭包拿到它的陈旧快照。
  const conversationRef = useRef<Conversation>(new Conversation())
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
  // 等待用户裁决的权限请求；非 null 时渲染对话框、禁用输入框。
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // 保存当前 ask 的 resolve，按键后调用它让 agent 循环继续。
  const permissionResolveRef = useRef<((v: PermissionVerdict) => void) | null>(null)

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
  const [state, setState] = useState<ConversationState>({
    messages: [],
    isThinking: false,
    totalUsage: undefined,
    contextTokens: undefined,
    generation: 0,
  })

  // 小辅助函数：按 id 不可变地更新某一条消息。
  const patch = useCallback((id: string, fn: (m: UIMessage) => UIMessage) => {
    setState((prev) => ({ ...prev, messages: prev.messages.map((m) => (m.id === id ? fn(m) : m)) }))
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      // client 尚未初始化（effect 还未运行或初始化失败）。
      if (!clientRef.current) {
        setState((prev) => ({ ...prev, error: '客户端未初始化' }))
        return
      }
      const conversation = conversationRef.current

      // 乐观更新：立刻显示用户这一回合。
      const userMessage: UIMessage = { id: generateId(), role: 'user', text, isStreaming: false }
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isThinking: true,
      }))

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

      // 把错误渲染成行内消息气泡：能接到当前助手气泡就替换其文本，否则新开一条。
      // 错误属于本回合的 scrollback，不再用会跨轮残留的粘性 state.error。
      const showError = (msg: string): void => {
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
              permissionResolveRef.current = resolve
              setPendingPermission(req)
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
              const outputFile = truncated ? writeToolOutputFile(name, event.output) : undefined
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
            if (controller.signal.aborted) showAborted()
            else showError(event.message)
          }
        }

        // 回合结束。runAgent 此时已把整个回合提交进账本（成功时）或什么都
        // 没提交（出错时），所以直接从它读取总计。
        setState((prev) => ({
          ...prev,
          isThinking: false,
          totalUsage: conversation.totalUsage,
          contextTokens: lastInputTokens ?? prev.contextTokens,
        }))
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
    [maxTokens, registry, patch, cwd, settings, systemPrompt],
  )

  const clear = useCallback(() => {
    conversationRef.current.clear()
    // 整体替换消息 → 自增 generation 令 <Static> remount，不再沿用旧会话的高水位。
    setState((prev) => ({
      messages: [],
      isThinking: false,
      totalUsage: undefined,
      contextTokens: undefined,
      generation: prev.generation + 1,
    }))
  }, [])

  // 用户在对话框按键 → 兑现 agent 正在 await 的 promise，并收起对话框。
  const resolvePermission = useCallback((verdict: PermissionVerdict) => {
    const resolve = permissionResolveRef.current
    permissionResolveRef.current = null
    setPendingPermission(null)
    resolve?.(verdict)
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
    const messages: UIMessage[] = conv.getMessages().map((m) => ({
      id: generateId(),
      role: m.role,
      text: m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      isStreaming: false,
    }))
    // 同 clear：换入新会话属于整体替换，自增 generation 强制 <Static> remount，
    // 否则换入的历史会被旧高水位从头截断。
    setState((prev) => ({
      messages,
      isThinking: false,
      totalUsage: conv.totalUsage,
      contextTokens: undefined,
      generation: prev.generation + 1,
    }))
  }, [])

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
  const submit = useCallback(
    async (input: string) => {
      const parsed = parseInput(input)
      if (!parsed) {
        await sendMessage(input)
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
    pendingPermission,
    resolvePermission,
    currentModel,
    currentProviderId,
    clientError,
    switchModel,
    modelSelectorOpen,
    confirmModelSelection,
    closeModelSelector,
    interrupt,
  }
}
