import { describe, it, expect } from 'vitest'
import { SESSION_CAPABILITY_TOOLS, type SessionCapabilityContext } from './sessionCapabilities.js'
import { ToolRegistry, type ModelClient, type ResolvedSettings } from '@zuse/core'
import type { TodoItem } from '@zuse/tools'

function fakeCtx(over: Partial<SessionCapabilityContext> = {}): SessionCapabilityContext {
  return {
    registry: new ToolRegistry(),
    getClient: () => ({}) as unknown as ModelClient,
    getSystemPrompt: () => 'sys',
    settings: {} as unknown as ResolvedSettings,
    sessionAllow: [],
    canUseTool: async () => ({ behavior: 'allow' }) as never,
    setTodos: () => {},
    ...over,
  }
}

describe('SESSION_CAPABILITY_TOOLS —— 会话级工具清单', () => {
  it('产出 Agent 与 TodoWrite 两个工具，名字正确、顺序 Agent 在前', () => {
    const tools = SESSION_CAPABILITY_TOOLS.map((make) => make(fakeCtx()))
    expect(tools.map((t) => t.name)).toEqual(['Agent', 'TodoWrite'])
  })

  it('TodoWrite.onUpdate 透传到 ctx.setTodos', async () => {
    let got: TodoItem[] | undefined
    const ctx = fakeCtx({ setTodos: (todos) => { got = todos } })
    const todoTool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'TodoWrite')!
    await todoTool.run({ todos: [{ content: 'do x', status: 'pending' }] }, {} as never)
    expect(got).toEqual([{ content: 'do x', status: 'pending' }])
  })
})
