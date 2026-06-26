import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '@zuse/core'
import { Conversation } from '@zuse/core'
import { createSession } from './createSession.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import type { SessionEvent, SessionCheckpoint } from './events.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'zuse-sess-'))
}

describe('createSession', () => {
  it('wires a working session: a plain submit streams events end-to-end', async () => {
    const dir = tmp()
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hi there' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { client } = fakeClient([script])
    const mgr = createSession({ sessionId: 'test', cwd: dir, client, snapshotStore: fakeSnapshotStore() })
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))

    await mgr.submit('hello')

    const types = events.map((e) => e.type)
    expect(types).toContain('turn-start')
    expect(types).toContain('text-delta')
    expect(types).toContain('turn-end')
    expect(mgr.getState().isThinking).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers TodoWrite wired to setTodos (todos-update emitted)', async () => {
    const dir = tmp()
    const scripts: StreamEvent[][] = [
      [
        { type: 'message-start', id: 'm1', model: 'fake-model' },
        { type: 'tool-use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'do x', status: 'pending' }] } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      [
        { type: 'message-start', id: 'm2', model: 'fake-model' },
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    ]
    const { client } = fakeClient(scripts)
    const mgr = createSession({ sessionId: 'test', cwd: dir, client, snapshotStore: fakeSnapshotStore() })
    const todoEvents: Extract<SessionEvent, { type: 'todos-update' }>[] = []
    mgr.subscribe((e) => {
      // TodoWrite is NOT readOnly → classified 'ask'; interactive policy parks it. Auto-allow.
      if (e.type === 'permission-request') mgr.resolvePermission(e.id, 'allow')
      if (e.type === 'todos-update') todoEvents.push(e)
    })

    await mgr.submit('make a plan')

    expect(todoEvents).toHaveLength(1)
    expect(todoEvents[0]!.todos[0]!.content).toBe('do x')
    expect(todoEvents[0]!.todos[0]!.status).toBe('pending')
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers the Agent tool so a sub-agent runs end-to-end (not "Unknown tool")', async () => {
    const dir = tmp()
    const scripts: StreamEvent[][] = [
      // main turn: call the Agent (sub-agent) tool
      [
        { type: 'message-start', id: 'm1', model: 'fake-model' },
        { type: 'tool-use', id: 'a1', name: 'Agent', input: { description: 'greet', prompt: 'say hi' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      // the sub-agent's own runAgent turn (shares the same scripted client): produce text
      [
        { type: 'message-start', id: 's1', model: 'fake-model' },
        { type: 'text-delta', text: 'sub-agent says hi' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      // main turn continues after the tool result
      [
        { type: 'message-start', id: 'm2', model: 'fake-model' },
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    ]
    const { client } = fakeClient(scripts)
    const mgr = createSession({ sessionId: 'test', cwd: dir, client, snapshotStore: fakeSnapshotStore() })
    const toolResults: Extract<SessionEvent, { type: 'tool-result' }>[] = []
    mgr.subscribe((e) => {
      if (e.type === 'permission-request') mgr.resolvePermission(e.id, 'allow')
      if (e.type === 'tool-result') toolResults.push(e)
    })

    await mgr.submit('use a sub-agent')

    const agentResult = toolResults.find((r) => r.id === 'a1')
    expect(agentResult).toBeDefined()
    expect(agentResult!.output).not.toContain('Unknown tool')
    expect(agentResult!.output).toContain('sub-agent says hi')
    rmSync(dir, { recursive: true, force: true })
  })

  it('restores conversation + checkpoints from opts (restore path)', () => {
    const dir = tmp()
    const conversation = new Conversation()
    conversation.appendUserText('earlier question')
    conversation.appendAssistantText('earlier answer')
    const checkpoints: SessionCheckpoint[] = [
      { messageIndex: 0, hash: 'abc123', at: '2026-01-01T00:00:00.000Z', label: 'earlier question' },
    ]
    const { client } = fakeClient([])
    const mgr = createSession({
      sessionId: 'restored',
      cwd: dir,
      conversation,
      checkpoints,
      client,
      snapshotStore: fakeSnapshotStore(),
    })

    expect(mgr.getConversation().length).toBe(2)
    expect(mgr.getConversation().getMessages()[0]!.role).toBe('user')
    expect(mgr.getCheckpoints()).toHaveLength(1)
    expect(mgr.getCheckpoints()[0]!.hash).toBe('abc123')
    rmSync(dir, { recursive: true, force: true })
  })
})
