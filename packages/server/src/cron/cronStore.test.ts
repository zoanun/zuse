import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTasks, saveTasks, appendRun, loadRuns, deleteTaskRuns } from './cronStore.js'
import type { CronTask, CronRun } from '@zuse/protocol'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cron-')) })

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 't1', name: 'n', cron: '0 9 * * *', prompt: 'p', cwd: '/tmp',
  permissionMode: 'bypassPermissions', enabled: true,
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
