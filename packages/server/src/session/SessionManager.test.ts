import { describe, it, expect } from 'vitest'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { Conversation, ToolRegistry, steerFoldSuffix } from '@zuse/core'
import type { Message, ModelClient, ResolvedSettings, Tool, ToolContext, ToolResult, StreamEvent } from '@zuse/core'
import type { SessionCheckpoint, SessionEvent } from './events.js'

/**
 * A ModelClient whose turn is held open until release() is called. Lets tests
 * observe isThinking === true mid-flight. If the AbortSignal is set once the gate
 * releases, it yields an `error` event so SessionManager.submit drives its aborted
 * path (submit emits 'aborted' when an error event arrives && signal.aborted).
 */
function gatedClient(model = 'fake-model'): { client: ModelClient; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const client: ModelClient = {
    getModel: () => model,
    async *sendMessages(_messages, _config, _tools, signal) {
      await gate
      if (signal?.aborted) {
        yield { type: 'error', message: 'aborted', category: 'other' }
        return
      }
      yield { type: 'message-start', id: 'm1', model }
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  }
  return { client, release }
}

function makeManagerFromClient(client: ModelClient) {
  return new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry: new ToolRegistry(),
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
    snapshotStore: fakeSnapshotStore(),
  })
}

function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

/** Minimal fake Bash tool satisfying the Tool interface for decide() evaluation. */
function makeBashTool(): Tool {
  return {
    name: 'Bash',
    description: 'Run a bash command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    run: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({ output: '' }),
    readOnly: false,
    specifierFor: (input: unknown) => (input as { command?: string }).command ?? null,
  }
}

function makeManager(scripts = [] as Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(scripts)
  const mgr = new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry: new ToolRegistry(),
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
    snapshotStore: fakeSnapshotStore(),
  })
  return { mgr, calls }
}

describe('SessionManager skeleton', () => {
  it('getState returns initial snapshot', () => {
    const { mgr } = makeManager()
    const s = mgr.getState()
    expect(s.sessionId).toBe('s1')
    expect(s.isThinking).toBe(false)
    expect(s.model).toBe('fake-model')
    expect(s.cwd).toBe('/work')
    expect(s.messageCount).toBe(0)
    expect(s.pendingPermissions).toEqual([])
  })

  it('subscribe receives emitted events; unsubscribe stops them', () => {
    const { mgr } = makeManager()
    const seen: string[] = []
    const off = mgr.subscribe((e) => seen.push(e.type))
    // @ts-expect-error reach a test-only emit hook
    mgr._emitForTest({ type: 'warning', message: 'x' })
    off()
    // @ts-expect-error
    mgr._emitForTest({ type: 'warning', message: 'y' })
    expect(seen).toEqual(['warning'])
  })
})

describe('SessionManager snapshot projection', () => {
  it('projects the conversation into SnapshotMessages and exposes checkpoints', () => {
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
    conversation.append({
      role: 'assistant',
      content: [
        { type: 'text', text: 'running it' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      ],
    })
    conversation.append({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt', is_error: false }],
    })

    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
    })

    const s = mgr.getState()
    expect(s.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'hello' }], ledgerIndex: 0 },
      {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'running it' },
          { kind: 'tool-use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ],
        ledgerIndex: 1,
      },
      { role: 'user', parts: [{ kind: 'tool-result', id: 'tu1', name: '', output: 'file.txt', isError: false }], ledgerIndex: 2 },
    ])
    // No turn has run, so no checkpoints recorded yet.
    expect(s.checkpoints).toEqual([])
    expect(s.messageCount).toBe(3)
  })

  it('strips the injected timestamp prefix from user text but not assistant text', () => {
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: '[2026-06-26 12:34] hello' }] })
    conversation.append({ role: 'assistant', content: [{ type: 'text', text: '[2026-06-26 12:34] not a real prefix' }] })

    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
    })

    const s = mgr.getState()
    // User text: leading timestamp prefix stripped (one occurrence only).
    expect(s.messages[0]!.parts).toEqual([{ kind: 'text', text: 'hello' }])
    // Assistant text: left untouched even though it looks like a prefix.
    expect(s.messages[1]!.parts).toEqual([{ kind: 'text', text: '[2026-06-26 12:34] not a real prefix' }])
  })

  it('attaches checkpointId to the message at the matching ledger index, undefined otherwise', () => {
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: 'first turn' }] })
    conversation.append({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] })

    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
      checkpoints: [{ messageIndex: 0, hash: 'cp-h', at: '2026-06-26T12:34:00.000Z', label: 'first turn' }],
    })

    const s = mgr.getState()
    expect(s.messages[0]!.checkpointId).toBe('cp-h')
    expect(s.messages[1]!.checkpointId).toBeUndefined()
  })

  const buildMgr = (conversation: Conversation): SessionManager =>
    new SessionManager({
      sessionId: 's1', cwd: '/work', client: fakeClient([]).client, registry: new ToolRegistry(),
      settings: makeSettings(), systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(), conversation,
    })

  it('a message with a structural steer field → strips the fold from the card + emits a 插话 bubble', () => {
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: 'do it' }] })
    conversation.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })
    // Carrier tool_result message: steer folded into content AND recorded in the structural field.
    conversation.append({
      role: 'user',
      steer: ['also do X'],
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'raw output' + steerFoldSuffix('also do X'), is_error: false }],
    })

    const s = buildMgr(conversation).getState()
    const trPart = s.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool-result')!
    expect(trPart).toMatchObject({ kind: 'tool-result', output: 'raw output' }) // injection stripped by exact text
    expect(JSON.stringify(trPart)).not.toContain('USER MESSAGE')
    const bubble = s.messages.find((m) => m.steer)!
    expect(bubble).toMatchObject({ role: 'user', steer: true, parts: [{ kind: 'text', text: 'also do X' }] })
  })

  it('a tool_result that merely CONTAINS the marker text but has no steer field is left untouched (no phantom bubble)', () => {
    // The #1 regression: reading a file (e.g. steer.ts) whose contents include the literal marker
    // must NOT be mis-parsed. Identification is structural (the steer field), never by content.
    const leaked = 'file contents: ' + steerFoldSuffix('not a real steer') + ' more'
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: 'read steer.ts' }] })
    conversation.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] })
    conversation.append({ // NOTE: no `steer` field — this is real content, not a steer.
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: leaked, is_error: false }],
    })

    const s = buildMgr(conversation).getState()
    expect(s.messages.some((m) => m.steer)).toBe(false)          // no phantom 插话 bubble
    const trPart = s.messages.flatMap((m) => m.parts).find((p) => p.kind === 'tool-result') as { output: string }
    expect(trPart.output).toBe(leaked)                            // content NOT truncated/altered
  })

  it('sets ledgerIndex on projected messages so search-jump survives spliced steer bubbles', () => {
    const conversation = new Conversation()
    conversation.append({ role: 'user', content: [{ type: 'text', text: 'q' }] })
    conversation.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] })
    conversation.append({ role: 'user', steer: ['mid'], content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' + steerFoldSuffix('mid'), is_error: false }] })
    conversation.append({ role: 'assistant', content: [{ type: 'text', text: 'after' }] }) // ledger index 3

    const s = buildMgr(conversation).getState()
    // The steer bubble is spliced in, so the array is longer than the ledger — but the assistant
    // AFTER it still reports ledgerIndex 3 (not shifted), keeping 'h3' aligned for search-jump.
    const afterMsg = s.messages.find((m) => m.parts.some((p) => p.kind === 'text' && p.text === 'after'))!
    expect(afterMsg.ledgerIndex).toBe(3)
    expect(s.messages.find((m) => m.steer)!.ledgerIndex).toBeUndefined() // spliced bubble carries none
  })
})

