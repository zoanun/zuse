/**
 * @zuse/protocol — web ↔ server 的唯一线缆契约（type-only，零运行时）。
 *
 * 注意：这里从 @zuse/core 只做 `export type` 转导。core 是 Node 引擎（node:fs /
 * better-sqlite3 等），不能进浏览器 bundle；但 `export type` 在编译期被擦除，web
 * 侧 `import type` 这些类型不会把任何 core 运行时拖进 bundle。详见 F3 设计 §2。
 */
import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

export type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

/** 快照消息的单个内容片段（镜像 web 侧 Part 形状；tool-result 用 isError，非 is_error）。 */
export type SnapshotPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; name: string; output: string; isError: boolean }

/** 快照消息（用于检查点时间轴恢复）。 */
export interface SnapshotMessage {
  role: 'user' | 'assistant'
  parts: SnapshotPart[]
  /** 若本条用户消息开启了某次 turn，则带上该 turn 检查点的 hash（供前端渲染逐条 revert）。 */
  checkpointId?: string
}

/** 检查点轻量摘要。 */
export interface CheckpointLite { id: string; label: string }

/** 会话列表项的轻量元数据（权威源；server 的 sessionStore.ts `import type` 复用）。 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  cwd: string
  messageCount: number
}

/** 记忆条目 DTO(权威源;server 的 MemoryService `import type` 复用,形状 = MemoryRow)。 */
export interface MemoryItem {
  id: number
  type: 'user' | 'project' | 'insight' | 'reference'
  content: string
  project: string
  hook: string
  createdAt: string
  updatedAt: string
}

/** A known project: its memory `project` slug (cwd-slug) ↔ the real working directory. */
export interface ProjectInfo {
  slug: string
  cwd: string
}

/** A named persona (USER.md-style prompt layer), one of which may be active (M2). */
export interface PersonaItem {
  id: string
  name: string
  content: string
  createdAt: string
  updatedAt: string
}

/** All personas plus which is active (null = none → only the read-only core prompt). */
export interface PersonasState {
  personas: PersonaItem[]
  activeId: string | null
}

/** An MCP server's config + live connection status + its tools (M4 management panel). */
export interface McpServerInfo {
  name: string
  /** connected = live this session; failed = configured but connect errored; configured = in settings, not yet connected (restart to apply). */
  status: 'connected' | 'failed' | 'configured'
  /** The stdio command (or omitted for URL/SSE servers), for display. */
  command?: string
  args?: string[]
  /** Connect error message when status === 'failed'. */
  error?: string
  /** Tools exposed by the server (only populated when connected). */
  tools: Array<{ name: string; description?: string }>
}

/** One labelled layer of the assembled system prompt (read-only "effective prompt" view). */
export interface PromptSection {
  /** Where it came from: 'core' | 'environment' | 'SYSTEM.md' | 'ZUSE.md' | 'MEMORY.md' | 'persona' | … */
  source: string
  content: string
}

/** 轻量 todo —— 与 server 内部状态镜像。 */
export interface TodoItemLite {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 已推给前端但尚未解决的权限请求。 */
export interface PendingPermissionLite {
  id: string
  req: PermissionRequest
}

/**
 * SessionManager 可发射给订阅者的全部事件。成员全部 JSON 可序列化（无函数/类实例），
 * 字段名镜像 @zuse/core 的 StreamEvent，便于零变换转发。
 */
export type SessionEvent =
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown; invalid_args?: string }
  | { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }
  | { type: 'message-stop'; stop_reason: string; usage: Usage }
  | { type: 'turn-start'; isResend: boolean }
  | { type: 'turn-end' }
  | { type: 'usage-update'; totalUsage: Usage | undefined }
  | { type: 'context-update'; contextTokens: number | undefined; contextWindow: number | undefined }
  | { type: 'permission-request'; id: string; req: PermissionRequest }
  | { type: 'permission-resolved'; id: string; verdict: PermissionVerdict }
  | { type: 'compaction-start' }
  | { type: 'compaction-done'; summaryText: string }
  | { type: 'failover'; fromModel: string; toModel: string; reason: string }
  | { type: 'checkpoint-recorded'; id: string; messageIndex: number; label: string }
  | { type: 'memory-notice'; text: string }
  | { type: 'todos-update'; todos: TodoItemLite[] }
  | { type: 'cwd-change'; cwd: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; category?: string }
  | { type: 'aborted' }
  | { type: 'model-select-needed'; reason: string }
  | { type: 'reverted'; checkpointId: string }
  | { type: 'user-echo'; text: string }
  | { type: 'title-changed'; title: string }

/** 连上时发给晚加入订阅者的全量状态快照。 */
export interface SessionSnapshot {
  sessionId: string
  isThinking: boolean
  model: string
  cwd: string
  totalUsage: Usage | undefined
  contextTokens: number | undefined
  contextWindow: number | undefined
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  messageCount: number
  messages: SnapshotMessage[]
  checkpoints: CheckpointLite[]
}

/** 上行 client → server。 */
export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'steer'; text: string }
  | { type: 'permission-reply'; id: string; verdict: PermissionVerdict }
  | { type: 'switch-model'; providerId: string; model: string }
  | { type: 'reset-session' }
  | { type: 'revert'; checkpointId: string }
  | { type: 'retry' }

/** 下行 server → client。 */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: SessionEvent }
  | { type: 'error'; message: string }
