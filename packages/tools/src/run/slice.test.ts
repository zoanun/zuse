import { describe, it, expect } from 'vitest'
import { sliceStream, splitBudget } from './slice.js'
import { sanitizeTerminalText } from '@zuse/protocol'

const base = (over: Partial<Parameters<typeof sliceStream>[0]> = {}) => ({
  text: 'abcdefghij', firstChar: 0, totalChars: 10, since: 0, limit: 100, ended: false, ...over,
})

describe('起点：负数 / 越界', () => {
  it('负数 = 从末尾往前数', () => {
    expect(sliceStream(base({ since: -3 })).raw).toBe('hij')
  })

  it('负得超过总长 → 归一到 0，不报错', () => {
    expect(sliceStream(base({ since: -999999 })).raw).toBe('abcdefghij')
  })

  it('起点超过已产生的总长 → 空片段，不抛', () => {
    const r = sliceStream(base({ since: 999 }))
    expect(r.raw).toBe('')
    expect(r.nextSince).toBe(10)
  })

  /** 起点落在**已被丢弃**的区间里（ring 档丢了前缀）→ 要如实报「前面没了多少」。 */
  it('起点早于持有区间 → droppedBefore 报出缺口', () => {
    const r = sliceStream({ text: 'fghij', firstChar: 5, totalChars: 10, since: 0, limit: 100, ended: false })
    expect(r.droppedBefore).toBe(5)
    expect(r.raw).toBe('fghij')
    expect(r.from).toBe(5)
  })
})

/**
 * §5.5 的三条边界规则。它们守的是同一件事：**切点不能把一条 CSI 劈成两半**，
 * 否则前半在净化时被当「半截」丢掉，后半（如 `1m`）当正文漏进模型看到的文本。
 */
describe('规则 (a)：右边界收回', () => {
  it('limit 正好切在 CSI 中间 → 收回到序列开头，下一段从序列头接上', () => {
    //          0123    4..8      9
    const text = 'abcd\x1b[31mZ'
    const r = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 0, limit: 6, ended: false })
    expect(r.raw).toBe('abcd')            // 不含半截 \x1b[3
    expect(r.nextSince).toBe(4)           // 下一段正好从 \x1b 开始
    const next = sliceStream({ text, firstChar: 0, totalChars: text.length, since: r.nextSince, limit: 100, ended: false })
    expect(sanitizeTerminalText(next.raw)).toBe('Z')
  })

  it('切点不在序列中间时不动它', () => {
    expect(sliceStream(base({ limit: 4 })).nextSince).toBe(4)
  })
})

describe('规则 (b)：收回会导致空区间时前伸', () => {
  it('整段就是一条序列的开头 → 前伸到序列结束', () => {
    const text = '\x1b[31mRED'
    const r = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 0, limit: 3, ended: false })
    expect(r.nextSince).toBeGreaterThan(0)     // 必须前进，否则死循环
    expect(r.raw.endsWith('m')).toBe(true)     // 前伸到了序列结束
  })

  /**
   * **进程死在半截序列上**：最后三个字符就是 `\x1b[3`，之后再也不会有输出。
   * 写成「前伸到序列结束」而序列没结束时，游标永远停在原地、
   * 尾部提示永远说「还有 3 字符未读」，**模型对着一个已 exited 的 run 无限轮询**。
   */
  /**
   * 这条我第一版**断言写错了**：以为该一次冲到 5。
   * 实际正确行为是先收回到 2（给出 'ok'），下一次再把那截没写完的序列消费掉 ——
   * 前伸只在「收回会得到空区间」时才发生，这里收回后还有内容可给。
   *
   * **真正要守的性质不是某个具体数字，是「游标一定前进、最终到底」** ——
   * 卡死才是那个失效模式。所以改成断言这个性质。
   */
  it('序列在持有区间里没结束 → 游标仍然前进，且后续能走到底（不卡死）', () => {
    const text = 'ok\x1b[3'
    const r1 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 0, limit: 3, ended: false })
    expect(r1.nextSince).toBeGreaterThan(0)
    expect(sanitizeTerminalText(r1.raw)).toBe('ok')
    const r2 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: r1.nextSince, limit: 100, ended: false })
    expect(r2.nextSince).toBe(text.length)          // 走到底了
    expect(sanitizeTerminalText(r2.raw)).toBe('')   // 半截序列不当正文漏出去
  })

  it('进程已结束时，末尾半截序列直接消费掉，游标推到底', () => {
    const text = 'ok\x1b[3'
    const r = sliceStream({ text, firstChar: 0, totalChars: text.length, since: text.length - 3, limit: 0, ended: true })
    expect(r.nextSince).toBe(text.length)
  })
})

