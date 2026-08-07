import { describe, it, expect } from 'vitest'
import { ProcOutputDecoder } from './output.js'
import { OEM_RAW_CAP } from './oem.js'

/**
 * 锁住「解码器接线」这一层。
 *
 * 为什么必须单测：`redecodeOemIfMojibake` 的**判据**早有测试（bash.test.ts 里直接喂
 * rawChunks），但「谁把原始字节留下来给它」这段接线一直只靠真跑覆盖。抽 proc 层时做
 * 变异验证 —— 把 keepRaw 改成直接 return —— **全仓 371 条测试全绿**，而真跑的表现是
 * 一条输出 GBK 的命令从「你好，世界！」变成 `(no output)`：判据照样命中，但拿去解码的
 * 缓冲是空的，于是整段输出**凭空消失**（比乱码更难发现）。这条测试就是补那个洞。
 */

/** 「你好」的 GBK(CP936) 字节 —— 按 UTF-8 解会得到 U+FFFD。 */
const GBK_NIHAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
const FFFD = String.fromCharCode(0xfffd)

describe('ProcOutputDecoder', () => {
  it('留存原始字节，收尾时能按 OEM 还原（stdout）', () => {
    const d = new ProcOutputDecoder('gbk')
    const body = d.writeStdout(GBK_NIHAO)
    expect(body).toContain(FFFD) // UTF-8 解不出来
    expect(d.redecodeOem(body)).toBe('你好')
  })

  it('stderr 的字节同样留存（原生程序常把中文报错写 stderr）', () => {
    const d = new ProcOutputDecoder('gbk')
    const body = d.writeStderr(GBK_NIHAO)
    expect(d.redecodeOem(body)).toBe('你好')
  })

  it('两条流按到达顺序拼接后一起重解码', () => {
    const d = new ProcOutputDecoder('gbk')
    let body = ''
    body += d.writeStdout(GBK_NIHAO)
    body += d.writeStderr(Buffer.from([0xa3, 0xac])) // GBK 全角逗号
    body += d.writeStdout(GBK_NIHAO)
    expect(d.redecodeOem(body)).toBe('你好，你好')
  })

  it('多字节码点跨 chunk 边界不乱码（StringDecoder 缓半个字符）', () => {
    const d = new ProcOutputDecoder(null) // 非 Windows / 未知代码页：只走 UTF-8
    const utf8 = Buffer.from('你好世界', 'utf8')
    const a = d.writeStdout(utf8.subarray(0, 5)) // 切在第二个汉字中间
    const b = d.writeStdout(utf8.subarray(5))
    expect(a + b + d.endStdout()).toBe('你好世界')
  })

  it('stdout / stderr 各自独立缓冲，互不串扰', () => {
    const d = new ProcOutputDecoder(null)
    const out = Buffer.from('你', 'utf8')
    const err = Buffer.from('好', 'utf8')
    // 交错喂半个字符：若两条流共用一个 decoder，这里就会拼出乱码。
    const a = d.writeStdout(out.subarray(0, 2))
    const b = d.writeStderr(err.subarray(0, 2))
    const c = d.writeStdout(out.subarray(2))
    const e = d.writeStderr(err.subarray(2))
    expect(a + c + d.endStdout()).toBe('你')
    expect(b + e + d.endStderr()).toBe('好')
  })

  it('未知代码页（oemLabel=null）时完全不留存，也不重解码', () => {
    const d = new ProcOutputDecoder(null)
    const body = d.writeStdout(GBK_NIHAO)
    expect(d.redecodeOem(body)).toBeNull()
  })

  it('原始字节超上限即弃守，保留 UTF-8 结果而不是解出半截', () => {
    const d = new ProcOutputDecoder('gbk')
    let body = d.writeStdout(GBK_NIHAO)
    body += d.writeStdout(Buffer.alloc(OEM_RAW_CAP + 1, 0xc4)) // 越过上限 → overflow
    expect(d.redecodeOem(body)).toBeNull()
  })
})
