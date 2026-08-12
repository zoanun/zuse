import { StreamDecoder } from './stream.js'
import { winOemLabel } from '../proc/oem.js'
import { RingSink, TruncateSink, type OutputSink } from './sink.js'
import type { RunPolicy } from './policy.js'
import type { ShellChildProcess } from '../proc/spawn.js'

/**
 * 终止原因。**必须是枚举，不能是自由文本。**
 *
 * v4 §3 要求「因 30 分钟无输出被停止」这句话必须出现在 UI 上，而 UI 要能按原因给不同
 * 文案（空闲被停 vs 输出太多被停 vs 用户自己按的停），就不能只收到一个字符串。
 *
 * `zombie` = 发了信号、升级过、宽限也过了，进程仍然活着。它**不是**「已结束」的同义词，
 * 而是一个要被明确报出去的失败状态：注册表要留着它、列表里要标出来，
 * 否则那个进程就成了谁也管不到的孤儿。
 */
export type EndReason = 'exit' | 'wall-clock' | 'idle' | 'killed' | 'detach' | 'output-cap' | 'zombie'

export type RunStatus = 'running' | 'killing' | 'exited' | 'zombie'

export type RunEvent =
  | { type: 'chunk'; stream: 'out' | 'err'; text: string }
  | { type: 'end'; reason: EndReason; exitCode: number | null }

/**
 * 外部依赖，**全部注入**。
 *
 * `spawn` / `killTree` 注入是为了能用假子进程测状态机：墙钟、空闲、kill 宽限都是
 * 分钟级策略，用真进程要么把测试拖成几分钟，要么把阈值调到毫秒而失去意义（spec §7.1）。
 */
export interface RunDeps {
  spawn: (command: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }) => ShellChildProcess
  killTree: (pid: number) => void
  /** 传给 StreamDecoder；null = 非 Windows / 代码页未知。默认由 StreamDecoder 那边探测。 */
  oemLabel?: string | null
  /** 首窗参数，仅供测试注入（默认见 StreamDecoder）。 */
  windowBytes?: number
  windowMs?: number
}

export interface RunInit {
  id: string
  command: string
  cwd: string
  sessionId: string
  policy: RunPolicy
  deps: RunDeps
  env?: NodeJS.ProcessEnv
}

/**
 * 一次运行的生命周期状态机。
 *
 * ## 状态迁移
 *
 * ```
 * running ──(close)──────────────────────────► exited
 *    │
 *    └─(kill 任意原因)─► killing ──(close)────► exited
 *                          │
 *                          └─(宽限×2 都过了)──► zombie
 * ```
 *
 * ## 两条不许改的规则
 *
 * 1. **逐出只能发生在收到 `close` 时**，不能在调 kill 那一刻。
 *    `killTree` 是彻底的 fire-and-forget（`tools/src/util.ts`：Windows 上 spawn taskkill
 *    不等结果；POSIX 上只发 SIGTERM、没有 SIGKILL 升级、不验证死没死），
 *    「发了信号」离「死了」还很远。在发信号那刻就把条目删掉 = 进程留活且谁也再找不到它，
 *    v4 §2 说的「只有杀 daemon 才能收」原样复发。
 *
 * 2. **先记下的原因不被后来的 `close` 覆盖。** 墙钟到点把进程杀了，随后收到的 close
 *    是这次 kill 的结果，不是「正常退出」。报成 `exit` 的话 UI 就说不出「因超时被停止」。
 */
export class Run {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly sessionId: string
  readonly policy: RunPolicy
  readonly startedAt = Date.now()

