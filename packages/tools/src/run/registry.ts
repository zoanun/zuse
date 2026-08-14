import { randomUUID } from 'node:crypto'
import { Run, type EndReason, type RunDeps, type RunStatus } from './run.js'
import type { RunPolicy } from './policy.js'

/** 超过并发上限。HTTP 层据此回 429（而不是 500 —— 这是「稍后再试」，不是「坏了」）。 */
export class RunLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`同时在跑的命令已达上限 ${limit} 个，先停掉一个再试`)
    this.name = 'RunLimitError'
  }
}

export interface RunSummary {
  id: string
  command: string
  cwd: string
  sessionId: string
  status: RunStatus
  /** 人话标签；缺省 undefined，消费方回落到 `command`。 */
  label: string | undefined
  endReason: EndReason | null
  exitCode: number | null
  startedAt: number
  /**
   * 结束时管道还被别人握着 = 有东西还在后台跑（占端口、占锁、写盘）。
   * 与 `endReason` 正交：正常退出也可能留孤儿，所以是独立字段而不是一个 reason 档。
   */
  orphaned: boolean
}

export interface RunRegistryOptions {
  deps: RunDeps
  /**
   * 同时在飞的上限。v4 §2 提到「永久占住一个并发额度」却没定义额度是多少，这里补上。
   * 8 是拍的：本机 CPU 核数量级，够并行跑几个构建，又不至于让用户连点几十下把机器打满。
   */
  maxConcurrent?: number
  /** 已结束的 run 保留多少条（供补历史、看退出码）。超出按结束顺序丢最早的。 */
  maxFinished?: number
}

export interface StartRunInit {
  command: string
  cwd: string
  sessionId: string
  policy: RunPolicy
  env?: NodeJS.ProcessEnv
  /**
   * 人话标签（`planExec` 给的「用 uv 跑 Python」之类）。
   *
   * 给模型看的：`command` 是一条真实命令（可能很长、带绝对路径和临时目录），
   * 而模型在列表里要认出「哪个是我刚起的那个」。`label` 缺省时列表回落到 `command`，
   * 所以它是纯增量，不传也不会坏。
   */
  label?: string
}

/**
 * runId → 在飞的 run。
 *
 * ## 必须**注入**，不能做成模块级单例
 *
 * 两条依据：
 *
 * 1. 服务端现有约定全是注入 —— `makeRequestHandler(deps)`、`attachWsServer(httpServer, deps)`，
 *    没有一处模块级服务单例。
 * 2. 模块级单例在本仓已经咬过人：`Shell.tsx` 里那句「`activePreview` 是模块级单例，
 *    **在此之前没有任何人在切会话时清它**」，为收拾残局 `ActiveRun` 被迫加了 `sessionId`
 *    字段，还要配一条 `useEffect(() => closeRun(), [currentSessionId])`。
 *
 * 服务端单例还多一层代价：同一个 vitest worker 里的用例会共享注册表状态，
 * **而且会把真子进程漏给下一个用例**。
 *
 * ## 逐出时机
 *
 * 结束的 run **不立刻删**：SSE 那头可能刚要接进来补历史，`GET /api/runs` 也要能显示
 * 「上一条跑完了、退出码是几」。但也不能无限留，所以按结束顺序保留最近 `maxFinished` 条。
 * **在飞的永远不参与淘汰** —— 淘汰掉一个还在跑的 run 就等于把它变成孤儿进程。
 */
export class RunRegistry {
  private readonly runs = new Map<string, Run>()
  /** 已结束 run 的 id，按结束**先后**排；淘汰从队头取。 */
  private readonly finished: string[] = []
  private readonly deps: RunDeps
  private readonly maxConcurrent: number
  private readonly maxFinished: number
  private closed = false

  constructor(opts: RunRegistryOptions) {
    this.deps = opts.deps
    this.maxConcurrent = opts.maxConcurrent ?? 8
    this.maxFinished = opts.maxFinished ?? 20
  }

  start(init: StartRunInit): Run {
    if (this.closed) throw new Error('注册表已关停，不再接受新的运行')
    if (this.liveCount() >= this.maxConcurrent) throw new RunLimitError(this.maxConcurrent)

    const id = randomUUID()
    const run = new Run({ ...init, id, deps: this.deps })
    this.runs.set(id, run)
    // 订阅只为了知道它什么时候结束。**这个订阅不能算进「有没有人在看」** ——
    // 否则片段档的 `onDetach:'kill'` 永远触发不了（注册表自己永远在订阅）。
    //
    // 这条约束原先只写在注释里、代码并没有实现它：Run 的 detach 判据是 `subs.size === 0`，
    // 而这个订阅一直挂到 end 才退，于是运行期间 size 永远 ≥ 1 —— **`onDetach:'kill'` 是死代码**。
    // 后果是用户关掉页面后片段进程照跑，一直到 300 秒墙钟。`internal: true` 把它放进
    // 单独的集合，判据才真的成立（有测试守着，别改回去）。
    const off = run.subscribe((e) => {
      if (e.type !== 'end') return
      off()
      this.onFinished(id)
    }, { internal: true })
    return run
  }

