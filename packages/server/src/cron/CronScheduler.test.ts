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
  const setWakeupDeadline = vi.fn()
  // 缺省立即静默；要验「fire 会等它」的用例自己用 mockImplementationOnce 卡住它。
  // （别在这里复刻真实的轮询语义：那只会让用例看起来验了顺序，实际什么都没钉住。
  //   真实实现由 SessionManager 的单测覆盖。）
  const waitUntilQuiescent = vi.fn(async () => {})
  const mgr = {
    submit,
    getState: () => ({ messages: [{ id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'the result' }] }] }),
    setWakeupDeadline,
    waitUntilQuiescent,
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
  it('success 记录必须晚于唤醒链静默 —— 卡住 waitUntilQuiescent，其间不得出现 success', async () => {
    // 这条钉的是**顺序**，不是"waitUntilQuiescent 被调用过"：只断言后者的话，
    // 把实现改回「submit 完就 appendRun(success)」测试照样绿，而那正是本特性要修的 bug
    // （summary/finishedAt 描述的不是会话实际做过的事）。
    const sessions = fakeSessions('ok')
    let releaseWait!: () => void
    sessions.mgr.waitUntilQuiescent.mockImplementationOnce(
      () => new Promise<void>((r) => { releaseWait = r }),
    )
    const sch = new CronScheduler({ dir, sessions })
    const fired = sch.fire(task())
    // 等到 fire() 确实卡在 waitUntilQuiescent 上（running 已落盘）
    while (!releaseWait) await new Promise((r) => setTimeout(r, 1))
    expect((await loadRuns(dir, 't1')).map((r) => r.status)).toEqual(['running'])
    releaseWait()
    await fired
    const runs = await loadRuns(dir, 't1')
    expect(runs[0]!.status).toBe('success')
    expect(runs[0]!.summary).toContain('the result')
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
