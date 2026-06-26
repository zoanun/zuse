import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService } from './MemoryService.js'

let dir: string
let svc: MemoryService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-memsvc-'))
  svc = new MemoryService({ dbPath: join(dir, 'memory.db') })
})

afterEach(() => {
  svc.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryService', () => {
  it('create → list → update → search(命中新内容)→ delete → list 不见', () => {
    // create
    const a = svc.create({ type: 'project', content: 'compaction 阈值 80%', project: 'p' })
    const b = svc.create({ type: 'user', content: '用户偏好 pnpm' }) // 全局(project 缺省 '')
    expect(a.id).toBeGreaterThan(0)
    expect(b.project).toBe('')

    // list (all)
    expect(svc.list().map((m) => m.id)).toEqual(expect.arrayContaining([a.id, b.id]))

    // list by project — 项目 ∪ 全局
    const byProject = svc.list({ project: 'p' })
    expect(byProject.map((m) => m.id)).toEqual(expect.arrayContaining([a.id, b.id]))

    // update
    const updated = svc.update(a.id, { content: 'compaction 阈值改成 90%' })
    expect(updated).not.toBeNull()
    expect(updated!.content).toBe('compaction 阈值改成 90%')

    // search 命中新内容、不命中旧内容
    expect(svc.list({ q: '90%', project: 'p' }).map((m) => m.id)).toContain(a.id)
    expect(svc.list({ q: '80%', project: 'p' })).toHaveLength(0)

    // delete
    expect(svc.remove(a.id)).toBe(true)
    expect(svc.list().map((m) => m.id)).not.toContain(a.id)
  })

  it('user 型恒为全局:create/update 强制 project=\'\'(即便传了 project)', () => {
    // create:user 型即使带 project 也落成全局
    const u = svc.create({ type: 'user', content: '用户是谁', project: 'some-project' })
    expect(u.project).toBe('')
    // update:把一条 project 记忆改成 user 型 → project 被清空
    const p = svc.create({ type: 'project', content: '项目事实', project: 'p' })
    expect(p.project).toBe('p')
    const changed = svc.update(p.id, { type: 'user', project: 'p' })
    expect(changed!.type).toBe('user')
    expect(changed!.project).toBe('')
  })

  it('update 未知 id 返回 null;remove 未命中返回 false', () => {
    expect(svc.update(99999, { content: 'x' })).toBeNull()
    expect(svc.remove(99999)).toBe(false)
  })

  it('close 后再用会惰性重开(数据仍在磁盘)', () => {
    svc.create({ type: 'user', content: '持久化', project: '' })
    svc.close()
    expect(svc.list()).toHaveLength(1) // 惰性重开同一文件
  })
})
