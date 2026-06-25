/**
 * @zuse/protocol — web ↔ server 的唯一线缆契约（type-only，零运行时）。
 *
 * 注意：这里从 @zuse/core 只做 `export type` 转导。core 是 Node 引擎（node:fs /
 * better-sqlite3 等），不能进浏览器 bundle；但 `export type` 在编译期被擦除，web
 * 侧 `import type` 这些类型不会把任何 core 运行时拖进 bundle。详见 F3 设计 §2。
 */
import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

export type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

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
}

/** 上行 client → server。 */
export type ClientMessage =
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'steer'; text: string }
  | { type: 'permission-reply'; id: string; verdict: PermissionVerdict }
  | { type: 'switch-model'; providerId: string; model: string }
  | { type: 'reset-session' }

/** 下行 server → client。 */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; event: SessionEvent }
  | { type: 'error'; message: string }
