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
    onAutoAllow: () => {},
    setTodos: () => {},
    scheduleWakeup: () => true,
    startBackgroundAgent: () => () => {},
    ...over,
  }
}

describe('SESSION_CAPABILITY_TOOLS —— 会话级工具清单', () => {
  it('产出 Agent / TodoWrite / ScheduleWakeup 三个工具，名字正确、顺序 Agent 在前', () => {
    const tools = SESSION_CAPABILITY_TOOLS.map((make) => make(fakeCtx()))
    expect(tools.map((t) => t.name)).toEqual(['Agent', 'TodoWrite', 'ScheduleWakeup'])
  })

  it('TodoWrite.onUpdate 透传到 ctx.setTodos', async () => {
    let got: TodoItem[] | undefined
    const ctx = fakeCtx({ setTodos: (todos) => { got = todos } })
    const todoTool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'TodoWrite')!
    await todoTool.run({ todos: [{ content: 'do x', status: 'pending' }] }, {} as never)
    expect(got).toEqual([{ content: 'do x', status: 'pending' }])
  })

  it('ScheduleWakeup.onSchedule 透传到 ctx.scheduleWakeup(秒 → 毫秒)', async () => {
    const calls: Array<[number, string]> = []
    const ctx = fakeCtx({ scheduleWakeup: (ms, msg) => { calls.push([ms, msg]); return true } })
    const tool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'ScheduleWakeup')!
    const r = await tool.run({ delaySeconds: 30, message: '看 CI' }, {} as never)
    expect(calls).toEqual([[30_000, '看 CI']])
    expect(r.isError).toBeFalsy()
  })

  it('被 deadline 拒绝时如实抛错（core 的 runOneTool 会转成 isError 回喂模型，不会打断回合）', async () => {
    const ctx = fakeCtx({ scheduleWakeup: () => false })
    const tool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'ScheduleWakeup')!
    await expect(tool.run({ delaySeconds: 30, message: 'x' }, {} as never)).rejects.toThrow(/额度|上限/)
  })

  // 这条守的是 B1 唯一的接线点。没有它，把上面那行映射删回 `createAgentTool(ctx)`
  // （= 后台子代理退回同步阻塞跑完，正是 B1 要修的 bug）时全套测试依然全绿：
  // onBackground 是可选字段，typecheck 不报，SessionManager 的用例又都直接调
  // mgr.startBackgroundAgent 绕过了清单。实测过 187 条全绿。
  it('Agent.onBackground 透传到 ctx.startBackgroundAgent（run_in_background 立即返回 ack）', async () => {
    const started: string[] = []
    const ctx = fakeCtx({ startBackgroundAgent: (desc) => { started.push(desc); return () => {} } })
    const tool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'Agent')!

    const r = await tool.run(
      { prompt: 'p', description: '后台活儿', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } } as never,
    )

    // 启动钩子必须在 run() 返回前就被调用（否则会话看不见「有子代理在飞」）。
    expect(started).toEqual(['后台活儿'])
    expect(r.output).toContain('launched in background')
  })

  it('并发上限的 throw 从能力面一路冒到工具外（不被吞掉）', async () => {
    const ctx = fakeCtx({ startBackgroundAgent: () => { throw new Error('本会话已有 5 个后台 Agent 在跑') } })
    const tool = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx)).find((t) => t.name === 'Agent')!
    await expect(
      tool.run(
        { prompt: 'p', description: 'x', runInBackground: true },
        { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } } as never,
      ),
    ).rejects.toThrow(/5 个后台 Agent/)
  })
})
