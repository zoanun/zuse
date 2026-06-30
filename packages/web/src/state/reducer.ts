import type { ServerMessage, SessionEvent, SessionSnapshot, SnapshotPart } from '@zuse/protocol'
import type { AppState, Connection, Part } from './types.js'

export const initialState: AppState = {
  messages: [], todos: [], pendingPermissions: [],
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
  const mapped = s.messages.map((m, i) => ({ id: 'h' + i, role: m.role, parts: m.parts.map(mapPart), checkpointId: m.checkpointId }))
  return {
    ...state,
    model: s.model,
    cwd: s.cwd,
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    totalUsage: s.totalUsage,
    todos: s.todos,
    pendingPermissions: s.pendingPermissions,
    thinking: s.isThinking,
    messages: foldToolResults(mapped),
  }
}

type Hist = { id: string; role: 'user' | 'assistant' | 'system'; parts: Part[]; checkpointId?: string }

/**
 * In the API ledger a tool's result is a `role: 'user'` message holding only a tool_result
 * block, so the raw snapshot renders it as an empty user bubble (and orphans the tool-use,
 * which can't pair with a result in a different message). Fold those tool-result parts back
 * into the preceding assistant message — matching the live shape, where tool-use and
 * tool-result land in the same assistant message and render as a paired card. Any real text
 * in the user message is kept as its own bubble.
 */
function foldToolResults(msgs: Hist[]): Hist[] {
  const out: Hist[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      const toolResults = m.parts.filter((p) => p.kind === 'tool-result')
      const rest = m.parts.filter((p) => p.kind !== 'tool-result')
      const prev = out[out.length - 1]
      if (toolResults.length && prev && prev.role === 'assistant') prev.parts = [...prev.parts, ...toolResults]
      else if (toolResults.length) out.push({ ...m, role: 'assistant', parts: toolResults, checkpointId: undefined })
      // Keep the user bubble only if it has real (non-tool-result) content; an empty turn
      // (tool-result carrier, or a message of only unknown blocks) would render as a blank pill.
      if (rest.length) out.push({ ...m, parts: rest })
    } else {
      out.push(m)
    }
  }
  return out
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
    case 'failover': return withNotice({ ...state, model: e.toModel }, '故障切换：' + e.fromModel + ' → ' + e.toModel + ' (' + e.reason + ')', 'warn')
    case 'model-select-needed': return withNotice(state, '需要选择模型：' + e.reason, 'warn')
    case 'compaction-start': return state
    case 'compaction-done': return withNotice(state, '上下文已压缩', 'info')
    case 'memory-notice': return withNotice(state, e.text, 'info')
    case 'cwd-change': return state
    case 'warning': return withNotice(state, e.message, 'warn')
    case 'error': return withNotice(state, e.message, 'error')
    case 'aborted': return withNotice({ ...state, thinking: false }, '已停止', 'warn')
    case 'checkpoint-recorded': {
      // Attach the checkpoint id to the most recent user message that lacks one
      // (one checkpoint per turn, in order → that turn's user message).
      const msgs = state.messages.slice()
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!
        if (m.role === 'user' && !m.checkpointId) { msgs[i] = { ...m, checkpointId: e.id }; break }
      }
      return { ...state, messages: msgs }
    }
    case 'reverted': return withNotice(state, '已回退到检查点', 'info')
    // Retry re-submits a question server-side; echo it back as a user message so it shows
    // immediately (the post-revert snapshot had dropped it). checkpoint-recorded re-attaches
    // this turn's checkpoint to it at turn end.
    case 'user-echo': return { ...state, messages: [...state.messages, { id: 'ue' + state.messages.length, role: 'user', parts: [{ kind: 'text', text: e.text }] }] }
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