  private readonly deps: RunDeps
  private readonly child: ShellChildProcess
  private readonly subs = new Set<(e: RunEvent) => void>()
  /**
   * **内部订阅者**（注册表用来知道「什么时候结束」的那种），不计入「有没有人在看」。
   *
   * 分成两个集合不是洁癖：注册表在 `start()` 里就订阅了、一直挂到 end 才退，
   * 所以只要用一个集合，运行期间 `subs.size` 永远 ≥ 1，片段档的 `onDetach:'kill'`
   * **就是一段死代码** —— 用户关掉页面，进程不会被收，一路跑到 300 秒墙钟。
   * 这个矛盾原先只写在 registry.ts 的注释里，没有在代码上解决。
   */
  private readonly internalSubs = new Set<(e: RunEvent) => void>()
  private readonly sinks: Record<'out' | 'err', OutputSink>
  private readonly decoders: Record<'out' | 'err', StreamDecoder>

  private _status: RunStatus = 'running'
  private _endReason: EndReason | null = null
  private _exitCode: number | null = null
  /** kill 时记下的原因；close 到来时用它而不是 'exit'。 */
  private pendingReason: EndReason | null = null
  private ended = false
  private wallTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(init: RunInit) {
    this.id = init.id
    this.command = init.command
    this.cwd = init.cwd
    this.sessionId = init.sessionId
    this.policy = init.policy
    this.deps = init.deps

    this.sinks = { out: makeSink(init.policy), err: makeSink(init.policy) }
    this.decoders = {
      out: this.makeDecoder('out'),
      err: this.makeDecoder('err'),
    }

    this.child = init.deps.spawn(init.command, { cwd: init.cwd, env: init.env })
    this.child.stdout.on('data', (b: Buffer) => this.onBytes('out', b))
    this.child.stderr.on('data', (b: Buffer) => this.onBytes('err', b))
    this.child.on('close', (code: number | null) => this.finish(code))
    // spawn 本身失败（ENOENT 之类）走 error 而不是 close。当成一次退出收场，
    // exitCode 记 null —— 调用方能从「没有任何输出 + exitCode null」看出来。
    // 若将来 UI 要把它和正常退出分开说，再给 EndReason 加一档，别在这里塞自由文本。
    this.child.on('error', () => this.finish(null))

    if (init.policy.wallClockMs !== null) {
      this.wallTimer = setTimeout(() => this.kill('wall-clock'), init.policy.wallClockMs)
    }
    this.armIdle()
  }

  get status(): RunStatus { return this._status }
  get endReason(): EndReason | null { return this._endReason }
  get exitCode(): number | null { return this._exitCode }

  /** 当前可见输出。中途接入的订阅者靠它补历史。 */
  snapshot(): { out: string; err: string } {
    return { out: this.sinks.out.snapshot(), err: this.sinks.err.snapshot() }
  }

  /**
   * 订阅事件流，返回退订函数。
   *
   * `replay` = 先把已有输出当成 chunk 事件补给这个订阅者。SSE 的 GET 接进来时要用它，
   * 否则中途接入的人只看得到「从现在起」的输出，前面跑过的全丢。
   */
  subscribe(fn: (e: RunEvent) => void, opts: { replay?: boolean; internal?: boolean } = {}): () => void {
    const set = opts.internal ? this.internalSubs : this.subs
    set.add(fn)
    if (opts.replay) {
      // 这里也走 deliver。**理由和 emit 那条不一样**：replay 是同步跑在 HTTP 请求栈里的，
      // `http/server.ts` 的 `void handle(...).catch(...)` 会接住它，最坏是 500，不会打死进程。
      // 包起来是为了「一个订阅者的毛病不该改变别人看到的东西」—— 半截 replay 之后
      // 订阅仍然留在 set 里，后续事件照收，那才是最难查的状态。
      for (const stream of ['out', 'err'] as const) {
        const text = this.sinks[stream].snapshot()
        if (text) this.deliver(fn, { type: 'chunk', stream, text })
      }
      if (this.ended && this._endReason) this.deliver(fn, { type: 'end', reason: this._endReason, exitCode: this._exitCode })
    }
    return () => {
      if (!set.delete(fn)) return
      // 没人看了 → 片段档杀掉（跑给谁看？），项目档留着（v4 §1 的两档差异之一）。
      // 已经结束的 run 不走这条：没什么可杀的，硬杀会给注册表发一次假的终止。
      // **判据只看 `subs`，不看 `internalSubs`** —— 见 internalSubs 的注释，
      // 把注册表那个常驻订阅算进来的话这个分支永远进不去。
      if (this.subs.size === 0 && this.policy.onDetach === 'kill' && !this.ended) this.kill('detach')
    }
  }

