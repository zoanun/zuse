// 消息里的内容块（与 Anthropic 的消息格式对齐）。
export type ContentBlock =
  | { type: 'text'; text: string }
  // 助手请求调用一个工具。`input` 是已解析好的参数对象。
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // 把工具的输出作为一个 user 角色的块回喂给模型，用调用 id 关联。
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

// 会话中的一条消息。
// v1 只产生 'user' / 'assistant'。全局系统提示词通过 API 顶层的 `system`
// 字段传入，而不是作为这里的一条消息。
// 注意：较新的模型（Opus 4.8+）也接受会话中途的 `role: 'system'` 消息
//（不能放在首条；追加在末尾以免破坏已缓存的前缀）。暂缓——在我们支持它
// 之前不放进这个联合类型（见 Phase 2）。
export interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

// 一个回合中产生的事件。前四个来自 ModelClient；后三个由 Agent 循环在
// 运行工具时产生（Phase 3）。
export type StreamEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  // 模型决定调用一个工具（由 client 在流把完整 tool_use 块拼装好后产生）。
  | { type: 'tool-use'; id: string; name: string; input: unknown }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  // 一个工具运行完成（由 Agent 循环产生，不是 client）。
  | { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }
  // Agent 触达 max_turns 并停止（故障模式①）。
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }

// Token 用量追踪（故障模式⑧的防御）
export interface Usage {
  input_tokens: number
  output_tokens: number
  // cache_read_input_tokens?: number  // Phase 6
  // cache_write_input_tokens?: number // Phase 6
}

// 模型配置
export interface ModelConfig {
  model: string
  max_tokens: number
  // 顶层系统提示词。缺省时 runAgent 会注入 DEFAULT_SYSTEM_PROMPT —— 设此字段可覆盖。
  system?: string
  // temperature?: number  // Phase 2+
}

// 客户端配置（API key、base URL 等）
export interface ClientConfig {
  apiKey: string
  baseURL?: string
}
