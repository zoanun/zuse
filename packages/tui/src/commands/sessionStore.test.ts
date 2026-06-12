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
