import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './SessionService.js'
import type { SessionManager } from './SessionManager.js'

/**
 * 删会话必须把它起的 run 一起收掉（回溯审计 C2）。
 *
 * `registry.killSession()` 此前**全仓只有测试在调** —— 于是删掉一个会话，它起过的 run
 * 一条都不会被收。步骤 4 之后更严重：项目档无墙钟、断连保留，一个孤儿 dev server 会
 * **永远占着端口**，而 UI 里再也看不到它（会话没了）。
 */
const fakeCreateSession = ((): SessionManager =>
  ({
    subscribe: () => () => {}, snapshot: () => ({}), close: () => {},
    getState: () => ({ cwd: '/w' }), cancelAllInjections: () => {},
  }) as unknown as SessionManager) as never

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zuse-del-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function make(): { service: SessionService; killed: string[] } {
  const killed: string[] = []
  const service = new SessionService({
    dir: join(dir, 'web-sessions'), cwd: '/w', createSession: fakeCreateSession,
    onDelete: (id) => killed.push(id),
  })
  return { service, killed }
}

describe('SessionService.delete → 收掉该会话的 run', () => {
  it('delete() 触发 onDelete，带上正确的 sessionId', async () => {
    const { service, killed } = make()
    const s = await service.create({ cwd: '/w' })
    await service.delete(s.id)
    expect(killed).toEqual([s.id])
  })

  /**
   * **写反就是灾难。** `release()` 的另外两个调用方是 cron 的**纯归还**
   * （`CronScheduler.fire()` 的 finally、`CronService.getRunDetail()`）—— 那时会话还在、
   * 用户还会再打开它，把它的 run 杀掉是错的：定时任务刚起的进程会被自己的归还动作打死。
   */
  it('release() 绝不触发 —— 那是 cron 的纯归还，会话还在', async () => {
    const { service, killed } = make()
    const s = await service.create({ cwd: '/w' })
    service.release(s.id)
    expect(killed).toEqual([])
  })

  /**
   * 收 run 失败**不能**阻止删盘，否则用户永远删不掉这个会话。
   * 而且这条链是 await 在 HTTP 请求栈上的 —— 本轮审计刚修过一条同型的
   * （killTree 的 spawn 失败没挂 'error'，把整个 daemon 带走）。
   */
  it('onDelete 抛出时，删除仍然完成', async () => {
    const killed: string[] = []
    const service = new SessionService({
      dir: join(dir, 'web-sessions'), cwd: '/w', createSession: fakeCreateSession,
      onDelete: (id) => { killed.push(id); throw new Error('killTree 炸了') },
    })
    const s = await service.create({ cwd: '/w' })
    await expect(service.delete(s.id)).resolves.toBeUndefined()
    expect(killed).toEqual([s.id])
    expect(await service.getOrLoad(s.id)).toBeNull()   // 盘上真的没了
  })
})
