/**
 * 终端输出的文本处理（spec §4）。
 *
 * 一句话：把 run 服务推来的**增量** chunk 变成能直接渲染的文本。
 * 干三件事——归一化 CRLF、剥掉 ANSI、处理裸 `\r` 的「覆盖本行」。
 *
 * **每条流一个实例。** `out` 和 `err` 是独立的流，各自可能在块边界上挂着半截东西；
 * 共用一个实例的话，一条流的半截转义序列会污染另一条。
 */

/** 完整的 CSI 序列。只做 strip，不做 ansi→span（v4 §8：实测 11 条命令 ESC 全为 0）。 */
const ANSI_FULL = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** 末尾**没写完**的那一截。增量场景下必须留到下一块，否则 `\x1b[3` | `1m` 会漏进正文。 */
const ANSI_TAIL = /\x1b(?:\[[0-9;?]*[ -/]*)?$/

export class TermBuffer {
  /** 已定稿的文本。 */
  private text = ''
  /** 上一块结尾挂着的 `\r`：还不知道它是 `\r\n` 的前半截，还是一个真的「覆盖本行」。 */
  private pendingCR = false
  /** 上一块结尾挂着的半截转义序列。 */
  private pendingEsc = ''

  /** 喂一块增量，返回**当前完整文本**（不是增量 —— 「覆盖本行」是个负增量，累加表达不了）。 */
  push(chunk: string): string {
    let s = this.pendingEsc + chunk
    this.pendingEsc = ''

    // 先剥 ANSI 再处理 CR：转义序列里不含 `\r`，所以这个顺序不会互相干扰，
    // 反过来则要在 CR 的分段逻辑里躲着转义序列走，复杂得多。
    s = s.replace(ANSI_FULL, '')
    const tail = ANSI_TAIL.exec(s)
    if (tail) { this.pendingEsc = tail[0]; s = s.slice(0, tail.index) }

    // 悬挂的 `\r` 现在能定性了：后面跟 `\n` 就是换行，否则就是覆盖本行。
    if (this.pendingCR) {
      this.pendingCR = false
      if (s.startsWith('\n')) this.text += '\n', s = s.slice(1)
      else this.overwriteLine()
    }

    // **顺序写死：先 `\r\n` → `\n`，再处理裸 `\r`。** v4 §8 实测 `mvn -v` 有 5 个 CR、
    // `tsc -v` 有 1 个；反过来先把 `\r` 当覆盖处理，Windows 上**每一行都会被吃掉**。
    s = s.replace(/\r\n/g, '\n')

    if (s.endsWith('\r')) { this.pendingCR = true; s = s.slice(0, -1) }

    // 剩下的 `\r` 都是真的裸 CR：每个都把本行清掉重来。
    const parts = s.split('\r')
    this.text += parts[0]
    for (let i = 1; i < parts.length; i++) {
      this.overwriteLine()
      this.text += parts[i]
    }
    return this.text
  }

  /**
   * 收尾：进程结束了，没有下一块了。
   *
   * 悬挂的 `\r` 直接丢弃（它后面永远不会有东西了），半截转义序列也丢弃
   * （那不是给人看的）——但**正文必须留着**，不能因为末尾挂了个 `\r` 就把整行吞掉。
   */
  flush(): string {
    this.pendingCR = false
    this.pendingEsc = ''
    return this.text
  }

  /** 当前完整文本（不改状态）。 */
  get value(): string { return this.text }

  /** 把最后一个换行之后的内容抹掉 —— 这就是 `\r` 的「回到行首」。 */
  private overwriteLine(): void {
    const nl = this.text.lastIndexOf('\n')
    this.text = nl === -1 ? '' : this.text.slice(0, nl + 1)
  }
}
