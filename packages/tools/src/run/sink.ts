/**
 * run 的输出汇：把流式文本收下来，并给晚来的订阅者一份可回放的快照。
 *
 * 两档策略（设计 v4 §1 的两档差异表）：
 *
 * |            | truncate（片段档）        | ring（项目档）        |
 * |------------|---------------------------|-----------------------|
 * | 满了怎么办 | 停止收集 + **杀进程**     | 丢最旧的，进程不动    |
 * | overflowed | 满了置 true               | **恒 false**          |
 *
 * `overflowed` 的语义是「**该杀进程了**」，不是「缓冲区放不下了」。ring 档天天在丢字符，
 * 但那是它正常工作的样子 —— 若也置 true，调用方就会去杀一个跑得好好的 dev server。
 *
 * ## 为什么不用 `StreamShaper`
 *
 * 设计 v2 的 §4 写的是「truncate 档 = `StreamShaper` + 调用方自己数字节」。真读完
 * `truncate.ts` 之后改主意了：`StreamShaper` 是为「一次性 `finalize()` + 落盘」造的，
 * **没有中途取快照的能力**（head/tail 都是 private，只有 `finalize()` 吐结果），
 * 而 run 服务恰恰需要给中途接入的 SSE 订阅者补历史。硬套它要么把它改造成两用，
 * 要么在它外面再挂一份缓冲 —— 两条都比这里几十行的有界缓冲贵。
 *
 * **代价**：本模块不落盘。片段档预算内的输出本来就在内存里放得下；项目档要落盘的话
 * 是步骤 4 的事，届时再决定是复用 `StreamShaper` 还是给 ring 加 spill。
 * 写在这里免得后来人以为「忘了落盘」。
 */
export interface OutputSink {
  /** 收一段文本。空串是 no-op。 */
  push(text: string): void
  /** **实际产生**的总字符数 —— 不是快照长度。UI 要能说「已产生 N 字符（只显示前 M）」。 */
  readonly totalChars: number
  /** 「该杀进程了」。ring 档恒 false，见文件头。 */
  readonly overflowed: boolean
  /**
   * 快照第一个字符在「**累计产生**」坐标系里的绝对位置。
   * 持有区间 = `[firstChar, firstChar + snapshot().length)`。
   *
   * **为什么必须由 sink 自己给，而不是调用方用 `totalChars - snapshot().length` 算**：
   * 那个公式假定「丢的一定是前缀」，只对 ring 成立。truncate 留的是**最先来的**、
   * 丢的是尾巴（见下面两个类的 `push`），两档方向相反。
   *
   * 用错的后果特别隐蔽（步骤 5 spec §5.1 推演过）：片段档下按那个公式算出的偏移量，
   * 内容索引**恰好还是连续的**，所以「读到的内容对不对」那类断言全绿；错的只是
   * 「缺口在哪一头」这个说法。于是读的人以为自己读完了全部输出，实际漏掉的是
   * `output-cap` 杀进程之前的收尾 —— 恰恰是「它到底怎么了」的答案所在。
   *
   * 也不要在调用方按 sink 种类 `if/else`：`policy.ts` 的文件头明写这个类型
   * 「不许长出 `kind: 'snippet' | 'project'` 这种判别字段」，那会让读侧知道策略层的实现。
   * 放在接口上，将来第三种 sink 自动正确。
   */
  readonly firstChar: number
  /** 当前可见文本；中途接入的订阅者拿它补历史。 */
  snapshot(): string
}

/** 片段档：收满预算就停手并举旗，由调用方去杀进程。 */
export class TruncateSink implements OutputSink {
  private buf = ''
  private total = 0
  private over = false

  constructor(private readonly budget: number) {}

  get totalChars(): number { return this.total }
  get overflowed(): boolean { return this.over }
  /** 恒 0 —— 它留的是最先来的那一段，开头一个字都没丢。缺口在**尾部**。 */
  get firstChar(): number { return 0 }
  snapshot(): string { return this.buf }

  push(text: string): void {
    if (text === '') return
    this.total += text.length
    const room = this.budget - this.buf.length
    if (room > 0) this.buf += text.slice(0, room)
    // 边界是「**越过**预算」而不是「达到预算」：恰好填满不该触发杀进程 ——
    // 一条输出正好等于预算的命令是跑成功了的，杀它等于把成功报成失败。
    if (this.total > this.budget) this.over = true
  }
}

/** 项目档：环形缓冲，只留最近 capacity 个字符，进程永远不动。 */
export class RingSink implements OutputSink {
  private buf = ''
  private total = 0

  constructor(private readonly capacity: number) {}

  get totalChars(): number { return this.total }
  /** 恒 false —— ring 丢字符是它正常工作的样子，不是「该杀了」。 */
  get overflowed(): boolean { return false }
  /**
   * 丢了多少前缀就前进多少。`capacity: 0` 时 `buf` 恒空、于是 `firstChar === total`，
   * 持有区间退化成空区间 —— 语义仍自洽（「产生的全丢了」），不用特判。
   */
  get firstChar(): number { return this.total - this.buf.length }
  snapshot(): string { return this.buf }

  push(text: string): void {
    if (text === '') return
    this.total += text.length
    if (this.capacity <= 0) return
    // 单次 push 就超过整个容量时，`slice(-capacity)` 直接取尾段，不需要特判。
    this.buf = (this.buf + text).slice(-this.capacity)
  }
}
