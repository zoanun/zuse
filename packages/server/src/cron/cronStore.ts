import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CronTask, CronRun } from '@zuse/protocol'
import { normalizePermissionMode } from '@zuse/core'

/** cron 数据根目录（tasks.json + runs/<taskId>.jsonl）。 */
export function cronDir(authDir: string): string { return join(authDir, 'cron') }

function tasksPath(dir: string): string { return join(dir, 'tasks.json') }
function runsDir(dir: string): string { return join(dir, 'runs') }
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid cron id: "${id}"`)
  return id
}
function runsPath(dir: string, taskId: string): string { return join(runsDir(dir), `${safeId(taskId)}.jsonl`) }

/**
 * 读所有任务；文件缺失/损坏 → []。
 *
 * permissionMode 在这里归一化：tasks.json 是**早于改名就已落盘**的数据，里面写的是老别名
 * `bypassPermissions`。不认它的话，用户几个月前建的「全自主」定时任务会静默退化成询问档，
 * 而非交互会话里 ask 一律当 deny —— 表现是任务到点跑起来、然后什么都干不成，且不报错。
 *
 * 放在 loadTasks 而不是 CronService 的各个方法里：这是**所有** cron 读路径的唯一咽喉
 * （list / create / update / delete / runNow / CronScheduler 的 setTasks 全都经由它），
 * 摆在这儿就不存在「将来新增一个读路径忘了归一化」的可能。
 *
 * 刻意**不做**一次性迁移写盘，因为不需要：CronService 的 create / update / delete 都是
 * 「loadTasks 全量 → 改一处 → saveTasks 全量」，而 saveTasks 写的是归一化后的内存对象，
 * 所以**任意一次增删改都会顺手把整份 tasks.json 重写成新名字**（不止被改的那条）。
 * 等于免费拿到惰性全量迁移。而读操作坚决不写盘 —— 一个只是列个表的 GET 请求去改用户的
 * tasks.json，在并发或磁盘满的时候是能把任务表弄丢的那种"贴心"。
 */
export async function loadTasks(dir: string): Promise<CronTask[]> {
  try {
    const arr = JSON.parse(await readFile(tasksPath(dir), 'utf8'))
    if (!Array.isArray(arr)) return []
    return (arr as CronTask[]).map((t) => {
      // 「字段没有」与「字段是垃圾」是两类输入，兜底方向刻意相反：
      //  - 缺字段 → bypass：早于该字段存在的老任务，历史语义就是全自主。
      //  - 认不出的值（手抖写成 `acceptEdit`、`yolo`）→ default：**绝不 fail-open**。
      //    把一个读不懂的档位当成最松的那档，等于让一次拼写错误静默提权成无人值守全自主。
      //    回落 default 后非交互会话里 ask→deny，任务会响亮地失败（跑起来但干不成事），
      //    这对一个安全档位是正确的失败方向 —— 与 CronService.update 里同款取舍一致。
      if (t?.permissionMode === undefined) return { ...t, permissionMode: 'bypass' as const }
      return { ...t, permissionMode: normalizePermissionMode(t.permissionMode) ?? 'default' }
    })
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
