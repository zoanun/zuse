import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionRecord } from './sessionStore.js'
import {
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
} from './sessionStore.js'
import type { SessionCheckpoint } from './events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zuse-sess-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const checkpoints: SessionCheckpoint[] = [
    { messageIndex: 0, hash: 'abc123', at: '2026-06-25T10:00:00.000Z', label: 'hello' },
  ]
  return {
    version: 1,
    id: newSessionId(new Date('2026-06-25T10:00:00.000Z')),
    title: 'Test session',
    cwd: '/home/user/project',
    model: 'claude-opus-4-8',
    createdAt: '2026-06-25T10:00:00.000Z',
    updatedAt: '2026-06-25T10:01:00.000Z',
    messages: [
      { role: 'user', id: 'm1', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', id: 'm2', content: [{ type: 'text', text: 'Hi!' }] },
    ],
    totalUsage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    checkpoints,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// newSessionId
// ---------------------------------------------------------------------------

describe('newSessionId', () => {
  it('matches the expected format YYYYMMDD-HHMMSS-xxxxxxxx', () => {
    const fixed = new Date('2026-06-25T14:30:00.000Z')
    const id = newSessionId(fixed)
    // Format: 8 digits - 6 digits - 8 hex chars (32 bits of crypto randomness, collision-resistant)
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/)
  })

  it('encodes the passed date in the prefix (local time parts)', () => {
    // Use a Date constructed from explicit local-time components so the test
    // is not sensitive to the machine's UTC offset.
    const fixed = new Date(2026, 0, 2, 3, 4, 5) // Jan 2 2026 03:04:05 local
    const id = newSessionId(fixed)
    expect(id.startsWith('20260102-030405-')).toBe(true)
  })

  it('two calls with the same date produce different ids (random suffix)', () => {
    const fixed = new Date('2026-06-25T10:00:00.000Z')
    const ids = new Set(Array.from({ length: 20 }, () => newSessionId(fixed)))
    // With a 4-hex-char suffix (65536 possibilities) collisions are astronomically rare
    expect(ids.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// saveSession + loadSession round-trip
// ---------------------------------------------------------------------------

describe('saveSession / loadSession', () => {
  it('round-trips all fields including checkpoints and totalUsage', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    const loaded = await loadSession(dir, rec.id)
    expect(loaded).not.toBeNull()
    expect(loaded).toEqual(rec)
  })

  it('loadSession returns null for a missing id', async () => {
    const dir = tempDir()
    const result = await loadSession(dir, 'missing-0000')
    expect(result).toBeNull()
  })

  it('loadSession returns null for a corrupt json file', async () => {
    const dir = tempDir()
    const id = newSessionId(new Date('2026-06-25T10:00:00.000Z'))
    writeFileSync(join(dir, `${id}.json`), 'not-json{{{{', 'utf8')
    const result = await loadSession(dir, id)
    expect(result).toBeNull()
  })

  it('atomic write: no leftover .tmp file after saveSession', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    const files = readdirSync(dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain(`${rec.id}.json`)
  })

  it('overwrites existing file on re-save', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    const updated = { ...rec, title: 'Updated title', updatedAt: '2026-06-25T12:00:00.000Z' }
    await saveSession(dir, updated)
    const loaded = await loadSession(dir, rec.id)
    expect(loaded?.title).toBe('Updated title')
  })

  it('round-trips the titleManual flag (manual title survives save→load)', async () => {
    const dir = tempDir()
    const rec = makeRecord({ title: 'Hand-picked name', titleManual: true })
    await saveSession(dir, rec)
    const loaded = await loadSession(dir, rec.id)
    expect(loaded?.titleManual).toBe(true)
    expect(loaded?.title).toBe('Hand-picked name')
  })
})

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  it('returns [] for a non-existent directory', async () => {
    const metas = await listSessions(join(tmpdir(), 'zuse-nonexistent-dir-xyz'))
    expect(metas).toEqual([])
  })

  it('returns metas sorted by updatedAt descending', async () => {
    const dir = tempDir()
    const older = makeRecord({
      id: newSessionId(new Date('2026-06-24T10:00:00.000Z')),
      title: 'Older',
      updatedAt: '2026-06-24T10:00:00.000Z',
      createdAt: '2026-06-24T10:00:00.000Z',
    })
    const newer = makeRecord({
      id: newSessionId(new Date('2026-06-25T10:00:00.000Z')),
      title: 'Newer',
      updatedAt: '2026-06-25T10:00:00.000Z',
      createdAt: '2026-06-25T10:00:00.000Z',
    })
    // Save older first to ensure sort isn't file-order dependent
    await saveSession(dir, older)
    await saveSession(dir, newer)
    const metas = await listSessions(dir)
    expect(metas).toHaveLength(2)
    expect(metas[0]?.title).toBe('Newer')
    expect(metas[1]?.title).toBe('Older')
  })

  it('skips a corrupt .json file and returns the valid ones', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    writeFileSync(join(dir, 'bad.json'), 'garbage{{{{', 'utf8')
    const metas = await listSessions(dir)
    expect(metas).toHaveLength(1)
    expect(metas[0]?.id).toBe(rec.id)
  })

  it('skips a .json file that lacks required fields', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'incomplete.json'), JSON.stringify({ version: 1 }), 'utf8')
    const metas = await listSessions(dir)
    expect(metas).toEqual([])
  })

  it('maps messageCount to messages.length', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    const metas = await listSessions(dir)
    expect(metas[0]?.messageCount).toBe(rec.messages.length)
  })
})

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('removes the session file', async () => {
    const dir = tempDir()
    const rec = makeRecord()
    await saveSession(dir, rec)
    await deleteSession(dir, rec.id)
    expect(existsSync(join(dir, `${rec.id}.json`))).toBe(false)
  })

  it('does not throw when deleting a missing id (idempotent)', async () => {
    const dir = tempDir()
    await expect(deleteSession(dir, 'nonexistent-0000')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

describe('safeId enforcement', () => {
  it('saveSession throws on id with path separators', async () => {
    const dir = tempDir()
    const rec = makeRecord({ id: '../evil' })
    await expect(saveSession(dir, rec)).rejects.toThrow(/Invalid session id/)
  })

  it('loadSession throws on id with path separators', async () => {
    const dir = tempDir()
    await expect(loadSession(dir, '../../etc/passwd')).rejects.toThrow(/Invalid session id/)
  })

  it('deleteSession throws on id with path separators', async () => {
    const dir = tempDir()
    await expect(deleteSession(dir, '../evil')).rejects.toThrow(/Invalid session id/)
  })
})
