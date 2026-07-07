import type { ServerMessage, SessionEvent, SessionSnapshot, SnapshotPart } from '@zuse/protocol'
import { isTurnOpener, type AppState, type Connection, type Part } from './types.js'

export const initialState: AppState = {
  messages: [], todos: [], pendingPermissions: [], pendingSteers: [],
  thinking: false, connection: 'connecting',
}

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'user-send'; id: string; text: string; steer?: boolean }
  | { kind: 'steer-queued'; id: string; text: string }
  | { kind: 'connection'; status: Connection }
  | { kind: 'reset' }

function withNotice(state: AppState, text: string, kind: 'info' | 'warn' | 'error' | 'summary' | 'compacting'): AppState {
  return { ...state, messages: [...state.messages, { id: 'sys-' + state.messages.length, role: 'system', parts: [{ kind: 'text', text }], noticeKind: kind }] }
}

/** Drop the transient "正在压缩…" start notice once compaction ends (done or aborted); without this
 *  it would linger forever, reading as if compaction were still in progress. Matched by its own
 *  noticeKind ('compacting') — not a localized text prefix that would break if the wording changed. */
function dropCompactionStart(msgs: AppState['messages']): AppState['messages'] {
  return msgs.filter((m) => m.noticeKind !== 'compacting')
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
  // Id by LEDGER index, not array position: the projection can splice extra steer bubbles, so
  // array index != ledger index. History-search jumps to 'h'+ledgerIndex, so real messages must
  // keep that id (steer bubbles, never search targets, get a collision-free 'hs'+i id).
  const mapped = s.messages.map((m, i) => ({
    id: m.steer ? 'hs' + i : 'h' + (m.ledgerIndex ?? i),
    role: m.role, parts: m.parts.map(mapPart), checkpointId: m.checkpointId, steer: m.steer,
  }))
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
    pendingSteers: [], // a fresh snapshot is authoritative — drop any transient queued-steer previews
  }
}

type Hist = { id: string; role: 'user' | 'assistant' | 'system'; parts: Part[]; checkpointId?: string; steer?: boolean }

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
    case 'compaction-start': return withNotice(state, `正在压缩上下文…(保留最近 ${e.keep} 条)`, 'compacting')
    // Compaction finished: drop the transient start notice, then show the summary (dimmed italic).
    case 'compaction-done': return withNotice({ ...state, messages: dropCompactionStart(state.messages) }, e.summaryText, 'summary')
    case 'memory-notice': return withNotice(state, e.text, 'info')
    // A tool's `cd` moved the session cwd — reflect it live so the header/dir picker update without
    // waiting for a reload. (Also covers the abort-time cwd revert, which re-emits this event.)
    case 'cwd-change': return { ...state, cwd: e.cwd }
    case 'warning': return withNotice(state, e.message, 'warn')
    case 'error': return withNotice(state, e.message, 'error')
    // Stop also drops any transient queued-steer previews (per the chosen UX: they clear when shown
    // or on abort). A re-delivered steer re-appears via its own user-echo below.
    case 'aborted': return withNotice({ ...state, messages: dropCompactionStart(state.messages), thinking: false, pendingSteers: [] }, '已停止', 'warn')
    case 'checkpoint-recorded': {
      // Attach the checkpoint id to the most recent turn opener (real user message) that lacks one
      // — one checkpoint per turn, in order → that turn's opener. Prefer a real opener over a
      // mid-turn steer bubble so the 回退 button anchors the turn's start, not an interjection.
      const msgs = state.messages.slice()
      let idx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isTurnOpener(msgs[i]!) && !msgs[i]!.checkpointId) { idx = i; break }
      }
      // Fallback (#5): a folded-steer-then-Stop re-run has NO opener bubble live — its echo was
      // suppressed because it was already shown as a "↪ 插话" bubble. Anchor on the most recent user
      // bubble lacking a checkpoint (that steer bubble) so the re-run's reply still gets a 回退
      // button, matching what a reload (which renders the re-run as a normal opener) shows.
      if (idx === -1) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]!.role === 'user' && !msgs[i]!.checkpointId) { idx = i; break }
        }
      }
      if (idx >= 0) msgs[idx] = { ...msgs[idx]!, checkpointId: e.id }
      return { ...state, messages: msgs }
    }
    case 'reverted': return withNotice(state, '已回退到检查点', 'info')
    // Retry re-submits a question server-side; echo it back as a user message so it shows
    // immediately (the post-revert snapshot had dropped it). checkpoint-recorded re-attaches
    // this turn's checkpoint to it at turn end.
    case 'user-echo': {
      // The steer just got its real, positioned bubble (folded "↪ 插话" or a follow-up opener) — so
      // resolve its transient bottom preview. The server joins several queued steers into one echo
      // with '\n', so a preview matches when its text is a whole '\n'-delimited segment of the echo.
      // (Segment-boundary match, not split-on-'\n', so a multi-line steer's own newlines don't break
      // matching and a short text can't partial-match inside an unrelated line.)
      const wrapped = '\n' + e.text + '\n'
      return {
        ...state,
        messages: [...state.messages, { id: 'ue' + state.messages.length, role: 'user', parts: [{ kind: 'text', text: e.text }], steer: e.steer }],
        pendingSteers: state.pendingSteers.filter((p) => !wrapped.includes('\n' + p.text + '\n')),
      }
    }
    default: return state
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'user-send':
      return { ...state, messages: [...state.messages, { id: action.id, role: 'user', parts: [{ kind: 'text', text: action.text }], steer: action.steer }] }
    case 'steer-queued':
      return { ...state, pendingSteers: [...state.pendingSteers, { id: action.id, text: action.text }] }
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
