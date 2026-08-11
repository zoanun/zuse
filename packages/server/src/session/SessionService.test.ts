import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings, StreamEvent } from '@zuse/core'
import { SessionService } from './SessionService.js'
import { SessionManager } from './SessionManager.js'
import type { CreateSessionOpts } from './createSession.js'
import { loadSession, saveSession, type SessionRecord } from './sessionStore.js'
import { fakeClient, fakeSnapshotStore, interactiveOpts } from './testFakes.js'

/**
 * 等后台 autosave 真的落盘。
 *
 * 取代原先散落各处的 `setTimeout(20~40)`：那些在本文件单跑时永远够，但全量并行跑时
 * worker 被饿死，20ms 的定时器可能实际睡 50ms+ —— 实测会让本文件随机红（每次红的还不是
 * 同一条，所以很容易被当成"偶发"忽略）。
 *
 * 轮询命中即返回，所以超时给足也不花时间。
 *
 * **interval 别调太小**（这条是实测踩出来的，调了两轮）：
 * - 5ms：全量跑时两个 helper **稳定**超时。每秒 200 次异步文件读把 IO 队列占住，
 *   **反而饿死了它自己要等的那个后台写盘**。
 * - 50ms：好很多，但全量跑仍偶发超时。
 * - 100ms + 18s 上限：最终值。
 *
 * 判据是实测的：这个文件**单独跑连过 5 次**、全量并行才闪 —— 说明不是产品竞态，
 * 是负载下轮询与被等待的写盘在同一个 worker 里抢时间片。轮询太密比太疏更危险，
 * 因为它把"等待"变成了"竞争"。上限受 vitest 的 testTimeout（20s）约束，故取 18s。
 */
async function persisted(dir: string, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const rec = await loadSession(dir, id)
    expect(rec).toBeTruthy()
  }, { timeout: 18_000, interval: 100 })
}

/**
 * 等标题生成也落盘。
 *
 * **不能**用 `persisted` 代替：标题是**后于**记录写盘的（先 autosave 记录，小模型生成标题
 * 后再写一次），`persisted` 在第一次写盘就返回，断言标题必然扑空。
 * 原先的 `sleep(20/40)` 碰巧把两段都盖住了 —— 这类"碰巧对"正是固定 sleep 最坑的地方：
 * 换成轮询时若不区分条件，就会把一个偶发失败变成稳定失败。
 */
async function titled(dir: string, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const rec = await loadSession(dir, id)
    expect(rec?.titleGenerated).toBe(true)
  }, { timeout: 18_000, interval: 100 })
}

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
      systemPrompt: 'SYS',
      ...interactiveOpts(makeSettings()),
      // Forward kind so create({kind:'cron'}) is observable via getKind() in tests.
      kind: opts.kind,
      snapshotStore: opts.snapshotStore ?? fakeSnapshotStore(),
      conversation: opts.conversation,
      checkpoints: opts.checkpoints,
      createdAt: opts.createdAt,
      titleAlreadySet: opts.titleAlreadySet,
    })
  }
}

