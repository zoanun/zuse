import type { Usage } from '@zuse/core'

/** UI state for a single message in the conversation */
export interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  text: string  // accumulated text content
  isStreaming: boolean  // true while receiving deltas
  usage?: Usage  // only for assistant messages after completion
}

/** Overall conversation state in UI */
export interface ConversationState {
  messages: UIMessage[]
  isThinking: boolean  // true while waiting for model response
  totalUsage?: Usage  // cumulative usage across the whole conversation
  error?: string  // error message if any
}