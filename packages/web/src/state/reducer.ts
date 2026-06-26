import type { ServerMessage, SessionEvent, SessionSnapshot, SnapshotPart } from '@zuse/protocol'
import type { AppState, Connection, Part } from './types.js'

export const initialState: AppState = {
  messages: [], todos: [], pendingPermissions: [], checkpoints: [],
  thinking: false, connection: 'connecting',
}

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'user-send'; id: string; text: string }
  | { kind: 'connection'; status: Connection }
  | { kind: 'reset' }

function withNotice(state: AppState, text: string, kind: 'info' | 'warn' | 'error'): AppState {
  return { ...state, messages: [...state.messages, { id: 'sys-' + state.messages.length, role: 'system', parts: [{ kind: 'text', text }], noticeKind: kind }] }
}

/** Append a part to the current (last) assistant message, creating one if needed. */
function appendPart(state: AppState, part: Part): AppState {
  const msgs = state.messages.slice()
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant') {
    msgs[msgs.length - 1] = { ...last, parts: [...last.parts, part] }
  } else {
    msgs.push({ id: 'a' + msgs.length, role: 'assistant', parts: [part] })
  }
  return { ...state, messages: msgs }
}

function appendText(state: AppState, text: string): AppState {
  const msgs = state.messages.slice()
  const last = msgs[msgs.length - 1]
  if (last && last.role === 'assistant') {
    const parts = last.parts.slice()
    const lp = parts[parts.length - 1]
    if (lp && lp.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: lp.text + text }
    else parts.push({ kind: 'text', text })
    msgs[msgs.length - 1] = { ...last, parts }
    return { ...state, messages: msgs }
  }
  return appendPart(state, { kind: 'text', text })
}

function mapPart(p: SnapshotPart): Part {
  if (p.kind === 'text') return { kind: 'text', text: p.text }
  if (p.kind === 'tool-use') return { kind: 'tool-use', id: p.id, name: p.name, input: p.input }
  return { kind: 'tool-result', id: p.id, name: p.name, output: p.output, isError: p.isError }
}

function applySnapshot(state: AppState, s: SessionSnapshot): AppState {
  return {
    ...state,
    model: s.model,
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    totalUsage: s.totalUsage,
    todos: s.todos,
    pendingPermissions: s.pendingPermissions,
    thinking: s.isThinking,
    messages: s.messages.map((m, i) => ({ id: 'h' + i, role: m.role, parts: m.parts.map(mapPart) })),
    checkpoints: s.checkpoints,
  }
}

function reduceEvent(state: AppState, e: SessionEvent): AppState {
  switch (e.type) {
    case 'message-start': return { ...state, messages: [...state.messages, { id: e.id, role: 'assistant', parts: [] }] }
    case 'text-delta': return appendText(state, e.text)
    case 'tool-use': return appendPart(state, { kind: 'tool-use', id: e.id, name: e.name, input: e.input })
    case 'tool-result': return appendPart(state, { kind: 'tool-result', id: e.id, name: e.name, output: e.output, isError: e.is_error })
    case 'message-stop': return state
    case 'turn-start': return { ...state, thinking: true }
    case 'turn-end': return { ...state, thinking: false }
    case 'usage-update': return { ...state, totalUsage: e.totalUsage }
    case 'context-update': return { ...state, contextTokens: e.contextTokens, contextWindow: e.contextWindow }
    case 'todos-update': return { ...state, todos: e.todos }
    case 'permission-request': return { ...state, pendingPermissions: [...state.pendingPermissions, { id: e.id, req: e.req }] }
    case 'permission-resolved': return { ...state, pendingPermissions: state.pendingPermissions.filter((p) => p.id !== e.id) }
    case 'failover': return withNotice({ ...state, model: e.toModel }, 'failover: ' + e.fromModel + ' → ' + e.toModel + ' (' + e.reason + ')', 'warn')
    case 'model-select-needed': return withNotice(state, 'model selection needed: ' + e.reason, 'warn')
    case 'compaction-start': return state
    case 'compaction-done': return withNotice(state, 'context compacted', 'info')
    case 'memory-notice': return withNotice(state, e.text, 'info')
    case 'cwd-change': return state
    case 'warning': return withNotice(state, e.message, 'warn')
    case 'error': return withNotice(state, e.message, 'error')
    case 'aborted': return withNotice({ ...state, thinking: false }, 'stopped', 'warn')
    case 'checkpoint-recorded': return { ...state, checkpoints: [...state.checkpoints, { id: e.id, label: e.label }] }
    case 'reverted': return withNotice(state, 'reverted to checkpoint', 'info')
    default: return state
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'user-send':
      return { ...state, messages: [...state.messages, { id: action.id, role: 'user', parts: [{ kind: 'text', text: action.text }] }] }
    case 'connection':
      return { ...state, connection: action.status }
    case 'reset':
      return { ...initialState, connection: state.connection }
    case 'server': {
      const m = action.msg
      if (m.type === 'snapshot') return applySnapshot(state, m.snapshot)
      if (m.type === 'error') return withNotice(state, m.message, 'error')
      if (m.type === 'event') return reduceEvent(state, m.event)
      return state
    }
    default:
      return state
  }
}