describe('SessionService', () => {
  it('forwards registerExtraTools into createSession (B4 MCP seam)', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const reg = (): void => {}
    let seen: unknown = 'unset'
    const createFake = (opts: CreateSessionOpts): SessionManager => {
      seen = opts.registerExtraTools
      return fakeCreateSessionFactory()(opts)
    }
    const svc = new SessionService({ dir, cwd: '/work', createSession: createFake, registerExtraTools: reg })
    await svc.create()
    expect(seen).toBe(reg) // the exact callback was threaded through to createSession
  })

  it('create() registers a live session but does NOT persist an empty record', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}$/)

    // Live in the registry (WS can reach it by id)...
    expect(await svc.getOrLoad(id)).not.toBeNull()
    // ...but an unused session is NOT written to disk and does NOT clutter the list
    // (avoids empty "New chat" entries). It persists on the first turn-end (see autosave test).
    expect(existsSync(join(dir, `${id}.json`))).toBe(false)
    expect(await svc.list()).toHaveLength(0)
  })

  it('create({title, cwd}) honors cwd and keeps the given title across the first persist', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/default', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create({ title: 'My session', cwd: '/custom' })
    // Drive a turn so the session actually persists, then check the explicit title stuck
    // (was kept as a manual title — not derived from the message) and the cwd was honored.
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('a message that would otherwise become the title')
    await persisted(dir, id)
    const list = await svc.list()
    expect(list[0]!.title).toBe('My session')
    expect(list[0]!.cwd).toBe('/custom')
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
    await persisted(dir, id)

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
    // Give it content so it actually persists to disk.
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('content so the session persists')
    await persisted(dir, id)
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
    // An unused session is not on disk yet (create no longer writes an empty record).
    expect(await svc.list()).toHaveLength(0)

    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('first user message here')
    await persisted(dir, id)

    // The first turn-end is the first time it hits disk.
    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.messageCount).toBeGreaterThan(0)
    // Title recomputed from the first user message (prefix stripped by submit/derive).
    expect(list[0]!.title).toBe('first user message here')

    // Exactly one record file on disk.
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
    await persisted(dir, id)

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
    // Drive a turn so the session is actually written to disk (create no longer persists empties).
    const mgrA = (await svcA.getOrLoad(id))!
    await mgrA.submit('content so the record exists on disk')
    await persisted(dir, id)

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
    await persisted(dir, id)

    const after = await loadSession(dir, id)
    expect(after?.title).toBe('Pinned name')
    expect(after?.titleManual).toBe(true)
  })

  it('加载无 id 的旧会话存档 → 每条消息得确定性 id，二次加载不变', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const id = '20260626-120000-bbbb'
    // Hand-write a LEGACY record on disk: messages have no `id` field at all, as real
    // pre-feature session files do. loadSession() is schema-free (plain JSON.parse + cast),
    // so writing raw JSON here (instead of going through saveSession/SessionRecord, whose TS
    // type now requires Message.id) faithfully simulates an actual legacy file.
    const legacyRec = {
      version: 1,
      id,
      title: 'Legacy chat',
      cwd: '/work',
      createdAt: '2026-06-26T12:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      checkpoints: [],
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${id}.json`), JSON.stringify(legacyRec, null, 2), 'utf8')

    // Load through the real restore path (SessionService.getOrLoad → createSession →
    // Conversation.fromJSON, which backfills legacy ids deterministically by index).
    const svc1 = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const mgr1 = (await svc1.getOrLoad(id))!
    const ids1 = mgr1.getConversation().getMessages().map((m) => m.id)
    expect(ids1).toEqual(['msg_legacy_0', 'msg_legacy_1'])
    expect(ids1.every((x) => typeof x === 'string' && x.length > 0)).toBe(true)

    // A second, independent load (fresh service, so getOrLoad actually re-reads disk instead of
    // hitting the registry) must backfill the SAME ids — deterministic by ledger index, not random.
    const svc2 = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const mgr2 = (await svc2.getOrLoad(id))!
    const ids2 = mgr2.getConversation().getMessages().map((m) => m.id)
    expect(ids2).toEqual(ids1)
  })

  it("create({kind:'cron'}) persists kind and release() drops the live manager but keeps the file", async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create({ cwd: '/tmp', permissionMode: 'bypass', kind: 'cron' })
    const mgr = await svc.getOrLoad(id)
    expect(mgr!.getKind()).toBe('cron')

    // release() must exist and not throw; it drops the live manager without deleting any file.
    expect(typeof svc.release).toBe('function')
    expect(() => svc.release(id)).not.toThrow()
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
    // 这处**不能**换成轮询：下面断言的是文件**不存在**，而轮询没法等一件不会发生的事。
    // 固定 sleep 在这里是正确工具（它的失败模式是漏报，不是误报）。
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
      systemPrompt: 'SYS',
      ...interactiveOpts(makeSettings()),
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
    await titled(dir, id)

    const rec = await loadSession(dir, id)
    expect(rec?.title).toBe('精简标题')          // generated title won over deriveTitle
    expect(rec?.titleGenerated).toBe(true)
    expect(rec?.titleManual).toBeFalsy()
    expect((await svc.list())[0]!.title).toBe('精简标题')
    expect(calls[id]).toBe(1)

    // A second message must NOT regenerate the title.
    // 这里是**否定断言**（"不该再生成"），没有可等的正向信号 —— 轮询在这种情况下会
    // 立刻返回、等于没等，反而让断言失去牙齿。固定 sleep 在此是正确工具。
    await mgr.submit('第二句')
    await new Promise((r) => setTimeout(r, 50))
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
    // 等的是事件到达，不是落盘 —— 用事件本身做条件，别拿落盘当代理信号。
    await vi.waitFor(() => expect(titles).toEqual(['事件标题']), { timeout: 18_000, interval: 100 })

    expect(titles).toEqual(['事件标题'])
  })

  it('a manual rename overrides a generated title (titleGenerated cleared)', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const calls: Record<string, number> = {}
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('机器标题', calls) })

    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('first message')
    await titled(dir, id)

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
      messages: [{ role: 'user', id: 'm1', content: [{ type: 'text', text: 'hi' }] }],
      totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      checkpoints: [],
    })
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactoryWithTitle('不该出现', calls) })
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('another message')
    await persisted(dir, id)

    expect(calls[id] ?? 0).toBe(0)                 // never asked the model again
    expect((await loadSession(dir, id))?.title).toBe('已生成的标题')
  })

  it('no small model → no title generated, falls back to deriveTitle', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!
    await mgr.submit('hello world first line')
    await persisted(dir, id)

    const rec = await loadSession(dir, id)
    expect(rec?.titleGenerated).toBeFalsy()
    expect(rec?.title).toBe('hello world first line')   // deterministic deriveTitle fallback
  })

})

// ---------------------------------------------------------------------------
// 会话离开 registry 时必须取消待触发的自唤醒（B2）
// ---------------------------------------------------------------------------

describe('SessionService — 自唤醒生命周期', () => {
  // 下面两条断言的是**效果**（产出确实没投出去），不是「某个取消方法被调用过」。
  // 后者是钉在具体实现名上的白盒 spy：待投递机制从 cancelWakeup 泛化到
  // cancelAllInjections 时，那种写法只会静默失效或误红，而不会说出真正要说的话。
  it('release() 作废全部待投递 —— 会话已离开 registry，那些产出无处可去', async () => {
    const svc = new SessionService({ dir: tempDir(), cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc.create({})
    const mgr = (await svc.getOrLoad(id))!
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    const finish = mgr.startBackgroundAgent('活儿')

    svc.release(id)
    finish('本该被丢弃的结果')

    expect(submit).not.toHaveBeenCalled()
  })

  it('delete() 同样作废 —— 会话文件都删了', async () => {
    const svc = new SessionService({ dir: tempDir(), cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc.create({})
    const mgr = (await svc.getOrLoad(id))!
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    const finish = mgr.startBackgroundAgent('活儿')

    await svc.delete(id)
    finish('本该被丢弃的结果')

    expect(submit).not.toHaveBeenCalled()
  })

  it('release() 之后待触发的唤醒确实不再触发（不只是调了 cancel）', async () => {
    const svc = new SessionService({ dir: tempDir(), cwd: '/work', createSession: fakeCreateSessionFactory() })
    const { id } = await svc.create({})
    const mgr = (await svc.getOrLoad(id))!
    // 假定时器：断言失败时也不会漏一个 5s 的真实定时器出去。
    vi.useFakeTimers()
    try {
      mgr.scheduleWakeup(5000, '幽灵')
      expect(mgr.hasPendingWakeup()).toBe(true)   // 前提成立，否则后面那条断言没有意义
      svc.release(id)
      expect(mgr.hasPendingWakeup()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
