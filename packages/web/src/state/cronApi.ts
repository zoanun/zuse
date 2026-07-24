import type { CronTaskWithNext, CronTaskInput, CronRun, CronRunDetail } from '@zuse/protocol'
import { request } from './session.js'

const JSON_HEADERS = { 'content-type': 'application/json' }
const enc = encodeURIComponent

/** GET /api/cron — 任务列表（含算出的 nextRun）。失败抛错。 */
export async function listCronTasks(): Promise<CronTaskWithNext[]> {
  return (await (await request('/api/cron', {}, 'list cron')).json()) as CronTaskWithNext[]
}

/** POST /api/cron — 新建任务。失败抛错（400 携带服务端 message）。 */
export async function createCronTask(body: CronTaskInput): Promise<CronTaskWithNext> {
  return (await (await request('/api/cron', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'create cron')).json()) as CronTaskWithNext
}

/** PATCH /api/cron/<id> — 更新任务。失败抛错。 */
export async function updateCronTask(id: string, body: Partial<CronTaskInput>): Promise<CronTaskWithNext> {
  return (await (await request(`/api/cron/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, 'update cron')).json()) as CronTaskWithNext
}

/** DELETE /api/cron/<id> — 删除任务（连带执行记录）。失败抛错。 */
export async function deleteCronTask(id: string): Promise<void> {
  await request(`/api/cron/${enc(id)}`, { method: 'DELETE' }, 'delete cron')
}

/** GET /api/cron/<taskId>/runs — 该任务的历次执行记录（新→旧）。失败抛错。 */
export async function listCronRuns(taskId: string): Promise<CronRun[]> {
  return (await (await request(`/api/cron/${enc(taskId)}/runs`, {}, 'list cron runs')).json()) as CronRun[]
}

/** POST /api/cron/<id>/run — 立即执行一次。失败抛错。 */
export async function runCronNow(id: string): Promise<void> {
  await request(`/api/cron/${enc(id)}/run`, { method: 'POST' }, 'run cron now')
}

/** GET /api/cron/<taskId>/runs/<runId> — 某次执行详情（run + 会话消息投影）。失败抛错。 */
export async function getCronRunDetail(taskId: string, runId: string): Promise<CronRunDetail> {
  return (await (await request(`/api/cron/${enc(taskId)}/runs/${enc(runId)}`, {}, 'cron run detail')).json()) as CronRunDetail
}
