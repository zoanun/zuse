import { describe, it, expect } from 'vitest'
import { runStatusNote } from './statusNote.js'
import type { RunSummary } from './registry.js'

const row = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r1', command: 'x', label: undefined, cwd: 'E:/t', sessionId: 's1',
  status: 'exited', endReason: 'exit', exitCode: 0, startedAt: 0, orphaned: false, ...over,
})

/**
 * §8 说这是**本设计最可能失败的地方**：工具存在 ≠ 模型会用。
 * 真实时序是「用户点运行 → 失败 → 打字『修一下』」，模型此时必须自己想到去查。
 */
describe('runStatusNote', () => {
  it('没有值得提的 → null（不是空串，调用方靠它决定要不要追加）', () => {
    expect(runStatusNote([])).toBeNull()
    expect(runStatusNote([row({ status: 'exited', exitCode: 0 })])).toBeNull()
  })

  it('在跑的要提', () => {
    const n = runStatusNote([row({ status: 'running', exitCode: null })])
    expect(n).toContain('仍在运行')
    expect(n).toContain('RunOutput')
  })

  it('非零退出要提 —— 那正是用户要你修的东西', () => {
    const n = runStatusNote([row({ status: 'exited', exitCode: 1 })])
    expect(n).toContain('退出码 1')
  })

  /** 正常跑完的不提：提了只是噪声，还会把真正要看的那条淹掉。 */
  it('exit=0 的混在里面时被滤掉，只留该看的', () => {
    const n = runStatusNote([
      row({ id: 'ok', status: 'exited', exitCode: 0 }),
      row({ id: 'bad', status: 'exited', exitCode: 2 }),
    ])!
    expect(n).toContain('bad')
    expect(n).not.toContain('ok')
  })

  it('用 label，没有才回落到 command', () => {
    expect(runStatusNote([row({ status: 'running', exitCode: null, label: '用 uv 跑 Python' })]))
      .toContain('用 uv 跑 Python')
    expect(runStatusNote([row({ status: 'running', exitCode: null, command: 'node x.js' })]))
      .toContain('node x.js')
  })

  it('最多 3 条，超出的说清还有几条', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row({ id: `r${i}`, status: 'running', exitCode: null }))
    const n = runStatusNote(rows)!
    expect(n).toContain('另有 2 条未列出')
    expect(n.match(/^- /gm)).toHaveLength(3)
  })

  /** 输出可能是几十万字符，塞进每条用户消息既烧 token 又挤爆上下文。 */
  it('不含任何输出内容', () => {
    const n = runStatusNote([row({ status: 'running', exitCode: null })])!
    expect(n).not.toMatch(/stdout|stderr/)
  })

  it('zombie 说人话（它不是「已结束」）', () => {
    const n = runStatusNote([row({ status: 'zombie', endReason: 'zombie', exitCode: null })])!
    expect(n).toContain('杀不掉')
  })
})
