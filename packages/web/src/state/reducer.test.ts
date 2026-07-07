import { describe, it, expect } from 'vitest'
import type { ServerMessage } from '@zuse/protocol'
import { reduce, initialState } from './reducer.js'
import type { AppState } from './types.js'

const ev = (event: unknown): ServerMessage => ({ type: 'event', event } as ServerMessage)
function run(actions: Array<Parameters<typeof reduce>[1]>, start: AppState = initialState): AppState {
  return actions.reduce((s, a) => reduce(s, a), start)
}

describe('reduce', () => {
  it('user-send pushes a user message', () => {
    const s = reduce(initialState, { kind: 'user-send', id: 'u1', text: 'hi' })
    expect(s.messages).toEqual([{ id: 'u1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }])
  })

  it('user-echo appends the re-submitted question as a user message (retry)', () => {
    const s = reduce(initialState, { kind: 'server', msg: ev({ type: 'user-echo', text: 'do it again' }) })
    expect(s.messages).toEqual([{ id: 'ue0', role: 'user', parts: [{ kind: 'text', text: 'do it again' }] }])
  })

  it('accumulates text-delta into one assistant message', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'turn-start', isResend: false }) },
      { kind: 'server', msg: ev({ type: 'message-start', id: 'm1', model: 'x' }) },
      { kind: 'server', msg: ev({ type: 'text-delta', text: 'Hel' }) },
      { kind: 'server', msg: ev({ type: 'text-delta', text: 'lo' }) },
      { kind: 'server', msg: ev({ type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) },
      { kind: 'server', msg: ev({ type: 'turn-end' }) },
    ])
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toEqual({ id: 'm1', role: 'assistant', parts: [{ kind: 'text', text: 'Hello' }] })
    expect(s.thinking).toBe(false)
  })

  it('adds tool-use and tool-result parts to the assistant message', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'message-start', id: 'm1', model: 'x' }) },
      { kind: 'server', msg: ev({ type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } }) },
      { kind: 'server', msg: ev({ type: 'tool-result', id: 't1', name: 'Bash', output: 'files', is_error: false }) },
    ])
    expect(s.messages[0]!.parts).toEqual([
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 't1', name: 'Bash', output: 'files', isError: false },
    ])
  })

  it('tracks ctx/window/usage and todos and permissions', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'context-update', contextTokens: 4700, contextWindow: 200000 }) },
      { kind: 'server', msg: ev({ type: 'usage-update', totalUsage: { input_tokens: 100, output_tokens: 91 } }) },
      { kind: 'server', msg: ev({ type: 'todos-update', todos: [{ content: 'a', status: 'in_progress' }] }) },
      { kind: 'server', msg: ev({ type: 'permission-request', id: 'p1', req: { toolName: 'Bash', specifier: 'rm' } as never }) },
    ])
    expect(s.contextTokens).toBe(4700)
    expect(s.contextWindow).toBe(200000)
    expect(s.totalUsage).toEqual({ input_tokens: 100, output_tokens: 91 })
    expect(s.todos).toHaveLength(1)
    expect(s.pendingPermissions).toHaveLength(1)
    const s2 = reduce(s, { kind: 'server', msg: ev({ type: 'permission-resolved', id: 'p1', verdict: 'allow' }) })
    expect(s2.pendingPermissions).toHaveLength(0)
  })

  it('snapshot initialises stats and replaces messages from snapshot', () => {
    const withMsg = reduce(initialState, { kind: 'user-send', id: 'u1', text: 'hi' })
    const s = reduce(withMsg, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 0,
      messages: [], checkpoints: [],
    } } })
    expect(s.model).toBe('claude')
    expect(s.contextWindow).toBe(1000)
    expect(s.messages).toHaveLength(0)
  })

  it('routes failover/warning/error to inline system messages', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'warning', message: 'careful' }) },
      { kind: 'server', msg: { type: 'error', message: 'boom' } },
    ])
    expect(s.messages.filter((m) => m.role === 'system').map((m) => m.noticeKind)).toEqual(['warn', 'error'])
  })

  it('connection action updates connection', () => {
    expect(reduce(initialState, { kind: 'connection', status: 'live' }).connection).toBe('live')
  })

  it('applySnapshot rebuilds messages (checkpoints list ignored on client)', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 2,
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
        { role: 'assistant', parts: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ] },
      ],
      checkpoints: [{ id: 'cp1', label: 'after hello' }],
    } } })
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toEqual({ id: 'h0', role: 'user', parts: [{ kind: 'text', text: 'hello' }], checkpointId: undefined })
    expect(s.messages[1]).toEqual({ id: 'h1', role: 'assistant', parts: [
      { kind: 'text', text: 'hi' },
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ], checkpointId: undefined })
  })

  it('applySnapshot carries checkpointId onto user messages', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 1,
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'hello' }], checkpointId: 'cpA' },
      ],
      checkpoints: [{ id: 'cpA', label: 'after hello' }],
    } } })
    expect(s.messages[0]!.checkpointId).toBe('cpA')
  })

  it('applySnapshot folds tool-result-only user turns into the preceding assistant message', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 3,
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'do it' }] },
        { role: 'assistant', parts: [{ kind: 'tool-use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] },
        // API ledger carries the tool result as a role:'user' message — must NOT be a bubble
        { role: 'user', parts: [{ kind: 'tool-result', id: 't1', name: '', output: 'contents', isError: false }] },
      ],
      checkpoints: [],
    } } })
    // 2 messages: the real user turn + the assistant turn (now holding the tool-result)
    expect(s.messages).toHaveLength(2)
    expect(s.messages.some((m) => m.role === 'user' && m.parts.length === 0)).toBe(false)
    expect(s.messages[1]!.role).toBe('assistant')
    expect(s.messages[1]!.parts).toEqual([
      { kind: 'tool-use', id: 't1', name: 'Read', input: { file_path: 'a.md' } },
      { kind: 'tool-result', id: 't1', name: '', output: 'contents', isError: false },
    ])
  })

  it('applySnapshot drops an empty user turn (only unmappable blocks) — no blank bubble', () => {
    const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      sessionId: 'default', isThinking: false, model: 'claude', cwd: '/x',
      totalUsage: undefined, contextTokens: 10, contextWindow: 1000, todos: [], pendingPermissions: [], messageCount: 1,
      messages: [{ role: 'user', parts: [] }],
      checkpoints: [],
    } } })
    expect(s.messages).toHaveLength(0)
  })

  it('checkpoint-recorded attaches e.id to the last user message lacking a checkpointId', () => {
    const s = run([
      { kind: 'user-send', id: 'u1', text: 'first' },
      { kind: 'server', msg: ev({ type: 'checkpoint-recorded', id: 'cp1', messageIndex: 0, label: 'turn 1' }) },
      { kind: 'user-send', id: 'u2', text: 'second' },
      { kind: 'server', msg: ev({ type: 'checkpoint-recorded', id: 'cp2', messageIndex: 2, label: 'turn 2' }) },
    ])
    const users = s.messages.filter((m) => m.role === 'user')
    expect(users[0]!.checkpointId).toBe('cp1')
    expect(users[1]!.checkpointId).toBe('cp2')
  })

  it('checkpoint-recorded skips a mid-turn steer bubble and anchors the real turn opener', () => {
    const s = run([
      { kind: 'user-send', id: 'u1', text: 'the question' },
      // Interjection sent while the reply streamed — role:'user' too, but must NOT catch the checkpoint.
      { kind: 'user-send', id: 's1', text: 'also do X', steer: true },
      { kind: 'server', msg: ev({ type: 'checkpoint-recorded', id: 'cp1', messageIndex: 0, label: 'turn 1' }) },
    ])
    const byId = (id: string) => s.messages.find((m) => m.id === id)!
    expect(byId('u1').checkpointId).toBe('cp1')       // the real opener gets the revert anchor
    expect(byId('s1').checkpointId).toBeUndefined()   // the steer bubble does not
  })

  it('reverted adds an info notice', () => {
    const s = reduce(initialState, { kind: 'server', msg: ev({ type: 'reverted', checkpointId: 'cp1' }) })
    const notices = s.messages.filter((m) => m.role === 'system')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.noticeKind).toBe('info')
    expect(notices[0]!.parts[0]).toEqual({ kind: 'text', text: '已回退到检查点' })
  })

  it('compaction-done removes the transient "正在压缩" start notice and shows the summary', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'compaction-start', keep: 4 }) },
      { kind: 'server', msg: ev({ type: 'compaction-done', summaryText: 'the summary' }) },
    ])
    const notices = s.messages.filter((m) => m.role === 'system')
    // The start notice is gone; only the summary remains.
    expect(notices.some((m) => m.parts.some((p) => p.kind === 'text' && p.text.startsWith('正在压缩上下文')))).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.noticeKind).toBe('summary')
    expect(notices[0]!.parts[0]).toEqual({ kind: 'text', text: 'the summary' })
  })

  it('aborted also clears a lingering "正在压缩" start notice', () => {
    const s = run([
      { kind: 'server', msg: ev({ type: 'compaction-start', keep: 4 }) },
      { kind: 'server', msg: ev({ type: 'aborted' }) },
    ])
    const notices = s.messages.filter((m) => m.role === 'system')
    expect(notices.some((m) => m.parts.some((p) => p.kind === 'text' && p.text.startsWith('正在压缩上下文')))).toBe(false)
    expect(notices.map((m) => m.parts[0])).toContainEqual({ kind: 'text', text: '已停止' })
  })
})

