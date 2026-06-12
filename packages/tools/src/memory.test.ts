import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolContext } from '@zuse/core'
import { createFileTracker } from '@zuse/core'
import { createMemoryTool, applyMemoryConsolidation } from './memory.js'
import { openMemoryStore } from './memory-store.js'

let dir: string
let tool: Tool & { dispose: () => void }

const ctx = (): ToolContext => ({
  cwd: 'E:\\proj',
  signal: new AbortController().signal,
  tracker: createFileTracker(),
  setCwd: () => {},
})

const mdPath = (): string => join(dir, 'MEMORY.md')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-memtool-'))
  tool = createMemoryTool('E--proj', { dbPath: join(dir, 'memory.db'), memoryMdPath: mdPath() })
})

afterEach(() => {
  tool.dispose() // Windows:不关 sqlite 连接,临时目录删不掉(EBUSY)
  rmSync(dir, { recursive: true, force: true })
})

describe('Memory 工具', () => {
  it('readOnly: true(写入面 = zuse 自有库,default 模式免确认)', () => {
    expect(tool.readOnly).toBe(true)
  })

  it('save 保存并重建 MEMORY.md 投影', async () => {
    const res = await tool.run({ action: 'save', type: 'project', content: 'zuse 用 pnpm workspace' }, ctx())
    expect(res.isError).toBeFalsy()
    expect(res.output).toMatch(/Saved memory \[\d+\] \(project\)/)
    // 投影同步重建,内容可见。
    expect(readFileSync(mdPath(), 'utf8')).toContain('zuse 用 pnpm workspace')
  })

  it('save 的 user 型记忆强制全局(其他项目可见)', async () => {
    await tool.run({ action: 'save', type: 'user', content: '用户偏好中文' }, ctx())
    const other = createMemoryTool('E--other-proj', { dbPath: join(dir, 'memory.db'), memoryMdPath: mdPath() })
    const res = await other.run({ action: 'list' }, ctx())
    other.dispose()
    expect(res.output).toContain('用户偏好中文')
    expect(res.output).toContain('(global)')
  })

  it('save 缺 type/content 回 observation 指引,不落库', async () => {
    const noType = await tool.run({ action: 'save', content: 'x' }, ctx())
    expect(noType.isError).toBe(true)
    expect(noType.output).toContain('user, project, insight, reference')
    const noContent = await tool.run({ action: 'save', type: 'user' }, ctx())
    expect(noContent.isError).toBe(true)
    expect(existsSync(mdPath())).toBe(false) // 没成功保存过,投影不应生成
  })

  it('search 命中返回带 id/type 的行;未命中给下一步建议', async () => {
    await tool.run({ action: 'save', type: 'insight', content: '压缩切点不能劈开工具配对' }, ctx())
    const hit = await tool.run({ action: 'search', query: '压缩' }, ctx())
    expect(hit.output).toMatch(/\[\d+\] \(insight\) 压缩切点/)
    const miss = await tool.run({ action: 'search', query: '不存在的词xyz' }, ctx())
    expect(miss.isError).toBeFalsy() // 无命中不是错误
    expect(miss.output).toContain('list')
  })

  it('list 为空时提示 save 用法', async () => {
    const res = await tool.run({ action: 'list' }, ctx())
    expect(res.output).toContain('save')
  })

  it('delete 删除并更新投影;未知 id 回显现有 id 列表', async () => {
    await tool.run({ action: 'save', type: 'project', content: '要删的事实' }, ctx())
    const ok = await tool.run({ action: 'delete', id: 1 }, ctx())
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(mdPath(), 'utf8')).not.toContain('要删的事实')

    await tool.run({ action: 'save', type: 'project', content: '留着的' }, ctx())
    const bad = await tool.run({ action: 'delete', id: 99 }, ctx())
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain('Existing ids: 2')
  })

  it('记忆索引满容时 save 被拒绝并要求先整理(Hermes 式硬闸,不静默截断)', async () => {
    // 直接灌满库:80 条 × ~110 字符的 hook 行,投影必超 8k。
    const s = openMemoryStore(join(dir, 'memory.db'))
    for (let i = 0; i < 80; i++) {
      s.save('project', `第 ${i} 条事实正文`, 'E--proj', 'h'.repeat(100))
    }
    s.close()
    const res = await tool.run({ action: 'save', type: 'project', content: '再来一条' }, ctx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('full')
    expect(res.output).toContain('delete') // 给出整理路径
    // 确认真的没存进去。
    const list = await tool.run({ action: 'list' }, ctx())
    expect(list.output).not.toContain('再来一条')
  })

  it('未知 action 列出可用 action(observation contract)', async () => {
    const res = await tool.run({ action: 'wipe' }, ctx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('save, search, recall, list, delete')
  })
})

describe('applyMemoryConsolidation(自动巩固应用)', () => {
  it('合并场景:先存新条目再删旧条目,重投影一次', async () => {
    const s = openMemoryStore(join(dir, 'memory.db'))
    s.save('project', '用 pnpm', 'E--proj', '')
    s.save('project', 'pnpm 管依赖', 'E--proj', '')
    s.save('user', '保留的', '', '')
    s.close()

    const { saved, deleted } = applyMemoryConsolidation(
      { saves: [{ type: 'project', hook: 'pnpm', content: '本项目统一用 pnpm 管依赖' }], deletes: [1, 2] },
      'E--proj',
      { dbPath: join(dir, 'memory.db'), memoryMdPath: mdPath() },
    )
    expect(saved).toBe(1)
    expect(deleted).toBe(2)
    const md = readFileSync(mdPath(), 'utf8')
    expect(md).toContain('- [4] pnpm') // 合并的新条目(投影行用 hook)
    expect(md).not.toContain('- [1]') // 旧条目已删
    expect(md).toContain('保留的')
  })

  it('meta 水位读写往返(巩固时间防抖用)', () => {
    const s = openMemoryStore(join(dir, 'memory.db'))
    expect(s.getMeta('consolidated_at')).toBe(null)
    s.setMeta('consolidated_at', '2026-06-12T12:00:00Z')
    expect(s.getMeta('consolidated_at')).toBe('2026-06-12T12:00:00Z')
    s.setMeta('consolidated_at', '2026-06-13T12:00:00Z') // 覆写
    expect(s.getMeta('consolidated_at')).toBe('2026-06-13T12:00:00Z')
    s.close()
  })

  it('删除不存在的 id 不计数也不抛;空操作不写投影', () => {
    const res = applyMemoryConsolidation(
      { saves: [], deletes: [99] },
      'E--proj',
      { dbPath: join(dir, 'memory.db'), memoryMdPath: mdPath() },
    )
    expect(res).toEqual({ saved: 0, deleted: 0 })
    expect(existsSync(mdPath())).toBe(false)
  })
})

describe('Memory recall(情景记忆)', () => {
  function writeSession(id: string, text: string): void {
    const d = join(dir, 'sessions', 'auto', 'E--proj')
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, `${id}.json`),
      JSON.stringify({
        version: 3,
        cwd: 'E:\\proj',
        createdAt: '2026-06-02T11:00:00Z',
        updatedAt: '2026-06-02T11:00:00Z',
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        totalUsage: { input_tokens: 0, output_tokens: 0 },
      }),
      'utf8',
    )
  }

  it('recall 检索历史会话,返回带会话 id 与 /resume 指引的片段', async () => {
    writeSession('20260602-110000-aaaa', '我们讨论过影子 git 的 clean -fd 语义')
    const t = createMemoryTool('E--proj', {
      dbPath: join(dir, 'memory.db'),
      memoryMdPath: mdPath(),
      sessionsDir: join(dir, 'sessions'),
    })
    const res = await t.run({ action: 'recall', query: 'clean -fd' }, ctx())
    t.dispose()
    expect(res.isError).toBeFalsy()
    expect(res.output).toContain('20260602-110000-aaaa')
    expect(res.output).toContain('clean')
    expect(res.output).toContain('/resume')
  })

  it('recall 缺 query 回指引;零命中给建议', async () => {
    const t = createMemoryTool('E--proj', {
      dbPath: join(dir, 'memory.db'),
      memoryMdPath: mdPath(),
      sessionsDir: join(dir, 'sessions'),
    })
    const noQuery = await t.run({ action: 'recall' }, ctx())
    expect(noQuery.isError).toBe(true)
    const miss = await t.run({ action: 'recall', query: '没聊过的话题xyz', days: 7 }, ctx())
    t.dispose()
    expect(miss.isError).toBeFalsy()
    expect(miss.output).toContain('last 7 days')
  })
})