  /**
   * 请求终止。**这只是发信号** —— 状态转 `killing`，真正的结束要等 `close`。
   * 已经在 killing 的不重复发（重复 taskkill 只是噪声），已经结束的直接无视。
   */
  kill(reason: EndReason): void {
    if (this.ended || this._status !== 'running') return
    this._status = 'killing'
    this.pendingReason = reason
    this.clearTimer('wall')
    this.clearTimer('idle')
    this.signal()
    // 宽限到点仍没 close → 升级再杀一次（POSIX 的 SIGTERM 可能被忽略）。
    this.graceTimer = setTimeout(() => {
      this.signal()
      // 第二个宽限还不死，就认了：转 zombie 并明确报出去，不静默消失。
      this.graceTimer = setTimeout(() => this.toZombie(), this.policy.killGraceMs)
    }, this.policy.killGraceMs)
  }

  /** 放弃这个 run（daemon 关停 / 注册表清场）：停表、断订阅，不再产出任何事件。 */
  dispose(): void {
    this.clearTimer('wall'); this.clearTimer('idle'); this.clearTimer('grace')
    this.decoders.out.dispose()
    this.decoders.err.dispose()
    this.subs.clear()
    this.internalSubs.clear()          // 漏掉这个 = 注册表的回调随 run 一起泄漏
  }

  private makeDecoder(stream: 'out' | 'err'): StreamDecoder {
    return new StreamDecoder({
      // **缺省要探测本机代码页，不能缺省成 null。** 早先写的是 `?? null`，
      // 于是 startServer 那边没传时永远判 UTF-8 —— 真跑验证里 `ping 127.0.0.1`
      // 出了 78 个 U+FFFD（"���� Ping ..."）。单测发现不了：测试自己传了 'gbk'。
      // 用 `!== undefined` 而不是 `??`：显式传 null（非 Windows / 不想解 OEM）要被尊重。
      oemLabel: this.deps.oemLabel !== undefined ? this.deps.oemLabel : winOemLabel(),
      ...(this.deps.windowBytes !== undefined ? { windowBytes: this.deps.windowBytes } : {}),
      ...(this.deps.windowMs !== undefined ? { windowMs: this.deps.windowMs } : {}),
      onText: (text) => this.onText(stream, text),
    })
  }

  private onBytes(stream: 'out' | 'err', chunk: Buffer): void {
    // **空闲计时按字节重置，不按可见文本。** 首窗还没定码时一个字符都吐不出来，
    // 但进程明明是活的；而 v4 §3 的实测判据本来就是字节级的（「死循环有输出，空闲仅 44ms」）。
    // 按可见文本判还会误杀只吐 `\r` 进度条的构建。
    this.armIdle()
    this.decoders[stream].write(chunk)
  }

  private onText(stream: 'out' | 'err', text: string): void {
    const sink = this.sinks[stream]
    // **溢出之后就不再往订阅者推了。** kill 是异步的（发信号 ≠ 进程立刻死），这中间
    // 一个刷屏的进程还能吐很多。真跑验证里：预算 5000，实际推给订阅者 **1,020,000 字符** ——
    // 预算形同虚设，SSE 那头照样收 1MB。单测发现不了：假子进程是我一次喂一小块的。
    //
    // 触发溢出的**那一块仍然全推**（用户要看得到出事前的最后一段），之后一块不推。
    // 于是推出去的总量 ≈ 预算 + 一块，而不是「直到进程真死为止的全部输出」。
    const wasOver = sink.overflowed
    sink.push(text)
    if (!wasOver) this.emit({ type: 'chunk', stream, text })
    // truncate 档满了就杀；ring 档的 overflowed 恒 false，永远走不到这里（见 sink.ts）。
    if (sink.overflowed && !wasOver) this.kill('output-cap')
  }

