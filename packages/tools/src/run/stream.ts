import { OEM_MOJIBAKE_RATIO } from '../proc/oem.js'

/**
 * 一条输出流的**流式**解码器：先攒一个首窗定编码，定了就对整条流锁死。
 *
 * ## 为什么不能复用 `proc/output.ts` 的 `ProcOutputDecoder`
 *
 * 那个是**一次性**语义：拿到完整 body 才判 U+FFFD 密度，判完整体重解码
 * （`output.ts` 的 `redecodeOem`）。run 服务要边跑边往前端推，收尾才判就等于不推。
 * 而且它**共享**一份 raw 缓冲和**一个** OEM 决策（`rawChunks` 被 stdout/stderr 两条
 * 写入路径共用），流式下照抄会出事，见下。
 *
 * 它在自己的语义下是对的，`bash.ts` 还在用，**本文件与它并存，不去动它**。
 *
 * ## 每条流各自一个实例（不要两条流共用一个决策）
 *
 * 实测（设计 §1.1 第 3 条，`git log --oneline -3 & ping 127.0.0.1 -n 1 1>&2`）：
 *
 *   out → utf8 (ratio 0)        err → OEM (ratio 0.3362)
 *
 * 一条普通命令就能让两条流的编码结论相反。若共用一个决策，谁的首窗先满谁锁死全局，
 * 另一条必然乱码 —— 而 stdout/stderr 的到达顺序是不确定的，症状会**随机复现**。
 *
 * ## 首窗的三个触发，风险不对称
 *
 *   a. 攒够 windowBytes(4096)  —— 窗口大，截断噪声被稀释到 0.0004（实测），安全
 *   c. 流结束 end()            —— 手上是全部字节，不存在截断，安全
 *   b. 首字节后 windowMs(300)  —— 窗口大小由 chunk 到达决定，可以只有十几字节，**危险**
 *
 * 危险在于：判据是 `U+FFFD 密度 ≥ 0.02`，而窗口末尾切在多字节序列中间会**凭空造出**
 * 一个 U+FFFD。实测 `"你好"` 切到 4 字节 → ratio 0.5 → 判成 OEM。也就是任何解码后
 * ≤50 字符的窗口，只要末尾被截断就翻车 —— 而定码后「永不回头」，一次误判 = 整个 run
 * 的输出全成乱码。
 *
 * 解法就是下面 `decide()` 里那个 `{ stream: true }`：TextDecoder 的流模式把挂起的
 * 尾序列留在内部、**不产出 U+FFFD**，截断噪声归零。
 */
export interface StreamDecoderOptions {
  /**
   * Windows OEM 代码页标签（如 `'gbk'`）；null = 非 Windows / 代码页未知。
   * null 时永远判 utf-8 —— 没有可切换的目标，硬判 OEM 只会更糟。
   */
  oemLabel: string | null
  /** 定码后（含首窗重放）吐出的文本。可能被同步调用，也可能由 windowMs 计时器异步调用。 */
  onText: (text: string) => void
  /** 首窗字节上限，默认 4096。 */
  windowBytes?: number
  /** 首字节到达后多久必须定码，默认 300ms。 */
  windowMs?: number
}

type Encoding = 'buffering' | string

export class StreamDecoder {
  private readonly opts: Required<StreamDecoderOptions>
  private buffered: Buffer[] = []
  private bufferedLen = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private decoder: TextDecoder | null = null
  private label: Encoding = 'buffering'
  private disposed = false

  constructor(opts: StreamDecoderOptions) {
    this.opts = { windowBytes: 4096, windowMs: 300, ...opts }
  }

  /** 已定的编码；`'buffering'` = 还没定。 */
  get encoding(): Encoding { return this.label }

  write(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return
    if (this.decoder) { this.emit(this.decoder.decode(chunk, { stream: true })); return }

    this.buffered.push(chunk)
    this.bufferedLen += chunk.length
    // 计时器**只在首字节到达时**起步，不是构造时。实测 `tsc -v` 的首字节 1032~1147ms
    // 才到，从构造起算的话 300ms 时缓冲区是空的 —— 会在零字节上定码。
    if (this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; this.decide() }, this.opts.windowMs)
      // 必须是**真定时器**，不能写成「下一个 chunk 到达时算 elapsed」：
      // 「吐一个字节然后沉默」的进程（等输入的 REPL、慢构建的第一行日志）
      // 在后一种写法下会永远卡在 buffering，一个字都不吐。
      if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref()
    }
    if (this.bufferedLen >= this.opts.windowBytes) this.decide()
  }

  /** 流结束：还没定码就用手上的全部字节定，然后冲刷解码器缓着的尾字节。 */
  end(): void {
    if (this.disposed) return
    if (!this.decoder) this.decide()
    if (this.decoder) this.emit(this.decoder.decode())
    this.clearTimer()
  }

  /** 放弃这条流（run 被杀 / 订阅者全走了）：清计时器，之后不再吐任何东西。 */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.buffered = []
  }

  private decide(): void {
    if (this.decoder || this.disposed) return
    this.clearTimer()
    const window = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered)
    this.label = this.pickLabel(window)
    this.decoder = new TextDecoder(this.label)
    // 重放攒下的字节 —— 用刚定的编码。少了这一步，首窗那几 KB 会凭空消失。
    if (window.length > 0) this.emit(this.decoder.decode(window, { stream: true }))
    this.buffered = []
    this.bufferedLen = 0
  }

  private pickLabel(window: Buffer): string {
    if (!this.opts.oemLabel || window.length === 0) return 'utf-8'
    // `{ stream: true }` 是这一行的**全部要点**：它把窗口末尾挂起的不完整序列留在
    // 内部而不产出 U+FFFD，否则「窗口恰好切在一个中文字中间」会被算成乱码证据。
    // 这个 TextDecoder 是**一次性**的（判完就丢），不是下面真正用来解码的那个。
    const probe = new TextDecoder('utf-8').decode(window, { stream: true })
    if (probe.length === 0) return 'utf-8'
    const fffd = probe.split('�').length - 1
    // 阈值与 `proc/oem.ts` 同源，不另立门户 —— 两处判据漂移过一次就再也对不齐了。
    if (fffd / probe.length < OEM_MOJIBAKE_RATIO) return 'utf-8'
    try { new TextDecoder(this.opts.oemLabel) } catch { return 'utf-8' }
    return this.opts.oemLabel
  }

  private emit(text: string): void {
    if (text.length > 0 && !this.disposed) this.opts.onText(text)
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }
}