describe('SessionManager permissions', () => {
  it('interactive: ask emits permission-request and resolves on resolvePermission', async () => {
    const { mgr } = makeManager()
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error reach private canUseTool for unit test
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })
    const pendingId = mgr.getState().pendingPermissions[0]?.id
    expect(pendingId).toBeDefined()
    expect(events).toContain('permission-request')
    mgr.resolvePermission(pendingId!, 'allow')
    await expect(p).resolves.toBe('allow')
    expect(mgr.getState().pendingPermissions).toEqual([])
  })

  it('interactive: two concurrent asks resolve independently', async () => {
    const { mgr } = makeManager()
    // @ts-expect-error
    const p1 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'a' }, specifier: 'a', rule: 'Bash(a)', reason: 'ask' })
    // @ts-expect-error
    const p2 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'b' }, specifier: 'b', rule: 'Bash(b)', reason: 'ask' })
    const ids = mgr.getState().pendingPermissions.map((x) => x.id)
    expect(ids.length).toBe(2)
    mgr.resolvePermission(ids[1]!, 'deny')
    mgr.resolvePermission(ids[0]!, 'allow')
    await expect(p1).resolves.toBe('allow')
    await expect(p2).resolves.toBe('deny')
  })

  it('non-interactive: allow-listed specifier resolves allow; others deny; no permission-request emitted', async () => {
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(ls)'], ask: [], deny: [] },
      },
      snapshotStore: fakeSnapshotStore(),
    })
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })).resolves.toBe('allow')
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm' }, specifier: 'rm', rule: 'Bash(rm)', reason: 'ask' })).resolves.toBe('deny')
    expect(events).not.toContain('permission-request')
  })

  it('non-interactive: compound Bash command is NOT bypassed by a prefix allow rule', async () => {
    // Regression test: "git status && rm -rf /tmp/x" must not be allowed just
    // because allow contains "Bash(git status*)". The compound command contains
    // a dangerous subcommand; decide() splits on && and must deny the whole thing.
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(git status*)'], ask: [], deny: [] },
      },
      snapshotStore: fakeSnapshotStore(),
    })
    const compound = 'git status && rm -rf /tmp/x'
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: compound }, specifier: compound, rule: `Bash(${compound})`, reason: 'ask' })).resolves.toBe('deny')
  })

  it('non-interactive: deny list is honored even when allow covers the tool', async () => {
    // Bash(*) in allow would naively allow everything, but deny: ['Bash(rm*)'] must
    // win due to deny-priority in decide().
    const { client } = fakeClient([])
    const registry = new ToolRegistry()
    registry.register(makeBashTool())
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: {
        interactive: false,
        config: { defaultMode: 'default', allow: ['Bash(*)'], ask: [], deny: ['Bash(rm*)'] },
      },
      snapshotStore: fakeSnapshotStore(),
    })
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm -rf /' }, specifier: 'rm -rf /', rule: 'Bash(rm -rf /)', reason: 'ask' })).resolves.toBe('deny')
  })

  it('resolvePermission ignores invalid verdict strings', async () => {
    const { mgr } = makeManager()
    // @ts-expect-error
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })
    const id = mgr.getState().pendingPermissions[0]!.id
    // @ts-expect-error intentionally invalid verdict
    mgr.resolvePermission(id, 'not-a-verdict')
    // The promise must still be pending (not resolved)
    const raced = await Promise.race([p.then(() => 'resolved'), Promise.resolve('pending')])
    expect(raced).toBe('pending')
    // The pending entry must still exist
    expect(mgr.getState().pendingPermissions.map((x) => x.id)).toContain(id)
    // Clean up
    mgr.resolvePermission(id, 'deny')
    await expect(p).resolves.toBe('deny')
  })
})

