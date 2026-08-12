/**
 * 【独立评审新增】StreamDecoder 的状态机边界穷举。
 *
 * 这些用例**记录当前实际行为**（不是「应该怎样」），所以全部是绿的。
 * 我在评审报告里逐条标了哪几条我认为该改。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamDecoder } from './stream.js'

afterEach(() => { vi.useRealTimers() })

const GBK_NIHAO = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]) // 「你好世界」GBK
const utf8 = (s: string) => Buffer.from(s, 'utf8')

type Opts = ConstructorParameters<typeof StreamDecoder>[0]

/** `opts` 故意放宽成 Partial<Opts>：本文件有几条就是要传 `windowBytes: undefined` 这种退化值。 */
function collect(opts: Partial<Opts> = {}) {
  const parts: string[] = []
  const base: Opts = { oemLabel: 'gbk', onText: (t: string) => { parts.push(t) } }
  const d = new StreamDecoder({ ...base, ...opts })
  return { d, parts, text: () => parts.join('') }
}

describe('评审：调用顺序的边界', () => {
  /**
   * 评审最初锁的是「没有护栏、照样吐字」那个**旧行为**。已按它的建议加上 `ended` 闸，
   * 断言随之翻过来：SSE 那头已经按「这次跑完了」收场了，再冒出 chunk 只会表现成
   * 「莫名其妙多出一段」。
   */
  it('write() 在 end() 之后：一律丢弃，不再吐字', () => {
    const { d, text, parts } = collect()
    d.write(utf8('a')); d.end()
    expect(text()).toBe('a')
    d.write(utf8('迟到的字节'))
    expect(parts.length).toBe(1)
    expect(text()).toBe('a')
  })

  it('end() 调两次：第二次是 no-op（不重复 emit、不崩）', () => {
    const { d, parts } = collect()
    d.write(utf8('你好')); d.end(); d.end()
    expect(parts).toEqual(['你好'])
  })

  it('end() 之后 dispose()，再 write()/end()：全部静默', () => {
    const { d, parts } = collect()
    d.write(utf8('x')); d.end(); d.dispose()
    d.write(utf8('y')); d.end()
    expect(parts).toEqual(['x'])
  })

  it('一个字节都没写就 dispose()，再 end()：不崩、不产出、encoding 仍是 buffering', () => {
    const { d, parts } = collect()
    d.dispose(); d.end()
    expect(parts).toEqual([])
    expect(d.encoding).toBe('buffering')
  })

  it('零字节流 end()：不产出，但 encoding 被定成 utf-8（spec §3.1 说「不需要决策」）', () => {
    const { d, parts } = collect()
    d.end()
    expect(parts).toEqual([])
    expect(d.encoding).toBe('utf-8')       // ← 实际是定了码的
  })

  it('write(空 buffer) 不起步计时器', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    d.write(Buffer.alloc(0))
    vi.advanceTimersByTime(10_000)
    expect(d.encoding).toBe('buffering')
    expect(text()).toBe('')
  })
})

describe('评审：onText 抛异常', () => {
  it('定码那一刻 onText 抛：异常向调用方冒泡，decoder 已就位、不会重复定码', () => {
    let calls = 0
    const d = new StreamDecoder({
      oemLabel: 'gbk', windowBytes: 4,
      onText: () => { calls++; throw new Error('订阅者炸了') },
    })
    expect(() => d.write(utf8('abcd'))).toThrow('订阅者炸了')
    expect(calls).toBe(1)
    expect(d.encoding).toBe('utf-8')       // 已定码：decoder 在 emit 之前就赋值了
    // 但 buffered / bufferedLen 没被清（emit 抛在 `this.buffered = []` 之前，stream.ts:110-112）
    // 表现不出功能异常（decoder 一旦非 null 就再也不看 buffered），代价是那几 KB 被永久持有。
    expect(() => d.write(utf8('e'))).toThrow('订阅者炸了')
    expect(calls).toBe(2)
  })

  it('计时器路径上 onText 抛：异常从定时器回调里出来（真实 node 里 = uncaughtException）', () => {
    vi.useFakeTimers()
    const d = new StreamDecoder({
      oemLabel: 'gbk', windowMs: 300,
      onText: () => { throw new Error('订阅者炸了') },
    })
    d.write(utf8('x'))
    expect(() => vi.advanceTimersByTime(300)).toThrow('订阅者炸了')
  })
})

