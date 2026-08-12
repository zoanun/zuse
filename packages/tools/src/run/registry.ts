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
  endReason: EndReason | null
  exitCode: number | null
  startedAt: number
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
    // Run 那边的 detach 判据是 `subs.size === 0`，所以这里退订后才可能触发；
    // 而我们在 end 到来后立刻退订，那时 run 已经结束、detach 分支本来就跳过。
    const off = run.subscribe((e) => {
      if (e.type !== 'end') return
      off()
      this.onFinished(id)
    })
    return run
  }

  get(id: string): Run | undefined { return this.runs.get(id) }

  list(): RunSummary[] {
    return [...this.runs.values()].map((r) => ({
      id: r.id, command: r.command, cwd: r.cwd, sessionId: r.sessionId,
      status: r.status, endReason: r.endReason, exitCode: r.exitCode, startedAt: r.startedAt,
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
