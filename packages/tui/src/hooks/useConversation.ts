import { useState, useCallback, useRef } from 'react'
import type { UIMessage, ConversationState } from '../types.js'
import {
  Conversation,
  runAgent,
  createFileTracker,
  type ModelClient,
  type ToolRegistry,
  type FileReadTracker,
  type ResolvedSettings,
  type PermissionRequest,
  type PermissionVerdict,
} from '@zuse/core'
import type { CommandContext } from '../commands/types.js'
import { parseInput, findCommand } from '../commands/registry.js'

interface UseConversationOptions {
  client: ModelClient | null
  maxTokens: number
  registry: ToolRegistry
  /** 工作目录：工具的相对路径据此解析。由入口一次性定好传入。 */
  cwd: string
  /** 解析后的设置，驱动权限闸门。 */
  settings: ResolvedSettings
}

interface UseConversationReturn {
  state: ConversationState
  /** 输入框的入口：分发斜杠命令，或发送一条消息。 */
  submit: (input: string) => Promise<void>
  clear: () => void
  pendingPermission: PermissionRequest | null
  resolvePermission: (verdict: PermissionVerdict) => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useConversation({
  client,
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
  // 本会话权限覆盖层（allow_session/allow_persist 追加的规则），跨 submit 保留。
  const sessionAllowRef = useRef<string[]>([])
  // 等待用户裁决的权限请求；非 null 时渲染对话框、禁用输入框。
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // 保存当前 ask 的 resolve，按键后调用它让 agent 循环继续。
  const permissionResolveRef = useRef<((v: PermissionVerdict) => void) | null>(null)

  // 渲染视图。镜像会话内容，外加流式期间任何进行中（尚未提交）的气泡。
  const [state, setState] = useState<ConversationState>({
    messages: [],
    isThinking: false,
    totalUsage: undefined,
    contextTokens: undefined,
    error: undefined,
  })

  // 小辅助函数：按 id 不可变地更新某一条消息。
  const patch = useCallback((id: string, fn: (m: UIMessage) => UIMessage) => {
    setState((prev) => ({ ...prev, messages: prev.messages.map((m) => (m.id === id ? fn(m) : m)) }))
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      if (!client) {
        setState((prev) => ({ ...prev, error: 'Client not initialized' }))
        return
      }
      const conversation = conversationRef.current

      // 乐观更新：立刻显示用户这一回合。
      const userMessage: UIMessage = { id: generateId(), role: 'user', text, isStreaming: false }
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isThinking: true,
        error: undefined,
      }))

      const controller = new AbortController()
      abortRef.current = controller

      // 每回合的流式状态。Agent 可能经历多个模型回合（text -> tool -> text...），
      // 所以我们在每个 message-start 时新建一个助手气泡，并把每个 tool_use id
      // 映射到它在屏幕上的工具气泡。
      let currentAssistantId: string | null = null
      let accumulated = ''
      const toolBubbleId: Record<string, string> = {}
      let lastInputTokens: number | undefined

      try {
        for await (const event of runAgent({
          conversation,
          client,
          registry,
          userText: text,
          config: { model: client.getModel(), max_tokens: maxTokens },
          cwd,
          signal: controller.signal,
          tracker: trackerRef.current,
          settings,
          sessionAllow: sessionAllowRef.current,
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
              patch(tid, (m) => ({
                ...m,
                isStreaming: false,
                tool: m.tool
                  ? { ...m.tool, status: 'done', isError: event.is_error, output: event.output }
                  : m.tool,
              }))
            }
          } else if (event.type === 'message-stop') {
            lastInputTokens = event.usage.input_tokens
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
            const aid = currentAssistantId
            const msg = event.message
            setState((prev) => ({
              ...prev,
              messages: aid
                ? prev.messages.map((m) =>
                    m.id === aid ? { ...m, isStreaming: false, text: `Error: ${msg}` } : m,
                  )
                : [
                    ...prev.messages,
                    {
                      id: generateId(),
                      role: 'assistant',
                      text: `Error: ${msg}`,
                      isStreaming: false,
                    },
                  ],
              error: msg,
            }))
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
        const message = err instanceof Error ? err.message : 'Unknown error'
        setState((prev) => ({ ...prev, isThinking: false, error: message }))
      } finally {
        abortRef.current = null
      }
    },
    [client, maxTokens, registry, patch, cwd, settings],
  )

  const clear = useCallback(() => {
    conversationRef.current.clear()
    setState({
      messages: [],
      isThinking: false,
      totalUsage: undefined,
      contextTokens: undefined,
      error: undefined,
    })
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
    setState({
      messages,
      isThinking: false,
      totalUsage: conv.totalUsage,
      contextTokens: undefined,
      error: undefined,
    })
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
        print(`Unknown command: /${parsed.name}. Type /help for a list.`)
        return
      }
      const ctx: CommandContext = {
        args: parsed.args,
        print,
        clear,
        conversation: conversationRef.current,
        load,
        settings,
      }
      try {
        await cmd.run(ctx)
      } catch (err) {
        print(`Error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [sendMessage, print, clear, load, settings],
  )

  return { state, submit, clear, pendingPermission, resolvePermission }
}