describe('pending steer previews (transient, client-only)', () => {
  it('steer-queued adds a preview; a matching user-echo resolves it into a real message', () => {
    const queued = reduce(initialState, { kind: 'steer-queued', id: 'ps1', text: 'change direction' })
    expect(queued.pendingSteers).toEqual([{ id: 'ps1', text: 'change direction' }])
    expect(queued.messages).toEqual([]) // NOT a real message yet

    // Server echoes it at its real delivery point → the preview clears and a real bubble appears.
    const shown = reduce(queued, { kind: 'server', msg: ev({ type: 'user-echo', text: 'change direction', steer: true }) })
    expect(shown.pendingSteers).toEqual([])
    expect(shown.messages).toEqual([{ id: 'ue0', role: 'user', parts: [{ kind: 'text', text: 'change direction' }], steer: true }])
  })

  it('a combined echo (join of several queued steers) clears every matching preview', () => {
    const s = run([
      { kind: 'steer-queued', id: 'ps1', text: 'A' },
      { kind: 'steer-queued', id: 'ps2', text: 'B' },
      { kind: 'server', msg: ev({ type: 'user-echo', text: 'A\nB', steer: true }) },
    ])
    expect(s.pendingSteers).toEqual([])
  })

  it('a non-matching user-echo leaves an unrelated preview pinned', () => {
    const s = run([
      { kind: 'steer-queued', id: 'ps1', text: 'still queued' },
      { kind: 'server', msg: ev({ type: 'user-echo', text: 'a different steer' }) },
    ])
    expect(s.pendingSteers).toEqual([{ id: 'ps1', text: 'still queued' }])
  })

  it('aborted clears all pending previews', () => {
    const s = run([
      { kind: 'steer-queued', id: 'ps1', text: 'X' },
      { kind: 'server', msg: ev({ type: 'aborted' }) },
    ])
    expect(s.pendingSteers).toEqual([])
  })

  it('a fresh snapshot drops any transient previews', () => {
    const withPreview = reduce(initialState, { kind: 'steer-queued', id: 'ps1', text: 'X' })
    const snap = reduce(withPreview, { kind: 'server', msg: { type: 'snapshot', snapshot: {
      messages: [], todos: [], pendingPermissions: [], isThinking: false,
      model: 'm', cwd: '/w', contextTokens: 0, contextWindow: 1000, totalUsage: { input_tokens: 0, output_tokens: 0 },
    } } as unknown as ServerMessage })
    expect(snap.pendingSteers).toEqual([])
  })
})
