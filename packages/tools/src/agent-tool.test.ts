import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '@zuse/core'
import type { ModelClient, StreamEvent, Usage, ResolvedSettings, Tool } from '@zuse/core'
import { createAgentTool, buildChildRegistry } from './agent-tool.js'

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
  permissions: { defaultMode: 'bypass', allow: [], ask: [], deny: [] },
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

  it('derives a label from the prompt when description is omitted (still runs)', async () => {
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
      { prompt: 'find something' }, // no description supplied
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('sub-result')
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
    // 描述是自由文本不是路径。漏了这个声明，权限层会把它当路径 resolve + 过 cwd 围栏，
    // 描述里带 `../` 的调用点了「本会话允许」之后仍会每轮重新弹框。
    expect(tool.specifierKind).toBe('opaque')
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
      onBackground: (desc) => (result) => { bgResult = { desc, result } },
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

  it('后台模式：onBackground 在启动时（而非完成时）被调用', async () => {
    let startedWith: string | null = null
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
      onBackground: (desc) => { startedWith = desc; return () => {} },
    })

    await tool.run(
      { prompt: 'bg task', description: 'start probe', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    // run() 一返回就该已经登记 —— 不 sleep，正是这条用例的意义（旧签名下这里必然是 null）。
    expect(startedWith).toBe('start probe')
  })

  it('后台模式：启动钩子 throw（并发上限）→ run 抛出，子代理不被放出去', async () => {
    let launched = false
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'should not run' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => client,
      settings: PERMISSIVE,
      // 探针放在 getSystemPrompt 而不是 getClient：getClient 是「构建 child client」的
      // 前置步骤，前台/后台两条路径都会先跑，早于后台分支，探不到「有没有放出去」。
      // getSystemPrompt 是 executeSubAgent try 内第一条受测试控制的语句，
      // 只要 executeSubAgent 被调用过就必然触发 —— 正是这条用例要否定的事。
      getSystemPrompt: () => { launched = true; return 'sys' },
      onBackground: () => { throw new Error('额度用完') },
    })

    await expect(
      tool.run(
        { prompt: 'bg task', description: 'over cap', runInBackground: true },
        { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
      ),
    ).rejects.toThrow('额度用完')

    await new Promise((r) => setTimeout(r, 30))
    expect(launched).toBe(false)
  })

  it('后台模式：子代理失败 → 结果回调收到失败文本', async () => {
    let got: string | null = null

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => fakeClient([]),
      settings: PERMISSIVE,
      // 失败注入点：getSystemPrompt 在 executeSubAgent 的 try 内被调用
      // （`const sysPrompt = deps.getSystemPrompt() + SUB_AGENT_SUFFIX`），
      // 抛出后被 catch 清理 worktree 再原样 rethrow → 后台 promise reject。
      getSystemPrompt: () => { throw new Error('boom') },
      onBackground: () => (result) => { got = result },
    })

    await tool.run(
      { prompt: 'bg task', description: 'fail probe', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(got).toBe('(sub-agent background execution failed)')
  })
})

/**
 * 会话级工具（绑在**父会话** sink 上的那些）绝不能进子代理的注册表。
 *
 * 真实缺陷：`TodoWrite` 的 `onUpdate` 绑的是父会话的 `setTodos`（sessionCapabilities.ts:62），
 * 而 buildChildRegistry 此前只跳过 `Agent`。于是子代理一调 TodoWrite，就把**用户正在看的**
 * 那份待办整份顶掉 —— 用户分的 3 组当场消失。`ScheduleWakeup` 同理（能给父会话排自唤醒、
 * 吃父会话额度）。
 *
 * 按 `sessionScoped` 标记排除，不按名字硬编：名字清单意味着第四个会话级工具出现时
 * 没人会想起来加那一行，而缺陷表现为「某个东西神秘地被子代理改掉」—— 最难查的那类。
 */
describe('子代理不继承会话级工具', () => {
  it('sessionScoped 的工具被排除，普通工具照常继承', async () => {
    const registry = new ToolRegistry()
    const seen: string[] = []
    const mk = (name: string, sessionScoped?: boolean): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      ...(sessionScoped ? { sessionScoped: true } : {}),
      async run() { seen.push(name); return { output: 'ok' } },
    })
    registry.register(mk('Read'))
    registry.register(mk('TodoWrite', true))
    registry.register(mk('ScheduleWakeup', true))

    const child = buildChildRegistry(registry, undefined)
    const names = child.list().map((t) => t.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('TodoWrite')
    expect(names).not.toContain('ScheduleWakeup')
  })
})
