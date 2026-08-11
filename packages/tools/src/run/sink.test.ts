import { describe, expect, it } from 'vitest'
import { RingSink, TruncateSink } from './sink.js'

describe('TruncateSink（片段档）', () => {
  it('预算内：原样收，不溢出', () => {
    const s = new TruncateSink(10)
    s.push('abc'); s.push('de')
    expect(s.snapshot()).toBe('abcde')
    expect(s.totalChars).toBe(5)
    expect(s.overflowed).toBe(false)
  })

  /** 「满了就杀进程」是片段档的策略，而调用方只能靠这个信号知道该杀 —— StreamShaper
   *  给不出它（`totalChars` 是 private、`append()` 返回 void，truncate.ts:105/117）。 */
  it('越过预算：截到预算处、置 overflowed，让调用方去杀进程', () => {
    const s = new TruncateSink(5)
    s.push('abc'); s.push('defgh')
    expect(s.snapshot()).toBe('abcde')     // 只留预算内的
    expect(s.overflowed).toBe(true)
    expect(s.totalChars).toBe(8)           // 但**总数照实记**，UI 要能说「已产生 8 字符」
  })

  it('溢出之后继续 push：不再增长可见文本，但总数继续记', () => {
    const s = new TruncateSink(3)
    s.push('abcdef'); s.push('ghi')
    expect(s.snapshot()).toBe('abc')
    expect(s.totalChars).toBe(9)
    expect(s.overflowed).toBe(true)
  })

  it('恰好等于预算：不算溢出（边界是「越过」不是「达到」）', () => {
    const s = new TruncateSink(3)
    s.push('abc')
    expect(s.overflowed).toBe(false)
    expect(s.snapshot()).toBe('abc')
  })
})

describe('RingSink（项目档）', () => {
  /** 项目档要「环形缓冲 + 不杀」：dev server 跑一天，只保留最近一段，进程不能动。 */
  it('容量内：原样收', () => {
    const s = new RingSink(10)
    s.push('abc'); s.push('de')
    expect(s.snapshot()).toBe('abcde')
    expect(s.overflowed).toBe(false)       // ring 永不「溢出」—— 溢出的语义是「该杀了」
  })

  it('超容量：丢最旧的，留最近的，永不置 overflowed', () => {
    const s = new RingSink(5)
    s.push('abcdefgh')
    expect(s.snapshot()).toBe('defgh')
    expect(s.overflowed).toBe(false)
    expect(s.totalChars).toBe(8)
  })

  it('跨多次 push 的滚动窗口', () => {
    const s = new RingSink(4)
    s.push('ab'); s.push('cd'); s.push('ef')
    expect(s.snapshot()).toBe('cdef')
  })

  it('单次 push 就超过整个容量', () => {
    const s = new RingSink(3)
    s.push('abcdefghij')
    expect(s.snapshot()).toBe('hij')
  })

  it('容量 0：什么都不留，但不崩、总数照记', () => {
    const s = new RingSink(0)
    s.push('abc')
    expect(s.snapshot()).toBe('')
    expect(s.totalChars).toBe(3)
  })
})

describe('两档共用的接口形状', () => {
  /** run.ts 只按 OutputSink 编程，策略由 policy 决定注入哪一个。
   *  两档的接口若不一致，步骤 4 接项目档时 run.ts 要改 —— 那正是 v4 §1
   *  「机制只有一套、差异全落在策略参数上」要避免的。 */
  it('空 push 不改变任何东西', () => {
    for (const s of [new TruncateSink(5), new RingSink(5)]) {
      s.push('')
      expect(s.snapshot()).toBe('')
      expect(s.totalChars).toBe(0)
      expect(s.overflowed).toBe(false)
    }
  })
})
