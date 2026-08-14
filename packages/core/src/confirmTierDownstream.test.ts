import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from './agent.js'
import { Conversation } from './conversation.js'
import { ToolRegistry, type Tool } from './tool.js'
import type { ModelClient } from './model-client.js'
import type { ResolvedSettings, StreamEvent, Usage, PermissionVerdict } from './types.js'

/**
 * **UI 藏按钮拦不住这条路。**
 *
 * 协议层只校验 verdict 是四个字面量之一，任何客户端（web / TUI / devPage 里那个纯 JS
 * 界面 / 直接发 WS 的脚本）都能送 `allow_persist` 上来。如果照单全收，写下去的是一条
 * **永远不生效**的规则 —— `sessionAllow` 只并进 `decide()` 的第 4 步 allow，
 * 而「必须确认」档在 3.2 就返回了。下次照样弹框、没有任何提示，规则还永久留在盘上。
 *
 * 那正是本仓最恨的失败形状（「配了、看得见、没生效、没提示」）。
 * **兜底必须在服务端。** 这两条测的就是它。
 */

const USAGE: Usage = { input_tokens: 1, output_tokens: 1 }
const TARGET = join(homedir(), '.zuse', 'SYSTEM.md')

function writeTool(): Tool {
  return {
    name: 'Write',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    specifierFor: (input: unknown) => (input as { path?: string }).path ?? null,
    run: async () => ({ output: 'written' }),
  }
}

function scriptedClient(): ModelClient {
  const scripts: StreamEvent[][] = [
    [
      { type: 'tool-use', id: 'a', name: 'Write', input: { path: TARGET } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ]
  let i = 0
  return { getModel: () => 'fake', async *sendMessages() { for (const e of scripts[i++] ?? []) yield e } }
}

function settings(): ResolvedSettings {
  return {
    tools: {}, providers: {},
    // 本仓自己就有这条 —— 正是当初把内建 ask 压掉的那一条。
    permissions: { defaultMode: 'default', allow: ['Write(./**)'], ask: [], deny: [] },
  } as ResolvedSettings
}

async function run(verdict: PermissionVerdict): Promise<{ sessionAllow: string[]; persisted: string[] }> {
  const reg = new ToolRegistry()
  reg.register(writeTool())
  const sessionAllow: string[] = []
  const persisted: string[] = []
  for await (const _e of runAgent({
    conversation: new Conversation(),
    client: scriptedClient(),
    registry: reg,
    userText: 'go',
    config: { model: 'fake', max_tokens: 100 },
    cwd: process.cwd(),
    signal: new AbortController().signal,
    settings: settings(),
    canUseTool: async () => verdict,
    sessionAllow,
    onPersistAllow: (r) => persisted.push(r),
  })) { void _e }
  return { sessionAllow, persisted }
}

describe('必须确认档：持久化 verdict 必须在服务端被降级', () => {
  it('客户端送 allow_persist → 放行这一次，但**不落盘、不进会话覆盖层**', async () => {
    const { sessionAllow, persisted } = await run('allow_persist')
    expect(persisted, '落盘了一条永远不会生效的规则').toEqual([])
    expect(sessionAllow, '进了会话覆盖层 —— 但那只在第 4 步生效，等于写了条死规则').toEqual([])
  })

  it('客户端送 allow_session → 同样不进会话覆盖层', async () => {
    const { sessionAllow, persisted } = await run('allow_session')
    expect(persisted).toEqual([])
    expect(sessionAllow).toEqual([])
  })

  it('对照：不在这一档的调用，allow_persist 照常落盘（别把正常路径也堵了）', async () => {
    const reg = new ToolRegistry()
    reg.register(writeTool())
    const sessionAllow: string[] = []
    const persisted: string[] = []
    const scripts: StreamEvent[][] = [
      [
        { type: 'tool-use', id: 'a', name: 'Write', input: { path: '/tmp/whatever.txt' } },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ]
    let i = 0
    const client: ModelClient = {
      getModel: () => 'fake',
      async *sendMessages() { for (const e of scripts[i++] ?? []) yield e },
    }
    // 用一个不含 Write(./**) 的配置，让 /tmp 那条落到 ask 上。
    const s = {
      tools: {}, providers: {},
      permissions: { defaultMode: 'default', allow: [], ask: ['Write(**)'], deny: [] },
    } as ResolvedSettings
    for await (const _e of runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go',
      config: { model: 'fake', max_tokens: 100 }, cwd: process.cwd(),
      signal: new AbortController().signal, settings: s,
      canUseTool: async () => 'allow_persist',
      sessionAllow, onPersistAllow: (r) => persisted.push(r),
    })) { void _e }
    expect(persisted).toHaveLength(1)
    expect(sessionAllow).toHaveLength(1)
  })
})