/** Build a manager with an optional custom registry, sharing the standard fakes. */
function makeManagerWith(
  scripts: StreamEvent[][],
  registry = new ToolRegistry(),
) {
  const { client, calls } = fakeClient(scripts)
  const mgr = new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry,
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
    snapshotStore: fakeSnapshotStore(),
  })
  return { mgr, calls }
}

describe('SessionManager turn loop', () => {
  it('plain text turn emits turn-start, message-start, text-delta, message-stop, turn-end', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hello' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
    const { mgr } = makeManagerWith([script])
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))
    await mgr.submit('hi')
    expect(types).toEqual([
      'turn-start', 'message-start', 'text-delta', 'message-stop',
      'usage-update', 'context-update', 'checkpoint-recorded', 'turn-end',
    ])
    expect(mgr.getState().isThinking).toBe(false)
  })

  it('idle-drain: a steer queued during a pure-text turn is delivered as its own follow-up turn', async () => {
    const textTurn = (t: string): StreamEvent[] => [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: t },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    // Two pure-text turns: the original reply, then the auto-drained steer's turn.
    const { mgr, calls } = makeManagerWith([textTurn('reply'), textTurn('addressed')])
    const echoes: Array<{ text: string; steer?: boolean }> = []
    mgr.subscribe((e) => { if (e.type === 'user-echo') echoes.push({ text: e.text, steer: e.steer }) })
    mgr.steer('also do X') // queued; a pure-text turn has no tool batch to consume it
    await mgr.submit('Q')
    // The idle-drain re-submitted the steer as a SECOND turn (a follow-up), not left in the queue.
    expect(calls).toHaveLength(2)
    const texts = mgr.getConversation().getMessages()
      .flatMap((m) => m.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
    expect(texts.some((t) => t.includes('also do X'))).toBe(true) // the steer became a real user turn
    // It's echoed as a NORMAL user bubble (no steer marker) opening the follow-up turn, so the
    // two replies aren't glued together and there's no mid-stream interjection.
    expect(echoes).toEqual([{ text: 'also do X', steer: undefined }])
  })

  it('tool-result is emitted with full raw output (no truncation)', async () => {
    const big = 'x'.repeat(5000)
    // Turn 0: model asks for a tool (stop_reason 'tool_use' makes core run it).
    // Turn 1: empty script -> clean stop. The tool-result is produced by core
    // running the registered tool, not from the scripted events.
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    // readOnly tool so decide() auto-allows under defaultMode 'default' (no permission prompt).
    const registry = new ToolRegistry()
    registry.register({
      name: 'Bash',
      description: 'Run a bash command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      readOnly: true,
      run: async (): Promise<ToolResult> => ({ output: big }),
    })
    const { mgr } = makeManagerWith([script, []], registry)
    let toolOut = ''
    mgr.subscribe((e) => { if (e.type === 'tool-result') toolOut = e.output })
    await mgr.submit('go')
    expect(toolOut.length).toBe(5000)
  })

  it('a steer folded during a tool batch is echoed as a "↪ 插话" bubble (user-echo steer:true)', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const registry = new ToolRegistry()
    registry.register({
      name: 'Bash', description: 'run', inputSchema: { type: 'object', properties: {} }, readOnly: true,
      run: async (): Promise<ToolResult> => ({ output: 'done' }),
    })
    const { mgr } = makeManagerWith([script, []], registry)
    const echoes: Array<{ text: string; steer?: boolean }> = []
    mgr.subscribe((e) => { if (e.type === 'user-echo') echoes.push({ text: e.text, steer: e.steer }) })
    mgr.steer('change direction') // consumed at the tool batch → folded → echoed as a steer bubble
    await mgr.submit('go')
    expect(echoes).toEqual([{ text: 'change direction', steer: true }])
  })
})

