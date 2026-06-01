// Content blocks in a message
export type ContentBlock =
  | { type: 'text'; text: string }
  // Future: tool_use, tool_result will be added in Phase 3

// Message in conversation.
// v1 only emits 'user' / 'assistant'. The global system prompt is passed via
// the API's top-level `system` field, NOT as a message here.
// Note: newer models (Opus 4.8+) also accept a mid-conversation `role: 'system'`
// message inside the array (must not be first; appended so it won't bust the
// cached prefix). Deferred — not in the union until we support it (see Phase 2).
export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

// Events emitted during streaming
export type StreamEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
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