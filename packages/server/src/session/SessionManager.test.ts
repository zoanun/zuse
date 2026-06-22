import { describe, it, expect } from 'vitest'
import { SessionManager, remapCheckpoints } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { Conversation, ToolRegistry } from '@zuse/core'
import type { Message, ModelClient, ResolvedSettings, Tool, ToolContext, ToolResult, StreamEvent } from '@zuse/core'
import type { SessionCheckpoint } from './events.js'

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
    // Conversation was replaced with a shorter, compacted ledger.
    expect(mgr.getState().messageCount).toBeLessThan(lengthBefore)
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
    await mgr.submit('first')
    // Ledger now has at least the user + assistant messages.
    expect(mgr.getState().messageCount).toBeGreaterThan(0)

    await mgr.revert('cp-hash-1')
    expect(restored).toEqual(['cp-hash-1'])
    // checkpointIndex was 0 (ledger empty before the turn), so revert truncates to 0.
    expect(mgr.getState().messageCount).toBe(0)
    expect(mgr.getState().contextTokens).toBeUndefined()

    // Reverting an unknown checkpoint is a no-op (no restore call).
    await mgr.revert('nope')
    expect(restored).toEqual(['cp-hash-1'])
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

describe('remapCheckpoints', () => {
  const cp = (messageIndex: number): SessionCheckpoint => ({
    messageIndex,
    hash: `h${messageIndex}`,
    at: '2026-01-01T00:00:00.000Z',
    label: `cp${messageIndex}`,
  })

  it('drops checkpoints inside the folded range [0, cut) and remaps the kept ones (− cut + 1)', () => {
    // Checkpoints at [0, 2, 5], cut = 3.
    //  - 0 and 2 are < cut → folded away (dropped).
    //  - 5 is >= cut → kept, remapped to 5 - 3 + 1 = 3 (the summary placeholder shifts it).
    const result = remapCheckpoints([cp(0), cp(2), cp(5)], 3)
    expect(result).toHaveLength(1)
    expect(result[0]!.messageIndex).toBe(3)
    // Identity-bearing fields are preserved on the survivor.
    expect(result[0]!.hash).toBe('h5')
    expect(result[0]!.label).toBe('cp5')
  })

  it('a checkpoint exactly at the cut index is kept and remaps to 1 (cut - cut + 1)', () => {
    const result = remapCheckpoints([cp(3)], 3)
    expect(result.map((c) => c.messageIndex)).toEqual([1])
  })

  it('remaps multiple survivors preserving order: [4, 7] with cut 3 → [2, 5]', () => {
    const result = remapCheckpoints([cp(1), cp(4), cp(7)], 3)
    // 1 dropped; 4 → 4-3+1=2; 7 → 7-3+1=5.
    expect(result.map((c) => c.messageIndex)).toEqual([2, 5])
  })

  it('does not mutate the input checkpoints', () => {
    const input = [cp(5)]
    remapCheckpoints(input, 3)
    expect(input[0]!.messageIndex).toBe(5)
  })
})
