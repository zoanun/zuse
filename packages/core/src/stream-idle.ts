/**
 * 流空闲守卫 —— 解决两个一起出现的故障：
 *   1) 上游开流后中途卡死：连接不关、也不再吐数据，`for await` 永久阻塞（界面 spinner 卡住）。
 *   2) 用户按 Esc 想中断，但 AbortSignal 从没接到底层 SDK 请求，所以救不回来。
 *
 * 做法：把「外部中断（用户 Esc）」与「空闲超时（上游静默太久）」合并进同一个 AbortController。
 * 把 {@link signal} 传给底层 SDK 请求（fetch 被 abort 时其异步迭代器会抛错，从而解除 `for await` 阻塞），
 * 再用 {@link tap} 包住返回的流：每收到一个数据块就重置空闲计时。任一条件触发都会中断本次请求。
 *
 * 计时器从守卫创建即开始计，故也覆盖 `create()`/`stream()` 本身挂死（开流前就卡住）的情况。
 */

/** 默认空闲超时：开流前的等待、或两个增量块之间静默超过这么久，判定上游卡死。 */
export const DEFAULT_STREAM_IDLE_MS = 120_000

/** 从环境变量解析空闲超时（毫秒）；未设或非法时回退到默认值。供运维按端点快慢调参/排障。 */
export function resolveStreamIdleMs(): number {
  const raw = process.env.ZUSE_STREAM_IDLE_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STREAM_IDLE_MS
}

export class StreamIdleGuard {
  private ac = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private external?: AbortSignal
  private idle = false
  private readonly onExternalAbort = (): void => this.ac.abort()
  private readonly onIdle = (): void => {
    this.idle = true
    this.ac.abort()
  }

  /**
   * @param idleMs   空闲超时（毫秒）。
   * @param external 外部中断信号（用户 Esc）。已处于 aborted 时立即中断。
   */
  constructor(
    private readonly idleMs: number,
    external?: AbortSignal,
  ) {
    this.external = external
    if (external) {
      if (external.aborted) this.ac.abort()
      else external.addEventListener('abort', this.onExternalAbort, { once: true })
    }
    this.timer = setTimeout(this.onIdle, idleMs)
    // 计时器纯属保活，不应单独拖住进程退出（真正的生命周期由 SDK 请求持有）。
    this.timer.unref?.()
  }

  /** 传给底层 SDK 请求的中断信号（外部中断或空闲超时任一触发都会 abort）。 */
  get signal(): AbortSignal {
    return this.ac.signal
  }

  /** 本次中断是否由空闲超时引起（true），而非外部主动 abort（false）。供调用方区分提示文案。 */
  get timedOut(): boolean {
    return this.idle
  }

  /** 包裹底层流：透传每个数据块，并在块间重置空闲计时。 */
  async *tap<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
    for await (const chunk of stream) {
      // 重新武装计时器：clear+set 而非 refresh()，对「计时器实现」零假设、各运行时都稳。
      clearTimeout(this.timer)
      this.timer = setTimeout(this.onIdle, this.idleMs)
      this.timer.unref?.()
      yield chunk
    }
  }

  /** 释放计时器与外部监听。务必在 finally 调用，避免泄漏与误触发。 */
  dispose(): void {
    clearTimeout(this.timer)
    this.external?.removeEventListener('abort', this.onExternalAbort)
  }
}
