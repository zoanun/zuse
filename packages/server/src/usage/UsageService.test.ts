import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Usage } from '@zuse/core'
import type { SessionRecord } from '../session/sessionStore.js'
import { UsageService } from './UsageService.js'

function writeRecord(
  dir: string, id: string, model: string, usage: Partial<Usage>, updatedAt: string,
  extra: Partial<SessionRecord> = {}, // 有类型才挡得住拼错的字段名
): void {
  const rec = {
    version: 1, id, title: `t-${id}`, cwd: '/work', createdAt: updatedAt, updatedAt,
    messages: [], checkpoints: [], model,
    totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    ...extra,
  }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec), 'utf8')
}

describe('UsageService (M5)', () => {
  let dir: string, svc: UsageService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zuse-usage-'))
    svc = new UsageService(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns empty stats for an empty dir', async () => {
    const s = await svc.stats()
    expect(s.sessionCount).toBe(0)
    expect(s.total.input_tokens).toBe(0)
    expect(s.byModel).toEqual([])
    expect(s.sessions).toEqual([])
  })

  it('sums grand total across sessions (incl. cache buckets)', async () => {
    writeRecord(dir, 'a', 'opus', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }, '2026-06-29T01:00:00Z')
    writeRecord(dir, 'b', 'opus', { input_tokens: 200, output_tokens: 70 }, '2026-06-29T02:00:00Z')
    const s = await svc.stats()
    expect(s.sessionCount).toBe(2)
    expect(s.total.input_tokens).toBe(300)
    expect(s.total.output_tokens).toBe(120)
    expect(s.total.cache_read_input_tokens).toBe(10)
  })

  it('groups by model, biggest first, and counts sessions per model', async () => {
    writeRecord(dir, 'a', 'opus', { input_tokens: 100, output_tokens: 0 }, '2026-06-29T01:00:00Z')
    writeRecord(dir, 'b', 'opus', { input_tokens: 100, output_tokens: 0 }, '2026-06-29T02:00:00Z')
    writeRecord(dir, 'c', 'sonnet', { input_tokens: 50, output_tokens: 0 }, '2026-06-29T03:00:00Z')
    const s = await svc.stats()
    expect(s.byModel.map((m) => m.model)).toEqual(['opus', 'sonnet']) // opus (200) before sonnet (50)
    expect(s.byModel[0]!.sessions).toBe(2)
    expect(s.byModel[0]!.usage.input_tokens).toBe(200)
    expect(s.byModel[1]!.sessions).toBe(1)
  })

  it("collects records with no model under 'unknown'", async () => {
    writeRecord(dir, 'a', '', { input_tokens: 10, output_tokens: 0 }, '2026-06-29T01:00:00Z')
    const s = await svc.stats()
    expect(s.byModel[0]!.model).toBe('unknown')
  })

  it("counts cron sessions but tags them so the dashboard can tell them apart", async () => {
    // Cron runs burn real tokens, so excluding them would under-report actual spend — they stay in
    // the totals. But they never appear in the sidebar, so an untagged row is a mystery session:
    // carry `kind` through and let the UI badge it.
    writeRecord(dir, 'chat', 'opus', { input_tokens: 100, output_tokens: 0 }, '2026-07-29T01:00:00Z')
    writeRecord(dir, 'nightly', 'opus', { input_tokens: 40, output_tokens: 0 }, '2026-07-29T02:00:00Z', { kind: 'cron' })
    const s = await svc.stats()
    expect(s.total.input_tokens).toBe(140) // cron spend is real spend — still counted
    expect(s.sessionCount).toBe(2)
    expect(s.sessions.find((x) => x.id === 'nightly')!.kind).toBe('cron')
    expect(s.sessions.find((x) => x.id === 'chat')!.kind).toBeUndefined()
  })

  it('orders the per-session list biggest first', async () => {
    writeRecord(dir, 'small', 'opus', { input_tokens: 10, output_tokens: 0 }, '2026-06-29T03:00:00Z')
    writeRecord(dir, 'big', 'opus', { input_tokens: 999, output_tokens: 0 }, '2026-06-29T01:00:00Z')
    const s = await svc.stats()
    expect(s.sessions[0]!.id).toBe('big')
    expect(s.sessions[1]!.id).toBe('small')
  })
})
