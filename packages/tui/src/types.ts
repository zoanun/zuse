import type { Usage } from '@zuse/core'

/** 在对话记录里展示的一次工具调用（Phase 3）。 */
export interface UIToolCall {
  name: string
  input: unknown
  status: 'running' | 'done'
  isError?: boolean
  output?: string // 工具结果，在 status === 'done' 时填入
}

/** 会话中单条消息的 UI 状态 */
export interface UIMessage {
  id: string
  // 'system' = 本地通知（斜杠命令）；'tool' = 一次工具调用及其结果
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string // 累积的文本内容
  isStreaming: boolean // 正在接收增量时为 true
  usage?: Usage // 仅用于完成后的助手消息
  tool?: UIToolCall // 仅用于 role === 'tool'
}

/** UI 中整个会话的状态 */
export interface ConversationState {
  messages: UIMessage[]
  isThinking: boolean // 正在等待模型响应时为 true
  totalUsage?: Usage // 整个会话的累计用量
  contextTokens?: number // 上一回合的 input_tokens —— 实时上下文大小（故障模式②）
  error?: string // 错误信息（如果有）
}
