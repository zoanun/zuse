import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Run, type RunDeps, type RunEvent } from './run.js'
import type { RunPolicy } from './policy.js'
import type { ShellChildProcess } from '../proc/spawn.js'

afterEach(() => { vi.useRealTimers() })

const POLICY: RunPolicy = {
  wallClockMs: null, idleMs: null, killGraceMs: 50,
  onDetach: 'keep', sink: { kind: 'truncate', budget: 1000 },
}

/**
 * 假子进程。两处刻意的选择：
 *
 * 1. **不起真进程。** 墙钟、空闲、kill 宽限都是分钟级策略，用真进程测要么把测试拖成
 *    几分钟，要么把阈值调到毫秒而失去意义（spec §7.1）。假的能精确触发每条边。
 * 2. **用 EventEmitter 而不是 PassThrough 当 stdout/stderr。** 真流的 `data` 事件走
 *    `process.nextTick`，而 nextTick **不受 vi 的假计时器控制** —— 「写入 → 推进计时器」
 *    这个顺序会变得不确定，测试时红时绿。EventEmitter 的 emit 是同步的。
 */
function makeRun(policy: Partial<RunPolicy> = {}, depsOver: Partial<RunDeps> = {}) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
  proc.stdout = stdout
  proc.stderr = stderr
  proc.pid = 4242

  const killed: number[] = []
  const deps: RunDeps = {
    spawn: () => proc as unknown as ShellChildProcess,
    killTree: (pid: number) => { killed.push(pid) },
    oemLabel: 'gbk',
    ...depsOver,
  }
  const run = new Run({
    id: 'r1', command: 'echo hi', cwd: 'E:/tmp', sessionId: 's1',
    policy: { ...POLICY, ...policy }, deps,
  })
  const events: RunEvent[] = []
  const off = run.subscribe((e) => events.push(e))
  return {
    run, killed, events, off,
    out: (b: Buffer) => stdout.emit('data', b),
    err: (b: Buffer) => stderr.emit('data', b),
    close: (code: number | null) => proc.emit('close', code),
  }
}

const textOf = (events: RunEvent[], stream?: 'out' | 'err') => events
  .filter((e) => e.type === 'chunk' && (!stream || e.stream === stream))
  .map((e) => (e as Extract<RunEvent, { type: 'chunk' }>).text).join('')
const endOf = (events: RunEvent[]) =>
  events.find((e) => e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined

describe('Run —— 输出', () => {
  it('stdout 的字节流成 chunk 事件推给订阅者', () => {
    const { run, events, out, close } = makeRun()
    out(Buffer.from('你好', 'utf8'))
    close(0)
    expect(textOf(events)).toBe('你好')
    expect(run.status).toBe('exited')
  })

  /** 两条流各自定码（spec §3.1）：实测有命令 out 是 UTF-8、err 是 OEM。 */
  it('stdout 与 stderr 各自定码，一条 UTF-8 一条 OEM 也不互相污染', () => {
    const { events, out, err, close } = makeRun()
    out(Buffer.from('中文', 'utf8'))
    err(Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]))            // 「你好」的 GBK
    close(0)
    expect(textOf(events, 'out')).toBe('中文')
    expect(textOf(events, 'err')).toBe('你好')
  })

  it('snapshot() 给中途接入的订阅者补历史', () => {
    const { run, out, close } = makeRun()
    out(Buffer.from('abc'))
    close(0)
    expect(run.snapshot().out).toBe('abc')
    expect(run.snapshot().err).toBe('')
  })
})

