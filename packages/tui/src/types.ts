import type { Usage } from '@zuse/core'

/** UI state for a single message in the conversation */
export interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'system'  // 'system' = local notices (slash commands)
  text: string  // accumulated text content
  isStreaming: boolean  // true while receiving deltas
  usage?: Usage  // only for assistant messages after completion
}

/** Overall conversation state in UI */
export interface ConversationState {
  messages: UIMessage[]
  isThinking: boolean  // true while waiting for model response
  totalUsage?: Usage  // cumulative usage across the whole conversation
  contextTokens?: number  // last turn's input_tokens — the live context size (fault mode ②)
  error?: string  // error message if any
}