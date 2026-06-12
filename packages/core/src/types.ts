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

/** 模型调用错误的归类:供编排层决定是否降级。 */
export type ErrorCategory = 'quota' | 'auth' | 'unavailable' | 'other'

// 一个回合中产生的事件。前四个来自 ModelClient；后三个由 Agent 循环在
// 运行工具时产生（Phase 3）。
export type StreamEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  // 模型决定调用一个工具（由 client 在流把完整 tool_use 块拼装好后产生）。
  // invalid_args（Phase 11）：模型生成的参数串不是合法 JSON 时，client 不中止回合，
  // 而是带上原始串（截 200 字符）透出；此时 input 为 {} 占位（保证账本可序列化重放），
  // Agent 循环据此跳过执行、合成 is_error tool_result 回喂模型自纠。仅 OpenAI 协议
  // 路径会产生（Anthropic 服务端保证 tool_use.input 合法）。
  | { type: 'tool-use'; id: string; name: string; input: unknown; invalid_args?: string }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  // 一个工具运行完成（由 Agent 循环产生，不是 client）。
  | { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }
  // Agent 触达 max_turns 并停止（故障模式①）。
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; status?: number; category?: ErrorCategory }

// Token 用量追踪（故障模式⑧的防御）。Phase 6 起含缓存命中统计。
export interface Usage {
  // 未命中缓存的「新」输入 token，不含缓存读取部分。各 client 统一归一到此口径：
  // Anthropic 的 input_tokens 本就排除 cache_read；OpenAI 的 prompt_tokens 含缓存，
  // 由 OpenAIClient 减去 cached_tokens 后填入。完整上下文规模 = input_tokens + cache_read_input_tokens。
  input_tokens: number
  output_tokens: number
  // 缓存命中读取的输入 token（Anthropic: cache_read_input_tokens；OpenAI: cached_tokens）。
  cache_read_input_tokens?: number
  // 首次写入缓存的输入 token（Anthropic 专有；OpenAI 无对应，留空）。
  cache_creation_input_tokens?: number
}

/** 全零 Usage 的工厂（含 cache 字段）。会话总计/回合累加/流初始化共用，避免字面量散落。 */
export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

// 模型配置
export interface ModelConfig {
  model: string
  max_tokens: number
  // 顶层系统提示词。缺省时 runAgent 会注入 DEFAULT_SYSTEM_PROMPT —— 设此字段可覆盖。
  system?: string
  // temperature?: number  // Phase 2+
}

// ——— Phase 5：设置与权限 ———

/** 权限模式（对齐 CC，本期不含 plan）。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

/** 工具暴露开关。enabled 在场 → 只暴露交集；disabled → 黑名单。 */
export interface ToolsConfig {
  enabled?: string[]
  disabled?: string[]
}

/** permissions 块（合并后，数组与 defaultMode 一定有值）。 */
export interface PermissionsConfig {
  defaultMode: PermissionMode
  allow: string[]
  ask: string[]
  deny: string[]
}

/** provider 的 wire 协议。 */
export type ProviderProtocol = 'anthropic' | 'openai'

/** models 数组的对象形条目:窗口等属性与 provider 缺省不同的模型用它声明。 */
export interface ModelEntryObject {
  name: string
  /** 该模型的上下文窗口(token),压过 provider 级 contextWindow。 */
  contextWindow?: number
}

/** providers.models 的条目:纯字符串(常态),或带模型级覆盖的对象。 */
export type ModelEntry = string | ModelEntryObject

/** settings 文件里单个 provider 的原始（未解析）形状，全部可选。 */
export interface RawProviderConfig {
  protocol?: ProviderProtocol
  baseURL?: string
  apiKey?: string
  models?: ModelEntry[]
  /**
   * 上下文窗口(token),provider 级回退值。查找顺序:模型级条目 → 这里 →
   * DEFAULT_CONTEXT_WINDOW。供自动压缩判定占用比例。
   */
  contextWindow?: number
}

/** 解析后、可直接交给 client 工厂的完整 provider 配置。 */
export interface ProviderConfig {
  id: string
  protocol: ProviderProtocol
  baseURL?: string
  apiKey: string
  models: string[]
}

/** 当前选中：哪个 provider 的哪个 model。 */
export interface ModelSelection {
  providerId: string
  model: string
}

/** settings 文件里单个搜索后端的原始形状,全部可选。 */
export interface RawWebSearchBackendConfig {
  apiKey?: string
}

/** WebSearch 的原始(未解析)配置,三层合并前的形状。 */
export interface RawWebSearchConfig {
  /** 主后端名(如 "tavily")。缺省取 backends 里第一个有 key 的。 */
  backend?: string
  /** 主后端硬失败时按序回退的后端名列表;缺省 = 不回退。 */
  fallback?: string[]
  /** 每次返回条数上限;缺省 5。 */
  maxResults?: number
  /** 各后端各存各的 key,按后端名索引。 */
  backends?: Record<string, RawWebSearchBackendConfig>
}

/** 解析后的 WebSearch 配置:backends 只含已解析出 key 的后端。供工具使用。 */
export interface WebSearchConfig {
  backend: string
  fallback: string[]
  maxResults: number
  backends: Record<string, { apiKey: string }>
}

/** 三层合并、补默认值后的最终设置。供 TUI 与 agent 使用。 */
export interface ResolvedSettings {
  model?: string
  maxTokens?: number
  baseURL?: string
  apiKey?: string
  /** HTTP(S) 代理地址（如 http://host:port）。配置后所有出站请求都经此代理，见 installProxy。 */
  proxy?: string
  /** 模型调用失败时的降级策略:'dialog' 弹 /model 选择器(默认);'auto' 自动切同 provider 下一个可用模型。 */
  failoverMode?: 'dialog' | 'auto'
  tools: ToolsConfig
  permissions: PermissionsConfig
  providers: Record<string, RawProviderConfig>
  /** WebSearch 原始配置;由 getWebSearchConfig 按需解析(同 providers 的处理方式)。 */
  webSearch?: RawWebSearchConfig
}

/** 判定结果三态。 */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** ask 时交给 canUseTool 的请求载体。rule 是预先算好的待追加规则字符串。 */
export interface PermissionRequest {
  toolName: string
  input: unknown
  /** 命令（Bash）或路径（文件工具）；无则 null。 */
  specifier: string | null
  /** 用于会话覆盖 / 写盘的规则字符串，如 `Bash(git status)` / `Write(./a.ts)`。 */
  rule: string
  /** 触发 ask 的原因（目前仅 Bash 安全检查会给出），供权限对话框展示，让用户知道为何被拦。 */
  reason?: string
}

/** 用户对一次 ask 的裁决（方案 A 回调返回）。 */
export type PermissionVerdict = 'allow' | 'deny' | 'allow_session' | 'allow_persist'