describe('评审：windowBytes / windowMs 的退化取值', () => {
  it('windowBytes = 0：第一个 chunk 就定码（窗口 = 那个 chunk，不是 0 字节）', () => {
    const { d, text } = collect({ windowBytes: 0 })
    d.write(utf8('你好'))
    expect(d.encoding).toBe('utf-8')
    expect(text()).toBe('你好')
  })

  it('windowBytes = -1：与 0 同样，第一个 chunk 定码，不崩', () => {
    const { d, text } = collect({ windowBytes: -1 })
    d.write(GBK_NIHAO)
    expect(d.encoding).toBe('gbk')
    expect(text()).toBe('你好世界')
  })

  /**
   * 评审最初锁的是 `{ windowBytes: 4096, ...opts }` 那个洞的**旧行为**（显式传
   * `undefined` 会把默认值顶掉，而 `Required<...>` 在类型上看着安全、编译期不报）。
   * 已改成逐项 `??` 取默认值，断言随之翻过来。
   */
  it('显式传 windowBytes: undefined → 仍然用默认 4096，不被顶掉', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowBytes: undefined, windowMs: 300 })
    d.write(utf8('a'.repeat(10_000)))
    expect(d.encoding).toBe('utf-8')       // 攒够 4096 就定码，不用等 300ms
    expect(text().length).toBe(10_000)
  })

  it('显式传 windowMs: undefined → 仍然是 300ms，不退化成 ~1ms', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: undefined })
    d.write(utf8('hi'))
    vi.advanceTimersByTime(1)
    expect(text()).toBe('')                // 1ms 时还没到点
    vi.advanceTimersByTime(299)
    expect(text()).toBe('hi')
  })

  it('单个 chunk 是 windowBytes 的好几倍：整个 chunk 都当窗口，不丢字节', () => {
    const { d, text } = collect({ windowBytes: 16 })
    const big = utf8('中'.repeat(5000))     // 15000 字节，约 940 倍窗口
    d.write(big)
    expect(d.encoding).toBe('utf-8')
    expect(text()).toBe('中'.repeat(5000))
  })
})

describe('评审：spec §10 点名但没落地的「两条流各自定码」', () => {
  it('out=UTF-8 / err=OEM 两个实例互不影响（锁住「不要退化成模块级共享决策」）', () => {
    const out = collect()
    const err = collect()
    err.d.write(GBK_NIHAO)                 // err 先定码成 gbk
    err.d.end()
    out.d.write(utf8('你好世界'))
    out.d.end()
    expect(err.d.encoding).toBe('gbk')
    expect(out.d.encoding).toBe('utf-8')
    expect(err.text()).toBe('你好世界')
    expect(out.text()).toBe('你好世界')
  })

  it('交错喂（真实的到达顺序不确定）也各判各的', () => {
    const out = collect({ windowBytes: 4 })
    const err = collect({ windowBytes: 4 })
    out.d.write(utf8('abcd')); err.d.write(GBK_NIHAO.subarray(0, 4))
    out.d.write(utf8('中文')); err.d.write(GBK_NIHAO.subarray(4))
    out.d.end(); err.d.end()
    expect(out.d.encoding).toBe('utf-8')
    expect(err.d.encoding).toBe('gbk')
    expect(out.text()).toBe('abcd中文')
    expect(err.text()).toBe('你好世界')
  })
})

