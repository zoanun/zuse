import { describe, it, expect } from 'vitest'
import {
  shouldConsolidateMemories,
  buildConsolidationPrompt,
  parseConsolidationOps,
  CONSOLIDATION_MAX_DELETES,
  effectiveConsolidationWatermark,
} from './memory-consolidation.js'

describe('shouldConsolidateMemories(触发门槛)', () => {
  const NOW = Date.parse('2026-06-12T12:00:00Z')

  it('投影体积不足上限 70% 不触发', () => {
    expect(
      shouldConsolidateMemories({ projectionChars: 3000, indexCap: 8000, lastRunAt: null, now: NOW }),
    ).toBe(false)
  })

  it('体积够 + 从未巩固过 → 触发', () => {
    expect(
      shouldConsolidateMemories({ projectionChars: 6000, indexCap: 8000, lastRunAt: null, now: NOW }),
    ).toBe(true)
  })

  it('距上次不足 24h 不触发(防抖);超过则触发', () => {
    expect(
      shouldConsolidateMemories({
        projectionChars: 6000, indexCap: 8000,
        lastRunAt: '2026-06-12T01:00:00Z', now: NOW, // 11h 前
      }),
    ).toBe(false)
    expect(
      shouldConsolidateMemories({
        projectionChars: 6000, indexCap: 8000,
        lastRunAt: '2026-06-10T12:00:00Z', now: NOW, // 2 天前
      }),
    ).toBe(true)
  })
})

describe('buildConsolidationPrompt', () => {
  it('清单含 id/类型/归属/日期/要点/内容与操作协议', () => {
    const prompt = buildConsolidationPrompt([
      { id: 3, type: 'user', content: '偏好中文', hook: '中文', project: '', createdAt: '2026-06-01T08:00:00Z' },
      { id: 7, type: 'project', content: '用 pnpm', hook: '', project: 'E--p-12345678', createdAt: '2026-06-02T08:00:00Z' },
    ])
    expect(prompt).toContain('[3] (user, global, 2026-06-01) hook:中文 content:偏好中文')
    expect(prompt).toContain('[7] (project, E--p-12345678, 2026-06-02) content:用 pnpm')
    expect(prompt).toContain('DELETE <id>')
    expect(prompt).toContain('SAVE <type>|')
    expect(prompt).toContain('NOOP')
  })
})

describe('parseConsolidationOps', () => {
  it('解析 DELETE 与 SAVE 行,忽略其他行,DELETE 去重', () => {
    const ops = parseConsolidationOps(
      'SAVE user|合并要点|合并后的完整内容\nDELETE 3\n这行是废话\nDELETE 7\nDELETE 3\nNOOP',
    )
    expect(ops.saves).toEqual([{ type: 'user', hook: '合并要点', content: '合并后的完整内容' }])
    expect(ops.deletes).toEqual([3, 7])
  })

  it('NOOP / 空输出 → 空操作', () => {
    expect(parseConsolidationOps('NOOP')).toEqual({ deletes: [], saves: [] })
    expect(parseConsolidationOps('')).toEqual({ deletes: [], saves: [] })
  })

  it('DELETE 超过安全帽整体放弃(防模型跑飞清空记忆库)', () => {
    const lines = Array.from({ length: CONSOLIDATION_MAX_DELETES + 1 }, (_, i) => `DELETE ${i + 1}`)
    expect(parseConsolidationOps(lines.join('\n'))).toEqual({ deletes: [], saves: [] })
  })

  it('坏 type 的 SAVE 行忽略', () => {
    expect(parseConsolidationOps('SAVE banana|x|y').saves).toEqual([])
  })
})

/**
 * **拒绝必须留下水位。** 触发判据是「投影 ≥ 阈值」，而拒绝不会让投影变小 ——
 * 只记「跑过」的话，越过阈值那天起用户每 24h 被问一次、**永远问下去**，
 * 而唯一「让它闭嘴」的按钮（「始终」）对这一档是空操作（confirm 在 allow 之前返回）。
 */
describe('拒绝之后不该每天再问', () => {
  const cap = 8000
  const over = cap // 稳稳超过 0.7 阈值
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  it('只被拒绝过（从没跑过）→ 24h 内不再问', () => {
    const wm = effectiveConsolidationWatermark(null, iso(60_000))
    expect(shouldConsolidateMemories({ projectionChars: over, indexCap: cap, lastRunAt: wm })).toBe(false)
  })

  it('拒绝比上次跑更晚 → 以拒绝时间为准', () => {
    const wm = effectiveConsolidationWatermark(iso(72 * 3600_000), iso(60_000))
    expect(shouldConsolidateMemories({ projectionChars: over, indexCap: cap, lastRunAt: wm })).toBe(false)
  })

  it('拒绝过很久了 → 可以再问一次（不是永久闭嘴）', () => {
    const wm = effectiveConsolidationWatermark(null, iso(72 * 3600_000))
    expect(shouldConsolidateMemories({ projectionChars: over, indexCap: cap, lastRunAt: wm })).toBe(true)
  })

  it('两个都没有 → null（首次）', () => {
    expect(effectiveConsolidationWatermark(null, null)).toBe(null)
  })

  it('坏时间戳当没有，不参与比较', () => {
    expect(effectiveConsolidationWatermark('不是时间', null)).toBe(null)
  })
})
