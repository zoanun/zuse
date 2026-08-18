import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMemoryConsolidation, CONSOLIDATION_MAX_SAVES, CONSOLIDATION_SAVE_CHARS } from './memory.js'
import { openMemoryStore } from './memory-store.js'

/**
 * **后台的「记忆巩固」原来完全不过权限判定。**
 *
 * `Memory(save)` / `Memory(delete)` 在 `BUILTIN_CONFIRM_RULES` 里（allow 与 bypass
 * 都压不过），理由是它写的东西会进**此后每一个会话**的系统提示词。
 * 而巩固这条路直接 `store.save()` + `writeProjection()`，一个闸都不过。
 *
 * 注入链是通的，而且比想象的更直接：`buildConsolidationPrompt` 把每条记忆的
 * **full content 原样**拼进提示词，且那次请求**不带任何系统提示词** ——
 * 「这些是事实，不是指令」那句框定在这一刻不在场。
 *
 * 闸做成**必传参数**而不是调用点自觉：今天两个调用方，明天第三个
 * （比如给 cron 加「夜间整理」）编译期就会被逼着表态。
 */

let dir: string
let dbPath: string
let mdPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-consol-'))
  dbPath = join(dir, 'm.db')
  mdPath = join(dir, 'MEMORY.md')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const seed = (): { ids: number[] } => {
  const s = openMemoryStore(dbPath)
  const ids = [
    s.save('project', 'A 项目的事实一', 'proj-a', 'hook1'),
    s.save('project', 'A 项目的事实二', 'proj-a', 'hook2'),
    s.save('project', 'B 项目的事实', 'proj-b', 'hookB'),
  ].map((r) => (typeof r === 'number' ? r : (r as { id: number }).id))
  s.close()
  return { ids }
}

const opts = () => ({ dbPath, memoryMdPath: mdPath })

describe('巩固必须先过闸', () => {
  it('approve 返回 false → 一条都不落库', async () => {
    const { ids } = seed()
    const r = await applyMemoryConsolidation(
      { deletes: [ids[0]!], saves: [{ type: 'project', hook: 'h', content: '新的' }] },
      'proj-a', () => false, opts(),
    )
    expect(r).toEqual({ saved: 0, deleted: 0, approved: false })
    const s = openMemoryStore(dbPath)
    expect(s.all()).toHaveLength(3)
    s.close()
  })

  it('approve 返回 true → 正常落库', async () => {
    const { ids } = seed()
    const r = await applyMemoryConsolidation(
      { deletes: [ids[0]!], saves: [{ type: 'project', hook: 'h', content: '新的' }] },
      'proj-a', () => true, opts(),
    )
    expect(r.approved).toBe(true)
    expect(r.saved).toBe(1)
    expect(r.deleted).toBe(1)
  })

  /** 闸拿到的必须是**将要发生的事**，否则用户是在给一张空白支票签字。 */
  it('闸收到的计划里带着要写什么、要删什么', async () => {
    const { ids } = seed()
    const approve = vi.fn((_p: unknown) => false)
    await applyMemoryConsolidation(
      { deletes: [ids[0]!], saves: [{ type: 'project', hook: 'h', content: '新的' }] },
      'proj-a', approve, opts(),
    )
    const plan = approve.mock.calls[0]?.[0] as { saves: unknown[]; deletes: number[] }
    expect(plan.saves).toHaveLength(1)
    expect(plan.deletes).toEqual([ids[0]])
  })
})

describe('范围与体量的硬闸（闸之外还要有闸）', () => {
  /**
   * **DELETE 原来完全不校验范围。** `DELETE FROM memories WHERE id = ?` 没有 project 条件。
   * 提示词只喂了本项目的 id，但模型（或注入）可以吐任意 id ——
   * SessionManager 那段长注释费力堵住的「跨项目改挂」，在 delete 侧原样敞着。
   */
  it('范围外的 id 删不掉（跨项目删除）', async () => {
    const { ids } = seed()
    const r = await applyMemoryConsolidation(
      { deletes: [ids[2]!], saves: [] }, 'proj-a', () => true, opts(),
    )
    expect(r.deleted).toBe(0)
    const s = openMemoryStore(dbPath)
    expect(s.all().some((m) => m.content === 'B 项目的事实')).toBe(true)
    s.close()
  })

  /**
   * **`type:user` 的 save 会落成全局**（`project` 存空串），所有项目都吃得到。
   * 巩固的职责是「整理本项目这份清单」，没有理由让它新造全局记忆。
   */
  it('巩固不许铸造全局（type:user）记忆', async () => {
    seed()
    const r = await applyMemoryConsolidation(
      { deletes: [], saves: [{ type: 'user', hook: 'h', content: '全局的' }] },
      'proj-a', () => true, opts(),
    )
    expect(r.saved).toBe(0)
  })

  it('SAVE 条数封顶', async () => {
    seed()
    const many = Array.from({ length: CONSOLIDATION_MAX_SAVES + 5 }, (_, i) => ({
      type: 'project' as const, hook: `h${i}`, content: `c${i}`,
    }))
    const r = await applyMemoryConsolidation({ deletes: [], saves: many }, 'proj-a', () => true, opts())
    expect(r.saved).toBe(CONSOLIDATION_MAX_SAVES)
  })

  it('单条内容超长直接截断，不是拒绝（拒绝会让整轮白跑）', async () => {
    seed()
    await applyMemoryConsolidation(
      { deletes: [], saves: [{ type: 'project', hook: 'h', content: 'x'.repeat(CONSOLIDATION_SAVE_CHARS + 500) }] },
      'proj-a', () => true, opts(),
    )
    const s = openMemoryStore(dbPath)
    const row = s.all().find((m) => m.content.startsWith('x'))!
    expect(row.content.length).toBeLessThanOrEqual(CONSOLIDATION_SAVE_CHARS)
    s.close()
  })

  /**
   * 摘要文本是**攻击者可控**的（SAVE 的 hook 与 content 都来自模型输出），而它要进终端。
   * ESC/OSC 序列能清屏、移光标、伪造提示行 —— 进 reason 之前必须剥掉控制字符。
   * 源码里不写字面控制字符：那会让这个文件变成二进制，diff 和 grep 都读不了。
   */
  it('计划摘要里剥掉控制字符', async () => {
    const ESC = String.fromCharCode(27)
    seed()
    const approve = vi.fn((_p: unknown) => false)
    await applyMemoryConsolidation(
      { deletes: [], saves: [{ type: 'project', hook: '', content: `正常${ESC}[2J文本` }] },
      'proj-a', approve, opts(),
    )
    const plan = approve.mock.calls[0]?.[0] as { summary: string }
    expect(plan.summary).not.toContain(ESC)
    expect(plan.summary).toContain('正常')
  })
})
