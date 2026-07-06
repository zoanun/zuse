import type { TodoItemLite, PendingPermissionLite, Usage } from '@zuse/protocol'

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; name: string; output: string; isError: boolean }

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: Part[]
  // only set for role:'system'. 'summary' = dimmed italic compaction summary; 'compacting' = the
  // transient "正在压缩…" start notice (dropped when compaction ends — matched by kind, not by text).
  noticeKind?: 'info' | 'warn' | 'error' | 'summary' | 'compacting'
  checkpointId?: string                     // only set for role:'user' — the turn's shadow-git checkpoint
}
export type Connection = 'connecting' | 'live' | 'down'

export interface AppState {
  messages: Message[]
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  model?: string
  /** Active session's working directory (S3) — root for the dir picker / file browser. */
  cwd?: string
  contextTokens?: number
  contextWindow?: number
  totalUsage?: Usage
  thinking: boolean
  connection: Connection
}
