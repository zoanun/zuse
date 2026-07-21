import { describe, it, expect } from 'vitest'
import { runAgent, isRunawayRepetition } from './agent.js'
import { Conversation } from './conversation.js'
import { ToolRegistry, type Tool, type ToolDefinition } from './tool.js'
import type { ModelClient } from './model-client.js'
import type { Message, StreamEvent, Usage } from './types.js'
import type { ResolvedSettings, PermissionVerdict } from './types.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

/**
 * 一个脚本化的 ModelClient：每次调用返回下一组预设好的事件列表。
 * 记录它收到的消息，好让我们断言 tool_result 的回喂。
 */
function fakeClient(scripts: StreamEvent[][]): { client: ModelClient; calls: Message[][]; toolsCalls: Array<ToolDefinition[] | undefined> } {
  const calls: Message[][] = []
  const toolsCalls: Array<ToolDefinition[] | undefined> = []
  let i = 0
  const client: ModelClient = {
    getModel: () => 'fake',
    async *sendMessages(messages, _config, tools) {
      calls.push(messages)
      toolsCalls.push(tools ? [...tools] : undefined)
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
  return { client, calls, toolsCalls }
}

function echoTool(): Tool {
  return {
    name: 'echo',
    description: 'echo input',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    run: async (input: unknown) => ({ output: `echoed:${(input as { value: string }).value}` }),
  }
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

function abortingClient(controller: AbortController, pre: StreamEvent[]): ModelClient {
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      for (const e of pre) yield e
      controller.abort()
      yield { type: 'error', message: 'aborted' }
    },
  }
}

describe('runAgent', () => {
  const config = { model: 'fake', max_tokens: 100 }
  const signal = new AbortController().signal

  it('commits a plain text turn (no tools)', async () => {
    const { client } = fakeClient([
      [
        { type: 'text-delta', text: 'hello' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'hi',
        config,
        cwd: '.',
        signal,
      }),
    )

    const msgs = conv.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
    expect(conv.totalUsage).toEqual({ ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('runs a tool, feeds the result back, and loops to a final answer', async () => {
    const { client, calls } = fakeClient([
      // 回合 1：模型请求调用 echo 工具
      [
        { type: 'tool-use', id: 'call_1', name: 'echo', input: { value: 'x' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      // 回合 2：模型用工具结果作答
      [
        { type: 'text-delta', text: 'done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    const events = await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
      }),
    )

    // 产生了一个带工具输出的 tool-result 事件
    const toolResult = events.find((e) => e.type === 'tool-result')
    expect(toolResult).toEqual({
      type: 'tool-result',
      id: 'call_1',
      name: 'echo',
      output: 'echoed:x',
      is_error: false,
    })

    // 第 2 次模型调用看到了作为 user 消息回喂的 tool_result
    expect(calls).toHaveLength(2)
    const secondCall = calls[1]!
    const lastSent = secondCall[secondCall.length - 1]!
    expect(lastSent.role).toBe('user')
    expect(lastSent.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'echoed:x',
      is_error: false,
    })

    // 账本：user、assistant(tool_use)、user(tool_result)、assistant(text) = 4 条
    expect(conv.getMessages()).toHaveLength(4)
    // 用量在两个回合间累加
    expect(conv.totalUsage).toEqual({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })

  it('runs multiple read-only tools concurrently in one turn', async () => {
    // 屏障证明并发：r1 开始后阻塞,直到 r2 开始才放行。
    // 串行执行下 r1 会先整体跑完（race 200ms 超时）才轮到 r2,
    // 于是 'r2:start' 落在 'r1:end' 之后 —— 断言失败。
    const order: string[] = []
    let r2Started!: () => void
    const r2StartedP = new Promise<void>((res) => { r2Started = res })
    const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

    const reg = new ToolRegistry()
    reg.register({
      name: 'r1', description: '', readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        order.push('r1:start')
        await Promise.race([r2StartedP, delay(200)])
        order.push('r1:end')
        return { output: 'out1' }
      },
    })
    reg.register({
      name: 'r2', description: '', readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        order.push('r2:start')
        r2Started()
        order.push('r2:end')
        return { output: 'out2' }
      },
    })

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'a', name: 'r1', input: {} },
        { type: 'tool-use', id: 'b', name: 'r2', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])

    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    }))

    // 并发证据：r2 在 r1 结束之前就已经开始。
    expect(order.indexOf('r2:start')).toBeLessThan(order.indexOf('r1:end'))
    // 两个工具结果都按各自 id 回喂了。
    const results = events.filter((e) => e.type === 'tool-result') as Array<{ id: string; output: string }>
    expect(results.map((r) => `${r.id}:${r.output}`).sort()).toEqual(['a:out1', 'b:out2'])
  })

  it('runs multiple parallelizable tools concurrently though they are not read-only', async () => {
    // Agent (sub-agent) is parallelizable but NOT readOnly. A barrier proves concurrency:
    // a1 blocks until a2 starts; serial execution would put 'a2:start' after 'a1:end'.
    const order: string[] = []
    let secondStarted!: () => void
    const secondStartedP = new Promise<void>((res) => { secondStarted = res })
    const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

    const reg = new ToolRegistry()
    reg.register({
      name: 'Agent', description: '', parallelizable: true, // not readOnly, but parallel-safe
      inputSchema: { type: 'object', properties: {} },
      run: async (input) => {
        const n = (input as { n?: number }).n
        if (n === 1) {
          order.push('a1:start')
          await Promise.race([secondStartedP, delay(200)])
          order.push('a1:end')
          return { output: 'r1' }
        }
        order.push('a2:start')
        secondStarted()
        order.push('a2:end')
        return { output: 'r2' }
      },
    })

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'a', name: 'Agent', input: { n: 1 } },
        { type: 'tool-use', id: 'b', name: 'Agent', input: { n: 2 } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])

    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
    }))

    expect(order.indexOf('a2:start')).toBeLessThan(order.indexOf('a1:end'))
    const results = events.filter((e) => e.type === 'tool-result') as Array<{ id: string; output: string }>
    expect(results.map((r) => `${r.id}:${r.output}`).sort()).toEqual(['a:r1', 'b:r2'])
  })

  it('aborts a turn that degenerates into runaway repetition (keeps the turn, truncates output)', async () => {
    const { client } = fakeClient([
      [
        // one big delta of pure repetition — the guard fires on the next check and breaks
        { type: 'text-delta', text: '测过了！'.repeat(1500) },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const conv = new Conversation()
    const events = await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'go', config, cwd: '.', signal,
    }))
    const warn = events.find((e) => e.type === 'warning' && /repetition/i.test((e as { message: string }).message))
    expect(warn).toBeDefined()
    // The turn is PRESERVED, not discarded: the user message must survive (else the user's
    // question vanishes), and the assistant reply is kept but truncated with a marker so the
    // degenerate tail isn't fed back next turn.
    const msgs = conv.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.role).toBe('assistant')
    const assistantText = msgs[1]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(assistantText).toContain('[output truncated: runaway repetition detected]')
    expect(assistantText.length).toBeLessThan('测过了！'.repeat(1500).length) // tail trimmed off
  })

  describe('isRunawayRepetition', () => {
    it('flags a short unit repeated for a long span', () => {
      expect(isRunawayRepetition('测过了！'.repeat(1500))).toBe(true)
      expect(isRunawayRepetition('ok '.repeat(2000))).toBe(true)
    })
    it('does not flag varied long text', () => {
      const varied = Array.from({ length: 1000 }, (_, i) => `step ${i}: do thing ${i * 7}\n`).join('')
      expect(varied.length).toBeGreaterThan(4000)
      expect(isRunawayRepetition(varied)).toBe(false)
    })
    it('does not flag short output even if repetitive', () => {
      expect(isRunawayRepetition('ab'.repeat(100))).toBe(false) // below the min-length gate
    })
    it('ignores whitespace-only runs (indentation/newlines)', () => {
      expect(isRunawayRepetition(' '.repeat(8000))).toBe(false)
      expect(isRunawayRepetition('\n'.repeat(8000))).toBe(false)
    })
  })

  it('runs concurrent ask prompts on read-only tools without deadlock', async () => {
    // 契约:canUseTool 实现必须支持并发调用（多个未兑现 promise 同时在飞）。
    // TUI 用权限队列满足之;本测试的实现直接并发応答。断言两个只读工具的 ask
    // 同时在飞(maxInFlight=2)且都完成 —— 锁住「并发 ask 不死锁」。
    // 历史:旧实现用单例 resolver,并发第二个 ask 会覆盖第一个的 resolve,
    // Promise.all 永不 settle;当时靠 agent.ts 的 wouldAsk 预检退串行绕开,
    // 权限队列落地后兜底已删,本测试取而代之。
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const canUseTool = async (): Promise<PermissionVerdict> => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((res) => setTimeout(res, 10))
      inFlight--
      return 'allow'
    }

    const reg = new ToolRegistry()
    for (const name of ['r1', 'r2']) {
      reg.register({
        name, description: '', readOnly: true,
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ output: name }),
      })
    }
    const askSettings: ResolvedSettings = {
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: ['r1', 'r2'], deny: [] },
      providers: {},
    }

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'a', name: 'r1', input: {} },
        { type: 'tool-use', id: 'b', name: 'r2', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])

    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool,
    }))

    // 两个 ask 都被问到且同时在飞 —— 不再退串行,也不死锁。
    expect(calls).toBe(2)
    expect(maxInFlight).toBe(2)
    // 两个工具结果仍按各自 id 回喂。
    const results = events.filter((e) => e.type === 'tool-result') as Array<{ id: string; output: string }>
    expect(results.map((r) => `${r.id}:${r.output}`).sort()).toEqual(['a:r1', 'b:r2'])
  })

  it('marks unknown tools as errors (fault mode ④) and still feeds them back', async () => {
    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'c1', name: 'nope', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    const reg = new ToolRegistry()

    const events = await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
      }),
    )
    const tr = events.find((e) => e.type === 'tool-result') as { is_error: boolean; output: string }
    expect(tr.is_error).toBe(true)
    // 错误回传契约(Phase 8):报未知工具时列出可用工具清单,模型才能自纠工具名。
    expect(tr.output).toContain('未知工具:nope')
    expect(tr.output).toContain('可用工具:')
  })

  it('unknown tool error lists the registered tool names', async () => {
    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'c1', name: 'read_file', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const reg = new ToolRegistry()
    reg.register(echoTool())

    const events = await collect(
      runAgent({
        conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      }),
    )
    const tr = events.find((e) => e.type === 'tool-result') as { output: string }
    expect(tr.output).toContain('echo')
  })

  it('does not commit anything when the model call errors', async () => {
    const { client } = fakeClient([[{ type: 'error', message: 'boom' }]])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'hi',
        config,
        cwd: '.',
        signal,
      }),
    )
    expect(conv.getMessages()).toHaveLength(0)
  })

  it('stops at maxTurns and keeps the ledger role-valid', async () => {
    // 总是请求工具 -> 没有上限就会永远循环下去。
    const loopScript: StreamEvent[] = [
      { type: 'tool-use', id: 'c', name: 'echo', input: { value: 'x' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const { client } = fakeClient([loopScript, loopScript, loopScript])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    const events = await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        maxTurns: 2,
      }),
    )
    expect(events.some((e) => e.type === 'warning')).toBe(true)
    const msgs = conv.getMessages()
    // 最后一条必须是 assistant（合成的收尾消息），以保证角色交替合法。
    expect(msgs[msgs.length - 1]!.role).toBe('assistant')
  })

  it('maxTurns stop message uses forceful CRITICAL text', async () => {
    const loopScript: StreamEvent[] = [
      { type: 'tool-use', id: 'c', name: 'echo', input: { value: 'x' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const { client } = fakeClient([loopScript, loopScript, loopScript])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        maxTurns: 2,
      }),
    )
    const msgs = conv.getMessages()
    const lastMsg = msgs[msgs.length - 1]!
    const text = lastMsg.content[0]!
    expect(text).toHaveProperty('type', 'text')
    if (text.type === 'text') {
      expect(text.text).toContain('CRITICAL')
      expect(text.text).toContain('Do NOT attempt any more tool calls')
    }
  })

  // ——— Phase 11 故障注入 ———

  it('坏 JSON tool_use（invalid_args）：不执行工具，合成 is_error 回喂，循环继续', async () => {
    let ran = false
    const reg = new ToolRegistry()
    reg.register({ ...echoTool(), run: async () => { ran = true; return { output: 'should-not' } } })
    const { client, calls } = fakeClient([
      [
        { type: 'tool-use', id: 'c1', name: 'echo', input: {}, invalid_args: '{"value":' },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    const events = await collect(
      runAgent({ conversation: conv, client, registry: reg, userText: 'go', config, cwd: '.', signal }),
    )

    expect(ran).toBe(false) // 绝不空参运行
    const tr = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
    expect(tr.is_error).toBe(true)
    expect(tr.output).toContain('不是合法 JSON')
    expect(tr.output).toContain('{"value":') // 回显原始串
    expect(tr.output).toContain('重新发起') // 下一步指令

    // 第二次模型调用看到了回喂的 tool_result；账本 4 条且角色合法。
    expect(calls).toHaveLength(2)
    const msgs = conv.getMessages()
    expect(msgs).toHaveLength(4)
    expect(msgs[1]!.content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'echo', input: {} })
    expect(msgs[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: true })
  })

  it('同轮一个坏 JSON 一个合法调用：合法的照常执行，不连坐', async () => {
    const reg = new ToolRegistry()
    reg.register(echoTool())
    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'bad', name: 'echo', input: {}, invalid_args: 'oops' },
        { type: 'tool-use', id: 'ok', name: 'echo', input: { value: 'x' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const events = await collect(
      runAgent({ conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal }),
    )
    const results = events.filter((e): e is Extract<StreamEvent, { type: 'tool-result' }> => e.type === 'tool-result')
    expect(results.find((r) => r.id === 'bad')!.is_error).toBe(true)
    expect(results.find((r) => r.id === 'ok')).toMatchObject({ output: 'echoed:x', is_error: false })
  })

  it('stop_reason=max_tokens：产出截断告警，半截回复仍提交但用户可见告警', async () => {
    const { client } = fakeClient([
      [
        { type: 'text-delta', text: 'half' },
        { type: 'message-stop', stop_reason: 'max_tokens', usage: USAGE },
      ],
    ])
    const conv = new Conversation()
    const events = await collect(
      runAgent({ conversation: conv, client, registry: new ToolRegistry(), userText: 'hi', config, cwd: '.', signal }),
    )
    const warn = events.find((e) => e.type === 'warning') as Extract<StreamEvent, { type: 'warning' }>
    expect(warn.message).toContain('max_tokens')
    expect(conv.getMessages()).toHaveLength(2) // 半截文本不是悬空账本，照常提交
  })

  it('signal 已中断：产出 Interrupted 告警，模型零调用、账本零提交', async () => {
    const ac = new AbortController()
    ac.abort()
    const { client, calls } = fakeClient([
      [{ type: 'text-delta', text: 'never' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    const events = await collect(
      runAgent({ conversation: conv, client, registry: new ToolRegistry(), userText: 'hi', config, cwd: '.', signal: ac.signal }),
    )
    expect(events).toEqual([{ type: 'warning', message: 'Interrupted.' }])
    expect(calls).toHaveLength(0)
    expect(conv.getMessages()).toHaveLength(0)
  })

  it('中途中断（纯文本）保留提问+半截文本+标记', async () => {
    const controller = new AbortController()
    const client = abortingClient(controller, [
      { type: 'message-start', id: 'm1', model: 'fake' },
      { type: 'text-delta', text: 'half answer' },
    ])
    const conv = new Conversation()
    await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'q', config, cwd: '.', signal: controller.signal,
    }))
    const msgs = conv.getMessages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1]!.content).toEqual([{ type: 'text', text: 'half answer' }])
    expect(msgs[2]!.content).toEqual([{ type: 'text', text: '[Request interrupted by user]' }])
  })

  it('中途中断（tool_use 已发、未执行）合成"已中断"结果 + for-tool-use 标记', async () => {
    const controller = new AbortController()
    const client = abortingClient(controller, [
      { type: 'message-start', id: 'm1', model: 'fake' },
      { type: 'text-delta', text: 'let me' },
      { type: 'tool-use', id: 't1', name: 'echo', input: { value: 'x' } },
    ])
    const conv = new Conversation()
    const reg = new ToolRegistry(); reg.register(echoTool())
    await collect(runAgent({
      conversation: conv, client, registry: reg, userText: 'q', config, cwd: '.', signal: controller.signal,
    }))
    const msgs = conv.getMessages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1]!.content).toEqual([
      { type: 'text', text: 'let me' },
      { type: 'tool_use', id: 't1', name: 'echo', input: { value: 'x' } },
    ])
    expect(msgs[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '[Tool interrupted by user]', is_error: true },
      { type: 'text', text: '[Request interrupted by user for tool use]' },
    ])
  })

  it('啥都没生成就中断 → 不提交（rewind 交给上层）', async () => {
    const controller = new AbortController()
    const client = abortingClient(controller, [])
    const conv = new Conversation()
    await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'q', config, cwd: '.', signal: controller.signal,
    }))
    expect(conv.getMessages()).toHaveLength(0)
  })

  it('工具步完成后于回合边界中断 → 提交该步 + 纯文本标记', async () => {
    const controller = new AbortController()
    const abortEcho: Tool = {
      name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} },
      run: async () => { controller.abort(); return { output: 'done' } },
    }
    const client = fakeClient([[
      { type: 'message-start', id: 'm1', model: 'fake' },
      { type: 'tool-use', id: 't1', name: 'echo', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]]).client
    const conv = new Conversation()
    const reg = new ToolRegistry(); reg.register(abortEcho)
    await collect(runAgent({
      conversation: conv, client, registry: reg, userText: 'q', config, cwd: '.', signal: controller.signal,
    }))
    const msgs = conv.getMessages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(msgs[2]!.content.some((b) => b.type === 'tool_result' && b.content === 'done')).toBe(true)
    expect(msgs[3]!.content).toEqual([{ type: 'text', text: '[Request interrupted by user]' }])
  })

  const askSettings: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: ['echo'], deny: [] },
    providers: {},
  }

  function askScript(): StreamEvent[][] {
    return [
      [
        { type: 'tool-use', id: 'c1', name: 'echo', input: { value: 'x' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ]
  }

  it('deny synthesizes an error result and does NOT run the tool', async () => {
    let ran = false
    const reg = new ToolRegistry()
    reg.register({ ...echoTool(), run: async () => { ran = true; return { output: 'should-not' } } })
    const denySettings: ResolvedSettings = {
      tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: ['echo'] }, providers: {},
    }
    const { client } = fakeClient(askScript())
    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: denySettings,
    }))
    expect(ran).toBe(false)
    const tr = events.find((e) => e.type === 'tool-result') as { is_error: boolean; output: string }
    expect(tr.is_error).toBe(true)
    // 错误回传契约(Phase 8):settings deny 是硬护栏,要点明"别原样重试"与改法。
    expect(tr.output).toContain('不要重试')
    expect(tr.output).toContain('echo')
  })

  it('ask → canUseTool deny blocks; allow runs', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const { client } = fakeClient(askScript())
    const denied = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool: async () => 'deny',
    }))
    const deniedTr = denied.find((e) => e.type === 'tool-result') as { is_error?: boolean; output: string }
    expect(deniedTr.is_error).toBe(true)
    // 错误回传契约(Phase 8):用户拒绝是本次裁决,下一步是问用户,而非原样重发。
    expect(deniedTr.output).toContain('用户拒绝')
    expect(deniedTr.output).toContain('请询问用户')

    const { client: client2 } = fakeClient(askScript())
    const allowed = await collect(runAgent({
      conversation: new Conversation(), client: client2, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool: async () => 'allow',
    }))
    expect((allowed.find((e) => e.type === 'tool-result') as { output?: string }).output).toBe('echoed:x')
  })

  it('no canUseTool → ask defaults to deny', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const { client } = fakeClient(askScript())
    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings,
    }))
    expect((events.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)
  })

  it('allow_session suppresses re-ask in the same session (no disk write)', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const sessionAllow: string[] = []
    let writes = 0
    const scripts: StreamEvent[][] = [
      [{ type: 'tool-use', id: 'a', name: 'echo', input: { value: '1' } }, { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE }],
      [{ type: 'tool-use', id: 'b', name: 'echo', input: { value: '2' } }, { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE }],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ]
    const { client } = fakeClient(scripts)
    let asked = 0
    const canUseTool = async (): Promise<PermissionVerdict> => { asked++; return 'allow_session' }
    await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool, sessionAllow, onPersistAllow: () => { writes++ },
    }))
    expect(asked).toBe(1)
    expect(sessionAllow).toContain('echo')
    expect(writes).toBe(0)
  })

  it('allow_persist triggers a disk write', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const sessionAllow: string[] = []
    const persisted: string[] = []
    const { client } = fakeClient(askScript())
    await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool: async () => 'allow_persist',
      sessionAllow, onPersistAllow: (rule) => persisted.push(rule),
    }))
    expect(persisted).toEqual(['echo'])
    expect(sessionAllow).toContain('echo')
  })

  it('picks up tools registered mid-loop (dynamic toolDefs)', async () => {
    const turn1: StreamEvent[] = [
      { type: 'tool-use', id: 'a', name: 'echo', input: { value: 'first' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const turn2: StreamEvent[] = [
      { type: 'tool-use', id: 'b', name: 'late', input: { value: 'hi' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ]
    const turn3: StreamEvent[] = [
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ]
    const { client, toolsCalls } = fakeClient([turn1, turn2, turn3])
    const conv = new Conversation()
    const reg = new ToolRegistry()
    reg.register(echoTool())

    const lateTool = {
      name: 'late',
      description: 'A late-registered tool',
      inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } }, required: ['value'] },
      async run(input: unknown) {
        return { output: `late: ${(input as { value: string }).value}` }
      },
    }

    const events: StreamEvent[] = []
    let firstToolDone = false
    for await (const event of runAgent({
      conversation: conv,
      client,
      registry: reg,
      userText: 'test dynamic',
      config,
      cwd: '.',
      signal,
    })) {
      events.push(event)
      if (event.type === 'tool-result' && !firstToolDone) {
        firstToolDone = true
        reg.register(lateTool)
      }
    }

    // The late tool result should succeed (execution uses live registry).
    const lateResult = events.find(
      (e) => e.type === 'tool-result' && e.name === 'late',
    )
    expect(lateResult).toBeTruthy()
    if (lateResult && lateResult.type === 'tool-result') {
      expect(lateResult.is_error).toBe(false)
      expect(lateResult.output).toContain('late: hi')
    }

    // Critical: the model's second call must include the 'late' tool definition.
    // If toolDefs is read only once (outside the loop), turn 2 still sends the
    // stale list without 'late'. Moving toolDefs inside the loop fixes this.
    expect(toolsCalls.length).toBeGreaterThanOrEqual(2)
    const turn2Tools = toolsCalls[1]!
    expect(turn2Tools.some((t) => t.name === 'late')).toBe(true)
  })

  it('injects steer text into the last tool result', async () => {
    let steerCalls = 0
    const consumeSteer = (): string | null => {
      steerCalls++
      return steerCalls === 1 ? 'skip test files' : null
    }

    const reg = new ToolRegistry()
    reg.register(echoTool())

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'c1', name: 'echo', input: { value: 'a' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'ok' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const conv = new Conversation()
    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        consumeSteer,
      }),
    )

    // The steer injection goes into staged messages (conversation), not yielded events.
    const msgs = conv.getMessages()
    // msgs: user, assistant(tool_use), user(tool_result), assistant(text) = 4
    const toolResultMsg = msgs[2]!
    expect(toolResultMsg.role).toBe('user')
    const lastBlock = toolResultMsg.content[toolResultMsg.content.length - 1]!
    expect(lastBlock.type).toBe('tool_result')
    if (lastBlock.type === 'tool_result') {
      expect(lastBlock.content).toContain('[USER MESSAGE')
      expect(lastBlock.content).toContain('skip test files')
    }
    // The fold is ALSO recorded structurally on the carrier message, so the snapshot projector can
    // identify + strip it by exact text without sniffing content.
    expect(toolResultMsg.steer).toEqual(['skip test files'])
  })

  it('does not inject when consumeSteer returns null', async () => {
    const consumeSteer = (): string | null => null

    const reg = new ToolRegistry()
    reg.register(echoTool())

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'c1', name: 'echo', input: { value: 'a' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [
        { type: 'text-delta', text: 'ok' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const conv = new Conversation()
    await collect(
      runAgent({
        conversation: conv,
        client,
        registry: reg,
        userText: 'go',
        config,
        cwd: '.',
        signal,
        consumeSteer,
      }),
    )

    const msgs = conv.getMessages()
    const toolResultMsg = msgs[2]!
    expect(toolResultMsg.role).toBe('user')
    const lastBlock = toolResultMsg.content[toolResultMsg.content.length - 1]!
    expect(lastBlock.type).toBe('tool_result')
    if (lastBlock.type === 'tool_result') {
      expect(lastBlock.content).not.toContain('[USER MESSAGE')
    }
  })

  // ——— I2 图片直传：expandAttachments 钩子 + userAttachments ———

  // 钩子实现：把任何带 attachments 的消息 content 前插一个 image 块（读盘→base64 的模拟）。
  // 返回新副本，绝不 mutate 入参消息/其 content 数组。
  const expandStub = async (messages: Message[]): Promise<Message[]> =>
    messages.map((m) =>
      m.attachments && m.attachments.length > 0
        ? {
            ...m,
            content: [
              ...m.attachments.map((att) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, mediaType: att.mediaType, data: 'BASE64' },
              })),
              ...m.content,
            ],
          }
        : m,
    )

  it('expandAttachments hook injects image blocks into the outbound copy without mutating the ledger', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    // 账本里一条 user 消息只带 attachments 引用（不含 base64）。
    conv.append({
      role: 'user',
      content: [{ type: 'text', text: 'look at this' }],
      attachments: [{ id: 'a', name: 'x.png', mediaType: 'image/png' }],
    })

    await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'go', config, cwd: '.', signal,
      expandAttachments: expandStub,
    }))

    // 假 client 收到的那条 user 消息含展开的 image 块（在原 text 块之前）。
    const sent = calls[0]!
    const seeded = sent[0]!
    expect(seeded.content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'BASE64' } })
    expect(seeded.content[1]).toEqual({ type: 'text', text: 'look at this' })

    // 原 conversation 未被 mutate：该消息 content 仍只有原 text 块、无 image。
    const msgs = conv.getMessages()
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'look at this' }])
    expect(msgs[0]!.content.some((b) => b.type === 'image')).toBe(false)
  })

  it('without expandAttachments, attachment-bearing messages are sent verbatim (no image block, no error)', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    conv.append({
      role: 'user',
      content: [{ type: 'text', text: 'look' }],
      attachments: [{ id: 'a', name: 'x.png', mediaType: 'image/png' }],
    })

    await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'go', config, cwd: '.', signal,
    }))

    const sent = calls[0]!
    expect(sent[0]!.content).toEqual([{ type: 'text', text: 'look' }])
    expect(sent.every((m) => m.content.every((b) => b.type !== 'image'))).toBe(true)
  })

  it('userAttachments ride the staged current-turn user message (ledger stays text-only; expanded for the model)', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const conv = new Conversation()
    const userAttachments = [{ id: 'u1', name: 'shot.png', mediaType: 'image/png' }]

    await collect(runAgent({
      conversation: conv, client, registry: new ToolRegistry(), userText: 'describe', config, cwd: '.', signal,
      userAttachments, expandAttachments: expandStub,
    }))

    // 账本：当前回合 user 消息带该 attachments 引用，但 content 仍只有 text（无 base64/image）。
    const msgs = conv.getMessages()
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.attachments).toEqual(userAttachments)
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'describe' }])

    // 通过钩子间接断言：模型看到的当前回合 user 消息含展开出的 image 块。
    const sent = calls[0]!
    expect(sent[0]!.content[0]).toEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'BASE64' } })
  })

  it('disabled tool is denied even if the model calls it', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const s: ResolvedSettings = { tools: { disabled: ['echo'] }, permissions: askSettings.permissions, providers: {} }
    const { client } = fakeClient(askScript())
    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: s, canUseTool: async () => 'allow',
    }))
    expect((events.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)
  })
})
