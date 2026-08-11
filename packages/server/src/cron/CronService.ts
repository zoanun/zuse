import type { CronTask, CronTaskInput, CronTaskWithNext, CronRun, CronRunDetail } from '@zuse/protocol'
import { normalizePermissionMode } from '@zuse/core'
import { newSessionId } from '../session/sessionStore.js'
import { loadTasks, saveTasks, loadRuns, deleteTaskRuns } from './cronStore.js'
import { CronScheduler, isValidCron } from './CronScheduler.js'

export interface CronServiceSessions {
  getOrLoad(id: string): Promise<{ getState(): { messages: unknown[] } } | null>
  release(id: string): void
  /** 该 id 是否已在内存中（用于只读路径判断「是不是我捞进来的」）。 */
  isLive(id: string): boolean
}

export interface CronServiceDeps {
  dir: string
  scheduler: CronScheduler
  defaultCwd: string
  /** 供 getRunDetail 取会话消息投影（drill-down）。可选：缺省则 detail.messages=[]（测试无需）。 */
  sessions?: CronServiceSessions
}

export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}

  private withNext(t: CronTask): CronTaskWithNext { return { ...t, nextRun: this.deps.scheduler.nextRunOf(t.id) } }

  async list(): Promise<CronTaskWithNext[]> {
    return (await loadTasks(this.deps.dir)).map((t) => this.withNext(t))
  }

  async create(input: CronTaskInput): Promise<CronTaskWithNext> {
    if (!input.name?.trim()) throw new Error('name is required')
    if (!input.prompt?.trim()) throw new Error('prompt is required')
    if (!isValidCron(input.cron)) throw new Error(`invalid cron expression: "${input.cron}"`)
    const now = new Date().toISOString()
    const task: CronTask = {
      id: newSessionId(), name: input.name, cron: input.cron, prompt: input.prompt,
      cwd: input.cwd ?? this.deps.defaultCwd,
      // 归一化边界之一：input 直接来自 HTTP 请求体（server.ts 的 POST /api/cron 把 body
      // 原样交过来，不做字段校验），所以老版本网页 bundle 发上来的老别名要在这里认掉。
      // 认不出 → 默认全自主（历史默认档，见 spec §5）。
      permissionMode: normalizePermissionMode(input.permissionMode) ?? 'bypass',
      enabled: input.enabled ?? true, createdAt: now, updatedAt: now,
    }
    const tasks = await loadTasks(this.deps.dir)
    tasks.push(task)
    await saveTasks(this.deps.dir, tasks)
    this.deps.scheduler.setTasks(tasks)
    return this.withNext(task)
  }

  async update(id: string, patch: Partial<CronTaskInput>): Promise<CronTaskWithNext | null> {
    if (patch.cron !== undefined && !isValidCron(patch.cron)) throw new Error(`invalid cron expression: "${patch.cron}"`)
    const tasks = await loadTasks(this.deps.dir)
    const i = tasks.findIndex((t) => t.id === id)
    if (i < 0) return null
    const current = tasks[i]!
    const patchedMode = patch.permissionMode !== undefined ? normalizePermissionMode(patch.permissionMode) : undefined
    tasks[i] = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      // 同 create：patch 来自 PATCH 请求体，未经校验。认不出就当这个字段没传（保留原档），
      // 而不是回落全自主 —— 改个名字的请求顺手把档位提到最松是绝不能有的行为。
      ...(patchedMode ? { permissionMode: patchedMode } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date().toISOString(),
    }
    await saveTasks(this.deps.dir, tasks)
    this.deps.scheduler.setTasks(tasks)
    return this.withNext(tasks[i]!)
  }

  async delete(id: string): Promise<void> {
    const tasks = (await loadTasks(this.deps.dir)).filter((t) => t.id !== id)
    await saveTasks(this.deps.dir, tasks)
    await deleteTaskRuns(this.deps.dir, id)
    this.deps.scheduler.setTasks(tasks)
  }

  async listRuns(taskId: string): Promise<CronRun[]> { return loadRuns(this.deps.dir, taskId) }

  async runNow(id: string): Promise<void> {
    const task = (await loadTasks(this.deps.dir)).find((t) => t.id === id)
    if (!task) throw new Error(`no such cron task: ${id}`)
    await this.deps.scheduler.fire(task)
  }

  /** 某次执行详情：run + 那次会话的消息投影（复用现有 SnapshotMessage 渲染）。 */
  async getRunDetail(taskId: string, runId: string): Promise<CronRunDetail | null> {
    const run = (await loadRuns(this.deps.dir, taskId)).find((r) => r.id === runId)
    if (!run) return null
    let messages: CronRunDetail['messages'] = []
    if (this.deps.sessions && run.sessionId) {
      // 「我捞的我才放」：release() 是生命周期终点（作废全部待投递 + 退订 autosave + 逐出
      // registry），不是「用完归还」。而这条是**纯读**路径 —— 若这次执行还在跑（fire() 正
      // 阻塞在 waitUntilQuiescent 上），会话此刻就是 live 的，无条件 release 等于用户点开
      // 「运行详情」就把它掐了：整条唤醒链没了，在飞的后台 Agent 产出也全丢。
      const wasLive = this.deps.sessions.isLive(run.sessionId)
      const mgr = await this.deps.sessions.getOrLoad(run.sessionId)
      if (mgr) {
        messages = mgr.getState().messages as CronRunDetail['messages']
        if (!wasLive) this.deps.sessions.release(run.sessionId)
      }
    }
    return { run, messages }
  }
}
