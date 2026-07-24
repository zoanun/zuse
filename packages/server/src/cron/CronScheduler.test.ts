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

// fake SessionService: create→id, getOrLoad→manager with submit + getState
function fakeSessions(behavior: 'ok' | 'throw' = 'ok') {
  const submit = vi.fn(async () => { if (behavior === 'throw') throw new Error('boom') })
  const mgr = {
    submit,
    getState: () => ({ messages: [{ id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'the result' }] }] }),
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
