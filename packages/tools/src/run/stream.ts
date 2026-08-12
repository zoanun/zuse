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
  /** 已收尾。之后再 `write` 一律无视 —— 见 `write()` 的注释。 */
  private ended = false

  constructor(opts: StreamDecoderOptions) {
    // 用 `??` 逐项取默认值，**不能写 `{ windowBytes: 4096, ...opts }`**：
    // 调用方显式传一个 `undefined`（从可选配置里转发时最自然的写法）会把默认值顶掉，
    // 而 `Required<...>` 在类型上看着安全、编译期一声不吭。实测后果：
    // `windowBytes: undefined` → `10000 >= undefined` 恒 false，4096 那档彻底失效；
    // `windowMs: undefined` → `setTimeout(fn, undefined)` 退化成 ~1ms，300ms 窗口没了。
    this.opts = {
      oemLabel: opts.oemLabel,
      onText: opts.onText,
      windowBytes: opts.windowBytes ?? 4096,
      windowMs: opts.windowMs ?? 300,
    }
  }

  /** 已定的编码；`'buffering'` = 还没定。 */
  get encoding(): Encoding { return this.label }

  write(chunk: Buffer): void {
    // `end()` 之后再来的字节一律丢。没有这道闸的话，run.ts 若收到一个迟到的 `'data'`
    // （或接线顺序有误），SSE 那头会在 **end 事件之后**又收到 chunk —— 客户端已经按
    // 「这次跑完了」收场了，再冒出内容只会表现成「莫名其妙多出一段」。
    if (this.disposed || this.ended || chunk.length === 0) return
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
      //
      // **刻意不 `unref()`。** 早先写了，评审实测证明它净收益为负：daemon 里子进程的
      // stdout 管道本来就是活 handle，unref 与否都不影响定时器触发（收益为零）；
      // 而在「进程正要退出」那个窄窗口里，unref 掉的定时器**永远不会触发** ——
      // 首窗那几 KB 被静默吞掉。零收益换一个静默丢数据的窗口，不划算。
    }
    if (this.bufferedLen >= this.opts.windowBytes) this.decide()
  }

  /** 流结束：还没定码就用手上的全部字节定，然后冲刷解码器缓着的尾字节。 */
  end(): void {
    if (this.disposed || this.ended) return
    this.ended = true
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
    // **两个条件都要满足**，密度之外还要至少 2 个坏字符。
    //
    // 只看密度在流式路径下会退化。`oem.ts` 的 0.02 是按**整份 body**（几千字符）调的，
    // 作用是「一两个杂散坏字节不该把一份 UTF-8 构建日志整体翻成 OEM」。但首窗在 300ms
    // 那一档可能只有十几个字符，`1/11 = 0.09` 就过线了 —— 同一串字节实测：
    //
    //   首窗只有一行(11 字符)   → ratio 0.0909 → OEM
    //   全量(2411 字符)         → ratio 0.0004 → utf8
    //
    // 而定码后「永不回头」，于是一个偶发的坏字节就把整条流锁死成乱码。
    // 真正的 OEM 输出坏字符是成片的（实测 ping 的 92 字节窗里有 24 个），而一个中文字
    // 的 GBK 双字节解成 UTF-8 也是 2 个 FFFD —— 所以 `>= 2` 能把两者干净分开。
    //
    // 代价：输出**极短且恰好只产生 1 个 FFFD** 的真 OEM 命令会被解错。用几个字符的乱码，
    // 换掉「整条流永久锁死」这个失败模式，值。
    if (fffd < 2 || fffd / probe.length < OEM_MOJIBAKE_RATIO) return 'utf-8'
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
