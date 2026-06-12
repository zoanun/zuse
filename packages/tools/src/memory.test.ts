import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolContext } from '@zuse/core'
import { createFileTracker } from '@zuse/core'
import { createMemoryTool } from './memory.js'

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

  it('未知 action 列出可用 action(observation contract)', async () => {
    const res = await tool.run({ action: 'wipe' }, ctx())
    expect(res.isError).toBe(true)
    expect(res.output).toContain('save, search, recall, list, delete')
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