describe('SessionManager re-entrancy guard', () => {
  it('rejects an external concurrent submit while a turn is in progress', async () => {
    const { client, release } = gatedClient()
    const mgr = makeManagerFromClient(client)
    const p = mgr.submit('a') // do NOT await: turn is held open by the gate
    expect(mgr.getState().isThinking).toBe(true)
    await expect(mgr.submit('b')).rejects.toThrow(/already in progress/)
    release()
    await p
    expect(mgr.getState().isThinking).toBe(false)
  })

  it('isResend bypasses the guard (no "already in progress" error)', async () => {
    const { client, release } = gatedClient()
    const mgr = makeManagerFromClient(client)
    const p = mgr.submit('a') // held open by the gate
    expect(mgr.getState().isThinking).toBe(true)

    // The isResend re-entry must NOT be rejected by the guard. It starts a nested
    // runAgent that also awaits the gate; we only assert the guard did not fire.
    let guardError: unknown
    const resend = mgr.submit('x', undefined, { isResend: true }).catch((e) => {
      guardError = e
    })

    // Release the gate so both the outer turn and the nested resend can complete,
    // then settle everything to avoid hanging promises.
    release()
    await Promise.all([p, resend])

    // The guard message must never have been thrown for the isResend call.
    if (guardError instanceof Error) {
      expect(guardError.message).not.toMatch(/already in progress/)
    }
  })

  it('interrupt() aborts a turn: emits aborted then turn-end', async () => {
    const { client, release } = gatedClient()
    const mgr = makeManagerFromClient(client)
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))

    const p = mgr.submit('go') // held open by the gate
    expect(mgr.getState().isThinking).toBe(true)

    // Abort while the gate still holds the turn. After release(), the gated client
    // observes signal.aborted and yields an 'error' event, which submit surfaces as
    // 'aborted' (error + signal.aborted).
    expect(mgr.interrupt()).toBe(true)
    release()
    await p

    expect(types).toContain('aborted')
    const abortedIdx = types.indexOf('aborted')
    const turnEndIdx = types.indexOf('turn-end')
    expect(turnEndIdx).toBeGreaterThan(abortedIdx)
    expect(mgr.getState().isThinking).toBe(false)
  })

  it('Stop after a steer discards the current turn but still runs the steer as a follow-up', async () => {
    // "Interject, then hit Stop" reads as: drop what you're doing and get to MY message. The
    // aborted turn is discarded, then the queued steer runs as its own fresh turn.
    const { client, release } = gatedClient()
    const mgr = makeManagerFromClient(client)
    const echoes: string[] = []
    mgr.subscribe((e) => { if (e.type === 'user-echo') echoes.push(e.text) })

    const p = mgr.submit('go')          // held open at the gate
    mgr.steer('do Y instead')           // queued during the (gated) turn
    expect(mgr.interrupt()).toBe(true)  // Stop
    release()                           // gated client sees the abort → turn 1 is discarded
    await p                             // awaits the idle-drained follow-up turn as well

    expect(echoes).toContain('do Y instead') // echoed as the follow-up's user message
    const texts = mgr.getConversation().getMessages().flatMap((m) => m.content)
      .filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
    expect(texts.some((t) => t.includes('do Y instead'))).toBe(true) // the steer actually ran
  })
})

describe('SessionManager failover', () => {
  it('auto failover: marks bad, swaps to backup, resends; exactly one turn-end (no double-emit)', async () => {
    // Settings with provider 'p' declaring two models and auto failover mode.
    const settings = {
      failoverMode: 'auto',
      providers: {
        p: { protocol: 'anthropic', apiKey: 'test-key', models: ['primary', 'backup'] },
      },
      tools: {},
      permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
    } as unknown as ResolvedSettings

    // PRIMARY client: yields a preStream quota error (no text emitted first).
    const primary: ModelClient = {
      getModel: () => 'primary',
      async *sendMessages() {
        yield { type: 'error', message: 'quota exceeded', category: 'quota' }
      },
    }

    // BACKUP client: a normal short turn. Injected via the createClient seam so the
    // failover swap never touches a real provider.
    const backup: ModelClient = {
      getModel: () => 'backup',
      async *sendMessages() {
        yield { type: 'message-start', id: 'm1', model: 'backup' }
        yield { type: 'text-delta', text: 'recovered' }
        yield { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }
      },
    }

    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client: primary,
      registry: new ToolRegistry(),
      settings,
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      providerId: 'p',
      createClient: () => backup,
    })

    const events: { type: string; [k: string]: unknown }[] = []
    let recoveredText = ''
    let backupUsage: unknown
    mgr.subscribe((e) => {
      events.push(e as never)
      if (e.type === 'text-delta') recoveredText += e.text
      if (e.type === 'message-stop') backupUsage = e.usage
    })

    await mgr.submit('hi')

    const failover = events.find((e) => e.type === 'failover')
    expect(failover).toBeDefined()
    expect(failover).toMatchObject({ fromModel: 'primary', toModel: 'backup' })

    const turnStarts = events.filter((e) => e.type === 'turn-start')
    expect(turnStarts.length).toBe(2)
    expect(turnStarts[0]).toMatchObject({ isResend: false })
    expect(turnStarts[1]).toMatchObject({ isResend: true })

    // CRITICAL: exactly one turn-end (no double-emit from the recursive resend).
    expect(events.filter((e) => e.type === 'turn-end').length).toBe(1)

    // The recovered (backup) turn actually ran.
    expect(recoveredText).toBe('recovered')
    expect(backupUsage).toMatchObject({ input_tokens: 7, output_tokens: 3 })
    expect(mgr.getState().isThinking).toBe(false)
  })
})

