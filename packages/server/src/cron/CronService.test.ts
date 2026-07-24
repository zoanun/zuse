import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from './CronService.js'
import { loadTasks } from './cronStore.js'

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
    expect(t.permissionMode).toBe('bypassPermissions')  // 默认全自主
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
