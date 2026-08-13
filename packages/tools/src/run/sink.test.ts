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

/**
 * `firstChar` = 当前快照第一个字符在「**累计产生**」坐标系里的绝对位置。
 * 于是持有区间统一为 `[firstChar, firstChar + snapshot().length)`，
 * **两个方向的缺口各自可判**：前面缺 = `firstChar > 0`，后面缺 = 右端 < `totalChars`。
 *
 * 为什么需要它（步骤 5 spec §5.1）：两档丢字符的方向**相反** —— truncate 留最先来的、
 * ring 留最后来的。步骤 5 的 spec 初稿用 `totalChars - snapshot().length` 当「丢掉的前缀长度」，
 * 那个公式只对 ring 成立；在片段档下会把「尾部丢了」报成「开头丢了」，
 * **而内容索引恰好还是连续的**，所以「读到的对不对」那类测试全绿，模型却以为自己读完了。
 * 丢掉的恰恰是 output-cap 杀进程之前的收尾输出 —— 用户来问「它怎么了」时最要紧的那段。
 *
 * 不按 sink 种类在调用方 if/else：`policy.ts` 文件头明写这个类型「不许长出
 * `kind: 'snippet' | 'project'` 这种判别字段」。`firstChar` 是 sink 自己的性质，
 * 加在接口上，将来第三种 sink 自动正确。
 */
describe('firstChar —— 快照第一个字符的绝对位置', () => {
  it('TruncateSink 恒 0：它留的是**最先来的**，丢的是尾巴', () => {
    const s = new TruncateSink(5)
    expect(s.firstChar).toBe(0)
    s.push('abc')
    expect(s.firstChar).toBe(0)
    s.push('defgh')                        // 越过预算
    expect(s.firstChar).toBe(0)            // 开头一个字没丢
    expect(s.snapshot()).toBe('abcde')
    // 右端 5 < totalChars 8 —— 缺的是**后面**那 3 个字符
    expect(s.firstChar + s.snapshot().length).toBeLessThan(s.totalChars)
  })

  it('RingSink 随丢弃前进：它留的是**最后来的**，丢的是开头', () => {
    const s = new RingSink(5)
    expect(s.firstChar).toBe(0)
    s.push('abcdefgh')
    expect(s.firstChar).toBe(3)            // 'abc' 被丢了
    expect(s.snapshot()).toBe('defgh')
    // 右端 3+5=8 == totalChars —— 后面不缺，只缺前面
    expect(s.firstChar + s.snapshot().length).toBe(s.totalChars)
  })

  it('RingSink 容量 0：全丢，区间退化成空但仍自洽', () => {
    const s = new RingSink(0)
    s.push('abc')
    expect(s.firstChar).toBe(3)            // 三个字符全在「已丢弃」的前缀里
    expect(s.snapshot()).toBe('')
    expect(s.firstChar + s.snapshot().length).toBe(s.totalChars)
  })

  /** 没超过容量时两档必须一致 —— 否则读侧要按种类分支，正是 firstChar 要消灭的。 */
  it('未超容量时两档都是 0', () => {
    for (const s of [new TruncateSink(10), new RingSink(10)]) {
      s.push('abc'); s.push('de')
      expect(s.firstChar).toBe(0)
      expect(s.firstChar + s.snapshot().length).toBe(s.totalChars)
    }
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