  get(id: string): Run | undefined { return this.runs.get(id) }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => ({
      id: r.id, command: r.command, label: r.label, cwd: r.cwd, sessionId: r.sessionId,
      status: r.status, endReason: r.endReason, exitCode: r.exitCode, startedAt: r.startedAt,
      orphaned: r.hasOrphan,
    }))
  }

  /**
   * 发终止信号。**不删条目** —— 删除只在收到 close 之后（见 run.ts 的两条规则）。
   * 返回 false = 没有这个 id。
   */
  stop(id: string, reason: EndReason = 'killed'): boolean {
    const run = this.runs.get(id)
    if (!run) return false
    run.kill(reason)
    return true
  }

  /** 杀掉某个会话名下所有在飞的 run，返回杀了几个。删会话时用，免得留下孤儿。 */
  killSession(sessionId: string): number {
    let n = 0
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId || !isLive(run.status)) continue
      run.kill('killed')
      n++
    }
    return n
  }

  /** daemon 关停：杀掉全部在飞的，并拒绝新的。 */
  closeAll(): void {
    this.closed = true
    for (const run of this.runs.values()) {
      if (isLive(run.status)) run.kill('killed')
    }
  }

  /**
   * 彻底拆掉：先发信号，再把每条 run 的定时器与订阅全停掉。
   *
   * **`closeAll()` 单独用不够。** 它只发信号 —— 而 `kill()` 会排两级 `killGraceMs`
   * 宽限表，进程若一直不给 `close`（关停时很正常），那两个定时器会在 3 秒、6 秒后
   * 各醒一次，对着**已经没人管的 run** 再 `signal()` 一遍。
   *
   * 这在测试里表现为一类极难查的串扰：`runsRoutes.test.ts` 的 `killTree` 假件往一个
   * **模块级**数组里 push，而那个数组每个用例 `beforeEach` 换新的 —— 于是上一个用例
   * 留下的宽限定时器会把 pid 塞进**下一个用例**的数组，让一条毫不相干的断言
   * 「前置：有人看着的时候不许杀」随机变红。实测约 1/6 的概率。
   *
   * 生产侧影响小但同源：daemon 关停后那几个定时器还吊着事件循环。
   */
  disposeAll(): void {
    this.closeAll()
    for (const run of this.runs.values()) run.dispose()
    this.runs.clear()
    this.finished.length = 0
  }

  /**
   * 在飞的数量。**zombie 也算** —— 它的语义是「信号发了、升级也发了，进程还活着」，
   * 那个进程还在占系统资源。不算的话，一串杀不掉的进程会被无限放行。
   */
  private liveCount(): number {
    let n = 0
    for (const run of this.runs.values()) if (isLive(run.status)) n++
    return n
  }

  private onFinished(id: string): void {
    this.finished.push(id)

    // **zombie 会同时出现在 `finished` 里又还活着**：它发过 end（所以进了这个队列），
    // 但进程没死（所以 isLive 为真）。对它有两条要求，缺一不可：
    //
    // 1. **不能删。** 删掉 = 那个还在跑的进程从此谁也找不到，正是 run.ts 第一条规则要防的事。
    // 2. **不占保留额度、也不挡住淘汰。** 额度只数真正结束的；遇到 zombie 要跳过继续往后找。
    //    早先写成「遇到活的就 break」，队头卡一个杀不掉的 zombie 会让淘汰彻底停摆；
    //    而把 zombie 算进额度，则会把正常结束的记录挤光（maxFinished=1 时一个都留不下）。
    //    两个坑都是变异测试发现这段没覆盖、顺着查出来的。
    const isDead = (fid: string): boolean => {
      const run = this.runs.get(fid)
      return !!run && !isLive(run.status)
    }
    let excess = this.finished.filter(isDead).length - this.maxFinished
    if (excess <= 0) return

    const keep: string[] = []
    for (const fid of this.finished) {
      if (excess > 0 && isDead(fid)) {
        this.runs.get(fid)!.dispose()
        this.runs.delete(fid)
        excess--
        continue
      }
      keep.push(fid)
    }
    this.finished.length = 0
    this.finished.push(...keep)
  }
}

/** 「还占着系统资源」= 还在跑、正在杀、或者杀不掉。 */
function isLive(status: RunStatus): boolean {
  return status === 'running' || status === 'killing' || status === 'zombie'
}