describe('评审：BOM 与判定探针', () => {
  it('UTF-8 BOM 被静默吃掉（判定探针和真解码器都是 ignoreBOM:false，行为一致）', () => {
    const { d, text } = collect()
    d.write(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8('hello')]))
    d.end()
    expect(d.encoding).toBe('utf-8')
    expect(text()).toBe('hello')           // BOM 不在输出里
  })

  it('BOM 落在定码之后的 chunk 里就**不会**被吃掉（同一条流两种待遇）', () => {
    const { d, text } = collect({ windowBytes: 2 })
    d.write(utf8('ab'))                    // 先定码
    d.write(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8('cd')]))
    d.end()
    expect(text()).toBe('ab﻿cd')      // ← 这里 BOM 原样留着
  })

  it('窗口全是挂起的不完整序列（probe 解出 0 字符）→ 判 utf-8，不崩', () => {
    const { d } = collect({ windowBytes: 1 })
    d.write(Buffer.from([0xE4]))           // 3 字节序列的第一个字节
    expect(d.encoding).toBe('utf-8')
  })
})

describe('评审：阈值在小窗口下的含义（OEM_MOJIBAKE_RATIO 复用）', () => {
  /**
   * 一次性路径（oem.ts）里 0.02 的作用是「别让一两个杂散坏字节把整份 UTF-8 翻掉」
   * （redecodeOemIfMojibake 的英文注释原话）。流式路径的首窗可以只有十几字符，
   * 同一个 0.02 就退化成「**只要有一个坏字节就翻**」——而且是永久锁死。
   * `{stream:true}` 只挡掉了「窗口末尾截断」这一个 FFFD 来源，挡不掉窗口**中间**的坏字节。
   */
  /**
   * **这条是本次评审判定的两个「必须改」之一，现已修复，断言翻过来。**
   *
   * 旧行为：只看密度。首窗在 300ms 那档可能只有十几个字符，`1/11 = 0.09 ≥ 0.02`
   * 就过线 → 整条干净的 UTF-8 流被永久锁成 gbk（定码后「永不回头」）。
   * 而同一串字节落在一次性路径的大 body 里（下一条）判的是 utf-8 —— 两条路径结论相反。
   *
   * 新判据：密度之外**还要至少 2 个 U+FFFD**。真 OEM 的坏字符是成片的
   * （ping 的 92 字节窗里有 24 个），一个杂散坏字节则恰好是 1 个。
   */
  it('首窗中间一个杂散坏字节 → **不再**把整条 UTF-8 流锁成 gbk', () => {
    vi.useFakeTimers()
    const { d, text } = collect({ windowMs: 300 })
    d.write(Buffer.concat([utf8('Building '), Buffer.from([0x9C]), utf8('\n')]))  // 11 字符里 1 个 FFFD
    vi.advanceTimersByTime(300)
    expect(d.encoding).toBe('utf-8')
    d.write(utf8('后面全是干净的 UTF-8 中文'))
    d.end()
    expect(text()).toContain('后面全是干净的')
  })

  /** 真 OEM 仍要认得出来：坏字符成片时照常判 gbk，别把闸门关过头。 */
  it('真 OEM 输出（坏字符成片）仍然判 gbk', () => {
    vi.useFakeTimers()
    const { d } = collect({ windowMs: 300 })
    d.write(Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]))   // 「你好世界」GBK
    vi.advanceTimersByTime(300)
    expect(d.encoding).toBe('gbk')
  })

  it('同一串字节，若落在一次性路径的大 body 里（5000 字符）则判 utf-8 —— 两条路径结论相反', () => {
    const { d, text } = collect({ windowBytes: 100_000 })
    d.write(Buffer.concat([utf8('Building '), Buffer.from([0x9C]), utf8('\n'), utf8('x'.repeat(5000))]))
    d.end()
    expect(d.encoding).toBe('utf-8')       // ratio ≈ 0.0002 < 0.02
    expect(text()).toContain('Building')
  })
})
