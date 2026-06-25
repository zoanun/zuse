import type { TodoItemLite, PendingPermissionLite, Usage } from '@zuse/protocol'

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }

export interface Message { id: string; role: 'user' | 'assistant'; parts: Part[] }
export interface Notice { id: string; text: string; kind: 'info' | 'warn' | 'error' }
export type Connection = 'connecting' | 'live' | 'down'

export interface AppState {
  messages: Message[]
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  model?: string
  contextTokens?: number
  contextWindow?: number
  totalUsage?: Usage
  thinking: boolean
  connection: Connection
  notices: Notice[]
}
