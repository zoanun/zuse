/**
 * 终端输出的净化：剥 ANSI、折 `\r`、归一 CRLF。
 *
 * ## 为什么在 `@zuse/protocol` 而不是 web 里
 *
 * 两侧要用**同一份规则**：
 * - **web 右栏**吃的是 SSE 推来的**增量** chunk（有状态，块边界上会挂半截东西）；
 * - **`RunOutput` 工具**吃的是从有界缓冲里切出来的**一次性**片段。
 *
 * 两边各写一份必然漂移，而漂移的症状是「同一次运行，右栏和模型看到的文本不一样」——
 * 排查时没人会先怀疑净化规则。放在 protocol 是因为 web 与 tools 都依赖它，
 * 而它不依赖任何一方。
 *
 * ## 有状态的这个类是本体，一次性版是它之上的薄封装 —— **不能反过来**
 *
 * 「每块自己净化再拼接」是最省事的写法，也是**错的**：
 * 实测 `['aaa', '\rb']` 逐块净化再拼会得到 `'aaab'`，而正确答案是 `'b'`
 *（`\r` 要抹掉**已经定稿**的那一行，跨块）。
 * 拿一次性版拼增量版会丢掉 `pendingCR` / `pendingEsc` 两个跨块状态，
 * 而且**现有用例一条都不会红** —— 右栏的进度条从此不折叠，没人会发现。
 *
 * **每条流一个实例。** `out` 和 `err` 是独立的流，各自可能在块边界上挂着半截东西；
 * 共用一个实例的话，一条流的半截转义序列会污染另一条。
 */

/** 完整的 CSI 序列。只做 strip，不做 ansi→span（实测 11 条命令 ESC 全为 0）。 */
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
      if (s.startsWith('\n')) { this.text += '\n'; s = s.slice(1) }
      else this.overwriteLine()
    }

    // **顺序写死：先 `\r\n` → `\n`，再处理裸 `\r`。** 实测 `mvn -v` 有 5 个 CR、
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

/**
 * 一次性净化一整段文本（`RunOutput` 那种从有界缓冲里切片的场景）。
 *
 * **它是 `TermBuffer` 之上的薄封装，不是另一套实现。** 见类注释里那段：
 * 反过来做会丢跨块状态，且现有用例一条都不会红。
 *
 * 用 `flush()` 收尾而不是只看 `push()` 的返回值：切片是「到此为止」的语义，
 * 末尾挂着的半截转义序列不该漏进正文。
 */
export function sanitizeTerminalText(text: string): string {
  const buf = new TermBuffer()
  buf.push(text)
  return buf.flush()
}
