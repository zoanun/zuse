import { describe, expect, it, vi, afterEach } from 'vitest'
import { StreamDecoder } from './stream.js'

afterEach(() => { vi.useRealTimers() })

/** 「你好世界」的 GBK 字节。用它造 OEM 流。 */
const GBK_NIHAO = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7])
const utf8 = (s: string) => Buffer.from(s, 'utf8')

/** 收集器：把 onText 吐出来的片段攒起来。 */
function collect(opts: Partial<ConstructorParameters<typeof StreamDecoder>[0]> = {}) {
  const parts: string[] = []
  const d = new StreamDecoder({ oemLabel: 'gbk', onText: (t) => parts.push(t), ...opts })
  return { d, parts, text: () => parts.join('') }
}

describe('StreamDecoder 首窗定码', () => {
  it('攒够 4096 字节就定码，之前一个字都不吐', () => {
    const { d, text } = collect()
    d.write(utf8('a'.repeat(4000)))
    expect(text()).toBe('')                    // 还在 buffering
    d.write(utf8('b'.repeat(100)))
    expect(text()).toBe('a'.repeat(4000) + 'b'.repeat(100))   // 定码后**重放**了攒下的
    expect(d.encoding).toBe('utf-8')
  })

  /**
   * 实测 `tsc -v` 的首字节 1032~1147ms 才到（见 spec §1.1 第 2 条）。窗口若从 spawn 起算，
   * 300ms 时缓冲区是空的 —— 会在**零字节**上定码。所以计时器只在首字节到达时才起步。
   */
  it('窗口从首字节起算，不是从构造起算', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    vi.advanceTimersByTime(5000)               // 构造后干等 5 秒，一个字节都没来
    expect(d.encoding).toBe('buffering')       // 没有在空缓冲上定码
    d.write(utf8('hi'))
    expect(text()).toBe('')                    // 首字节刚到，计时器才起步
    vi.advanceTimersByTime(300)
    expect(text()).toBe('hi')
    expect(d.encoding).toBe('utf-8')
  })

  /**
   * 「吐一个字节然后沉默」（banner 之后等输入的 REPL、慢构建的第一行日志）。
   * 若把 300ms 写成「下一个 chunk 到达时算 elapsed」，这里会**永远卡在 buffering**、
   * 一个字都不吐 —— 必须是真 setTimeout。
   */
  it('吐一个字节后再无输入：300ms 到点仍然吐字', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    d.write(utf8('x'))
    vi.advanceTimersByTime(299)
    expect(text()).toBe('')
    vi.advanceTimersByTime(1)
    expect(text()).toBe('x')
  })

  it('进程退出时若仍在 buffering，end() 负责定码并吐出', () => {
    const { d, text } = collect()
    d.write(utf8('短输出'))
    expect(text()).toBe('')
    d.end()
    expect(text()).toBe('短输出')
  })

  it('一个字节都没有：end() 不产出任何东西，也不崩', () => {
    const { d, parts } = collect()
    d.end()
    expect(parts).toEqual([])
  })
})

describe('StreamDecoder 编码判定', () => {
  it('OEM 字节 → 判 oem 并按 OEM 解码', () => {
    const { d, text } = collect()
    d.write(GBK_NIHAO)
    d.end()
    expect(d.encoding).toBe('gbk')
    expect(text()).toBe('你好世界')
  })

  it('UTF-8 中文 → 判 utf-8', () => {
    const { d, text } = collect()
    d.write(utf8('你好世界'))
    d.end()
    expect(d.encoding).toBe('utf-8')
    expect(text()).toBe('你好世界')
  })

  /**
   * **本文件最重要的一条。** 判据是 `U+FFFD 密度 ≥ 0.02`，而窗口末尾切在多字节序列
   * 中间会**凭空造出**一个 U+FFFD。实测（spec §1.3）：
   *
   *   "你好" 完整 6 字节 → ratio 0    → utf8
   *   "你好" 切到 4 字节 → ratio 0.5  → OEM   ← 误判
   *
   * 即**任何解码后 ≤50 字符的窗口，只要末尾被截断，就翻成 OEM**；而定码后「永不回头」，
   * 一次误判 = 整个 run 的输出全成乱码。三个触发里只有 300ms 那档窗口可以只有十几字节，
   * 风险不对称。解法：判定前用 TextDecoder 的 stream 模式吃掉挂起的尾序列。
   */
  it('窗口末尾切断多字节序列，不能被误判成 OEM', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    const nihao = utf8('你好')
    d.write(nihao.subarray(0, 4))              // 切在「好」的中间：窗口只有 4 字节
    vi.advanceTimersByTime(300)                // 定码 —— 此刻窗口末尾是半个字符
    expect(d.encoding).toBe('utf-8')           // 不能因为那半个字符翻成 gbk
    d.write(nihao.subarray(4))
    expect(text()).toBe('你好')                 // 半个字符跨窗口边界也要拼回来
  })

  it('oemLabel 为 null（非 Windows / 代码页未知）时，永远判 utf-8', () => {
    const { d, text } = collect({ oemLabel: null })
    d.write(GBK_NIHAO)
    d.end()
    expect(d.encoding).toBe('utf-8')
    expect(text()).not.toBe('你好世界')          // 解不出来，但不能崩、也不能假装是 gbk
  })
})

describe('StreamDecoder 定码后的解码', () => {
  /**
   * `new TextDecoder(label, {stream:true})` 是**错的** —— stream 是 `decode()` 的参数，
   * 构造函数只吃 `{fatal, ignoreBOM}`，传进去被静默忽略，于是每次 decode 都当一次完整
   * 刷新。实测（spec §1.4）：错写法把跨块的「你好世界」解成 "你�檬澜�"。
   */
  /**
   * 窗口取 5 字节而不是 3：判据要求**至少 2 个 U+FFFD**（见 pickLabel 的注释 ——
   * 一个杂散坏字节不该把整条流锁成 OEM）。而 GBK 窗口太小时坏字符数也少：
   * 实测 3 字节窗只有 1 个 FFFD，4 字节起才 ≥2。5 字节的切点落在「世」(CA C0) 的
   * 两个字节之间，跨块解码这件事照样测到。
   */
  it('GBK 双字节跨 chunk：定码之后到来的块也要接着解', () => {
    const { d, text } = collect({ windowBytes: 5 })  // 头 5 字节就定码，剩下的走增量路径
    d.write(GBK_NIHAO.subarray(0, 5))
    expect(d.encoding).toBe('gbk')
    d.write(GBK_NIHAO.subarray(5))
    d.end()
    expect(text()).toBe('你好世界')              // 错写法这里会是 "你�檬澜�"
  })

  it('UTF-8 多字节跨 chunk 断开仍不乱码', () => {
    const { d, text } = collect({ windowBytes: 2 })
    const b = utf8('中文')
    d.write(b.subarray(0, 2))
    d.write(b.subarray(2))
    d.end()
    expect(text()).toBe('中文')
  })

  it('定码后不再回头：先 UTF-8 后来一段 OEM 字节，仍按 UTF-8 解', () => {
    const { d } = collect({ windowBytes: 4 })
    d.write(utf8('abcd'))
    expect(d.encoding).toBe('utf-8')
    d.write(GBK_NIHAO)
    d.end()
    expect(d.encoding).toBe('utf-8')            // 粘滞，不因为后面的字节改判
  })

  it('dispose() 清掉计时器，之后不再吐字', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    d.write(utf8('x'))
    d.dispose()
    vi.advanceTimersByTime(1000)
    expect(text()).toBe('')
  })
})
