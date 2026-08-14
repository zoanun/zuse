import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { onChildSettled } from './settle.js'
import type { ShellChildProcess } from './spawn.js'

/**
 * 假 child：真流 + 可手动触发 exit/close。用真 `Readable` 而不是 EventEmitter，
 * 因为收尾要对流做 `removeAllListeners('data')` + `resume()`，那是流才有的行为，
 * 拿 EventEmitter 假装会把「有没有真的停止收集」这条测掉。
 */
function fakeChild(): ShellChildProcess & {
  exit(code: number | null, signal?: NodeJS.Signals | null): void
  close(code: number | null, signal?: NodeJS.Signals | null): void
} {
  const c = new EventEmitter() as unknown as ShellChildProcess & { exit: unknown; close: unknown }
  const mk = (): Readable => new Readable({ read() { /* 手动 push */ } })
  Object.assign(c, {
    stdout: mk(),
    stderr: mk(),
    stdin: null,
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => c.emit('exit', code, signal),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => c.emit('close', code, signal),
  })
  return c as never
}

describe('onChildSettled', () => {
  /**
   * 正常命令走这条：实测 exit→close 的 Δ 恒为 0ms。
   * 不锁住「不等 drainMs」的话，「一律等满 250ms」的实现也全绿 —— 每条命令白加 250ms。
   */
  it('close 先到 → 立刻收尾，drained:true，不等 drainMs', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb)
    c.exit(0)
    c.close(0)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]![0]).toEqual({ code: 0, signal: null, drained: true })
    vi.useRealTimers()
  })

  /** 这是本次修复的本体：孙进程握着管道，close 永不到达。 */
  it('exit 后 close 不来 → drainMs 到点收尾，drained:false，退出码来自 exit', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb)
    c.exit(7)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(249)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]![0]).toEqual({ code: 7, signal: null, drained: false })
    vi.useRealTimers()
  })

  it('回调至多一次 —— 姗姗来迟的 close 不得再触发一次', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb)
    c.exit(0)
    vi.advanceTimersByTime(250)
    c.close(0)
    expect(cb).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  /**
   * `bash.ts` 的 `code === null` 分支要打印 `[killed by signal: X]`。不透传就是
   * `undefined`。Windows 上不易发现（taskkill 走 exit code 1），**POSIX 上
   * SIGTERM/SIGKILL 天天走这条**。
   */
  it('signal 透传（两条路径都要）', () => {
    vi.useFakeTimers()
    for (const via of ['close', 'exit'] as const) {
      const c = fakeChild()
      const cb = vi.fn()
      onChildSettled(c, { drainMs: 250 }, cb)
      c.exit(null, 'SIGTERM')
      if (via === 'close') c.close(null, 'SIGTERM')
      else vi.advanceTimersByTime(250)
      expect(cb.mock.calls[0]![0].signal).toBe('SIGTERM')
    }
    vi.useRealTimers()
  })

  /**
   * `onExit` 存在的唯一理由：run.ts 要在 exit 那一刻**立刻**清掉 kill 的 grace 定时器。
   * 晚 250ms 的话，exit 落在 [kill+5750ms, kill+6000ms) 会先被判成 zombie，
   * 而 zombie 永久占一个并发额度 —— 本次要修的失效模式从另一个门回来。
   */
  it('onExit 在 exit 事件里同步触发，且早于 cb', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const order: string[] = []
    onChildSettled(c, { drainMs: 250, onExit: () => order.push('onExit') }, () => order.push('cb'))
    c.exit(0)
    expect(order).toEqual(['onExit'])   // 同步：exit 一返回就已经跑过了
    vi.advanceTimersByTime(250)
    expect(order).toEqual(['onExit', 'cb'])
    vi.useRealTimers()
  })

  it('spawn 失败：exit 不来、close 带 -4058 —— helper 仍然要收尾一次', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb)
    c.close(-4058)   // 实测 ENOENT 的真实形态：只有 error + close，没有 exit
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]![0]).toEqual({ code: -4058, signal: null, drained: true })
    vi.useRealTimers()
  })

  it('cancel() 之后计时器不再触发（Run.dispose 要用它）', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    const h = onChildSettled(c, { drainMs: 250 }, cb)
    c.exit(0)
    h.cancel()
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  /**
   * **这两条才是 `cancel()` 的真实时序。** 第一版只 `clearTimeout`，于是只有
   * 「先 exit 再 cancel」那一种能过 —— 而 `cancel()` 的存在理由是 `Run.dispose()`，
   * 真实的 dispose 时机是 **run 还在跑的时候**，也就是 cancel 在 exit **之前**。
   * 那时计时器还没起，clear 了个空，随后 exit/close 照样回调，
   * 「dispose 之后不再产出任何事件」的承诺在真实时机上不成立。
   */
  it('cancel() 在 exit 之前 —— 之后的 exit 也不得回调', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb).cancel()
    c.exit(0)
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('cancel() 之后 close 到达也不得回调', () => {
    const c = fakeChild()
    const cb = vi.fn()
    onChildSettled(c, { drainMs: 250 }, cb).cancel()
    c.close(0)
    expect(cb).not.toHaveBeenCalled()
  })

  /**
   * `drainMs` 在 `exit` 事件里求值，所以调用方能按「是不是被我们杀的」分档。
   * **必须分档**：实测 killTree 之后 Δ 可达 694ms，且 exit+250ms 时手上一个字节都没有 ——
   * 给 250ms 等于把超时命令的 partial output 整个丢掉，而那正是最需要它的时刻。
   */
  it('drainMs 可以是函数，在 exit 那一刻求值', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    const cb = vi.fn()
    let wide = false
    onChildSettled(c, { drainMs: () => (wide ? 1500 : 250) }, cb)
    wide = true                      // 求值发生在 exit 时，所以这个改动要生效
    c.exit(0)
    vi.advanceTimersByTime(250)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1250)
    expect(cb).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  /**
   * 这套判据成立的前提是消费者一直 flowing。有人 `pause()` 过就意味着
   * **收尾那一刀会静默丢一截输出** —— 全仓今天没人这么干，但这是本次改动里唯一一条
   * 「违反了全部测试都绿、后果是静默丢数据」的约束，不能只活在注释里。
   */
  it('流被 pause 过 → 收尾时告警（唯一一条违反后果是静默丢数据的约束）', async () => {
    const c = fakeChild()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    c.stdout.on('data', () => {})
    c.stdout.pause()
    onChildSettled(c, { drainMs: 10 }, () => {})
    c.exit(0)
    await new Promise((r) => setTimeout(r, 40))
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('pause')
    warn.mockRestore()
  })

  /**
   * **方向极其容易写反。** v1 的设计写的是 `destroy()`，实测那会让孙进程写 stdout
   * 拿 EPIPE **自杀** —— `pnpm dev &` 起的后台进程会在 exit+250ms 无声死掉，
   * 而用户看到的是「done」秒回。所以这里断言的是**没有被 destroy**。
   */
  it('收尾后停止收集，但流不得被 destroy（destroy 会打死用户的后台进程）', async () => {
    // 真定时器：`Readable.push` 是经 nextTick 投递的，用假定时器会让「投递了没有」
    // 这件事变得不可观测 —— 而那正是这条要测的东西。
    const c = fakeChild()
    const seen: string[] = []
    c.stdout.on('data', (b: Buffer) => seen.push(b.toString()))
    onChildSettled(c, { drainMs: 10 }, () => {})
    c.stdout.push('before')
    await new Promise((r) => setTimeout(r, 0))
    c.exit(0)
    await new Promise((r) => setTimeout(r, 40))
    c.stdout.push('after')
    await new Promise((r) => setTimeout(r, 10))

    expect(c.stdout.destroyed).toBe(false)
    expect(c.stderr.destroyed).toBe(false)
    expect(c.stdout.listenerCount('data')).toBe(0)
    expect(seen.join('')).toBe('before')   // 'after' 被读完即丢，没有进回调、也没有堆积
  })

  /**
   * 流上没有 'error' 监听者时 node 直接 throw，而调用点在定时器回调栈上、没有任何
   * catch，本仓也没有 process 级兜底 —— 整机级。同 `util.ts` 里 killTree 那条教训。
   */
  it('收尾后流上仍有 error 监听 —— 没有的话一次管道错误打死整个 daemon', () => {
    vi.useFakeTimers()
    const c = fakeChild()
    onChildSettled(c, { drainMs: 250 }, () => {})
    c.exit(0)
    vi.advanceTimersByTime(250)
    expect(c.stdout.listenerCount('error')).toBeGreaterThan(0)
    expect(c.stderr.listenerCount('error')).toBeGreaterThan(0)
    expect(() => c.stdout.emit('error', new Error('EPIPE'))).not.toThrow()
    vi.useRealTimers()
  })
})
