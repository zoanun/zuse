import { describe, it, expect } from 'vitest'
import { Conversation, ToolRegistry, runAgent } from '@zuse/core'
import type { ModelClient, StreamEvent, Usage, ResolvedSettings } from '@zuse/core'
import { createAgentTool } from './agent-tool.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

/**
 * Creates a fake ModelClient that replays scripted responses.
 * Each call to sendMessages consumes the next script in order.
 */
function fakeClient(scripts: StreamEvent[][]): ModelClient {
  let i = 0
  return {
    getModel: () => 'fake-model',
    async *sendMessages() {
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
}

const PERMISSIVE: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'bypassPermissions', allow: [], ask: [], deny: [] },
  providers: {},
}

describe('createAgentTool', () => {
  it('runs a sub-agent and returns its final text', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'sub-result' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'find something', description: 'search task' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('sub-result')
    expect(result.isError).toBeFalsy()
  })

  it('returns error when prompt is missing', async () => {
    const client = fakeClient([])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { description: 'search task' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('prompt')
  })

  it('returns error when description is missing', async () => {
    const client = fakeClient([])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'find something' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('description')
  })

  it('excludes Agent tool from child registry', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    // Register a dummy "Agent" tool in parent to verify it gets excluded
    registry.register({
      name: 'Agent',
      description: 'self',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'should not be reachable' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    // The tool itself should still work — it just doesn't let the sub-agent spawn more sub-agents
    const result = await tool.run(
      { prompt: 'do something', description: 'test' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('done')
    expect(result.isError).toBeFalsy()
  })

  it('filters tools by allowedTools', async () => {
    // We test indirectly: if allowedTools restricts to ["Read"], the child registry
    // should only contain Read. We verify the tool runs successfully (it doesn't blow up)
    // and the sub-agent text is returned.
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'filtered-result' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    registry.register({
      name: 'Read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => ({ output: 'file contents' }),
    })
    registry.register({
      name: 'Write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'written' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'read only', description: 'test', allowedTools: ['Read'] },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('filtered-result')
    expect(result.isError).toBeFalsy()
  })

  it('specifierFor returns description', () => {
    const client = fakeClient([])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    expect(tool.specifierFor!({ description: 'my label' })).toBe('my label')
    expect(tool.specifierFor!({ description: 123 })).toBeNull()
    expect(tool.specifierFor!({})).toBeNull()
  })

  it('returns fallback text when sub-agent produces no output', async () => {
    const client = fakeClient([
      [
        // Only a stop event, no text-delta
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'do something silent', description: 'silent task' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('(sub-agent produced no text output)')
    expect(result.isError).toBeFalsy()
  })

  // ── Model override — bad format ────────────────────────────────────

  it('returns error for model spec without slash', async () => {
    const client = fakeClient([])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'do something', description: 'test', model: 'no-slash' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid model format')
  })

  it('returns error for model spec with empty model name', async () => {
    const client = fakeClient([])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'do something', description: 'test', model: 'prov/' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Model name is empty')
  })

  // ── allowedTools — sub-agent tool-use call succeeds for whitelisted tool ──

  it('allows whitelisted tool to be called by sub-agent', async () => {
    // Turn 1: model calls Read tool
    // Turn 2: model returns final text after seeing tool result
    const client = fakeClient([
      [
        { type: 'tool-use', id: 'call_1', name: 'Read', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'read-ok' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    registry.register({
      name: 'Read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => ({ output: 'file contents' }),
    })
    registry.register({
      name: 'Write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'written' }),
    })
    registry.register({
      name: 'Grep',
      description: 'grep',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => ({ output: 'matched' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'read a file', description: 'test', allowedTools: ['Read', 'Grep'] },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('read-ok')
    expect(result.isError).toBeFalsy()
  })

  it('rejects tool call for tool not in allowedTools whitelist', async () => {
    // Turn 1: model tries to call Write (not whitelisted)
    // Turn 2: model sees "Unknown tool" error and falls back to text
    const client = fakeClient([
      [
        { type: 'tool-use', id: 'call_w', name: 'Write', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'fallback-answer' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    registry.register({
      name: 'Read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => ({ output: 'file contents' }),
    })
    registry.register({
      name: 'Write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'written' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'write a file', description: 'test', allowedTools: ['Read'] },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    // Sub-agent should still produce output (model falls back after unknown tool error)
    expect(result.output).toBe('fallback-answer')
    expect(result.isError).toBeFalsy()
  })

  // ── Recursion prevention — Agent call in sub-agent gets Unknown tool ──

  it('prevents sub-agent from calling Agent (recursion prevention)', async () => {
    // Turn 1: model tries to call Agent
    // Turn 2: model sees "Unknown tool" error and falls back to text
    const client = fakeClient([
      [
        { type: 'tool-use', id: 'call_a', name: 'Agent', input: { prompt: 'nested', description: 'nope' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'no-recursion' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    registry.register({
      name: 'Agent',
      description: 'self',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'should not be reachable' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'spawn sub-agent', description: 'test' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('no-recursion')
    expect(result.isError).toBeFalsy()
  })

  // ── allowedTools containing "Agent" — silently filtered ──

  it('silently filters Agent from allowedTools list', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'agent-filtered' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    registry.register({
      name: 'Read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      run: async () => ({ output: 'file contents' }),
    })
    registry.register({
      name: 'Agent',
      description: 'self',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'should not be reachable' }),
    })

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    // Explicitly requesting Agent in allowedTools should not cause errors
    const result = await tool.run(
      { prompt: 'do something', description: 'test', allowedTools: ['Read', 'Agent'] },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('agent-filtered')
    expect(result.isError).toBeFalsy()
  })

  // ── Permission inheritance — canUseTool ──────────────────────────────

  it('child agent inherits canUseTool — ask triggers callback', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'Write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'written' }),
    })

    const askSettings: ResolvedSettings = {
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: ['Write'], deny: [] },
      providers: {},
    }

    let askCalled = false
    const client = fakeClient([
      [
        { type: 'tool-use', id: 'w1', name: 'Write', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: askSettings,
      getSystemPrompt: () => 'sys',
      canUseTool: async () => { askCalled = true; return 'allow' },
    })

    await tool.run(
      { prompt: 'write something', description: 'write test' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(askCalled).toBe(true)
  })

  it('child agent inherits sessionAllow — pre-approved tools skip ask', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'Write',
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ output: 'written' }),
    })

    const askSettings: ResolvedSettings = {
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: ['Write'], deny: [] },
      providers: {},
    }

    let askCalled = false
    const client = fakeClient([
      [
        { type: 'tool-use', id: 'w1', name: 'Write', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: askSettings,
      getSystemPrompt: () => 'sys',
      sessionAllow: ['Write'],
      canUseTool: async () => { askCalled = true; return 'allow' },
    })

    const result = await tool.run(
      { prompt: 'write something', description: 'write test' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(askCalled).toBe(false)
    expect(result.output).toBe('done')
  })

  // ── Background Agent ─────────────────────────────────────────────────

  it('returns immediately in background mode and calls onBackground when done', async () => {
    let bgResult: { desc: string; result: string } | null = null
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'bg-done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'sys',
      onBackground: (desc, result) => { bgResult = { desc, result } },
    })

    const result = await tool.run(
      { prompt: 'bg task', description: 'background test', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toContain('launched in background')
    expect(result.isError).toBeFalsy()

    await new Promise((r) => setTimeout(r, 50))
    expect(bgResult).toEqual({ desc: 'background test', result: 'bg-done' })
  })
})
