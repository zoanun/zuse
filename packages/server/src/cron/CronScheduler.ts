import { Cron } from 'croner'
import type { CronTask, CronRun } from '@zuse/protocol'
import { newSessionId } from '../session/sessionStore.js'
import { appendRun } from './cronStore.js'

/** cron 从会话管理器上用到的最小面（SessionManager 的子集）。 */
export interface CronSessionManager {
  submit(text: string): Promise<void>
  getState(): { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }> }
  /** 给本次触发的自唤醒链设上限；到顶后新的 scheduleWakeup 被拒。 */
  setWakeupDeadline(at: number | null): void
  /** 等到会话静默（无回合在跑，且无待投递：自唤醒、在飞的后台 Agent）或越过 deadline。 */
  waitUntilQuiescent(deadline: number): Promise<void>
}

/** CronScheduler 只依赖会话创建/驱动的最小接口（驱动源中立，不 import HTTP/WS）。 */
export interface CronSessions {
  create(opts: { cwd: string; permissionMode: CronTask['permissionMode']; kind: 'cron' }): Promise<{ id: string }>
  getOrLoad(id: string): Promise<CronSessionManager | null>
  release(id: string): void
}

/** cron 会话的自唤醒链上限：从本次触发起算 1 小时。到顶后拒绝新唤醒并收尾。 */
const WAKEUP_CHAIN_MS = 60 * 60 * 1000

export interface CronSchedulerDeps {
  dir: string                 // cronDir(authDir)
  sessions: CronSessions      // 通常是 SessionService
}

/** cron 表达式是否合法（croner 构造非法表达式会抛）。 */
export function isValidCron(expr: string): boolean {
  try { new Cron(expr, { paused: true }).stop(); return true } catch { return false }
}

/** 取某会话末条 assistant 文本，截断到 ~200 字，作执行结果摘要。 */
function summarize(state: ReturnType<CronSessionManager['getState']>): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]
    if (!m || m.role !== 'assistant') continue
    const text = m.parts.filter((p) => p.kind === 'text').map((p) => p.text ?? '').join('').trim()
    if (text) return text.slice(0, 200)
  }
  return ''
}

export class CronScheduler {
  private readonly dir: string
  private readonly sessions: CronSessions
  private readonly jobs = new Map<string, Cron>()

  constructor(deps: CronSchedulerDeps) {
    this.dir = deps.dir
    this.sessions = deps.sessions
  }

  /** 用给定任务集重建调度（停旧、按 enabled 建新）。start() / CRUD 后都走它。 */
  setTasks(tasks: CronTask[]): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    for (const t of tasks) if (t.enabled) this.schedule(t)
  }

  private schedule(task: CronTask): void {
    if (!isValidCron(task.cron)) return // 非法表达式：跳过调度（CronService 建时已 400 挡住，这是兜底）
    // 不传 timezone → 本机时区；protect:true → 同任务上次未跑完则跳过本次（不堆叠并发）。
    // 回调必须 RETURN fire() 的 promise：croner 的 protect 靠 await 回调返回的 promise 判断
    // 「上次是否还在跑」；返回 void 会让每次触发看似瞬时完成、protect 失效。fire() 绝不 reject。
    const job = new Cron(task.cron, { protect: true }, () => this.fire(task))
    this.jobs.set(task.id, job)
  }

  /** 某任务下次执行时间（未调度 → null）。 */
  nextRunOf(taskId: string): string | null {
    const d = this.jobs.get(taskId)?.nextRun() ?? null
    return d ? d.toISOString() : null
  }

  /**
   * 到点（或手动"立即执行"）：开全新 cron 会话跑一轮、记 run。**绝不 reject**——croner 的 protect
   * 会 await 这个 promise，一旦 reject 会冒泄到 croner；且本方法是「吞错记 failed」的唯一记录点。
   * 故 create/首条 appendRun 也在 try 内：create 失败同样记一条 failed（sessionId 为空）。
   */
  async fire(task: CronTask): Promise<void> {
    const runId = newSessionId()
    const startedAt = new Date().toISOString()
    let sessionId = ''
    const base = (): Omit<CronRun, 'status'> => ({ id: runId, taskId: task.id, startedAt, sessionId })
    try {
      sessionId = (await this.sessions.create({ cwd: task.cwd, permissionMode: task.permissionMode, kind: 'cron' })).id
      await appendRun(this.dir, { ...base(), status: 'running' })
      const mgr = await this.sessions.getOrLoad(sessionId)
      if (!mgr) throw new Error('cron session vanished after create')
      const deadline = Date.now() + WAKEUP_CHAIN_MS
      mgr.setWakeupDeadline(deadline)
      await mgr.submit(task.prompt)
      // 模型可能在这一轮里安排了自唤醒。等整条链静默再定稿 —— 否则 summary/finishedAt
      // 描述的不是这个会话实际做过的事。croner 的 protect 会 await fire()，所以
      // 「链还在跑」自然延伸成「这次执行还没结束」，下一次到点不会重入。
      await mgr.waitUntilQuiescent(deadline)
      await appendRun(this.dir, { ...base(), status: 'success', finishedAt: new Date().toISOString(), summary: summarize(mgr.getState()) })
    } catch (err) {
      // 记 failed 也可能抛（磁盘错）——用 catch 兜住，保证 fire 永不 reject。
      await appendRun(this.dir, { ...base(), status: 'failed', finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }).catch(() => {})
    } finally {
      if (sessionId) this.sessions.release(sessionId)
    }
  }

  /** daemon 关停：停掉所有 croner 定时器。 */
  close(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }
}
