import type { RunSummary } from './registry.js'

/** 最多列几条 —— 再多就是噪声，模型也不会挨个去读。 */
const MAX_ROWS = 3

/**
 * 「模型怎么知道该去看」（步骤 5 §8(b)）。
 *
 * ## 这是本设计最可能失败的地方
 *
 * 工具存在 ≠ 模型会用。真实时序是：用户点运行 → 失败 → 用户打字「修一下」→
 * 模型此时**必须自己想到**去调 `RunOutput`。想不到，功能等于没做。
 * 工具 description 里的引导（§8(a)）是零改动但不可靠的一半；这里是另一半。
 *
 * ## 只列「在跑的」和「非零退出的」
 *
 * 正常跑完（exit=0）的不提 —— 没什么要修的，提了只是噪声，还会把真正要看的那条淹掉。
 *
 * ## 不含输出
 *
 * 只给 id / 名字 / 状态 / 退出码。输出可能是几十万字符，塞进每一条用户消息里
 * 既烧 token 又把上下文挤爆 —— 要看输出是 `RunOutput` 的事，这里只负责让模型知道「有东西可看」。
 */
export function runStatusNote(rows: readonly RunSummary[]): string | null {
  // `zombie` 必须在里面 —— 我第一版漏了它，测试红出来的。
  // 它的语义是「信号发了、升级也发了，进程还活着」，正是最该让模型（和用户）知道的一种。
  const interesting = rows.filter(
    (r) => r.status === 'running' || r.status === 'killing' || r.status === 'zombie'
      || (r.exitCode !== null && r.exitCode !== 0),
  )
  if (interesting.length === 0) return null

  const shown = interesting.slice(0, MAX_ROWS)
  const lines = shown.map((r) => {
    const what = r.label ?? r.command
    const state = r.status === 'exited'
      ? `已结束，退出码 ${r.exitCode}`
      : r.status === 'zombie' ? '杀不掉，可能还在跑' : '仍在运行'
    return `- ${r.id}｜${what}｜${state}`
  })
  const more = interesting.length > shown.length ? `\n（另有 ${interesting.length - shown.length} 条未列出）` : ''
  return (
    '[本会话的后台命令现状]\n' +
    lines.join('\n') + more +
    '\n用 RunOutput 工具读它们的输出（负数 since 读末尾，通常就是你要的报错）。'
  )
}
