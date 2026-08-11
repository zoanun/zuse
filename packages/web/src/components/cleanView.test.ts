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
const texts = (ms: Message[]) => ms.flatMap((m) => m.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text))

describe('filterForCleanView', () => {
  /**
   * **本文件最重要的一条 —— 这是一个回归测试，钉住一个真发生过的数据丢失。**
   *
   * 旧规则是「一轮只留最后一条有正文的 assistant 消息」。它在真实会话里是这么翻车的
   * （`~/.zuse/web-sessions/20260811-140454-8615dfef.json` 第 26~39 条原文）：
   *
   *   用户：第二个，也改成全部完成
   *   #29 ：善。日常工作组三事，皆已毕矣 …   ← 真正的回答
   *   #31~37：我将执行 pwd 命令来查看当前工作目录。（模型顺手验证了几次 cwd）
   *   #39 ：当前工作目录为 /e/ai-study/zuse   ← 旧规则只留这条
   *
   * 于是用户问「改成全部完成」，主画面答「当前工作目录为 …」。
   * **"哪句是最终回答"没有可靠判据** —— 模型给完答案再顺手跑条命令收尾是 agent 的常态形状。
   * 所以规则改成：正文一句不删，只收工具卡片。多几句碎碎念远好过丢掉答案。
   */
  it('答案在前、模型顺手又跑了几条命令 → 答案必须还在主画面', () => {
    const msgs = [
      user('u1', '第二个，也改成全部完成'),
      asst('a1', '善。日常工作组三事，皆已毕矣', true),
      asst('a2', '我将执行 pwd 命令来查看当前工作目录。', true),
      asst('a3', '当前工作目录为 /e/ai-study/zuse'),
    ]
    expect(texts(filterForCleanView(msgs))).toContain('善。日常工作组三事，皆已毕矣')
  })

  it('工具调用与结果收进抽屉，正文原样留下', () => {
    const msgs = [user('u1'), asst('a1', '先看看文件', true), asst('a2', '看完了，结论是 X')]
    expect(kinds(filterForCleanView(msgs))).toEqual(['user:text', 'assistant:text', 'assistant:text'])
  })

  /**
   * 规则与轮次、与「是否正在跑」都**无关**了，这是它比旧规则强的地方：
   * 旧规则要靠 `thinking` 兜住「流式期间最后一条非单调 → 刚读到的正文当场消失」；
   * 新规则里 text 部件只增不减，天然不会闪，因此不再需要那个参数（少一个能传错的东西）。
   */
  it('一轮多条正文 → 全部保留（不再挑"最终答案"）', () => {
    const msgs = [user('u1'), asst('a1', '中间话'), asst('a2', '中间话2'), asst('a3', '最终答案')]
    expect(texts(filterForCleanView(msgs))).toEqual(['q', '中间话', '中间话2', '最终答案'])
  })

  it('assistant 消息只有工具、没有正文 → 整条不显示（空壳子不占地方）', () => {
    const msgs = [user('u1'), asst('a1', '我查到了 Y'), asst('a2', '', true)]
    expect(kinds(filterForCleanView(msgs))).toEqual(['user:text', 'assistant:text'])
  })

  it('整轮一条正文都没有 → 该轮只剩用户消息（不能崩）', () => {
    expect(kinds(filterForCleanView([user('u1'), asst('a1', '', true)]))).toEqual(['user:text'])
  })

  /**
   * 系统提示留在主画面：压缩、「已被用户中断」、图片解析失败警告都是**关于这次对话本身**的，
   * 不是模型的工作过程。刚修完图片解析静默就是为了让警告被看见，再收进抽屉等于又藏起来。
   */
  it('系统提示（警告 / 压缩摘要）留在主画面', () => {
    const msgs = [user('u1'), sys('s1'), asst('a1', '答案')]
    expect(kinds(filterForCleanView(msgs))).toEqual(['user:text', 'system:text', 'assistant:text'])
  })

  it('插话(steer) 保留', () => {
    const msgs = [user('u1'), asst('a1', '中间话'), steer('s1'), asst('a2', '最终答案')]
    expect(kinds(filterForCleanView(msgs))).toEqual(['user:text', 'assistant:text', 'user:text', 'assistant:text'])
  })

  it('返回的消息对象在无需改动时保持同一引用（memo 友好，不白掉渲染优化）', () => {
    const msgs = [user('u1'), asst('a1', '答案')]
    const out = filterForCleanView(msgs)
    expect(out[0]).toBe(msgs[0])   // user 原样
    expect(out[1]).toBe(msgs[1])   // 只有 text 部件，无需重建
  })

  /**
   * 与 `turnStepsOf` 的**互补性**：主画面留下的 + 抽屉收走的 = 原始部件全集，一个不多一个不少。
   * 两边各写一套判据必然漂移，漂移的表现就是「某个东西两边都没有」—— 界面上彻底消失。
   */
  it('主画面留下的 text 部件数 + 抽屉收走的部件数 = 总部件数（不丢不重）', () => {
    const msgs = [user('u1'), asst('a1', '中间', true), asst('a2', '答案', true)]
    const total = msgs.reduce((n, m) => n + m.parts.length, 0)
    const kept = filterForCleanView(msgs).reduce((n, m) => n + m.parts.length, 0)
    const dropped = msgs.reduce((n, m) => n + m.parts.filter((p) => p.kind !== 'text').length, 0)
    expect(kept + dropped).toBe(total)
  })
})
