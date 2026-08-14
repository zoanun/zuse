import { describe, it, expect } from 'vitest'
import { TermBuffer, sanitizeTerminalText } from './term-text.js'

/**
 * 下沉到 protocol 之后的守卫（步骤 5 落地 1b）。
 *
 * web 侧 `termText.test.ts` 的 11 条用例继续跑，充当「行为一字未变」的回归证据；
 * 这里补的是**下沉本身**引入的新约束。
 */

/** 逐块喂，返回最终文本 —— 这是 SSE 那条路的真实形状。 */
const feed = (chunks: string[]): string => {
  const b = new TermBuffer()
  for (const c of chunks) b.push(c)
  return b.flush()
}

/**
 * **这一组是本次下沉最重要的守卫。**
 *
 * 「复用一份纯函数」最省事的写法是「每块自己净化再拼接」——**而那是错的**。
 * `\r` 要抹掉的是**已经定稿**的那一行，跨块；逐块净化再拼会把
 * `['aaa','\rb']` 变成 `'aaab'`（正确答案是 `'b'`）。
 *
 * 危险之处在于：那样改**现有用例一条都不会红**，右栏的进度条从此不折叠，没人会发现。
 * 所以这两条必须显式存在。
 */
describe('跨块状态：一次性版拼不出增量版', () => {
  it("['aaa','\\rb'] → 'b'（\\r 抹掉的是上一块已经定稿的内容）", () => {
    expect(feed(['aaa', '\rb'])).toBe('b')
    // 反面：逐块净化再拼会得到 'aaab'。写出来是为了让「改成那样」显眼。
    expect(sanitizeTerminalText('aaa') + sanitizeTerminalText('\rb')).toBe('aaab')
  })

  it("['done\\nA','\\rB'] → 'done\\nB'（只抹最后一行，不动之前的）", () => {
    expect(feed(['done\nA', '\rB'])).toBe('done\nB')
  })

  it('半截转义序列跨块也不能漏进正文', () => {
    // `\x1b[3` | `1m` 被切成两块；拼起来是一个完整的 CSI，应当整个消失。
    expect(feed(['a\x1b[3', '1mb'])).toBe('ab')
    // 逐块净化会把 `\x1b[3` 当正文留下（或留下残片）—— 同样是那个错误写法的症状。
    expect(sanitizeTerminalText('a\x1b[3') + sanitizeTerminalText('1mb')).not.toBe('ab')
  })

  it('\\r\\n 被切在块边界上仍然是换行，不是覆盖', () => {
    expect(feed(['a\r', '\nb'])).toBe('a\nb')
  })

  /**
   * **上面几条都没覆盖到 `pendingCR` 那条分支** —— 它们把 `\r` 放在第二块的**开头**，
   * 走的是块内 split 的路。我做变异验证时发现的：把 `pendingCR` 的 `overwriteLine()`
   * 删掉，我新写的用例**一条都不红**，是 web 那边的老用例抓住的。
   *
   * 悬挂 `\r` 的判定要跨块才做得出来（后面跟不跟 `\n` 决定它是换行还是覆盖），
   * 那正是这个类不能被「逐块净化再拼接」代替的核心理由，必须自己有守卫。
   */
  it('块**结尾**的 \\r，下一块不是 \\n → 覆盖本行（pendingCR 分支）', () => {
    expect(feed(['abc\r', 'x'])).toBe('x')
    expect(feed(['done\nabc\r', 'x'])).toBe('done\nx')
  })
})

describe('sanitizeTerminalText：一次性切片', () => {
  it('剥 ANSI', () => {
    expect(sanitizeTerminalText('\x1b[32mok\x1b[0m')).toBe('ok')
  })

  it('归一 CRLF', () => {
    expect(sanitizeTerminalText('a\r\nb')).toBe('a\nb')
  })

  it('折裸 \\r（进度条只留最后一帧）', () => {
    expect(sanitizeTerminalText('10%\r50%\r100%')).toBe('100%')
  })

  it('末尾挂着的 \\r 丢弃，但正文留着', () => {
    expect(sanitizeTerminalText('done\r')).toBe('done')
  })

  it('末尾半截转义序列不漏进正文', () => {
    expect(sanitizeTerminalText('ab\x1b[3')).toBe('ab')
  })

  it('空串不炸', () => {
    expect(sanitizeTerminalText('')).toBe('')
  })

  /** 它必须**就是** TermBuffer 的封装 —— 同一段文本，两条路结果必须一致。 */
  it('与 TermBuffer 一次性喂完等价', () => {
    for (const s of ['a\r\nb', '10%\r100%', '\x1b[31merr\x1b[0m', 'x\ry\rz', 'plain']) {
      expect(sanitizeTerminalText(s)).toBe(feed([s]))
    }
  })
})