describe('Run —— 终止原因是结构化枚举', () => {
  it('正常退出 → reason=exit，带 exitCode', () => {
    const { events, close } = makeRun()
    close(3)
    expect(endOf(events)!.reason).toBe('exit')
    expect(endOf(events)!.exitCode).toBe(3)
  })

  it('墙钟到点 → reason=wall-clock，并真的去杀', () => {
    vi.useFakeTimers()
    const { killed, events, close } = makeRun({ wallClockMs: 200 })
    vi.advanceTimersByTime(199)
    expect(killed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(killed).toEqual([4242])
    close(null)
    expect(endOf(events)!.reason).toBe('wall-clock')       // 不是 'exit' —— UI 要能分开说
  })

  it('输出超预算 → reason=output-cap，并去杀', () => {
    vi.useFakeTimers()
    const { killed, events, out, close } = makeRun({ sink: { kind: 'truncate', budget: 5 } })
    out(Buffer.from('abcdefghij'))
    vi.advanceTimersByTime(300)                            // 让首窗定码、文本进汇
    expect(killed).toEqual([4242])
    close(null)
    expect(endOf(events)!.reason).toBe('output-cap')
  })

  it('ring 档永远不会因为输出多而被杀', () => {
    vi.useFakeTimers()
    const { killed, out } = makeRun({ sink: { kind: 'ring', chars: 5 } })
    out(Buffer.from('abcdefghij'))
    vi.advanceTimersByTime(300)
    expect(killed).toEqual([])
  })
})

describe('Run —— 空闲计时', () => {
  /**
   * 判据是**有字节到达**，不是有可见文本到达。理由是 v4 §3 的实测判据本身就是字节级的
   * （「死循环有输出 6000ms 后仍活着，空闲仅 44ms」）；按可见文本判会误杀只吐
   * `\r` 进度条的构建。这里用「首窗还没定码、一个字符都还没吐出来」那个时刻来钉它。
   */
  it('首窗 buffering 期间（还没吐出任何文本）的字节也重置空闲计时', () => {
    vi.useFakeTimers()
    // windowMs 调很大 = 首窗永远不会因超时而定码，于是「字节到了但一个字符都还没吐出来」
    // 这个状态能被稳稳按住 —— 正是要钉的那一刻。
    const { killed, events, out } = makeRun({ idleMs: 200 }, { windowMs: 10_000 })
    vi.advanceTimersByTime(150)
    out(Buffer.from('x'))                                  // 还在 buffering，尚未产出任何 chunk 事件
    expect(textOf(events)).toBe('')                        // 自证：确实一个字符都没吐
    vi.advanceTimersByTime(150)                            // 距起点 300ms，但距最后字节仅 150ms
    expect(killed).toEqual([])                             // 没被杀 —— 字节重置了计时
    vi.advanceTimersByTime(60)
    expect(killed).toEqual([4242])
  })

  it('一直没有字节 → idleMs 后 reason=idle', () => {
    vi.useFakeTimers()
    const { killed, events, close } = makeRun({ idleMs: 200 })
    vi.advanceTimersByTime(200)
    expect(killed).toEqual([4242])
    close(null)
    expect(endOf(events)!.reason).toBe('idle')
  })
})

describe('Run —— kill 的兑现（spec §7.3）', () => {
  /**
   * `killTree` 是彻底的 fire-and-forget（`tools/src/util.ts`：Windows 上 spawn taskkill
   * 不等结果，POSIX 上只发 SIGTERM、没有 SIGKILL 升级、不验证死没死）。
   * 所以状态机必须自己带宽限与升级，否则「杀掉」只是发了个信号。
   */
  it('宽限期内没死 → 二次 killTree（升级）', () => {
    vi.useFakeTimers()
    const { run, killed } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    expect(killed).toEqual([4242])
    vi.advanceTimersByTime(50)
    expect(killed).toEqual([4242, 4242])
  })

  /**
   * **逐出只在收到 exit 时。** 在调 kill 那一刻就当它死了，会把条目删掉、进程留活 ——
   * 谁也再杀不了它，v4 §2 说的「只有杀 daemon 才能收」原样复发。
   */
  it('kill 之后、进程还没退出之前，状态是 killing 而不是 exited', () => {
    vi.useFakeTimers()
    const { run } = makeRun()
    run.kill('killed')
    expect(run.status).toBe('killing')
    expect(run.endReason).toBeNull()                       // end 还没发
  })

  it('升级之后仍不死 → 转 zombie，并明确发 end（不是静默消失）', () => {
    vi.useFakeTimers()
    const { run, events } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    vi.advanceTimersByTime(50)                             // 升级
    vi.advanceTimersByTime(50)                             // 第二个宽限过去，还是没 close
    expect(run.status).toBe('zombie')
    expect(endOf(events)!.reason).toBe('zombie')
  })

  it('真的退出了 → 用**先前记下的**原因发 end，不被 exit 覆盖', () => {
    vi.useFakeTimers()
    const { run, events, close } = makeRun({ wallClockMs: 100 })
    vi.advanceTimersByTime(100)
    close(null)
    expect(endOf(events)!.reason).toBe('wall-clock')
    expect(run.status).toBe('exited')
  })

  it('end 只发一次（close 来两遍也不重复发）', () => {
    const { events, close } = makeRun()
    close(0)
    close(0)
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1)
  })

  it('已经退出的 run 再 kill 一次：不再发信号、也不再发 end', () => {
    const { run, killed, events, close } = makeRun()
    close(0)
    run.kill('killed')
    expect(killed).toEqual([])
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1)
  })
})

describe('Run —— 订阅与 detach', () => {
  it('订阅者全走光 + onDetach=kill → 杀掉', () => {
    vi.useFakeTimers()
    const { killed, off } = makeRun({ onDetach: 'kill' })
    off()
    expect(killed).toEqual([4242])
  })

  it('订阅者全走光 + onDetach=keep → 不动（项目档要可重连）', () => {
    vi.useFakeTimers()
    const { killed, off } = makeRun({ onDetach: 'keep' })
    off()
    expect(killed).toEqual([])
  })

  it('还有别的订阅者时不算 detach', () => {
    vi.useFakeTimers()
    const { run, killed, off } = makeRun({ onDetach: 'kill' })
    run.subscribe(() => {})
    off()
    expect(killed).toEqual([])
  })

  it('已经结束的 run，订阅者来去不会触发 detach 杀', () => {
    const { run, killed, close } = makeRun({ onDetach: 'kill' })
    close(0)
    const off2 = run.subscribe(() => {})
    off2()
    expect(killed).toEqual([])
  })

  /**
   * `replay` 是 SSE 中途接入时补历史用的。注意断言前要先让首窗定码 ——
   * 定码之前文本还压在解码器里、汇是空的，这是**正确**行为（首字节最多晚 300ms，
   * 见 spec §3.4 的已知代价），不是 bug。第一版这条测试没推进计时器，
   * 断言到的是空串，暴露的是测试自己的问题。
   */
  it('新订阅者立刻收到历史快照，不用等下一个 chunk', () => {
    vi.useFakeTimers()
    const { run, out } = makeRun()
    out(Buffer.from('abc'))
    vi.advanceTimersByTime(300)                            // 首窗定码，文本落进汇
    const seen: RunEvent[] = []
    run.subscribe((e) => seen.push(e), { replay: true })
    expect(textOf(seen, 'out')).toBe('abc')
  })

  it('replay 给已经结束的 run 时，历史之后还要补一条 end', () => {
    const { run, out, close } = makeRun()
    out(Buffer.from('abc'))
    close(0)
    const seen: RunEvent[] = []
    run.subscribe((e) => seen.push(e), { replay: true })
    expect(textOf(seen, 'out')).toBe('abc')
    expect(endOf(seen)!.reason).toBe('exit')               // 否则 SSE 那头会一直等一个永不到来的收尾
  })
})
