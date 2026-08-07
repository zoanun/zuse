/**
 * 进程层 —— 子进程输出解码。
 *
 * 把 `bash.ts` 里散落的三段逻辑（两条流各一个 `StringDecoder`、Windows 原始字节留存、
 * 收尾时的 OEM 重解码）收进一个对象。**逻辑一字未改**，只是从自由变量变成实例字段：
 * 原来 stdout/stderr 的 handler 里 `append(decoder.write(chunk))` 与 `keepRaw(chunk)`
 * 是两条相邻语句、彼此无交互，这里合并成一次调用，效果相同。
 *
 * 抽出来的理由见设计 §1：跨 chunk 的 `StringDecoder` 与 OEM 重解码是「模型输出中文
 * 不乱码」的全部依据，run 服务必须复用同一份，不能重写。
 */

import { StringDecoder } from 'node:string_decoder'
import { OEM_RAW_CAP, redecodeOemIfMojibake, winOemLabel } from './oem.js'

/**
 * 一个子进程的两条输出流的解码器。
 *
 * 每条流各用一个 StringDecoder：多字节 UTF-8 码点跨 chunk 边界时，decoder 会
 * 缓存半个字符等下一块，避免 chunk.toString() 各自解码造成的乱码（中文/emoji）。
 *
 * On Windows, also retain the raw bytes (bounded, in arrival order) so output that UTF-8
 * decoding corrupts can be re-decoded in the OEM codepage at close — native console apps
 * (ping, dir, …) emit OEM bytes, not UTF-8. No-op on other platforms / unknown codepage.
 */
export class ProcOutputDecoder {
  private readonly outDecoder = new StringDecoder('utf8')
  private readonly errDecoder = new StringDecoder('utf8')
  private readonly oemLabel: string | null
  private readonly rawChunks: Buffer[] = []
  private rawLen = 0
  private rawOverflow = false

  /**
   * oemLabel 默认取本机探测值（惰性、记忆化，检测成本不落在 server 启动路径上）；
   * 显式传入仅供测试注入。
   */
  constructor(oemLabel: string | null = winOemLabel()) {
    this.oemLabel = oemLabel
  }

  /** 解码 stdout 的一块；顺带按到达顺序留存原始字节（供 OEM 重解码）。 */
  writeStdout(chunk: Buffer): string {
    const text = this.outDecoder.write(chunk)
    this.keepRaw(chunk)
    return text
  }

  /** 解码 stderr 的一块；顺带按到达顺序留存原始字节（供 OEM 重解码）。 */
  writeStderr(chunk: Buffer): string {
    const text = this.errDecoder.write(chunk)
    this.keepRaw(chunk)
    return text
  }

  /** 冲刷 stdout decoder 里可能缓着的尾字节。 */
  endStdout(): string {
    return this.outDecoder.end()
  }

  /** 冲刷 stderr decoder 里可能缓着的尾字节。 */
  endStderr(): string {
    return this.errDecoder.end()
  }

  /**
   * 收尾时判断要不要按 OEM 代码页整体重解码；返回 null = 保留原 UTF-8 文本。
   * 一次性语义（须拿到完整 body 才能判密度），流式复用见 oem.ts 的说明。
   */
  redecodeOem(utf8Body: string): string | null {
    return redecodeOemIfMojibake(utf8Body, this.rawChunks, this.rawOverflow, this.oemLabel)
  }

  private keepRaw(chunk: Buffer): void {
    if (!this.oemLabel || this.rawOverflow) return
    this.rawLen += chunk.length
    if (this.rawLen > OEM_RAW_CAP) { this.rawOverflow = true; this.rawChunks.length = 0; return }
    this.rawChunks.push(chunk)
  }
}
