import { describe, it, expect } from 'vitest'
import { runStatusNote } from '@zuse/tools'
import type { RunSummary } from '@zuse/tools'

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: 'r', command: 'x', cwd: '.', sessionId: 's', status: 'running',
  label: undefined, endReason: null, exitCode: null, startedAt: 0, orphaned: false,
  ...over,
} as RunSummary)

/**
 * **§8(b) 的另一半：回合中插话那条路。**
 *
 * 正常提交走 `expandAttachments`（`createSession` 里包的 `expandWithRunStatus`）挂上
 * 后台运行现状。而**插话**是折进 tool_result 的，完全不经过那个通路 ——
 * 于是「后台 dev server 挂了 → 你插一句『修一下』」这个**最需要现状的场景**，
 * 恰恰是唯一拿不到它的。这条欠账 spec 里写着（`2026-08-13-run-as-tool-step5-design.md`
 * §8 末尾「记为欠账；要补就在 consumeSteer 那侧再接一次」），本轮补上。
 *
 * 这里钉的是**拼接契约**：note 贴在插话文本后面、且只贴在发给模型的那一份上。
 * 真正的接线在 `SessionManager` 的 `consumeSteer` 闭包里，端到端由既有的 run 测试覆盖。
 */
describe('插话要带上后台运行现状', () => {
  const rows = [
    run({ id: 'r1', label: 'pnpm dev', status: 'running' }),
    run({ id: 'r2', label: 'build', status: 'exited', exitCode: 1 }),
  ]

  it('有值得提的 run → note 非空，且带着标签', () => {
    const note = runStatusNote(rows)
    expect(note).not.toBeNull()
    expect(note!).toContain('pnpm dev')
  })

  it('拼接形态：插话文本在前，现状在后，中间空一行', () => {
    const combined = '修一下'
    const note = runStatusNote(rows)!
    const sent = `${combined}\n\n${note}`
    expect(sent.startsWith('修一下')).toBe(true)
    expect(sent).toContain(`\n\n${note}`)
  })

  /**
   * 全部正常跑完的不提 —— 提了只是噪声，还会把真正出问题的那条淹掉。
   * 这一条同时保证「没有 run 的会话」不会因为这次改动多出一段空白。
   */
  it('没有值得提的 → null，插话原样发出去', () => {
    const ok = [run({ id: 'r3', label: 'test', status: 'exited', exitCode: 0 })]
    expect(runStatusNote(ok)).toBeNull()
    expect(runStatusNote([])).toBeNull()
  })
})
