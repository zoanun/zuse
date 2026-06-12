import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Conversation } from '@zuse/core'
import {
  cwdSlug,
  newSessionId,
  autosaveSession,
  listAutoSessions,
  loadAutoSession,
  remapCheckpoints,
  type SessionCheckpoint,
} from './sessionStore.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zuse-sessions-'))
  process.env.ZUSE_SESSIONS_DIR = dir
})

afterEach(() => {
  delete process.env.ZUSE_SESSIONS_DIR
  rmSync(dir, { recursive: true, force: true })
})

function convWith(texts: string[]): Conversation {
  const conv = new Conversation()
  for (const [i, t] of texts.entries()) {
    if (i % 2 === 0) conv.appendUserText(t)
    else conv.appendAssistantText(t)
  }
  return conv
}

describe('cwdSlug', () => {
  it('flattens a Windows path to a single safe segment', () => {
    expect(cwdSlug('E:\\ai-study\\zuse')).toBe('E--ai-study-zuse')
    expect(cwdSlug('/home/u/proj')).toBe('-home-u-proj')
  })
})

describe('newSessionId', () => {
  it('is sortable by time and unique-ish', () => {
    const a = newSessionId(new Date('2026-06-12T08:30:00'))
    expect(a).toMatch(/^20260612-083000-[a-z0-9]{4}$/)
  })
})

