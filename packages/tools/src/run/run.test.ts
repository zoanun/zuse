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
  // 补一个 no-op `resume`：收尾时 `proc/settle.ts` 会对流做「摘 data 监听 + resume」
  // （**不是 destroy** —— destroy 会让孙进程拿 EPIPE 自杀）。EventEmitter 没有 resume，
  // 不补的话这里会以 `s.resume is not a function` 变红。故意补在假货这一侧、
  // 不在生产代码里加 `typeof s.resume === 'function'` 之类的守卫：那种守卫会把
  // 「传错了对象」这种真错误静默吞掉。
  const stdout = Object.assign(new EventEmitter(), { resume: () => {} })
  const stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number }
  proc.stdout = stdout
  proc.stderr = stderr
  proc.pid = 4242

  const killed: number[] = []
  // 记录每次杀的强度：第二轮宽限必须是 hard（SIGKILL），重发 SIGTERM 不算升级。
  const killLog: Array<'soft' | 'hard'> = []
  const deps: RunDeps = {
    spawn: () => proc as unknown as ShellChildProcess,
    killTree: (pid: number) => { killed.push(pid); killLog.push('soft') },
    killTreeHard: (pid: number) => { killed.push(pid); killLog.push('hard') },
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
    run, killed, killLog, events, off,
    out: (b: Buffer) => stdout.emit('data', b),
    err: (b: Buffer) => stderr.emit('data', b),
    close: (code: number | null) => proc.emit('close', code),
    exit: (code: number | null) => proc.emit('exit', code, null),
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

  /**
   * **真跑验证抓到的缺陷，单测原先照不出来。**
   *
   * kill 是异步的（发信号 ≠ 进程立刻死），这中间一个刷屏的进程还能吐很多。
   * 真跑实测：预算 5000，实际推给订阅者 **1,020,000 字符** —— 预算形同虚设，
   * SSE 那头照样收 1MB。假子进程发现不了，因为测试是我一次喂一小块的。
   */
  it('溢出之后不再往订阅者推（否则预算只管快照、不管推送量）', () => {
    vi.useFakeTimers()
    const { events, out } = makeRun({ sink: { kind: 'truncate', budget: 5 } }, { windowBytes: 1 })
    out(Buffer.from('abcdefghij'))                         // 一次就溢出，这块仍全推
    vi.advanceTimersByTime(1)
    const afterFirst = textOf(events).length
    out(Buffer.from('X'.repeat(1000)))                     // 溢出之后的，一个字符都不该推
    vi.advanceTimersByTime(1)
    expect(textOf(events).length).toBe(afterFirst)
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

  /**
   * 设计审计（2026-08-14）：「升级重杀」调的是**同一个** `killTree`（POSIX = SIGTERM），
   * 而它的注释写着「POSIX 的 SIGTERM 可能被忽略」—— 自陈要防的东西，手段上防不住。
   * 对 trap / ignore 掉 SIGTERM 的进程，重发 N 次与发 1 次完全等效。
   *
   * WSL Ubuntu 上用**本仓 kill-tree.ts 的产品代码**实测（不是等价脚本）：
   *   killTree 第 1 次之后: ALIVE / 第 2 次之后: ALIVE / SIGKILL 之后: DEAD(ESRCH)
   * vite / webpack / nodemon 都 trap SIGTERM，所以这不是边角情况。
   */
  it('第二轮宽限必须是硬杀（重发 SIGTERM 不算升级）', () => {
    vi.useFakeTimers()
    const { run, killLog } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    expect(killLog).toEqual(['soft'])       // 第一刀给 graceful shutdown 留机会
    vi.advanceTimersByTime(50)
    expect(killLog).toEqual(['soft', 'hard'])
  })

  /**
   * **zombie 曾经是不可逆终态。** `_status` 全文件只有三个写点，回到 `'exited'` 那条
   * 在 `finish()` 里、而 `finish()` 开头是 `if (this.ended) return`，`toZombie()`
   * 已经把 ended 置真 —— 于是进程后来真死了，状态也回不去。
   * 而 `isLive()` 把 zombie 算成活的、直接卡 `maxConcurrent`（默认 8）。
   * 链条：POSIX 上一个 trap 了 SIGTERM 的 dev server → 两轮 SIGTERM 无效 → zombie
   * → 永久占额度 → 攒够 8 个，run 服务对整个 daemon 失效，只能重启。
   *
   * 自愈点放在 `onProcessExit()` 而不是探活定时器：`settle()` 不 cancel settleHandle
   *（那只在 dispose 里），所以 zombie 之后 `child.on('exit')` 仍然挂着。
   */
  it('zombie 会自愈：进程后来真死了 → 状态降级成 exited，原因保留 zombie', () => {
    vi.useFakeTimers()
    const { run, exit } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(50)
    expect(run.status).toBe('zombie')

    exit(137)                                // 进程终于死了
    expect(run.status).toBe('exited')
    // 原因**不改写**：它确实是从 zombie 恢复的，不是一次正常退出。
    expect(run.endReason).toBe('zombie')
  })

  /**
   * 收尾改判 `exit` 之后新出现的一个窗口，**必须堵住**。
   *
   * 对外的 end 事件推迟到 `exit + drainMs`（等 close 冲刷）。若「进程死了」这件事也
   * 跟着推迟，那么 exit 落在 `[kill + 2×grace − drainMs, kill + 2×grace)` 里时，
   * 第二个宽限会先到 → `toZombie()` → `ended = true` → 随后真正的 `finish(code)` 被吞。
   * 结果：一条**已经正常退出**的 run 被记成 zombie，而 `isLive()` 把 zombie 算成活的
   * → **永久占一个并发额度**，正是本次改动要修的那个失效模式，从另一个门回来。
   *
   * 堵法是 `onExit`：exit 那一刻同步停掉宽限表。于是 zombie 的判据从「close 没来」
   * 变成「发了信号还等不到 exit」= 进程真的杀不掉。
   */
  it('exit 落在第二个宽限窗口里 → 是正常退出，不得判成 zombie', () => {
    vi.useFakeTimers()
    const { run, events, exit } = makeRun({ killGraceMs: 300 })
    run.kill('killed')
    vi.advanceTimersByTime(300)      // 升级重杀
    vi.advanceTimersByTime(299)      // 第二个宽限还差 1ms 到点
    exit(0)                          // 进程此刻真的退出了（close 被孙进程压着，不来）
    vi.advanceTimersByTime(1)        // 原来的实现会在这一刻 toZombie()
    expect(run.status).not.toBe('zombie')
    // **被 kill 的路径用的是更宽的 drain（1500ms，不是 250ms）。** 实测 killTree 之后
    // Δ 可达 694ms，且 exit+250ms 时手上一个字节都没有 —— 给 250ms 等于把「被停止那
    // 一刻的现场」整个丢掉。这条断言顺带锁住了那个分档。
    vi.advanceTimersByTime(250)
    expect(run.status).not.toBe('exited')   // 250ms 还不够
    vi.advanceTimersByTime(1250)
    expect(run.status).toBe('exited')
    expect(endOf(events)!.reason).toBe('killed')   // 原因仍是先前记下的那个
    expect(endOf(events)!.exitCode).toBe(0)
  })

  /**
   * `killGraceMs` 很小时，两个宽限都排在 drain 窗口之内 —— 只要 `exit` 在它们之前到，
   * 就不能判 zombie。（`onProcessExit` 清表是主机制；`toZombie` 里那道
   * `processExited` 守卫是第二道，两道都在。）
   */
  it('killGraceMs 很小时，exit 先到就不得判成 zombie', () => {
    vi.useFakeTimers()
    const { run, events, exit } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    vi.advanceTimersByTime(40)       // 第一个宽限还没到
    exit(0)
    vi.advanceTimersByTime(3000)
    expect(run.status).toBe('exited')
    expect(endOf(events)!.exitCode).toBe(0)
  })

  /**
   * **这条以前是「已知限制」，2026-08-14 设计审计之后修掉了。**
   *
   * 原来的说法：两个宽限都过完 `exit` 才姗姗来迟时，状态**不会**被回改成 exited，
   * 理由是「end 事件已经发出去了，收回来会让订阅者看到『结束了两次』」。
   *
   * 那个理由只对**事件**成立，不对**状态**成立 —— 而真正咬人的是状态：
   * `isLive()` 把 zombie 算成活的、直接卡 `maxConcurrent`（默认 8），
   * 于是每个 zombie 永久吃掉一个额度，攒够 8 个 run 服务对整个 daemon 失效。
   *
   * 现在的契约：进程真死了 → `status` 降级成 `exited`，
   * 但**不补发任何事件**（订阅者仍然只看到一次 end），`endReason` 也保持 `zombie`
   *（它确实是从 zombie 恢复的，这个事实要留给 UI 和排查）。
   * 两全：不重复发事件，也不永久吃额度。
   */
  it('宽限都过完 exit 才到 → 状态自愈成 exited，但不补发事件', () => {
    vi.useFakeTimers()
    const { run, events, exit } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    vi.advanceTimersByTime(100)      // 两个宽限都过完 → 已判 zombie
    expect(run.status).toBe('zombie')
    const endCount = events.filter((e) => e.type === 'end').length
    expect(endCount).toBe(1)

    exit(0)
    vi.advanceTimersByTime(3000)
    expect(run.status).toBe('exited')                       // 额度还回去了
    expect(run.endReason).toBe('zombie')                    // 但事实不抹掉
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1)  // 没有「结束了两次」
  })

  /**
   * drain 窗口里进程已经死了，但状态还是 `running`、`ended` 还是 false ——
   * 那时 `registry.stop()` / `closeAll()` / output-cap / detach 都还能调 `kill()`。
   * 进来的后果:① `signal()` 打在**已死的 pid** 上（POSIX 是 `process.kill(-pid)`，
   * 组空了 pgid 可复用 → 误杀无关进程组）;② 正常退出被记成 `killed`。
   */
  it('drain 窗口里再调 kill：不发信号、不改原因', () => {
    vi.useFakeTimers()
    const { run, killed, events, exit } = makeRun()
    exit(0)
    expect(run.status).toBe('running')   // 还没对外收尾
    run.kill('killed')
    expect(killed).toEqual([])           // **没有对着死 pid 发信号**
    vi.advanceTimersByTime(250)
    expect(run.status).toBe('exited')
    expect(endOf(events)!.reason).toBe('exit')   // 不是 'killed'
  })

  /**
   * 「孙进程还握着管道」= 后台还有东西在跑。不报出来的话用户看到的是
   * 「运行结束、退出码 0」，而那个 dev server 还占着端口。
   */
  it('close 没来、靠 drain 收尾 → 标记出「后台还有东西在跑」', () => {
    vi.useFakeTimers()
    const { run, exit, close } = makeRun()
    exit(0)
    vi.advanceTimersByTime(250)
    expect(run.hasOrphan).toBe(true)

    const b = makeRun()
    b.close(0)                            // 正常收尾（close 到了）
    expect(b.run.hasOrphan).toBe(false)
    void close
  })

  /** 反面：进程**真的**杀不掉（exit 一直不来）时，zombie 这一档必须仍然生效。 */
  it('信号发了、宽限过了、exit 一直不来 → 仍然判 zombie', () => {
    vi.useFakeTimers()
    const { run, events } = makeRun({ killGraceMs: 50 })
    run.kill('killed')
    vi.advanceTimersByTime(100)
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

/**
 * 订阅者的异常**不许溢出到投递方**。
 *
 * 这不是防御式编程的洁癖，是真跑复现过的：一个订阅者 throw，整个 daemon（所有会话）
 * 退出码 1 死掉。堆栈是
 * `ChildProcess.close → finish → settle → decoder.end → StreamDecoder.emit → Run.onText → Run.emit → 订阅者`，
 * 而本仓**没有任何 process 级 uncaughtException 兜底**（server.ts 的注释也这么写着），
 * 所以 Node 的默认行为就是终止进程。
 *
 * 唯一的真实订阅者是 SSE 推流里的 `res.write()` —— 一个写坏的响应能带走用户所有会话。
 */
describe('Run —— 订阅者异常不得掀掉投递方', () => {
  /** 坏订阅者排在前面：它不但不能带走进程，也不能挡住排在后面的人。 */
  it('一个订阅者抛异常，事件仍然送达其余订阅者，且不传播给调用方', () => {
    const { run, out, close } = makeRun()
    const seen: RunEvent[] = []
    run.subscribe(() => { throw new Error('订阅者炸了') })
    run.subscribe((e) => seen.push(e))
    expect(() => { out(Buffer.from('abc')); close(0) }).not.toThrow()
    expect(textOf(seen, 'out')).toBe('abc')
    expect(endOf(seen)!.reason).toBe('exit')
  })

  /** replay 分支是**另一条**同步调用路径，单独守：它在 HTTP 请求线程里跑。 */
  it('replay 时抛异常也不传播（这条走的是 subscribe 里另一处 fn 调用）', () => {
    const { run, out, close } = makeRun()
    out(Buffer.from('abc'))
    close(0)
    expect(() => run.subscribe(() => { throw new Error('replay 炸了') }, { replay: true })).not.toThrow()
  })

  /**
   * **不许静默吞。** 吞掉异常等于把「某个订阅者收不到事件」变成没有任何线索的怪事，
   * 正是本仓 CLAUDE.md 点名要消灭的「运行期神秘失效」。
   *
   * 为什么是裸 `console.error` 而不是可注入的钩子（评审拍板）：全仓没有 logger 抽象，
   * server 包的房规就是裸 `console.warn('[zuse-server] …')`；而可选钩子在只有一个消费者时
   * 是投机性抽象，且「忘了注入 = 退回静默」恰好就是它要避免的失效。它是纯加法字段，
   * 真出现第二个消费者时零成本补上。
   */
  it('异常写到 console.error 并带上 run id，不静默吞掉', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { run, out, close } = makeRun()
      run.subscribe(() => { throw new Error('订阅者炸了') })
      out(Buffer.from('abc'))
      close(0)
      expect(spy).toHaveBeenCalled()
      // 带 run id 才查得出是哪一条运行出的事；只打一个 Error 对象等于让人对着堆栈猜。
      expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('r1')
    } finally { spy.mockRestore() }
  })
})

/**
 * 读取口（步骤 5 落地 2）。`RunOutput` 工具要靠它把「服务端持有哪一段原始字符」
 * 一次拿全，游标才对得齐。
 */
describe('Run.read —— 每流各自的原始坐标', () => {
  it('两条流各有各的计数，互不干扰', () => {
    vi.useFakeTimers()
    const { run, out, err } = makeRun()
    out(Buffer.from('hello'))
    err(Buffer.from('E'))
    // 首窗定码之前字节还压在解码器里、没进 sink —— 与本文件其它用例同一个前提。
    vi.advanceTimersByTime(300)
    expect(run.read('out').totalChars).toBe(5)
    expect(run.read('err').totalChars).toBe(1)
    expect(run.read('out').text).toBe('hello')
    expect(run.read('err').text).toBe('E')
  })

  /**
   * **`firstChar` 必须由 sink 给，不能让调用方用 `totalChars - text.length` 算。**
   * 那个公式假定「丢的一定是前缀」—— 只对 ring 成立；truncate 留的是最先来的、丢的是尾巴。
   * 算错的后果是把「尾部丢了」报成「开头丢了」，而且测试全绿（v1 被评审推翻的正是这条）。
   */
  it('truncate 档：丢的是尾巴，firstChar 仍然是 0', () => {
    vi.useFakeTimers()
    const { run, out } = makeRun({ sink: { kind: 'truncate', budget: 4 } })
    out(Buffer.from('abcdefgh'))
    vi.advanceTimersByTime(300)
    const r = run.read('out')
    expect(r.firstChar).toBe(0)                 // 开头一个字符都没丢
    expect(r.totalChars).toBe(8)                // 但确实产生了 8 个
    expect(r.text.length).toBeLessThanOrEqual(4)
    // 反面：那个错误公式会算出 4，等于谎称「前 4 个字符丢了」。
    expect(r.totalChars - r.text.length).not.toBe(r.firstChar)
  })

  it('ring 档：丢的是前缀，firstChar 跟着前进', () => {
    vi.useFakeTimers()
    const { run, out } = makeRun({ sink: { kind: 'ring', chars: 4 } })
    out(Buffer.from('abcdefgh'))
    vi.advanceTimersByTime(300)
    const r = run.read('out')
    expect(r.totalChars).toBe(8)
    expect(r.firstChar).toBe(8 - r.text.length)  // ring 下这个公式才成立
    expect(r.text).toBe('efgh')
  })
})
