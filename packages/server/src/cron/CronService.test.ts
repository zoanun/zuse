import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from './CronService.js'
import { loadTasks, appendRun } from './cronStore.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronsvc-')) })

function fakeScheduler() {
  return { setTasks: vi.fn(), nextRunOf: vi.fn(() => '2026-07-25T09:00:00.000Z'), fire: vi.fn(async () => {}), close: vi.fn() } as any
}

describe('CronService CRUD', () => {
  it('create: fills id/timestamps/defaults, persists, reschedules, returns with nextRun', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    expect(t.id).toBeTruthy()
    expect(t.enabled).toBe(true)
    expect(t.permissionMode).toBe('bypass')  // 默认全自主
    expect(t.cwd).toBe('/tmp')
    expect(t.nextRun).toBe('2026-07-25T09:00:00.000Z')
    expect((await loadTasks(dir)).map((x) => x.id)).toEqual([t.id])
    expect(scheduler.setTasks).toHaveBeenCalled()
  })
  it('create: invalid cron throws (route maps to 400)', async () => {
    const svc = new CronService({ dir, scheduler: fakeScheduler(), defaultCwd: '/tmp' })
    await expect(svc.create({ name: 'n', cron: 'garbage', prompt: 'p' })).rejects.toThrow(/cron/i)
  })
  it('update + delete', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    const u = await svc.update(t.id, { enabled: false })
    expect(u!.enabled).toBe(false)
    await svc.delete(t.id)
    expect(await loadTasks(dir)).toEqual([])
  })
  it('runNow calls scheduler.fire with the task', async () => {
    const scheduler = fakeScheduler()
    const svc = new CronService({ dir, scheduler, defaultCwd: '/tmp' })
    const t = await svc.create({ name: 'n', cron: '0 9 * * *', prompt: 'p' })
    await svc.runNow(t.id)
    expect(scheduler.fire).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }))
  })
})

describe('getRunDetail —— 只读路径不得拆掉别人正在用的会话', () => {
  /** 造一个 sessions 依赖，记录 release 调用；isLive 由 live 集合决定。 */
  function fakeSessions(live: Set<string>) {
    const released: string[] = []
    return {
      released,
      isLive: (id: string) => live.has(id),
      getOrLoad: async (id: string) => ({ getState: () => ({ messages: [{ role: 'user', id }] }) }),
      release: (id: string) => { released.push(id); live.delete(id) },
    }
  }

  async function seedRun(taskId: string, sessionId: string) {
    await appendRun(dir, { id: 'r1', taskId, startedAt: new Date().toISOString(), sessionId, status: 'running' })
  }

  it('会话已 live（这次执行还在跑）→ 读完不 release', async () => {
    await seedRun('t1', 's1')
    const sessions = fakeSessions(new Set(['s1']))
    const svc = new CronService({ dir, scheduler: fakeScheduler(), defaultCwd: '/tmp', sessions })

    const detail = await svc.getRunDetail('t1', 'r1')

    expect(detail!.messages).toHaveLength(1)      // 照样读到了消息
    expect(sessions.released).toEqual([])         // 但没把它拆掉
  })

  it('会话不在内存（回看历史执行）→ 是我捞的，读完要 release', async () => {
    await seedRun('t2', 's2')
    const sessions = fakeSessions(new Set())
    const svc = new CronService({ dir, scheduler: fakeScheduler(), defaultCwd: '/tmp', sessions })

    await svc.getRunDetail('t2', 'r1')

    expect(sessions.released).toEqual(['s2'])     // 不放回去就会永久堆在 registry 里
  })
})
