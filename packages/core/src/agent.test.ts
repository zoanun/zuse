import { describe, it, expect } from 'vitest'
import { runAgent } from './agent.js'
import { Conversation } from './conversation.js'
import { ToolRegistry, type Tool } from './tool.js'
import type { ModelClient } from './model-client.js'
import type { Message, StreamEvent, Usage } from './types.js'
import type { ResolvedSettings, PermissionVerdict } from './types.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

/**
 * 一个脚本化的 ModelClient：每次调用返回下一组预设好的事件列表。
 * 记录它收到的消息，好让我们断言 tool_result 的回喂。
 */
function fakeClient(scripts: StreamEvent[][]): { client: ModelClient; calls: Message[][] } {
  const calls: Message[][] = []
  let i = 0
  const client: ModelClient = {
    getModel: () => 'fake',
    async *sendMessages(messages) {
      calls.push(messages)
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
  return { client, calls }
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
    expect(conv.totalUsage).toEqual(USAGE)
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
    expect(conv.totalUsage).toEqual({ input_tokens: 20, output_tokens: 10 })
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
    const tr = events.find((e) => e.type === 'tool-result')
    expect(tr).toMatchObject({ is_error: true, output: 'Unknown tool: nope' })
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

  const askSettings: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: ['echo'], deny: [] },
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
      tools: {}, permissions: { defaultMode: 'default', allow: [], ask: [], deny: ['echo'] },
    }
    const { client } = fakeClient(askScript())
    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: denySettings,
    }))
    expect(ran).toBe(false)
    const tr = events.find((e) => e.type === 'tool-result')
    expect(tr).toMatchObject({ is_error: true })
  })

  it('ask → canUseTool deny blocks; allow runs', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const { client } = fakeClient(askScript())
    const denied = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool: async () => 'deny',
    }))
    expect((denied.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)

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

  it('disabled tool is denied even if the model calls it', async () => {
    const reg = new ToolRegistry(); reg.register(echoTool())
    const s: ResolvedSettings = { tools: { disabled: ['echo'] }, permissions: askSettings.permissions }
    const { client } = fakeClient(askScript())
    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: s, canUseTool: async () => 'allow',
    }))
    expect((events.find((e) => e.type === 'tool-result') as { is_error?: boolean }).is_error).toBe(true)
  })
})