  private armIdle(): void {
    if (this.policy.idleMs === null || this.ended) return
    this.clearTimer('idle')
    this.idleTimer = setTimeout(() => this.kill('idle'), this.policy.idleMs)
  }

  private signal(): void {
    const pid = this.child.pid
    if (typeof pid === 'number') this.deps.killTree(pid)
  }

  private toZombie(): void {
    if (this.ended) return
    this._status = 'zombie'
    this.settle('zombie', null)
  }

  private finish(code: number | null): void {
    if (this.ended) return
    this._status = 'exited'
    // 先前记下的原因优先：墙钟杀出来的 close 不是「正常退出」。
    this.settle(this.pendingReason ?? 'exit', code)
  }

  private settle(reason: EndReason, code: number | null): void {
    this.ended = true
    this._endReason = reason
    this._exitCode = code
    this.clearTimer('wall'); this.clearTimer('idle'); this.clearTimer('grace')
    // 先冲刷解码器 —— 它可能还缓着首窗或半个多字符，那些文本必须排在 end 事件**前面**。
    this.decoders.out.end()
    this.decoders.err.end()
    this.emit({ type: 'end', reason, exitCode: code })
  }

  private emit(e: RunEvent): void {
    // 复制一份再遍历：订阅者的回调里退订自己是完全合法的（SSE 连接断开就会这么干）。
    for (const fn of [...this.subs, ...this.internalSubs]) this.deliver(fn, e)
  }

  /**
   * 投递一个事件给一个订阅者，**异常一律就地拦住**。
   *
   * 这不是防御式编程的洁癖，是真跑复现过的：订阅者 throw 一次，整个 daemon
   * （用户的所有会话）退出码 1 死掉。堆栈：
   * `ChildProcess.close → finish → settle → decoder.end → StreamDecoder.emit → onText → emit → 订阅者`。
   * 这条栈上**没有任何 catch**，而本仓没有 process 级 uncaughtException 兜底
   * （`http/server.ts` 的注释也这么写着，它为 HTTP 那条路径专门加过同样的防护）。
   * 唯一的真实订阅者是 SSE 的 `res.write()` —— 一个写坏的响应能带走用户所有会话。
   *
   * **try/catch 必须在循环体内、每个订阅者一个，不能包整个 for。** `settle()` 里
   * `decoders.end()` 会先触发一轮 chunk 投递，**然后**才 `emit({type:'end'})`；
   * 包整个循环的话，前面一个订阅者在 chunk 上抛，后面所有人连 end 都收不到 ——
   * SSE 那头就是一条永远不收尾的连接。
   *
   * 不做「抛异常就自动退订」：throw 不是「订阅者死了」的证据，而 SSE 真正的断连信号
   * 本来就有（`req.on('close')`）。自动退订会把一次瞬时错误变成永久静默丢数据；
   * 更糟的是片段档 `onDetach:'kill'` 下踢掉最后一个订阅者会直接把进程杀了。
   */
  private deliver(fn: (e: RunEvent) => void, e: RunEvent): void {
    try {
      fn(e)
    } catch (err) {
      // 静默吞 = 「某个订阅者收不到事件」变成查无线索的怪事，正是本仓明令要消灭的失效方式。
      console.error(`[zuse-run] 订阅者回调抛异常 run=${this.id} event=${e.type}`, err)
    }
  }

  private clearTimer(which: 'wall' | 'idle' | 'grace'): void {
    const key = which === 'wall' ? 'wallTimer' : which === 'idle' ? 'idleTimer' : 'graceTimer'
    const t = this[key]
    if (t !== null) { clearTimeout(t); this[key] = null }
  }
}

function makeSink(policy: RunPolicy): OutputSink {
  return policy.sink.kind === 'truncate'
    ? new TruncateSink(policy.sink.budget)
    : new RingSink(policy.sink.chars)
}
