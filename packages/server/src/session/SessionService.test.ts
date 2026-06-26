import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, StreamEvent } from '@zuse/core'
import { SessionService } from './SessionService.js'
import { SessionManager } from './SessionManager.js'
import type { CreateSessionOpts } from './createSession.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'

// ---------------------------------------------------------------------------
// Temp dirs
// ---------------------------------------------------------------------------

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zuse-svc-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeSettings(): ResolvedSettings {
  return {
    providers: {},
    tools: {},
    permissions: { defaultMode: 'default', allow: [], deny: [], ask: [] },
  } as unknown as ResolvedSettings
}

/**
 * A fake createSession that builds a real SessionManager around a fake client —
 * no real settings/model/network. `scriptsById` lets a test pre-seed a turn
 * script for the manager built under a given session id.
 */
function fakeCreateSessionFactory(scriptsById: Record<string, StreamEvent[][]> = {}) {
  return (opts: CreateSessionOpts): SessionManager => {
    const { client } = fakeClient(scriptsById[opts.sessionId] ?? [])
    return new SessionManager({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      client,
      registry: new ToolRegistry(),
      settings: makeSettings(),
      systemPrompt: 'SYS',
      permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: opts.snapshotStore ?? fakeSnapshotStore(),
      conversation: opts.conversation,
      checkpoints: opts.checkpoints,
      createdAt: opts.createdAt,
    })
  }
}

describe('SessionService', () => {
  it('create() returns an id, list() shows it as "New chat", and a record file exists', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)

    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(id)
    expect(list[0]!.title).toBe('New chat')

    expect(existsSync(join(dir, `${id}.json`))).toBe(true)
  })

  it('create({title, cwd}) honors the given title and cwd', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/default', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create({ title: 'My session', cwd: '/custom' })
    const list = await svc.list()
    expect(list[0]!.title).toBe('My session')
    expect(list[0]!.cwd).toBe('/custom')
    expect(id).toBeTruthy()
  })

  it('getOrLoad(): registry hit returns the same instance', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    const a = await svc.getOrLoad(id)
    const b = await svc.getOrLoad(id)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('getOrLoad() returns null for an unknown id', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    expect(await svc.getOrLoad('20990101-000000-dead')).toBeNull()
  })

  it('getOrLoad() loads from disk in a fresh service (conversation + checkpoints restored)', async () => {
    const dir = join(tempDir(), 'web-sessions')

    // Create a session, drive a turn so the record gets a conversation + a
    // checkpoint, then let the turn-end autosave persist. A scriptless fake
    // client yields no assistant text, but submit() still appends the user
    // message and records a checkpoint (fakeSnapshotStore.track returns a hash).
    const svc1 = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc1.create()
    const mgr1 = (await svc1.getOrLoad(id))!
    await mgr1.submit('remember this')
    await new Promise((r) => setTimeout(r, 20))

    // Fresh service over the same dir → must load from disk.
    const svc2 = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const mgr2 = await svc2.getOrLoad(id)
    expect(mgr2).not.toBeNull()
    expect(mgr2!.getConversation().length).toBeGreaterThan(0)
    expect(mgr2!.getCheckpoints().length).toBeGreaterThan(0)
  })

  it('delete() removes the session from list() and deletes the file', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    expect(existsSync(join(dir, `${id}.json`))).toBe(true)

    await svc.delete(id)
    expect(await svc.list()).toHaveLength(0)
    expect(existsSync(join(dir, `${id}.json`))).toBe(false)
    // After delete, getOrLoad must not resurrect it from the registry.
    expect(await svc.getOrLoad(id)).toBeNull()
  })

  it('autosave: a turn updates the on-disk record (messages persisted, title derived)', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    // Initial record exists with the default title.
    let list = await svc.list()
    expect(list[0]!.title).toBe('New chat')
    expect(list[0]!.messageCount).toBe(0)

    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('first user message here')
    await new Promise((r) => setTimeout(r, 20))

    list = await svc.list()
    expect(list[0]!.messageCount).toBeGreaterThan(0)
    // Title recomputed from the first user message (prefix stripped by submit/derive).
    expect(list[0]!.title).toBe('first user message here')

    // Exactly one record file on disk (create + autosave overwrote in place).
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })
})
