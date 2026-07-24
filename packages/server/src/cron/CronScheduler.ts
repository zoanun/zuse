import { Cron } from 'croner'
import type { CronTask, CronRun } from '@zuse/protocol'
import { newSessionId } from '../session/sessionStore.js'
import { appendRun } from './cronStore.js'

/** CronScheduler 只依赖会话创建/驱动的最小接口（驱动源中立，不 import HTTP/WS）。 */
export interface CronSessions {
  create(opts: { cwd: string; permissionMode: CronTask['permissionMode']; kind: 'cron' }): Promise<{ id: string }>
  getOrLoad(id: string): Promise<{ submit(text: string): Promise<void>; getState(): { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }> } } | null>
  release(id: string): void
}

export interface CronSchedulerDeps {
  dir: string                 // cronDir(authDir)
  sessions: CronSessions      // 通常是 SessionService
}

/** cron 表达式是否合法（croner 构造非法表达式会抛）。 */
export function isValidCron(expr: string): boolean {
  try { new Cron(expr, { paused: true }).stop(); return true } catch { return false }
}

/** 取某会话末条 assistant 文本，截断到 ~200 字，作执行结果摘要。 */
function summarize(state: { messages: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }> }): string {
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
    const job = new Cron(task.cron, { protect: true }, () => { void this.fire(task) })
    this.jobs.set(task.id, job)
  }

  /** 某任务下次执行时间（未调度 → null）。 */
  nextRunOf(taskId: string): string | null {
    const d = this.jobs.get(taskId)?.nextRun() ?? null
    return d ? d.toISOString() : null
  }

  /** 到点（或手动"立即执行"）：开全新 cron 会话跑一轮、记 run。绝不抛（吞错记 failed）。 */
  async fire(task: CronTask): Promise<void> {
    const runId = newSessionId()
    const startedAt = new Date().toISOString()
    const { id: sessionId } = await this.sessions.create({ cwd: task.cwd, permissionMode: task.permissionMode, kind: 'cron' })
    const base: CronRun = { id: runId, taskId: task.id, startedAt, status: 'running', sessionId }
    await appendRun(this.dir, base)
    try {
      const mgr = await this.sessions.getOrLoad(sessionId)
      if (!mgr) throw new Error('cron session vanished after create')
      await mgr.submit(task.prompt)
      await appendRun(this.dir, { ...base, status: 'success', finishedAt: new Date().toISOString(), summary: summarize(mgr.getState()) })
    } catch (err) {
      await appendRun(this.dir, { ...base, status: 'failed', finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.sessions.release(sessionId)
    }
  }

  /** daemon 关停：停掉所有 croner 定时器。 */
  close(): void {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }
}
