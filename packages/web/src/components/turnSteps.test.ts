import { describe, expect, it } from 'vitest'
import { turnStepsOf } from './turnSteps.js'
import type { Message } from '../state/types.js'

const user = (id: string, text: string): Message => ({ id, role: 'user', parts: [{ kind: 'text', text }] })
const steer = (id: string, text: string): Message => ({ id, role: 'user', parts: [{ kind: 'text', text }], steer: true })
const sys = (id: string): Message => ({ id, role: 'system', parts: [{ kind: 'text', text: 'n' }], noticeKind: 'warn' })
const asst = (id: string, text: string, tool?: string): Message => ({
  id, role: 'assistant',
  parts: [
    ...(text ? [{ kind: 'text' as const, text }] : []),
    ...(tool ? [
      { kind: 'tool-use' as const, id: id + 't', name: tool, input: {} },
      { kind: 'tool-result' as const, id: id + 't', name: tool, output: 'o', isError: false },
    ] : []),
  ],
})

describe('turnStepsOf', () => {
  it('没有工具、也没有中间正文的轮次 → 不出 tab（点开是空的 tab 属于骗人）', () => {
    expect(turnStepsOf([user('u1', '你好'), asst('a1', '你也好')])).toEqual([])
  })

  it('一轮有工具 → 出一个 tab，标签带轮次序号与提问前若干字', () => {
    const out = turnStepsOf([user('u1', '帮我查一下这个文件里有什么东西'), asst('a1', '好的', 'Read'), asst('a2', '查完了')])
    expect(out).toHaveLength(1)
    expect(out[0]!.turnId).toBe('u1')          // 滚动锚点 = 该轮的用户提问
    expect(out[0]!.index).toBe(1)
    expect(out[0]!.label).toContain('帮我查一下')
  })

  /** 抽屉的价值就是「这一轮到底发生了什么」，按类型分区会打乱因果。 */
  it('步骤按时间顺序混排：中间正文与工具卡片交错，不按类型分堆', () => {
    const out = turnStepsOf([
      user('u1', 'q'),
      asst('a1', '先看文件', 'Read'),
      asst('a2', '再跑个命令', 'Bash'),
      asst('a3', '结论'),
    ])
    expect(out[0]!.parts.map((p) => p.part.kind)).toEqual([
      'text', 'tool-use', 'tool-result',
      'text', 'tool-use', 'tool-result',
    ])
    expect((out[0]!.parts[0]!.part as { text: string }).text).toBe('先看文件')
  })

  it('最终回答不进抽屉 —— 它在主画面上', () => {
    const out = turnStepsOf([user('u1', 'q'), asst('a1', '中间', 'Read'), asst('a2', '最终答案')])
    const texts = out[0]!.parts.filter((p) => p.part.kind === 'text').map((p) => (p.part as { text: string }).text)
    expect(texts).toEqual(['中间'])
    expect(texts).not.toContain('最终答案')
  })

  it('插话(steer) 不产生新 tab —— 它是插话不是轮次边界', () => {
    const out = turnStepsOf([
      user('u1', 'q1'), asst('a1', '中间', 'Read'), steer('s1', '等下'), asst('a2', '答案'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.index).toBe(1)
  })

  it('多轮：各自一个 tab，序号连续，顺序从旧到新（与主画面滚动方向一致）', () => {
    const out = turnStepsOf([
      user('u1', '第一问'), asst('a1', '中间', 'Read'), asst('a2', '答1'),
      user('u2', '第二问'), asst('a3', '答2'),                       // 无工具无中间正文 → 不出 tab
      user('u3', '第三问'), asst('a4', '中间', 'Bash'), asst('a5', '答3'),
    ])
    expect(out.map((t) => t.turnId)).toEqual(['u1', 'u3'])
    // 序号是**轮次序号**，不是 tab 的下标 —— 第三轮就该显示 3，否则点开跟主画面对不上。
    expect(out.map((t) => t.index)).toEqual([1, 3])
  })

  it('系统提示不进抽屉（它留在主画面）', () => {
    const out = turnStepsOf([user('u1', 'q'), sys('s1'), asst('a1', '中间', 'Read'), asst('a2', '答')])
    expect(out[0]!.parts.every((p) => p.part.kind !== 'text' || (p.part as { text: string }).text !== 'n')).toBe(true)
  })

  it('最后一条只有工具没正文 → 兜底保住的那条不算步骤，其余算', () => {
    // 与 cleanView 的兜底同一套：主画面留「最后一条有正文的」，抽屉收其余。
    const out = turnStepsOf([user('u1', 'q'), asst('a1', '我查到了 Y', 'Read'), asst('a2', '', 'Bash')])
    const texts = out[0]!.parts.filter((p) => p.part.kind === 'text')
    expect(texts).toHaveLength(0)                       // '我查到了 Y' 被兜底留在主画面
    expect(out[0]!.parts.filter((p) => p.part.kind === 'tool-use')).toHaveLength(2)
  })

  it('每个 part 带着它所属消息的 id（渲染要用它做 key，避免同名工具撞车）', () => {
    const out = turnStepsOf([user('u1', 'q'), asst('a1', '中间', 'Read'), asst('a2', '答')])
    expect(out[0]!.parts.every((p) => p.msgId === 'a1')).toBe(true)
  })
})
