import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler, isValidCron } from './CronScheduler.js'
import { loadRuns } from './cronStore.js'
import type { CronTask } from '@zuse/protocol'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronsch-')) })

const task = (over: Partial<CronTask> = {}): CronTask => ({
  id: 't1', name: 'n', cron: '0 9 * * *', prompt: 'do it', cwd: '/tmp',
  permissionMode: 'bypassPermissions', enabled: true, createdAt: 'c', updatedAt: 'u', ...over,
})

// fake SessionService: create→id, getOrLoad→manager with submit + getState + 唤醒链那几个方法
function fakeSessions(behavior: 'ok' | 'throw' = 'ok') {
  const submit = vi.fn(async () => { if (behavior === 'throw') throw new Error('boom') })
  const hasPendingWakeup = vi.fn(() => false)
  const setWakeupDeadline = vi.fn()
  // fake 的等待复刻真实语义（轮询到没有待触发唤醒为止），这样用例可以靠 hasPendingWakeup
  // 的返回值模拟「模型在这一轮里排了个自唤醒」。真实实现另有 SessionManager 的单测。
  const waitUntilQuiescent = vi.fn(async () => {
    while (hasPendingWakeup()) await new Promise((r) => setTimeout(r, 1))
  })
  const mgr = {
    submit,
    getState: () => ({ messages: [{ id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'the result' }] }] }),
    setWakeupDeadline,
    waitUntilQuiescent,
    hasPendingWakeup,
  }
  const create = vi.fn(async () => ({ id: 'sess-1' }))
  const getOrLoad = vi.fn(async () => mgr)
  const release = vi.fn()
  return { create, getOrLoad, release, submit, mgr } as any
}

describe('isValidCron', () => {
  it('accepts a 5-field expr, rejects garbage', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
  })
})

describe('CronScheduler.fire', () => {
  it('success: creates cron session, submits prompt, records success + summary', async () => {
    const sessions = fakeSessions('ok')
    const sch = new CronScheduler({ dir, sessions })
    await sch.fire(task())
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp', permissionMode: 'bypassPermissions', kind: 'cron' }))
    expect(sessions.submit).toHaveBeenCalledWith('do it')
    expect(sessions.release).toHaveBeenCalledWith('sess-1')
    const runs = await loadRuns(dir, 't1')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('success')
    expect(runs[0]!.summary).toContain('the result')
    expect(runs[0]!.sessionId).toBe('sess-1')
  })
  it('failure: submit throws → records failed + error, still releases', async () => {
    const sessions = fakeSessions('throw')
    const sch = new CronScheduler({ dir, sessions })
    await sch.fire(task())
    const runs = await loadRuns(dir, 't1')
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('boom')
    expect(sessions.release).toHaveBeenCalledWith('sess-1')
  })
  it('create failure: never rejects, records failed, does not release (no session)', async () => {
    // create() throwing must NOT reject fire() (croner awaits it via protect) and must still
    // record a failed run — the create/first-appendRun are inside the try (code-review finding).
    const sessions = { create: vi.fn(async () => { throw new Error('create boom') }), getOrLoad: vi.fn(), release: vi.fn() } as any
    const sch = new CronScheduler({ dir, sessions })
    await expect(sch.fire(task())).resolves.toBeUndefined()
    const runs = await loadRuns(dir, 't1')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('create boom')
    expect(sessions.getOrLoad).not.toHaveBeenCalled()
    expect(sessions.release).not.toHaveBeenCalled()
  })
  it('等唤醒链静默再定稿 run 记录（否则 summary/finishedAt 描述的不是会话实际做过的事）', async () => {
    const sessions = fakeSessions('ok')
    // 第一次问还有唤醒待触发，第二次才静默 —— 模拟"模型在这一轮里排了个自唤醒"
    sessions.mgr.hasPendingWakeup.mockReturnValueOnce(true).mockReturnValue(false)
    const sch = new CronScheduler({ dir, sessions })
    await sch.fire(task())
    expect(sessions.mgr.waitUntilQuiescent).toHaveBeenCalled()
    const runs = await loadRuns(dir, 't1')
    expect(runs[0]!.status).toBe('success')
  })

  it('给 cron 会话设唤醒链上限（1 小时），普通会话不受影响', async () => {
    const sessions = fakeSessions('ok')
    const sch = new CronScheduler({ dir, sessions })
    const before = Date.now()
    await sch.fire(task())
    expect(sessions.mgr.setWakeupDeadline).toHaveBeenCalledTimes(1)
    const at = sessions.mgr.setWakeupDeadline.mock.calls[0]![0] as number
    expect(at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 5000)
    expect(at).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5000)
  })

  it('等待期间抛错不让 fire() reject（croner 的 protect 会 await 它），记为 failed', async () => {
    const sessions = fakeSessions('ok')
    sessions.mgr.waitUntilQuiescent.mockRejectedValueOnce(new Error('wait boom'))
    const sch = new CronScheduler({ dir, sessions })
    await expect(sch.fire(task())).resolves.toBeUndefined()
    const runs = await loadRuns(dir, 't1')
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('wait boom')
    expect(sessions.release).toHaveBeenCalledWith('sess-1')
  })
})

describe('CronScheduler schedule lifecycle', () => {
  it('start() schedules only enabled tasks; nextRunOf reflects it', async () => {
    const sessions = fakeSessions('ok')
    const sch = new CronScheduler({ dir, sessions })
    sch.setTasks([task({ id: 'on', enabled: true }), task({ id: 'off', enabled: false })])
    expect(sch.nextRunOf('on')).not.toBeNull()
    expect(sch.nextRunOf('off')).toBeNull()
    sch.close()
  })
})