describe('SessionManager auto-compaction', () => {
  it('compacts before a turn when contextTokens exceeds the window threshold', async () => {
    // Seed a conversation with several user/assistant turn pairs so findCompactionCut
    // (keepTurns=2) returns a non-null cut index > 0.
    const seed: Message[] = []
    for (let n = 0; n < 4; n++) {
      seed.push({ role: 'user', content: [{ type: 'text', text: `user message ${n} ${'x'.repeat(200)}` }] })
      seed.push({ role: 'assistant', content: [{ type: 'text', text: `assistant reply ${n} ${'y'.repeat(200)}` }] })
    }
    const conversation = Conversation.fromJSON({
      version: 1,
      messages: seed,
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })

    // scripts[0] = the summary request response (summarizeForCompaction collects text-delta);
    // scripts[1] = the actual turn response.
    const summaryScript: StreamEvent[] = [
      { type: 'message-start', id: 'sum', model: 'fake-model' },
      { type: 'text-delta', text: '## Active Task\nNone.\n## Goal\nTesting compaction.' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } },
    ]
    const turnScript: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
    const { client, calls } = fakeClient([summaryScript, turnScript])

    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
    })

    // Force the pre-turn trigger: DEFAULT_CONTEXT_WINDOW=512000, threshold=0.8 → > 409600.
    // @ts-expect-error reach a test-only seam to set contextTokens high
    mgr._setContextTokensForTest(500_000)

    const lengthBefore = mgr.getState().messageCount
    const types: string[] = []
    let summaryText = ''
    mgr.subscribe((e) => {
      types.push(e.type)
      if (e.type === 'compaction-done') summaryText = e.summaryText
    })

    await mgr.submit('next question')

    // The summary request fired before the turn request.
    expect(calls.length).toBe(2)
    // Compaction lifecycle events were emitted during submit.
    expect(types).toContain('compaction-start')
    expect(types).toContain('compaction-done')
    expect(types).toContain('memory-notice')
    expect(summaryText).toContain('## Active Task')
    // Feature B: the full ledger is NOT shortened — it keeps every message and grows by the
    // new turn's messages (display/search see the whole history).
    expect(mgr.getState().messageCount).toBeGreaterThan(lengthBefore)
    // Compaction was recorded as metadata (summary + a cut into the full ledger), not by
    // replacing the ledger.
    const comp = mgr.getCompaction()
    expect(comp).not.toBeNull()
    expect(comp!.cutIndex).toBeGreaterThan(0)
    expect(comp!.summaryText).toContain('## Active Task')
    // The model turn (calls[1]) received the COMPACTED view (summary + recent tail), NOT the full
    // history — proof the LLM context was shortened even though the ledger was not.
    expect(calls[1]!.length).toBeLessThan(lengthBefore)
  })

  it('compactNow() compacts on demand regardless of the context threshold (web /compact)', async () => {
    const seed: Message[] = []
    for (let n = 0; n < 4; n++) {
      seed.push({ role: 'user', content: [{ type: 'text', text: `user message ${n} ${'x'.repeat(200)}` }] })
      seed.push({ role: 'assistant', content: [{ type: 'text', text: `assistant reply ${n} ${'y'.repeat(200)}` }] })
    }
    const conversation = Conversation.fromJSON({
      version: 1, messages: seed, totalUsage: { input_tokens: 0, output_tokens: 0 },
    })
    // Only the summary request is made (no turn). contextTokens left at 0 (below threshold) to prove
    // manual compaction ignores the threshold.
    const summaryScript: StreamEvent[] = [
      { type: 'message-start', id: 'sum', model: 'fake-model' },
      { type: 'text-delta', text: '## Active Task\nNone.' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } },
    ]
    const { client, calls } = fakeClient([summaryScript])
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(), settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(), conversation,
    })
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))

    await mgr.compactNow()

    expect(calls.length).toBe(1) // the summary request ran even though we're under threshold
    // Locks the composer (turn-start/turn-end) and runs the full compaction lifecycle.
    expect(types).toContain('turn-start')
    expect(types).toContain('compaction-start')
    expect(types).toContain('compaction-done')
    expect(types).toContain('memory-notice')
    expect(types).toContain('turn-end')
    expect(mgr.getCompaction()).not.toBeNull()
  })
})

describe('SessionManager compaction failover', () => {
  const seed = () => {
    const s: Message[] = []
    for (let n = 0; n < 4; n++) {
      s.push({ role: 'user', content: [{ type: 'text', text: `user ${n} ${'x'.repeat(200)}` }] })
      s.push({ role: 'assistant', content: [{ type: 'text', text: `asst ${n} ${'y'.repeat(200)}` }] })
    }
    return Conversation.fromJSON({ version: 1, messages: s, totalUsage: { input_tokens: 0, output_tokens: 0 } })
  }
  const settingsWith = (models: string[]) => ({
    failoverMode: 'auto',
    providers: { p: { protocol: 'anthropic', apiKey: 'k', models } },
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings)
  const quotaClient = (name: string): ModelClient => ({
    getModel: () => name,
    async *sendMessages() { yield { type: 'error', message: 'quota', category: 'quota' } },
  })

  it('summarize hits quota → fails over to the next model → real summary, no fallback warning', async () => {
    const backup: ModelClient = {
      getModel: () => 'backup',
      async *sendMessages() {
        yield { type: 'message-start', id: 's', model: 'backup' }
        yield { type: 'text-delta', text: '## Active Task\nreal summary from backup' }
        yield { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }
      },
    }
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client: quotaClient('primary'), registry: new ToolRegistry(),
      settings: settingsWith(['primary', 'backup']), systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(), providerId: 'p', createClient: () => backup, conversation: seed(),
    })
    const types: string[] = []
    let summaryText = '', warned = false
    mgr.subscribe((e) => {
      types.push(e.type)
      if (e.type === 'compaction-done') summaryText = e.summaryText
      if (e.type === 'warning') warned = true
    })
    await mgr.compact()
    expect(types).toContain('failover')
    expect(summaryText).toContain('real summary from backup')
    expect(summaryText).not.toContain('Deterministic fallback')
    expect(warned).toBe(false)
    expect(mgr.getCompaction()).not.toBeNull()
  })

  it('summarize quota with no other model → mechanical fallback + warning', async () => {
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client: quotaClient('only'), registry: new ToolRegistry(),
      settings: settingsWith(['only']), systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(), providerId: 'p', conversation: seed(),
    })
    const types: string[] = []
    let summaryText = ''
    mgr.subscribe((e) => { types.push(e.type); if (e.type === 'compaction-done') summaryText = e.summaryText })
    await mgr.compact()
    expect(types).toContain('warning')
    expect(summaryText).toContain('Deterministic fallback')
    expect(mgr.getCompaction()).not.toBeNull()
  })

  it('no-op when nothing new to fold since the last compaction (no model call, no events)', async () => {
    let called = false
    const client: ModelClient = {
      getModel: () => 'm',
      async *sendMessages() { called = true; yield { type: 'error', message: 'should not be called', category: 'quota' } },
    }
    const conv = Conversation.fromJSON({
      version: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(), settings: settingsWith(['m']),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(), providerId: 'p', conversation: conv,
      compaction: { summaryText: 'old summary', cutIndex: 0 },   // already compacted; nothing new to fold
    })
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))
    const msg = await mgr.compact()
    expect(msg).toContain('没有新内容')
    expect(called).toBe(false)                       // never hit the model
    expect(types).not.toContain('compaction-start')  // no compaction events emitted
    expect(types).not.toContain('compaction-done')
    expect(mgr.getCompaction()).toMatchObject({ cutIndex: 0 })  // metadata unchanged
  })
})