describe('规则 (c)：起点往回看', () => {
  /**
   * 模型可以传任意负数，归纳链就断了 —— 起点可能正好落在一条 CSI 中间。
   * 往回扫找到它、把起点前推到序列结束。
   */
  it('起点落在 CSI 中间 → 前推到序列结束，不把半截当正文', () => {
    const text = 'abc\x1b[31mRED'
    // 起点 5 落在 `\x1b[31m` 内部
    const r = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 5, limit: 100, ended: false })
    expect(r.raw).toBe('RED')
    expect(r.from).toBe(8)
  })

  /**
   * **绝不能反过来「把开头那截孤儿序列尾巴剥掉」。** 那条判据
   * （`^[0-9;?]*[ -/]*[@-~]`）里 `[@-~]` 囊括全部字母，实测 6/7 的正常文本
   * 会被吃掉第一个字符。这几条就是那张实测表里的反例。
   */
  it('正常文本的第一个字符一个都不许吃', () => {
    for (const s of [
      'Traceback (most recent call last):',
      'ERROR: build failed',
      'main.py", line 7',
      '  at Object.<anonymous>',
      '2026-08-13 10:27 build ok',
    ]) {
      const r = sliceStream({ text: s, firstChar: 0, totalChars: s.length, since: 0, limit: 100, ended: false })
      expect(r.raw, `「${s}」被吃掉了开头`).toBe(s)
    }
  })
})

/**
 * §5.6 的已知代价：**分段净化 ≠ 整份净化**（`\r` 的作用域是整行，跨读取边界抹不掉）。
 *
 * **不许**断言「两段拼起来 == 整份净化」—— 那条按字面写必然红，而实现者为了让它绿
 * 会挑一份不含 `\r` 的夹具，于是退化成「测了个不会失败的东西」。拆成两条写。
 */
describe('已知代价：分段净化与整份净化不同', () => {
  it('不含 \\r 时两者一致', () => {
    const text = 'hello world'
    const s1 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 0, limit: 5, ended: false })
    const s2 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: s1.nextSince, limit: 100, ended: false })
    expect(sanitizeTerminalText(s1.raw) + sanitizeTerminalText(s2.raw)).toBe(sanitizeTerminalText(text))
  })

  it('含 \\r 时分段会残留一行过期进度条 —— 这是刻意接受的代价，钉住它', () => {
    const text = '10%\r100%'
    const s1 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: 0, limit: 4, ended: false })
    const s2 = sliceStream({ text, firstChar: 0, totalChars: text.length, since: s1.nextSince, limit: 100, ended: false })
    const segmented = sanitizeTerminalText(s1.raw) + sanitizeTerminalText(s2.raw)
    expect(sanitizeTerminalText(text)).toBe('100%')      // 整份净化：只剩最后一帧
    expect(segmented).not.toBe(sanitizeTerminalText(text))
    expect(segmented).toContain('100%')                   // 但最后一帧必须在
  })
})

/**
 * §5.4：小的那条永远给全，大的那条吃剩余额度。
 * stderr 通常很短而信息密度最高（traceback 就在那），让它被 stdout 挤掉是最坏的结果。
 */
describe('splitBudget', () => {
  it('两条都放得下 → 都给全', () => {
    expect(splitBudget(100, 200, 1000)).toEqual({ out: 100, err: 200 })
  })

  it('err 很短 → err 给全，out 吃剩下的', () => {
    expect(splitBudget(40000, 100, 30000)).toEqual({ out: 29900, err: 100 })
  })

  it('out 很短 → out 给全，err 吃剩下的', () => {
    expect(splitBudget(100, 40000, 30000)).toEqual({ out: 100, err: 29900 })
  })

  it('两条都很大 → 对半分', () => {
    expect(splitBudget(40000, 40000, 30000)).toEqual({ out: 15000, err: 15000 })
  })

  /** 这条是本组的**要害**：stderr 不许被 stdout 挤到 0。 */
  it('out 巨大而 err 有内容时，err 一个字符都不许被挤掉', () => {
    const r = splitBudget(999999, 8213, 30000)
    expect(r.err).toBe(8213)
    expect(r.out).toBe(30000 - 8213)
  })
})