describe('autosaveSession', () => {
  it('writes a v2 record grouped by cwd and loads it back', async () => {
    const conv = convWith(['第一问', '第一答'])
    const id = newSessionId()
    await autosaveSession(id, 'E:\\proj\\a', conv, '2026-06-12T08:00:00Z')
    const loaded = await loadAutoSession('E:\\proj\\a', id)
    expect(loaded.conversation.getMessages()).toEqual(conv.getMessages())
    expect(loaded.createdAt).toBe('2026-06-12T08:00:00Z')
  })

  it('skips empty conversations (no file written)', async () => {
    await autosaveSession(newSessionId(), 'E:\\proj\\a', new Conversation(), '2026-06-12T08:00:00Z')
    expect(readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json'))).toEqual([])
  })

  it('overwrites the same id on subsequent turns (one file per session)', async () => {
    const id = newSessionId()
    await autosaveSession(id, 'E:\\proj\\a', convWith(['a', 'b']), '2026-06-12T08:00:00Z')
    await autosaveSession(id, 'E:\\proj\\a', convWith(['a', 'b', 'c', 'd']), '2026-06-12T08:00:00Z')
    const metas = await listAutoSessions('E:\\proj\\a')
    expect(metas).toHaveLength(1)
    expect(metas[0]!.messageCount).toBe(4)
  })
})

describe('listAutoSessions', () => {
  it('lists only the given cwd, newest first, with first-user-text preview', async () => {
    await autosaveSession('20260612-080000-aaaa', 'E:\\proj\\a', convWith(['早问', '答']), '2026-06-12T08:00:00Z')
    await autosaveSession('20260612-090000-bbbb', 'E:\\proj\\a', convWith(['晚问', '答']), '2026-06-12T09:00:00Z')
    await autosaveSession('20260612-100000-cccc', 'E:\\proj\\b', convWith(['别的项目', '答']), '2026-06-12T10:00:00Z')

    const metas = await listAutoSessions('E:\\proj\\a')
    expect(metas.map((m) => m.id)).toEqual(['20260612-090000-bbbb', '20260612-080000-aaaa'])
    expect(metas[0]!.firstUserText).toBe('晚问')
    expect(metas[0]!.messageCount).toBe(2)
  })

  it('skips corrupt files instead of failing the whole list', async () => {
    await autosaveSession('20260612-080000-aaaa', 'E:\\proj\\a', convWith(['好的', '答']), '2026-06-12T08:00:00Z')
    const slugDir = join(dir, 'auto', cwdSlug('E:\\proj\\a'))
    writeFileSync(join(slugDir, 'broken.json'), '{not json', 'utf8')
    const metas = await listAutoSessions('E:\\proj\\a')
    expect(metas).toHaveLength(1)
    expect(metas[0]!.id).toBe('20260612-080000-aaaa')
  })

  it('returns [] when the cwd has no sessions yet', async () => {
    expect(await listAutoSessions('E:\\nowhere')).toEqual([])
  })

  it('truncates long first-user-text in the preview', async () => {
    const long = '这是一条非常长的首条消息'.repeat(10)
    await autosaveSession('20260612-080000-aaaa', 'E:\\proj\\a', convWith([long, '答']), '2026-06-12T08:00:00Z')
    const metas = await listAutoSessions('E:\\proj\\a')
    expect(metas[0]!.firstUserText.length).toBeLessThanOrEqual(41) // 40 + 省略号
    expect(metas[0]!.firstUserText.endsWith('…')).toBe(true)
  })
})

describe('loadAutoSession', () => {
  it('throws a friendly error for an unknown id', async () => {
    await expect(loadAutoSession('E:\\proj\\a', 'no-such-id')).rejects.toThrow(/找不到/)
  })

  it('rejects ids that try to escape the sessions dir', async () => {
    mkdirSync(join(dir, 'auto'), { recursive: true })
    await expect(loadAutoSession('E:\\proj\\a', '..\\..\\evil')).rejects.toThrow()
  })
})

// ——— Phase 12:checkpoints(v3) ———

const CP = (messageIndex: number, hash = 'a'.repeat(40)): SessionCheckpoint => ({
  messageIndex,
  hash,
  at: '2026-06-12T08:00:00Z',
  label: `回合 ${messageIndex}`,
})

describe('SessionRecord v3 checkpoints', () => {
  it('v3 写读往返:checkpoints 原样带回', async () => {
    const id = newSessionId()
    const cps = [CP(0), CP(2, 'b'.repeat(40))]
    await autosaveSession(id, 'E:\\proj\\a', convWith(['问1', '答1', '问2', '答2']), '2026-06-12T08:00:00Z', cps)
    const loaded = await loadAutoSession('E:\\proj\\a', id)
    expect(loaded.checkpoints).toEqual(cps)
  })

  it('v2 旧文件读入时 checkpoints 缺省为 [](向后兼容)', async () => {
    const slugDir = join(dir, 'auto', cwdSlug('E:\\proj\\a'))
    mkdirSync(slugDir, { recursive: true })
    const v2 = {
      version: 2,
      cwd: 'E:\\proj\\a',
      createdAt: '2026-06-12T08:00:00Z',
      updatedAt: '2026-06-12T08:05:00Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
    }
    writeFileSync(join(slugDir, '20260612-080000-v2v2.json'), JSON.stringify(v2), 'utf8')
    const loaded = await loadAutoSession('E:\\proj\\a', '20260612-080000-v2v2')
    expect(loaded.checkpoints).toEqual([])
    // v2 也仍出现在 /resume 列表里。
    const metas = await listAutoSessions('E:\\proj\\a')
    expect(metas.map((m) => m.id)).toContain('20260612-080000-v2v2')
  })
})

describe('remapCheckpoints(压缩联动)', () => {
  it('折叠区间内的删除、保留区间的重映射(−cut+1 条摘要占位)', () => {
    // 压缩 cut=4:messages[0..4) 折叠为 1 条摘要。
    const out = remapCheckpoints([CP(0), CP(2), CP(4), CP(6)], 4)
    expect(out.map((c) => c.messageIndex)).toEqual([1, 3]) // 4→1(摘要后第一条)、6→3
  })

  it('恰在切点的检查点保留并映射到摘要后第一位', () => {
    const out = remapCheckpoints([CP(4)], 4)
    expect(out).toHaveLength(1)
    expect(out[0]!.messageIndex).toBe(1)
    expect(out[0]!.hash).toBe('a'.repeat(40)) // 其余字段不动
  })

  it('全部在折叠区间内 → 空', () => {
    expect(remapCheckpoints([CP(0), CP(2)], 4)).toEqual([])
  })
})