describe('SessionManager checkpoints + revert', () => {
  it('records a checkpoint after a turn with the snapshot hash', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'ok' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { client } = fakeClient([script])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      // track() returns a known hash so we can assert on it.
      snapshotStore: { track: async () => 'cp-hash-1', restore: async () => {} },
    })
    let recorded: { id: string; messageIndex: number; label: string } | undefined
    mgr.subscribe((e) => {
      if (e.type === 'checkpoint-recorded') recorded = { id: e.id, messageIndex: e.messageIndex, label: e.label }
    })
    await mgr.submit('do the thing')
    expect(recorded).toMatchObject({ id: 'cp-hash-1', messageIndex: 0, label: 'do the thing' })
  })

  it('revert restores the snapshot and truncates the ledger to the checkpoint index', async () => {
    // First turn: model asks a tool then stops, producing 3 ledger messages (user, assistant
    // tool_use, user tool_result) + the next assistant turn. We just need length > 0 after.
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hello there' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { client } = fakeClient([script])
    const restored: string[] = []
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: { track: async () => 'cp-hash-1', restore: async (h) => { restored.push(h) } },
    })
    const reverted: string[] = []
    mgr.subscribe((e) => { if (e.type === 'reverted') reverted.push(e.checkpointId) })
    await mgr.submit('first')
    // Ledger now has at least the user + assistant messages.
    expect(mgr.getState().messageCount).toBeGreaterThan(0)

    await mgr.revert('cp-hash-1')
    expect(restored).toEqual(['cp-hash-1'])
    // checkpointIndex was 0 (ledger empty before the turn), so revert truncates to 0.
    expect(mgr.getState().messageCount).toBe(0)
    expect(mgr.getState().contextTokens).toBeUndefined()
    // A successful revert emits a `reverted` event carrying the checkpoint id.
    expect(reverted).toEqual(['cp-hash-1'])

    // Reverting an unknown checkpoint is a no-op (no restore call, no `reverted` event).
    await mgr.revert('nope')
    expect(restored).toEqual(['cp-hash-1'])
    expect(reverted).toEqual(['cp-hash-1'])
  })

  it('revert rejects while a turn is in progress (mirrors submit/retry)', async () => {
    // Regression: revert() had no isThinking guard, so a mid-turn revert truncated the ledger
    // out from under the in-flight runAgent loop — which then pushed a checkpoint and overwrote
    // usage from the stale ledger, resurrecting the reverted turn and desyncing state.
    const { client, release } = gatedClient()
    const mgr = makeManagerFromClient(client)
    const p = mgr.submit('go') // held open by the gate: a turn is now in flight
    expect(mgr.getState().isThinking).toBe(true)
    await expect(mgr.revert('any-hash')).rejects.toThrow(/already in progress/)
    release()
    await p
    expect(mgr.getState().isThinking).toBe(false)
  })

  it('retry reverts the last turn then re-submits the same prompt', async () => {
    const mkScript = (): StreamEvent[] => [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: 'an answer' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { client } = fakeClient([mkScript(), mkScript()])
    const restored: string[] = []
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(),
      settings: makeSettings(), systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: { track: async () => 'cp-hash-1', restore: async (h) => { restored.push(h) } },
    })
    const reverted: string[] = []
    const echoed: string[] = []
    mgr.subscribe((e) => {
      if (e.type === 'reverted') reverted.push(e.checkpointId)
      if (e.type === 'user-echo') echoed.push(e.text)
    })

    await mgr.submit('my question')
    const before = mgr.getState().messageCount
    expect(before).toBeGreaterThan(0)

    await mgr.retry()
    expect(restored).toEqual(['cp-hash-1'])
    expect(reverted).toEqual(['cp-hash-1'])
    // Echoes the re-submitted question so clients show it immediately (no refresh needed).
    expect(echoed).toEqual(['my question'])
    expect(mgr.getState().messageCount).toBe(before)
    const first = mgr.getState().messages[0]!
    expect(first.role).toBe('user')
    expect(first.parts[0]).toMatchObject({ kind: 'text', text: 'my question' })

    mgr.reset()
    await mgr.retry()
    expect(restored).toEqual(['cp-hash-1'])
  })

  it('retry skips intervening tool_result (role:user) messages and resubmits the real question', async () => {
    // A turn with a tool call leaves a tool_result committed as role:'user'. Scanning for the
    // last role:'user' message would land there (no checkpoint → silent no-op). retry must use
    // the last checkpoint, which anchors the real question at index 0.
    const seeded = Conversation.fromJSON({ version: 1, messages: [
      { role: 'user', content: [{ type: 'text', text: '[2026-06-27 10:00] the real question' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
    ], totalUsage: new Conversation().totalUsage })
    const { client } = fakeClient([[
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: 'fresh answer' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]])
    const restored: string[] = []
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(),
      settings: makeSettings(), systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: { track: async () => 'cp-new', restore: async (h) => { restored.push(h) } },
      conversation: seeded,
      checkpoints: [{ messageIndex: 0, hash: 'cp0', at: '2026-06-27T10:00:00.000Z', label: 'q' }],
    })
    await mgr.retry()
    expect(restored).toEqual(['cp0'])
    expect(mgr.getState().messages[0]!.parts[0]).toMatchObject({ kind: 'text', text: 'the real question' })
  })
})

