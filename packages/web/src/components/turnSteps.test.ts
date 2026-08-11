import { describe, expect, it } from 'vitest'
import { turnStepsOf } from './turnSteps.js'
import { filterForCleanView } from './cleanView.js'
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
  it('没有工具的轮次 → 不出 tab（点开是空的 tab 属于骗人）', () => {
    expect(turnStepsOf([user('u1', '你好'), asst('a1', '你也好')])).toEqual([])
  })

  /**
   * 用户原话：「随便说几句话就很多很多 tab 了」。
   * 这条不靠额外的"简单轮次"启发式解决，而是分法自带的：正文全留主画面 → 纯聊天轮次
   * 的非 text 部件为零 → 不出 tab。**多轮纯聊天也一个 tab 都不出。**
   */
  it('连着聊好几轮、一次工具都没调 → 一个 tab 都不出', () => {
    const out = turnStepsOf([
      user('u1', '你好'), asst('a1', '你好，有什么可以帮你'),
      user('u2', '讲个笑话'), asst('a2', '从前有座山'),
      user('u3', '再来一个'), asst('a3', '山里有座庙'),
    ])
    expect(out).toEqual([])
  })

  it('一轮有工具 → 出一个 tab，标签带轮次序号与提问前若干字', () => {
    const out = turnStepsOf([user('u1', '帮我查一下这个文件里有什么东西'), asst('a1', '好的', 'Read'), asst('a2', '查完了')])
    expect(out).toHaveLength(1)
    expect(out[0]!.turnId).toBe('u1')          // 滚动锚点 = 该轮的用户提问
    expect(out[0]!.index).toBe(1)
    expect(out[0]!.label).toContain('帮我查一下')
  })

  /**
   * 连续追问常常前几个字一模一样，截太短就分不出是哪一轮 —— 竖排时代的 12 字上限
   * 会把下面这两条截成完全相同的标签。横排放得下更多字，上限提到 20。
   */
  it('标签够长，能分开前缀相同的连续追问', () => {
    const out = turnStepsOf([
      user('u1', '你给第一个改成全部完成'), asst('a1', '', 'TodoWrite'),
      user('u2', '你给第一个改成全部进行中'), asst('a2', '', 'TodoWrite'),
    ])
    expect(out[0]!.label).not.toBe(out[1]!.label)
  })

  /** 抽屉的价值就是「这一轮到底发生了什么」，按类型分区会打乱因果。 */
  it('多次工具调用按时间顺序排，不按类型分堆', () => {
    const out = turnStepsOf([
      user('u1', 'q'),
      asst('a1', '先看文件', 'Read'),
      asst('a2', '再跑个命令', 'Bash'),
      asst('a3', '结论'),
    ])
    expect(out[0]!.parts.map((p) => p.part.kind)).toEqual([
      'tool-use', 'tool-result', 'tool-use', 'tool-result',
    ])
    expect((out[0]!.parts[0]!.part as { name: string }).name).toBe('Read')
  })

  /**
   * **回归测试**：上一版把「不是最终回答的正文」也收进抽屉，结果在真实会话里
   * 把真正的答案（「善。日常工作组三事，皆已毕矣」）赶出了主画面。见 cleanView.ts 的说明。
   */
  it('正文一句都不进抽屉 —— 它们全在主画面', () => {
    const out = turnStepsOf([user('u1', 'q'), asst('a1', '中间话', 'Read'), asst('a2', '最终答案')])
    expect(out[0]!.parts.filter((p) => p.part.kind === 'text')).toHaveLength(0)
  })

  it('插话(steer) 不产生新 tab —— 它是插话不是轮次边界', () => {
    const out = turnStepsOf([
      user('u1', 'q1'), asst('a1', '中间', 'Read'), steer('s1', '等下'), asst('a2', '答案'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.index).toBe(1)
  })

  it('多轮：只有调过工具的出 tab，序号是轮次序号而非 tab 下标', () => {
    const out = turnStepsOf([
      user('u1', '第一问'), asst('a1', '中间', 'Read'), asst('a2', '答1'),
      user('u2', '第二问'), asst('a3', '答2'),                       // 没调工具 → 不出 tab
      user('u3', '第三问'), asst('a4', '中间', 'Bash'), asst('a5', '答3'),
    ])
    expect(out.map((t) => t.turnId)).toEqual(['u1', 'u3'])
    // 第三轮就该显示 3，否则点开跟主画面对不上号。
    expect(out.map((t) => t.index)).toEqual([1, 3])
  })

  it('系统提示不进抽屉（它留在主画面）', () => {
    const out = turnStepsOf([user('u1', 'q'), sys('s1'), asst('a1', '中间', 'Read'), asst('a2', '答')])
    expect(out[0]!.parts.every((p) => p.part.kind !== 'text')).toBe(true)
  })

  it('每个 part 带着它所属消息的 id（渲染要用它做 key，避免同名工具撞车）', () => {
    const out = turnStepsOf([user('u1', 'q'), asst('a1', '中间', 'Read'), asst('a2', '答')])
    expect(out[0]!.parts.every((p) => p.msgId === 'a1')).toBe(true)
  })

  /**
   * **两个函数的互补性 —— 这条是防信息黑洞的护栏。**
   *
   * 主画面（filterForCleanView）留下的部件 + 抽屉（turnStepsOf）收走的部件，
   * 必须正好等于原始部件全集。任何一边多加一条自己的判据，这里就会红。
   * 红了说明有部件**两边都没有** = 在界面上彻底消失，而用户不会知道自己少看了什么。
   */
  it('主画面留的 + 抽屉收的 = 全集：没有任何部件两边都不出现', () => {
    const msgs = [
      user('u1', 'q1'), asst('a1', '中间话', 'Read'), asst('a2', '答1'),
      user('u2', 'q2'), asst('a3', '', 'Bash'),
      user('u3', 'q3'), asst('a4', '纯聊天没工具'),
    ]
    const total = msgs.reduce((n, m) => n + m.parts.length, 0)
    const inMain = filterForCleanView(msgs).reduce((n, m) => n + m.parts.length, 0)
    const inDrawer = turnStepsOf(msgs).reduce((n, t) => n + t.parts.length, 0)
    expect(inMain + inDrawer).toBe(total)
  })
})
