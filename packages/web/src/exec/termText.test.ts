import { describe, expect, it } from 'vitest'
import { TermBuffer } from './termText.js'

/**
 * `push` 返回的是**当前完整文本**，不是增量。
 *
 * 因为裸 `\r`（覆盖本行）是个**负增量** —— 累加各次返回值的模型根本表达不了它
 * （`['aaa\r','b']` 的结果是 `'b'`，第二次得把前面的 `aaa` 抵消掉）。
 * 处理是增量的（只碰新来的那块），对外给完整文本。
 */
const feed = (chunks: string[]): string => {
  const b = new TermBuffer()
  for (const c of chunks) b.push(c)
  return b.flush()
}

describe('TermBuffer —— CRLF', () => {
  /**
   * **顺序不能反。** v4 §8 实测：`mvn -v` 有 5 个 CR、`tsc -v` 有 1 个。
   * 先处理裸 `\r`（当成「回到行首覆盖本行」）的话，Windows 上**每一行都会被吃掉**。
   * 所以必须先把 `\r\n` 归一成 `\n`，剩下的才是真正的裸 `\r`。
   */
  it('\\r\\n 归一成 \\n，行不会被吃掉', () => {
    expect(feed(['a\r\nb\r\nc'])).toBe('a\nb\nc')
  })

  it('裸 \\r 表示覆盖本行（进度条那种）', () => {
    expect(feed(['10%\r20%\r100%'])).toBe('100%')
  })

  it('裸 \\r 只覆盖当前行，不影响前面已经完成的行', () => {
    expect(feed(['done\nA\rB'])).toBe('done\nB')
  })
})

describe('TermBuffer —— 跨块边界', () => {
  /** 前块结尾 `\r`、后块开头 `\n`：合起来是一个换行，不是「覆盖 + 换行」。 */
  it('\\r 与 \\n 跨块分裂，仍然算一个换行', () => {
    expect(feed(['a\r', '\nb'])).toBe('a\nb')
    // 对照：分在一起时结果必须一样，否则就是分块影响了语义
    expect(feed(['a\r\nb'])).toBe('a\nb')
  })

  /** 悬挂的 `\r` 后面跟的不是 `\n` → 它是真的裸 CR，要按覆盖处理。 */
  it('悬挂的 \\r 后面不是 \\n 时，按覆盖处理', () => {
    expect(feed(['aaa\r', 'b'])).toBe('b')
  })

  /**
   * **ANSI 序列同样会跨块分裂。** v1 只写了 CRLF 的悬挂处理，漏了这条 ——
   * 是同一类问题：一条只对完整文本成立的正则，改成增量后就漏了。
   */
  it('ANSI 转义序列跨块分裂，不能漏进输出', () => {
    expect(feed(['\x1b[3', '1mRED\x1b[0m'])).toBe('RED')
    expect(feed(['plain\x1b', '[32mgreen'])).toBe('plaingreen')
  })

  it('完整的 ANSI 序列被去掉，行数不变', () => {
    expect(feed(['\x1b[31mA\x1b[0m\n\x1b[32mB\x1b[0m'])).toBe('A\nB')
  })

  /** 没有下一块了：正文不能因为末尾挂着个 `\r` 就凭空消失。 */
  it('末尾悬着 \\r 时，正文仍然在（不会被当成覆盖而丢掉）', () => {
    const b = new TermBuffer()
    expect(b.push('abc\r')).toBe('abc')      // \r 还不知道是覆盖还是换行，正文先给出去
    expect(b.flush()).toBe('abc')            // 进程结束了，那个 \r 后面什么都没有
  })

  it('半截 ANSI 序列被丢掉，而不是当正文吐出来；正文不受影响', () => {
    const b = new TermBuffer()
    expect(b.push('text\x1b[3')).toBe('text')
    expect(b.flush()).toBe('text')           // 半截转义序列不是给人看的
  })
})

describe('TermBuffer —— 两条流各自一份状态', () => {
  /**
   * `out` 和 `err` 是独立的流（run.ts 的 `stream: 'out'|'err'`），各自有各自的
   * 悬挂状态。用同一个 buffer 处理两条流的话，一条流的半截序列会污染另一条。
   */
  it('两个实例互不干扰', () => {
    const out = new TermBuffer(), err = new TermBuffer()
    out.push('O\x1b[3')                    // out 悬着半截序列
    expect(err.push('E\n')).toBe('E\n')      // err 不受影响
    expect(out.push('1mX')).toBe('OX')
  })
})
