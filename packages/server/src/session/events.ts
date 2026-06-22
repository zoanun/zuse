import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

/**
 * SessionEvent — everything the SessionManager can emit to subscribers.
 * All members are plain JSON-serialisable (no functions, no class instances).
 *
 * Passthrough members (message-start / text-delta / tool-use / tool-result /
 * message-stop) mirror the real @zuse/core StreamEvent field names so Task 6
 * can forward them without transformation.
 *
 * Differences from the plan snippet reconciled against actual core types:
 *   • tool-use:    added `invalid_args?: string`  (core StreamEvent has it)
 *   • tool-result: added `name: string`; `is_error` is required (not optional)
 *                  (core StreamEvent `tool-result` shape)
 *   • message-stop: added `stop_reason: string`   (core StreamEvent has it)
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
  | { type: 'context-update'; contextTokens: number | undefined }
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

/** Lightweight todo item — mirrors the relevant fields used by SessionManager. */
export interface TodoItemLite {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A pending permission that has been sent to the subscriber but not yet resolved. */
export interface PendingPermissionLite {
  id: string
  req: PermissionRequest
}

/** Full state snapshot sent to late-joining subscribers. */
export interface SessionSnapshot {
  sessionId: string
  isThinking: boolean
  model: string
  cwd: string
  totalUsage: Usage | undefined
  contextTokens: number | undefined
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  messageCount: number
}