describe('SessionManager switchModel', () => {
  it('rebuilds the client and reflects the new model in getState', () => {
    const settings = {
      providers: { p: { protocol: 'anthropic', apiKey: 'k', models: ['a', 'b'] } },
      tools: {},
      permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
    } as unknown as ResolvedSettings
    const { client } = fakeClient([], 'a')
    const newClient: ModelClient = {
      getModel: () => 'b',
      async *sendMessages() {},
    }
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings,
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      providerId: 'p',
      createClient: () => newClient,
    })
    expect(mgr.getState().model).toBe('a')
    mgr.switchModel('p', 'b')
    expect(mgr.getState().model).toBe('b')
  })
})

describe('SessionManager memory flush in compact()', () => {
  it('invokes the Memory tool save for each MEMORY candidate the summary yields', async () => {
    const seed: Message[] = []
    for (let n = 0; n < 4; n++) {
      seed.push({ role: 'user', content: [{ type: 'text', text: `user message ${n} ${'x'.repeat(200)}` }] })
      seed.push({ role: 'assistant', content: [{ type: 'text', text: `assistant reply ${n} ${'y'.repeat(200)}` }] })
    }
    const conversation = Conversation.fromJSON({
      version: 1,
      messages: seed,
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })

    // The summary response contains a MEMORY line in the exact format splitMemoryCandidates
    // parses: `MEMORY: <type>|<hook>|<content>`.
    const summaryScript: StreamEvent[] = [
      { type: 'message-start', id: 'sum', model: 'fake-model' },
      { type: 'text-delta', text: '## Active Task\nNone.\nMEMORY: project|build|use pnpm not npm' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } },
    ]
    const { client } = fakeClient([summaryScript])

    // Fake Memory tool capturing run() calls.
    const memCalls: unknown[] = []
    const registry = new ToolRegistry()
    registry.register({
      name: 'Memory',
      description: 'persist memories',
      inputSchema: { type: 'object', properties: {} },
      run: async (input: unknown): Promise<ToolResult> => { memCalls.push(input); return { output: 'saved' } },
    })

    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry,
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
    })

    await mgr.compact()

    expect(memCalls).toHaveLength(1)
    expect(memCalls[0]).toMatchObject({ action: 'save', type: 'project', hook: 'build', content: 'use pnpm not npm' })
  })
})

describe('SessionManager session-allow accumulation across turns', () => {
  it('allow_session in turn 1 auto-allows the same tool in turn 2 (no second permission-request)', async () => {
    // A non-readOnly, non-Bash tool with a null specifier → rule is the bare tool name
    // 'Deploy'. Under defaultMode 'default', decide() classifies it 'ask', so turn 1
    // triggers canUseTool → a permission-request. Resolving with 'allow_session' makes
    // core's gateAndRunTool push 'Deploy' into the reused this.sessionAllow array, so in
    // turn 2 decide() finds the rule and returns 'allow' — NO new permission-request.
    let runCount = 0
    const registry = new ToolRegistry()
    registry.register({
      name: 'Deploy',
      description: 'deploy something',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
      run: async (): Promise<ToolResult> => { runCount++; return { output: 'deployed' } },
      // specifierFor omitted → specifier is null → rule === 'Deploy'.
    })

    // Per submit, runAgent runs two model calls: the tool_use turn then a clean stop.
    const toolUse: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'tool-use', id: 't', name: 'Deploy', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const stop: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    // submit #1 consumes scripts[0..1]; submit #2 consumes scripts[2..3].
    const { mgr } = makeManagerWith([toolUse, stop, toolUse, stop], registry)

    // Auto-resolve any permission-request with allow_session, and count them.
    let permRequests = 0
    mgr.subscribe((e) => {
      if (e.type === 'permission-request') {
        permRequests++
        mgr.resolvePermission(e.id, 'allow_session')
      }
    })

    await mgr.submit('deploy please')
    await mgr.submit('deploy again')

    // The rule was asked exactly once (turn 1); turn 2 was auto-allowed from sessionAllow.
    expect(permRequests).toBe(1)
    // The tool actually ran in BOTH turns (turn 2 was not denied/skipped).
    expect(runCount).toBe(2)
  })
})

describe('SessionManager steer', () => {
  it('consumeSteer drains the queued steer text into the running turn', async () => {
    // runAgent calls opts.consumeSteer() after each tool batch and injects the returned
    // text as a follow-up user message. Queue a steer before the turn; the tool batch
    // gives runAgent a consume point, and we assert the steered text reached the client
    // (it appears in the messages the fake client received on the second model call) and
    // that the queue was drained.
    const registry = new ToolRegistry()
    registry.register({
      name: 'Noop',
      description: 'no-op tool',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true, // auto-allowed under defaultMode 'default' (no permission prompt)
      run: async (): Promise<ToolResult> => ({ output: 'ok' }),
    })
    const toolUse: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'tool-use', id: 't', name: 'Noop', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const stop: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { mgr, calls } = makeManagerWith([toolUse, stop], registry)

    // Enqueue a steer before the turn; runAgent consumes it after the tool batch.
    mgr.steer('extra steer text')
    await mgr.submit('start')

    // The steer text is injected into the last tool_result block's content, so on the
    // SECOND model call the fake client receives a message containing it. Serialize all
    // received messages and assert the steered text is present (consumeSteer drained it).
    const serialized = JSON.stringify(calls)
    expect(serialized).toContain('extra steer text')
    expect(serialized).toContain('USER MESSAGE') // the steer-injection wrapper from core
  })

  it('steer drops blank/whitespace-only text (queue stays empty, nothing injected)', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'Noop',
      description: 'no-op tool',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async (): Promise<ToolResult> => ({ output: 'ok' }),
    })
    const toolUse: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'tool-use', id: 't', name: 'Noop', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const stop: StreamEvent[] = [
      { type: 'message-start', id: 'm', model: 'fake-model' },
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { mgr, calls } = makeManagerWith([toolUse, stop], registry)

    // Only blank/whitespace steers — steer() must trim and drop them, so nothing is
    // injected and core's steer wrapper never appears in any model call.
    mgr.steer('   ')
    mgr.steer('')
    await mgr.submit('start')

    expect(JSON.stringify(calls)).not.toContain('USER MESSAGE')
  })
})

