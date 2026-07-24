import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CronTask, CronRun } from '@zuse/protocol'

/** cron 数据根目录（tasks.json + runs/<taskId>.jsonl）。 */
export function cronDir(authDir: string): string { return join(authDir, 'cron') }

function tasksPath(dir: string): string { return join(dir, 'tasks.json') }
function runsDir(dir: string): string { return join(dir, 'runs') }
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid cron id: "${id}"`)
  return id
}
function runsPath(dir: string, taskId: string): string { return join(runsDir(dir), `${safeId(taskId)}.jsonl`) }

/** 读所有任务；文件缺失/损坏 → []。 */
export async function loadTasks(dir: string): Promise<CronTask[]> {
  try {
    const arr = JSON.parse(await readFile(tasksPath(dir), 'utf8'))
    return Array.isArray(arr) ? (arr as CronTask[]) : []
  } catch { return [] }
}

/** 原子写全部任务（tmp→rename）。 */
export async function saveTasks(dir: string, tasks: CronTask[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const final = tasksPath(dir)
  const tmp = `${final}.tmp`
  await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
  await rename(tmp, final)
}

/** 追加一条执行记录（同 id 视为更新——loadRuns 去重 last-wins）。 */
export async function appendRun(dir: string, run: CronRun): Promise<void> {
  await mkdir(runsDir(dir), { recursive: true })
  await appendFile(runsPath(dir, run.taskId), JSON.stringify(run) + '\n', 'utf8')
}

/** 读某任务全部执行记录：按 id 去重(后写覆盖先写)，按 startedAt 倒序。坏行跳过。 */
export async function loadRuns(dir: string, taskId: string): Promise<CronRun[]> {
  let raw: string
  try { raw = await readFile(runsPath(dir, taskId), 'utf8') } catch { return [] }
  const byId = new Map<string, CronRun>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line) as CronRun; byId.set(r.id, r) } catch { /* skip corrupt line */ }
  }
  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/** 删某任务的执行记录文件（幂等）。 */
export async function deleteTaskRuns(dir: string, taskId: string): Promise<void> {
  try { await unlink(runsPath(dir, taskId)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
