import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { RunRegistry } from './registry.js'
import type { RunDeps } from './run.js'
import { createRunOutputTool } from './runOutput.js'
import type { RunPolicy } from './policy.js'
import type { ShellChildProcess } from '../proc/spawn.js'
import type { ToolContext } from '@zuse/core'

afterEach(() => { vi.useRealTimers() })

const POLICY: RunPolicy = {
  wallClockMs: null, idleMs: null, killGraceMs: 50,
  onDetach: 'keep', sink: { kind: 'truncate', budget: 100_000 },
}

const ctx = {} as ToolContext

function harness() {
  const procs: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }> = []
  let pid = 1000
  const deps: RunDeps = {
    spawn: () => {
      const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
      p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = ++pid
      procs.push(p)
      return p as unknown as ShellChildProcess
    },
    killTree: () => {}, killTreeHard: () => {}, oemLabel: null,
  }
  const registry = new RunRegistry({ deps })
  const tool = createRunOutputTool({ registry, sessionId: 's1' })
  const start = (sessionId = 's1', label?: string) =>
    registry.start({ command: 'x', cwd: 'E:/tmp', sessionId, policy: POLICY, ...(label ? { label } : {}) })
  const feed = (i: number, s: 'stdout' | 'stderr', text: string) => {
    procs[i]![s].emit('data', Buffer.from(text, 'utf8'))
    vi.advanceTimersByTime(300)          // 让首窗定码
  }
  return { registry, tool, start, feed, procs }
}

const runTool = async (tool: ReturnType<typeof createRunOutputTool>, input: unknown) =>
  (await tool.run(input, ctx)).output

describe('RunOutput —— 列表', () => {
  it('没有 runId 时列出本会话的 run，用 label 而不是命令串', async () => {
    vi.useFakeTimers()
    const { tool, start } = harness()
    start('s1', '用 uv 跑 Python')
    const out = await runTool(tool, {})
    expect(out).toContain('用 uv 跑 Python')
  })

  it('一条都没有时说人话，不是空字符串', async () => {
    const { tool } = harness()
    expect(await runTool(tool, {})).toContain('还没有起过')
  })

  /** **会话隔离**：别的会话的 run 连列都不该列出来。 */
  it('别的会话的 run 不出现在列表里', async () => {
    vi.useFakeTimers()
    const { tool, start } = harness()
    const mine = start('s1', '我的')
    start('s2', '别人的')
    const out = await runTool(tool, {})
    expect(out).toContain(mine.id)
    expect(out).not.toContain('别人的')
  })
})

describe('RunOutput —— 会话隔离', () => {
  /**
   * 报「没有这个运行」而**不是**「无权访问」—— 后者会把「别的会话存在一个 id 为 X 的
   * run」这个事实泄露给模型，而模型的输出会进用户的聊天记录。
   */
  it('读别的会话的 runId → 报「没有这个运行」，不泄露它存在', async () => {
    vi.useFakeTimers()
    const { tool, start } = harness()
    const other = start('s2')
    const out = await runTool(tool, { runId: other.id })
    expect(out).toContain('没有这个运行')
    expect(out).not.toMatch(/无权|权限|forbidden/i)
  })

  it('压根不存在的 runId 落同一句话', async () => {
    const { tool } = harness()
    expect(await runTool(tool, { runId: 'nope' })).toContain('没有这个运行')
  })
})

describe('RunOutput —— 读取', () => {
  it('读到输出，并且 ANSI 被净化掉', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', '\u001b[32mhello\u001b[0m\n')
    const out = await runTool(tool, { runId: r.id })
    expect(out).toContain('hello')
    expect(out).not.toContain('\u001b')
  })

  it('两条流分别标出来', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', 'OUT')
    feed(0, 'stderr', 'ERR')
    const out = await runTool(tool, { runId: r.id })
    expect(out).toContain('stdout')
    expect(out).toContain('OUT')
    expect(out).toContain('stderr')
    expect(out).toContain('ERR')
  })

  it('只要一条流时不带另一条', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', 'OUT')
    feed(0, 'stderr', 'ERR')
    const out = await runTool(tool, { runId: r.id, stream: 'err' })
    expect(out).toContain('ERR')
    expect(out).not.toContain('OUT')
  })

  /** 负数 since 是模型 90% 的实际需求（「看看它报了什么错」）。 */
  it('负数 since = 读末尾', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', 'A'.repeat(50) + 'TAIL')
    const out = await runTool(tool, { runId: r.id, since: -4, stream: 'out' })
    expect(out).toContain('TAIL')
    expect(out).not.toContain('A'.repeat(50))
  })

  it('nextSince 传回来能接着读，不重复不遗漏', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', 'abcdefghij')
    const first = await runTool(tool, { runId: r.id, stream: 'out', since: 0 })
    const m = /nextSince=(\{[^}]*\})/.exec(first)
    expect(m).not.toBeNull()
    const ns = JSON.parse(m![1]!) as { out: number }
    expect(ns.out).toBe(10)
    const second = await runTool(tool, { runId: r.id, stream: 'out', since: ns.out })
    expect(second).toContain('暂无新输出')
  })

  it('还有没读完的会明说，并让模型把 nextSince 传回来', async () => {
    vi.useFakeTimers()
    const { tool, start, feed } = harness()
    const r = start()
    feed(0, 'stdout', 'X'.repeat(40_000))     // 超过单次 30k 上限
    const out = await runTool(tool, { runId: r.id, stream: 'out', since: 0 })
    expect(out).toMatch(/还有 \d+ 字符未读/)
    expect(out).toContain('nextSince')
  })

  it('状态里说清「仍在运行」还是「已结束」', async () => {
    vi.useFakeTimers()
    const { tool, start, feed, procs } = harness()
    const r = start()
    feed(0, 'stdout', 'hi')
    expect(await runTool(tool, { runId: r.id })).toContain('仍在运行')
    procs[0]!.emit('close', 0)
    expect(await runTool(tool, { runId: r.id })).toContain('已结束')
  })
})

describe('RunOutput —— 工具面元数据', () => {
  it('只读、可并发、会话级', () => {
    const { tool } = harness()
    expect(tool.readOnly).toBe(true)
    expect(tool.parallelizable).toBe(true)
    // 会话级：它绑的是**创建它的那个会话**的 run 视图，绝不能被子代理继承。
    expect(tool.sessionScoped).toBe(true)
  })
})