describe('SessionManager reset ("New chat")', () => {
  it('clears todos/usage/context, zeroes messageCount, and emits an empty todos-update', async () => {
    // Run a real turn so totalUsage/contextTokens and the conversation are populated,
    // then assert reset() wipes them back to a brand-new state.
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hi' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
    const { mgr } = makeManagerWith([script])
    await mgr.submit('first')

    mgr.setTodos([{ content: 'task A', status: 'pending' }])
    expect(mgr.getState().todos.length).toBeGreaterThan(0)
    expect(mgr.getState().messageCount).toBeGreaterThan(0)
    expect(mgr.getState().totalUsage).toBeDefined()
    expect(mgr.getState().contextTokens).toBeDefined()

    // Subscribe AFTER seeding so we only observe the reset-driven emission.
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))

    mgr.reset()

    const s = mgr.getState()
    expect(s.todos).toEqual([])
    expect(s.messageCount).toBe(0)
    expect(s.totalUsage).toBeUndefined()
    expect(s.contextTokens).toBeUndefined()

    const todosUpdate = events.find(
      (e): e is Extract<SessionEvent, { type: 'todos-update' }> => e.type === 'todos-update',
    )
    expect(todosUpdate).toBeDefined()
    expect(todosUpdate?.todos).toEqual([])
  })

  it('settles parked permission prompts with deny instead of orphaning them', async () => {
    const { mgr } = makeManager()
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))
    // @ts-expect-error reach private canUseTool to park a permission request
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm x' }, specifier: 'rm x', rule: 'Bash(rm x)', reason: 'ask' })
    expect(mgr.getState().pendingPermissions.length).toBe(1)

    mgr.reset()

    // The awaited promise must settle (to 'deny') — not hang forever — and the
    // pending map must be empty, with a permission-resolved emitted.
    await expect(p).resolves.toBe('deny')
    expect(mgr.getState().pendingPermissions).toEqual([])
    const resolved = events.find(
      (e): e is Extract<SessionEvent, { type: 'permission-resolved' }> => e.type === 'permission-resolved',
    )
    expect(resolved?.verdict).toBe('deny')
  })

  it('clears compaction metadata (feature B: compaction lives outside the ledger now)', () => {
    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(), settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      compaction: { summaryText: 'old summary', cutIndex: 3 },
    })
    expect(mgr.getCompaction()).not.toBeNull()
    mgr.reset()
    expect(mgr.getCompaction()).toBeNull()   // a fresh chat must not inherit the previous summary
  })
})

describe('context window in snapshot', () => {
  it('getState includes a positive contextWindow', () => {
    const { mgr } = makeManagerWith([])
    const snap = mgr.getState()
    expect(typeof snap.contextWindow).toBe('number')
    expect((snap.contextWindow ?? 0)).toBeGreaterThan(0)
  })
})

describe('SessionManager persistence accessors', () => {
  it('getConversation() returns the seeded conversation with its messages', () => {
    const conversation = Conversation.fromJSON({
      version: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello from seed' }] }],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    })
    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      conversation,
    })
    const msgs = mgr.getConversation().getMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello from seed' }] })
  })

  it('getCheckpoints() returns the seeded checkpoints and is a defensive copy', () => {
    const { client } = fakeClient([])
    const checkpoints: SessionCheckpoint[] = [
      { messageIndex: 0, hash: 'h1', at: '2026-01-01T00:00:00Z', label: 'hi' },
    ]
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      checkpoints,
    })

    const first = mgr.getCheckpoints()
    expect(first).toEqual([{ messageIndex: 0, hash: 'h1', at: '2026-01-01T00:00:00Z', label: 'hi' }])

    // Mutating the returned array must NOT affect subsequent calls (defensive copy).
    first.push({ messageIndex: 99, hash: 'phantom', at: '2026-01-01T00:00:00Z', label: 'extra' })
    const second = mgr.getCheckpoints()
    expect(second).toHaveLength(1)
    expect(second[0]!.hash).toBe('h1')
  })

  it('getCreatedAt() returns the explicitly passed createdAt value', () => {
    const { client } = fakeClient([])
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
      createdAt: '2026-03-15T10:00:00.000Z',
    })
    expect(mgr.getCreatedAt()).toBe('2026-03-15T10:00:00.000Z')
  })

  it('getModelId() returns the model from the injected client', () => {
    const { client } = fakeClient([], 'test-model-xyz')
    const mgr = new SessionManager({
      sessionId: 's1',
      cwd: '/work',
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
    })
    expect(mgr.getModelId()).toBe('test-model-xyz')
  })
})
