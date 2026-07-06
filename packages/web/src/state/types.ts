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
  // only set for role:'user' — true if this was a mid-turn steer (sent while the reply was still
  // streaming). Rendered with a "↪ 插话" marker; also stops the preceding assistant message from
  // being treated as turn-final (so it doesn't spuriously grow a copy/share footer mid-turn).
  steer?: boolean
}
/**
 * A "turn opener" is a real user message — the start of a turn. A mid-turn steer bubble is also
 * role:'user', but it's an interjection, NOT a turn boundary. Anything that walks back to "this
 * turn's user message" — the checkpoint/revert anchor (reducer), share grouping (Shell.turnIdsOf),
 * the running sub-agent panel's scope (AgentsPanel.currentTurn) — must use this so a steer doesn't
 * get mistaken for the turn's start. Single source of truth so a new scan can't silently drift.
 */
export function isTurnOpener(m: Message): boolean {
  return m.role === 'user' && !m.steer
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
