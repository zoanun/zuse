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

  it('applySnapshot rebuilds messages and sets checkpoints', () => {
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
    expect(s.messages[0]).toEqual({ id: 'h0', role: 'user', parts: [{ kind: 'text', text: 'hello' }] })
    expect(s.messages[1]).toEqual({ id: 'h1', role: 'assistant', parts: [
      { kind: 'text', text: 'hi' },
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ] })
    expect(s.checkpoints).toEqual([{ id: 'cp1', label: 'after hello' }])
  })

  it('checkpoint-recorded appends to checkpoints', () => {
    const s = reduce(initialState, { kind: 'server', msg: ev({ type: 'checkpoint-recorded', id: 'cp2', messageIndex: 3, label: 'after step 3' }) })
    expect(s.checkpoints).toEqual([{ id: 'cp2', label: 'after step 3' }])
  })

  it('reverted adds an info notice', () => {
    const s = reduce(initialState, { kind: 'server', msg: ev({ type: 'reverted', checkpointId: 'cp1' }) })
    const notices = s.messages.filter((m) => m.role === 'system')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.noticeKind).toBe('info')
    expect(notices[0]!.parts[0]).toEqual({ kind: 'text', text: 'reverted to checkpoint' })
  })
})
