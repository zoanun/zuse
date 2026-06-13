import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEpisodeStore, type EpisodeStore } from './episode-store.js'

let dir: string
let store: EpisodeStore

const SLUG = 'E--proj-abcd1234'

/** 造一个自动会话文件(SessionRecord 形状,只填 recall 关心的字段)。 */
function writeSession(
  id: string,
  updatedAt: string,
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>,
  slug = SLUG,
): void {
  const d = join(dir, 'sessions', 'auto', slug)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, `${id}.json`),
    JSON.stringify({ version: 3, cwd: 'E:\\proj', createdAt: updatedAt, updatedAt, messages, totalUsage: { input_tokens: 0, output_tokens: 0 } }),
    'utf8',
  )
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-episode-'))
  store = openEpisodeStore({ dbPath: join(dir, 'memory.db'), sessionsDir: join(dir, 'sessions') })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('EpisodeStore.recall', () => {
  it('检索历史会话原文,命中返回会话 id/角色/日期/片段', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [
      user('影子 git 的 clean -fd 为什么不会删 ignored 文件?'),
      assistant('因为 clean 尊重 .gitignore,被忽略的文件不视为 untracked 垃圾。'),
    ])
    const hits = store.recall('clean -fd', SLUG)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.sessionId).toBe('20260602-110000-aaaa')
    expect(hits[0]!.at).toBe('2026-06-02T11:00:00Z')
    expect(hits[0]!.snippet).toContain('clean')
  })

  it('命中带 ±2 条对话上下文,锚点标记(对齐 Hermes 的窗口语义)', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [
      user('先聊点别的开场白'),
      user('影子 git 怎么初始化?'),
      assistant('用独立 --git-dir 配合 --work-tree。'),
      user('那 restore 呢?'),
      assistant('read-tree 加 checkout-index 加 clean 三连。'),
    ])
    const hits = store.recall('初始化', SLUG)
    expect(hits).toHaveLength(1)
    const ctx = hits[0]!.context
    // 锚点是第 2 条(msg_index 1),±2 = 下标 0..3 共 4 条。
    expect(ctx.length).toBe(4)
    expect(ctx.filter((c) => c.anchor)).toHaveLength(1)
    expect(ctx.find((c) => c.anchor)!.text).toContain('初始化')
    expect(ctx[0]!.text).toContain('开场白') // 前文
    expect(ctx[3]!.text).toContain('restore') // 后文
  })

  it('中文检索可命中(trigram)', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [user('我们讨论过上下文压缩的切点')])
    const hits = store.recall('上下文压缩', SLUG)
    expect(hits).toHaveLength(1)
  })

  it('只搜本项目 slug 的会话', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [user('本项目聊到 failover')])
    writeSession('20260602-120000-bbbb', '2026-06-02T12:00:00Z', [user('别的项目也聊到 failover')], 'E--other-99999999')
    const hits = store.recall('failover', SLUG)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toContain('本项目')
  })

  it('days 过滤:只搜最近 N 天更新过的会话', () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString()
    const recent = new Date(Date.now() - 2 * 86400_000).toISOString()
    writeSession('20260513-110000-oldd', old, [user('一个月前聊过 sandbox')])
    writeSession('20260610-110000-neww', recent, [user('前天也聊过 sandbox')])
    const all = store.recall('sandbox', SLUG)
    expect(all).toHaveLength(2)
    const recent10 = store.recall('sandbox', SLUG, { days: 10 })
    expect(recent10).toHaveLength(1)
    expect(recent10[0]!.sessionId).toBe('20260610-110000-neww')
  })

  it('增量索引:会话文件追加消息后,重新 recall 能看到新内容', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [user('第一回合')])
    expect(store.recall('第二回合', SLUG)).toHaveLength(0)
    // 同一会话续写(updatedAt 变化 → 重建该会话的索引)。
    writeSession('20260602-110000-aaaa', '2026-06-02T12:00:00Z', [user('第一回合'), user('第二回合聊了 tmux')])
    expect(store.recall('第二回合', SLUG)).toHaveLength(1)
  })

  it('上下文按索引行序取,夹在中间的工具消息不缩小窗口', () => {
    // 原始下标:0 user / 1-2 工具消息 / 3 anchor / 4 工具消息 / 5 assistant。
    // 按原始下标差 ±2 开窗会漏掉下标 0 的前文;按行序必须前后各取到 1 条。
    const toolMsg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c', content: '工具输出噪音' }],
    }
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [
      user('前文:聊到了快照目录'),
      toolMsg,
      toolMsg,
      user('锚点:影子仓库怎么清理?'),
      toolMsg,
      assistant('后文:目前不做 GC,记了 backlog。'),
    ])
    const hits = store.recall('影子仓库怎么清理', SLUG)
    expect(hits).toHaveLength(1)
    const ctx = hits[0]!.context
    expect(ctx.map((c) => c.anchor)).toEqual([false, true, false])
    expect(ctx[0]!.text).toContain('快照目录') // 原始下标差 3,仍是行序上的前一条
    expect(ctx[2]!.text).toContain('backlog')
    expect(ctx.some((c) => c.text.includes('工具输出噪音'))).toBe(false)
  })

  it('tool_use/tool_result 块不进索引(只索引 user/assistant 的文本)', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'findstr 工具噪音' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '一千行工具噪音输出' }] },
      assistant('真正的结论文本'),
    ])
    expect(store.recall('工具噪音', SLUG)).toHaveLength(0)
    expect(store.recall('结论', SLUG)).toHaveLength(1)
  })

  it('损坏的会话文件跳过,不影响其他会话检索', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [user('好会话聊 markdown')])
    const d = join(dir, 'sessions', 'auto', SLUG)
    writeFileSync(join(d, 'broken.json'), '{not json', 'utf8')
    expect(store.recall('markdown', SLUG)).toHaveLength(1)
  })

  it('会话目录不存在时返回空,不抛错', () => {
    expect(store.recall('anything', 'E--nonexistent-00000000')).toEqual([])
  })

  it('两字中文短词也能命中(LIKE 回退)', () => {
    writeSession('20260602-110000-aaaa', '2026-06-02T11:00:00Z', [user('讨论了回滚的语义')])
    expect(store.recall('回滚', SLUG).length).toBeGreaterThan(0)
  })
})
