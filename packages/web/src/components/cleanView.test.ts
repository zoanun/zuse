import { describe, expect, it } from 'vitest'
import { filterForCleanView } from './cleanView.js'
import type { Message } from '../state/types.js'

const user = (id: string, text = 'q'): Message =>
  ({ id, role: 'user', parts: [{ kind: 'text', text }] })
const steer = (id: string, text = 's'): Message =>
  ({ id, role: 'user', parts: [{ kind: 'text', text }], steer: true })
const sys = (id: string, text = 'note'): Message =>
  ({ id, role: 'system', parts: [{ kind: 'text', text }], noticeKind: 'warn' })
/** 一条 assistant 消息的常态形状就是 [text, tool-use, tool-result] —— 见设计 §2.1a。 */
const asst = (id: string, text: string, withTool = false): Message => ({
  id, role: 'assistant',
  parts: [
    ...(text ? [{ kind: 'text' as const, text }] : []),
    ...(withTool ? [
      { kind: 'tool-use' as const, id: id + 't', name: 'Read', input: {} },
      { kind: 'tool-result' as const, id: id + 't', name: 'Read', output: 'x', isError: false },
    ] : []),
  ],
})

const kinds = (ms: Message[]) => ms.map((m) => `${m.role}:${m.parts.map((p) => p.kind).join('+') || '∅'}`)

describe('filterForCleanView', () => {
  it('未开启精简（调用方不用它）时不改任何东西 —— 这里只测开启后的行为', () => {
    // 占位说明：开关在渲染层，纯函数只负责"开启后长什么样"。
    expect(typeof filterForCleanView).toBe('function')
  })

  /**
   * **本设计最核心的一条**（§2.0）。
   *
   * reducer 的真实行为：text-delta / tool-use / tool-result 都追加到**最后一条** assistant
   * 消息上，然后 message-start 新建下一条。所以「本轮最后一条有正文的消息」在流式期间是
   * **非单调**的 —— 模型先说一句话（用户已经读到了），再追加工具调用、再开新消息，
   * 那一刻刚读到的正文就不再是"最后一条"，会当场从主画面消失。每调一次工具闪一次。
   *
   * 定案：**正在跑的那一轮完全不过滤**，跑完才收拢。
   */
  it('正在跑的那一轮：全量显示，工具卡片就在主画面', () => {
    const msgs = [user('u1'), asst('a1', '先看看文件', true), asst('a2', '')]
    expect(kinds(filterForCleanView(msgs, true))).toEqual([
      'user:text', 'assistant:text+tool-use+tool-result', 'assistant:∅',
    ])
  })

  it('同一份数据，thinking 变假 → 才收敛（这两条合起来才钉得住"不闪"）', () => {
    const msgs = [user('u1'), asst('a1', '先看看文件', true), asst('a2', '看完了，结论是 X')]
    expect(kinds(filterForCleanView(msgs, false))).toEqual(['user:text', 'assistant:text'])
    const kept = filterForCleanView(msgs, false)[1]!
    expect((kept.parts[0] as { text: string }).text).toBe('看完了，结论是 X')
  })

  it('一轮有多条 assistant 正文 → 只留最后一条有正文的', () => {
    const msgs = [user('u1'), asst('a1', '中间话'), asst('a2', '中间话2'), asst('a3', '最终答案')]
    const out = filterForCleanView(msgs, false)
    expect(out).toHaveLength(2)
    expect((out[1]!.parts[0] as { text: string }).text).toBe('最终答案')
  })

  /**
   * 兜底：一轮的**最后一条** assistant 消息可能只有工具、没有正文（被中断、纯工具收尾）。
   * 此时若机械地"取最后一条"，主画面上这一轮就只剩用户的问题 —— 看着像模型没回话。
   * 规则本身已经含了兜底：取的是「最后一条**有正文的**」，不是「最后一条」。
   */
  it('最后一条只有工具、没有正文 → 回退到更早那条有正文的，不留下空白轮次', () => {
    const msgs = [user('u1'), asst('a1', '我查到了 Y'), asst('a2', '', true)]
    const out = filterForCleanView(msgs, false)
    expect(out).toHaveLength(2)
    expect((out[1]!.parts[0] as { text: string }).text).toBe('我查到了 Y')
  })

  it('整轮一条正文都没有 → 该轮只剩用户消息（没得兜，但不能崩）', () => {
    const msgs = [user('u1'), asst('a1', '', true)]
    expect(kinds(filterForCleanView(msgs, false))).toEqual(['user:text'])
  })

  /**
   * 系统提示留在主画面：压缩、「已被用户中断」、失败警告都是**关于这次对话本身**的，
   * 不是模型的工作过程。刚修完图片解析静默就是为了让警告被看见，再收进抽屉等于又藏起来。
   */
  it('系统提示（警告 / 压缩摘要）留在主画面', () => {
    const msgs = [user('u1'), sys('s1'), asst('a1', '答案')]
    expect(kinds(filterForCleanView(msgs, false))).toEqual(['user:text', 'system:text', 'assistant:text'])
  })

  it('插话(steer) 保留，且不把一轮切成两轮', () => {
    // isTurnOpener：steer 是插话不是轮次边界。若误当边界，a1 会被当成"上一轮的最终答案"
    // 而 a2 变成新一轮的 —— 两条都留下，收敛就失效了。
    const msgs = [user('u1'), asst('a1', '中间话'), steer('s1'), asst('a2', '最终答案')]
    const out = filterForCleanView(msgs, false)
    expect(kinds(out)).toEqual(['user:text', 'user:text', 'assistant:text'])
    expect((out[2]!.parts[0] as { text: string }).text).toBe('最终答案')
  })

  it('多轮：每轮各自收敛，互不影响', () => {
    const msgs = [
      user('u1'), asst('a1', '中间'), asst('a2', '答案1'),
      user('u2'), asst('a3', '中间'), asst('a4', '答案2'),
    ]
    const out = filterForCleanView(msgs, false)
    expect(out.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['q', '答案1', 'q', '答案2'])
  })

  it('最后一轮在跑时，**前面已结束的轮次照常收敛**（只有在飞那轮免过滤）', () => {
    const msgs = [
      user('u1'), asst('a1', '中间'), asst('a2', '答案1'),
      user('u2'), asst('a3', '正在说', true),
    ]
    expect(kinds(filterForCleanView(msgs, true))).toEqual([
      'user:text', 'assistant:text', 'user:text', 'assistant:text+tool-use+tool-result',
    ])
  })

  it('返回的消息对象在无需改动时保持同一引用（memo 友好，不白掉渲染优化）', () => {
    const msgs = [user('u1'), asst('a1', '答案')]
    const out = filterForCleanView(msgs, false)
    expect(out[0]).toBe(msgs[0])   // user 原样
    expect(out[1]).toBe(msgs[1])   // 只有 text 部件，无需重建
  })
})
