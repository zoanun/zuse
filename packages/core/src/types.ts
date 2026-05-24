// Content blocks in a message
export type ContentBlock =
  | { type: 'text'; text: string }
  // Future: tool_use, tool_result will be added in Phase 3

// Message in conversation
export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

// Events emitted during streaming
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'message-start'; id: string; model: string }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  | { type: 'error'; message: string }

// Token usage tracking (fault mode ⑧ defense)
export interface Usage {
  input_tokens: number
  output_tokens: number
  // cache_read_input_tokens?: number  // Phase 6
  // cache_write_input_tokens?: number // Phase 6
}

// Model configuration
export interface ModelConfig {
  model: string
  max_tokens: number
  // temperature?: number  // Phase 2+
}

// Client config (API key, base URL, etc.)
export interface ClientConfig {
  apiKey: string
  baseURL?: string
}