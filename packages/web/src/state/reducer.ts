import type { ServerMessage, SessionEvent, SessionSnapshot, SnapshotMessage, SnapshotPart, MessageAttachment } from '@zuse/protocol'
import type { AppState, Connection, Part } from './types.js'

export const initialState: AppState = {
  messages: [], todos: [], backgroundAgents: [], pendingPermissions: [], pendingSteers: [],
  thinking: false, connection: 'connecting',
}

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'user-send'; id: string; text: string; steer?: boolean; attachments?: MessageAttachment[] }
  | { kind: 'steer-queued'; id: string; text: string; attachments?: MessageAttachment[] }
  | { kind: 'connection'; status: Connection }
  | { kind: 'notice'; text: string; noticeKind?: 'info' | 'warn' | 'error' | 'help' }
  | { kind: 'model-changed'; model: string; providerId?: string }
  | { kind: 'reset' }

function withNotice(state: AppState, text: string, kind: 'info' | 'warn' | 'error' | 'summary' | 'compacting' | 'help'): AppState {
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

/**
 * Project a server `SnapshotMessage[]` into renderable UI messages: map each part, then fold
 * tool-result carrier `user` messages into the preceding assistant (see foldToolResults). This is
 * the single source of the projection rule — `applySnapshot` (the live chat stream) and the cron
 * run-detail view (`CronPanel`) both call it, so their rendering can never drift.
 * Server hands a stable ledger id per message, so ids come straight through (no array-position derivation).
 */
export function projectSnapshotMessages(msgs: SnapshotMessage[]): AppState['messages'] {
  return foldToolResults(msgs.map((m) => ({
    id: m.id,
    role: m.role, parts: m.parts.map(mapPart), checkpointId: m.checkpointId, steer: m.steer,
    attachments: m.attachments, interrupt: m.interrupt,
  })))
}

function applySnapshot(state: AppState, s: SessionSnapshot): AppState {
  return {
    ...state,
    model: s.model,
    modelProviderId: s.modelProviderId,
    cwd: s.cwd,
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    totalUsage: s.totalUsage,
    todos: s.todos,
    backgroundAgents: s.backgroundAgents ?? [],
    pendingPermissions: s.pendingPermissions,
    thinking: s.isThinking,
    messages: projectSnapshotMessages(s.messages),
    pendingSteers: [], // a fresh snapshot is authoritative — drop any transient queued-steer previews
  }
}

type Hist = {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: Part[]
  checkpointId?: string
  steer?: boolean
  attachments?: MessageAttachment[]
  // only set for role:'system' — mirrors Message.noticeKind so a folded-in interrupt marker
  // (see foldToolResults) renders as the same low-key notice as 'aborted'/'reverted'.
  noticeKind?: 'info' | 'warn' | 'error' | 'summary' | 'compacting' | 'help'
  // Mirrors SnapshotMessage.interrupt — consumed (and stripped) by foldToolResults, which emits the
  // system notice; never present on a message once it leaves that function.
  interrupt?: boolean
}

/**
 * In the API ledger a tool's result is a `role: 'user'` message holding only a tool_result
 * block, so the raw snapshot renders it as an empty user bubble (and orphans the tool-use,
 * which can't pair with a result in a different message). Fold those tool-result parts back
 * into the preceding assistant message — matching the live shape, where tool-use and
 * tool-result land in the same assistant message and render as a paired card. Any real text
 * in the user message is kept as its own bubble.
 *
 * A message flagged `interrupt` (server-side cancel marker; its marker text part is already
 * omitted from `parts` by the projection) is ledger housekeeping, not user content — render it as
 * a low-key system notice instead of a user bubble. It may still carry a tool-result (when the
 * cancel landed mid-tool-call), which folds into the preceding assistant same as any other.
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
      if (m.interrupt) out.push({ id: m.id, role: 'system', parts: [{ kind: 'text', text: '已被用户中断' }], noticeKind: 'info' })
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
    case 'background-agents': return { ...state, backgroundAgents: e.labels }
    case 'permission-request': return { ...state, pendingPermissions: [...state.pendingPermissions, { id: e.id, req: e.req }] }
    case 'permission-resolved': return { ...state, pendingPermissions: state.pendingPermissions.filter((p) => p.id !== e.id) }
    case 'failover': return withNotice({ ...state, model: e.toModel }, '故障切换：' + e.fromModel + ' → ' + e.toModel + ' (' + e.reason + ')', 'warn')
    // Authoritative model truth from the server after a switch-model (SessionEvent, NOT the local
    // optimistic `kind:'model-changed'` action above): corrects the optimistic Header value — e.g.
    // when the server's client rebuild failed and it kept the old model.
    case 'model-changed': return { ...state, model: e.model, modelProviderId: e.providerId }
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
    // "已被用户中断": same wording (and low-key 'info' style) as the ledger interrupt marker rendered
    // on snapshot re-projection, so the live indicator and the post-refresh one read identically.
    case 'aborted': return withNotice({ ...state, messages: dropCompactionStart(state.messages), thinking: false, pendingSteers: [] }, '已被用户中断', 'info')
    case 'checkpoint-recorded': {
      // The server names the exact message this checkpoint anchors on (the turn's own ledger id,
      // stable across steer bubbles / retries) — attach by id instead of scanning back through
      // local state guessing which bubble is the turn's opener.
      const msgs = state.messages.slice()
      const idx = msgs.findIndex((m) => m.id === e.anchorMessageId)
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
        messages: [...state.messages, { id: e.messageId, role: 'user', parts: [{ kind: 'text', text: e.text }], steer: e.steer, attachments: e.attachments }],
        pendingSteers: state.pendingSteers.filter((p) => !wrapped.includes('\n' + p.text + '\n')),
      }
    }
    default: return state
  }
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'user-send':
      return { ...state, messages: [...state.messages, { id: action.id, role: 'user', parts: [{ kind: 'text', text: action.text }], steer: action.steer, attachments: action.attachments }] }
    case 'steer-queued':
      return { ...state, pendingSteers: [...state.pendingSteers, { id: action.id, text: action.text, attachments: action.attachments }] }
    case 'connection':
      return { ...state, connection: action.status }
    case 'notice':
      return withNotice(state, action.text, action.noticeKind ?? 'info')
    // Optimistic Header update after a temporary model switch — the server acks 'switch-model'
    // over WS with no event, so the reducer reflects the choice locally.
    case 'model-changed':
      return { ...state, model: action.model, modelProviderId: action.providerId ?? state.modelProviderId }
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
