import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTasks, saveTasks, appendRun, loadRuns, deleteTaskRuns } from './cronStore.js'
import type { CronTask, CronRun } from '@zuse/protocol'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-')) })

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 't1', name: 'n', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp',
  permissionMode: 'bypass', enabled: true,
  createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z', ...over,
})

describe('cronStore tasks', () => {
  it('round-trips tasks; missing file → []', async () => {
    expect(await loadTasks(dir)).toEqual([])
    await saveTasks(dir, [task(), task({ id: 't2', name: 'm' })])
    const got = await loadTasks(dir)
    expect(got.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('cronStore runs', () => {
  const run = (over: Partial<CronRun> = {}): CronRun => ({
    id: 'r1', taskId: 't1', startedAt: '2026-07-24T09:00:00.000Z', status: 'running', sessionId: 's1', ...over,
  })
  it('append + dedupe by id (last wins), newest startedAt first', async () => {
    await appendRun(dir, run())
    await appendRun(dir, run({ status: 'success', finishedAt: 'x', summary: 'done' })) // same id r1 → replaces
    await appendRun(dir, run({ id: 'r2', startedAt: '2026-07-24T10:00:00.000Z', status: 'failed', error: 'e' }))
    const runs = await loadRuns(dir, 't1')
    expect(runs.map((r) => r.id)).toEqual(['r2', 'r1'])        // newest first
    expect(runs.find((r) => r.id === 'r1')!.status).toBe('success') // last write won
  })
  it('skips a corrupt jsonl line', async () => {
    await appendRun(dir, run())
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(dir, 'runs', 't1.jsonl'), 'NOT JSON\n')
    await appendRun(dir, run({ id: 'r2' }))
    expect((await loadRuns(dir, 't1')).map((r) => r.id).sort()).toEqual(['r1', 'r2'])
  })
  it('deleteTaskRuns removes the jsonl', async () => {
    await appendRun(dir, run())
    await deleteTaskRuns(dir, 't1')
    expect(await loadRuns(dir, 't1')).toEqual([])
  })
})

describe('cronStore —— 落盘任务的 permissionMode 别名归一化', () => {
  it('磁盘上的老别名 bypassPermissions 读进来变成 bypass', async () => {
    // 直接写一份"改名之前"的 tasks.json：这就是用户机器上 ~/.zuse/cron/tasks.json 的样子。
    // 不认它的话，几个月前建的全自主任务会退化成询问档，而非交互会话里 ask 一律当 deny ——
    // 表现是任务到点跑起来、然后什么都干不成，且不报错。
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.json'), JSON.stringify([
      { ...task(), permissionMode: 'bypassPermissions' },
    ]), 'utf8')
    const got = await loadTasks(dir)
    expect(got).toHaveLength(1)
    expect(got[0]!.permissionMode).toBe('bypass')
  })

  it('其余档位原样保留，不会被一并拉成 bypass', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.json'), JSON.stringify([
      { ...task(), id: 'a', permissionMode: 'default' },
      { ...task(), id: 'b', permissionMode: 'acceptEdits' },
    ]), 'utf8')
    const got = await loadTasks(dir)
    expect(got.map((t) => t.permissionMode)).toEqual(['default', 'acceptEdits'])
  })

  it('垃圾档位回落 default 而不是 bypass —— 拼错一个词绝不能静默提权成全自主', async () => {
    // fail-open 是这里最容易犯的错：把读不懂的值当成最松的那档，等于让 tasks.json 里
    // 一个手抖（`acceptEdit` 少个 s）把无人值守任务提权到跳过所有确认。
    // 回落 default 后非交互会话 ask→deny，任务会响亮地失败，那是正确的失败方向。
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.json'), JSON.stringify([
      { ...task(), id: 'a', permissionMode: 'yolo' },
      { ...task(), id: 'b', permissionMode: 'acceptEdit' },
      { ...task(), id: 'c', permissionMode: 'Bypass' },
    ]), 'utf8')
    const got = await loadTasks(dir)
    expect(got.map((t) => t.permissionMode)).toEqual(['default', 'default', 'default'])
  })

  it('缺字段回落 bypass —— 早于该字段存在的老任务，历史语义就是全自主', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.json'), JSON.stringify([
      { id: 'b', name: 'n', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp', enabled: true, createdAt: 'c', updatedAt: 'u' },
    ]), 'utf8')
    expect((await loadTasks(dir))[0]!.permissionMode).toBe('bypass')
  })

  it('归一化不写盘：只读一次不改用户的 tasks.json', async () => {
    // 刻意的取舍 —— 一个只是列表的 GET 不该产生写副作用（并发/磁盘满时能把任务表弄丢）。
    await mkdir(dir, { recursive: true })
    const raw = JSON.stringify([{ ...task(), permissionMode: 'bypassPermissions' }])
    await writeFile(join(dir, 'tasks.json'), raw, 'utf8')
    await loadTasks(dir)
    expect(await readFile(join(dir, 'tasks.json'), 'utf8')).toBe(raw)
  })
})
