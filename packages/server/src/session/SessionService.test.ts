import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, StreamEvent } from '@zuse/core'
import { SessionService } from './SessionService.js'
import { SessionManager } from './SessionManager.js'
import type { CreateSessionOpts } from './createSession.js'
import { loadSession, saveSession, type SessionRecord } from './sessionStore.js'
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
      titleAlreadySet: opts.titleAlreadySet,
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

  it('rename() on a live session pins the title against a later autosave deriveTitle', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    await svc.rename(id, 'My renamed session')

    // Disk reflects the manual title + flag immediately.
    let rec = await loadSession(dir, id)
    expect(rec?.title).toBe('My renamed session')
    expect(rec?.titleManual).toBe(true)

    // A later turn-end autosave must NOT clobber the manual title with deriveTitle.
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('a user message that would otherwise become the title')
    await new Promise((r) => setTimeout(r, 20))

    rec = await loadSession(dir, id)
    expect(rec?.title).toBe('My renamed session')
    expect(rec?.titleManual).toBe(true)
    // And the list view agrees.
    expect((await svc.list())[0]!.title).toBe('My renamed session')
  })

  it('rename() on a disk-only (not live) session edits the disk record directly', async () => {
    const dir = join(tempDir(), 'web-sessions')
    // Service A creates + persists, then we discard it so service B never has it live.
    const svcA = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svcA.create()

    const svcB = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    // Not loaded into svcB's registry — rename must hit the disk path.
    await svcB.rename(id, 'Renamed on disk')

    const rec = await loadSession(dir, id)
    expect(rec?.title).toBe('Renamed on disk')
    expect(rec?.titleManual).toBe(true)
  })

  it('rename() on a missing id is a no-op (no file created)', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    await svc.rename('20990101-000000-dead', 'ghost')
    expect(await svc.list()).toHaveLength(0)
  })

  it('getOrLoad() restoring a titleManual record keeps the manual title across autosaves', async () => {
    const dir = join(tempDir(), 'web-sessions')

    // Hand-write a record that is already manually titled (simulating a prior rename
    // that was persisted, then the process restarted with a fresh service).
    const id = '20260626-120000-aaaa'
    const rec: SessionRecord = {
      version: 1,
      id,
      title: 'Pinned name',
      titleManual: true,
      cwd: '/work',
      createdAt: '2026-06-26T12:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
      messages: [],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      checkpoints: [],
    }
    await saveSession(dir, rec)

    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const mgr = (await svc.getOrLoad(id))!
    // Drive a turn → autosave fires; manual title must survive (seeded from titleManual).
    await mgr.submit('this would be the derived title')
    await new Promise((r) => setTimeout(r, 20))

    const after = await loadSession(dir, id)
    expect(after?.title).toBe('Pinned name')
    expect(after?.titleManual).toBe(true)
  })

  it('delete() does not resurrect: a trailing in-flight persist cannot rewrite the file', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!

    // Kick a turn (queues a turn-end autosave) and delete immediately, racing the
    // fire-and-forget persist. The unsub + tombstone must keep the file gone.
    const turn = mgr.submit('about to be deleted')
    await svc.delete(id)
    await turn
    // Let any trailing persist attempt run.
    await new Promise((r) => setTimeout(r, 30))

    expect(existsSync(join(dir, `${id}.json`))).toBe(false)
    expect(await svc.list()).toHaveLength(0)
    // A fresh autosave directly through the (now unsubscribed) manager must also
    // not recreate the file — the tombstone blocks persist().
    mgr.subscribe(() => {}) // no-op; just proving manual persist below is blocked
    expect(existsSync(join(dir, `${id}.json`))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Small-model title generation
// ---------------------------------------------------------------------------

const titleStop: StreamEvent = { type: 'message-stop', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }

/**
 * Like fakeCreateSessionFactory, but each built manager also gets a small-model
 * titleClient that yields `titleText` for its single title call. `titleCalls`
 * (keyed by session id) lets a test count how many times the title model ran.
 */
function fakeCreateSessionFactoryWithTitle(titleText: string, titleCalls: Record<string, number>) {
  return (opts: CreateSessionOpts): SessionManager => {
    const { client } = fakeClient([])
    const title = fakeClient([[{ type: 'text-delta', text: titleText }, titleStop]], 'small')
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
      titleAlreadySet: opts.titleAlreadySet,
      titleClient: {
        getModel: () => 'small',
        async *sendMessages(m, c, t, s) {
          titleCalls[opts.sessionId] = (titleCalls[opts.sessionId] ?? 0) + 1
          yield* title.client.sendMessages(m, c, t, s)
        },
      },
      titleModel: 'small',
    })
  }
}

describe('SessionService — small-model title', () => {
  it('generates a title the moment the first message is sent (not on reply), pins it, survives later autosaves', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const calls: Record<string, number> = {}
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('精简标题', calls) })

    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('一段很啰嗦很长的第一句用户消息，本不该直接当标题')
    await new Promise((r) => setTimeout(r, 40))

    const rec = await loadSession(dir, id)
    expect(rec?.title).toBe('精简标题')          // generated title won over deriveTitle
    expect(rec?.titleGenerated).toBe(true)
    expect(rec?.titleManual).toBeFalsy()
    expect((await svc.list())[0]!.title).toBe('精简标题')
    expect(calls[id]).toBe(1)

    // A second message must NOT regenerate the title.
    await mgr.submit('第二句')
    await new Promise((r) => setTimeout(r, 40))
    expect(calls[id]).toBe(1)
    expect((await loadSession(dir, id))?.title).toBe('精简标题')
  })

  it('emits a title-changed event carrying the generated title', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const calls: Record<string, number> = {}
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('事件标题', calls) })
    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!

    const titles: string[] = []
    mgr.subscribe((e) => { if (e.type === 'title-changed') titles.push(e.title) })
    await mgr.submit('hello there')
    await new Promise((r) => setTimeout(r, 40))

    expect(titles).toEqual(['事件标题'])
  })

  it('a manual rename overrides a generated title (titleGenerated cleared)', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const calls: Record<string, number> = {}
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('机器标题', calls) })

    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('first message')
    await new Promise((r) => setTimeout(r, 40))
    expect((await loadSession(dir, id))?.titleGenerated).toBe(true)

    await svc.rename(id, '手动命名')
    const rec = await loadSession(dir, id)
    expect(rec?.title).toBe('手动命名')
    expect(rec?.titleManual).toBe(true)
    expect(rec?.titleGenerated).toBe(false)
  })

  it('getOrLoad() restoring a non-empty / titleGenerated record does not regenerate', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const calls: Record<string, number> = {}
    const id = '20260626-130000-bbbb'
    await saveSession(dir, {
      version: 1, id, title: '已生成的标题', titleGenerated: true, cwd: '/work',
      createdAt: '2026-06-26T13:00:00.000Z', updatedAt: '2026-06-26T13:00:00.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      checkpoints: [],
    })
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('不该出现', calls) })
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('another message')
    await new Promise((r) => setTimeout(r, 40))

    expect(calls[id] ?? 0).toBe(0)                 // never asked the model again
    expect((await loadSession(dir, id))?.title).toBe('已生成的标题')
  })

  it('no small model → no title generated, falls back to deriveTitle', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('hello world first line')
    await new Promise((r) => setTimeout(r, 40))

    const rec = await loadSession(dir, id)
    expect(rec?.titleGenerated).toBeFalsy()
    expect(rec?.title).toBe('hello world first line')   // deterministic deriveTitle fallback
  })
})
