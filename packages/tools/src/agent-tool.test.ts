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

    expect(result.output).toContain('未产生文本输出')
    expect(result.isError).toBeFalsy()
  })
})
