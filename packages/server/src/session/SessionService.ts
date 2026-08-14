import { Conversation, type ToolRegistry, type ModelClient, type Message } from '@zuse/core'
import { SessionRegistry } from './SessionRegistry.js'
import { createSession as defaultCreateSession } from './createSession.js'
import type { SessionManager } from './SessionManager.js'
import {
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  type SessionRecord,
  type SessionMeta,
} from './sessionStore.js'
import { stripUserStamp } from './userStamp.js'

export interface SessionServiceOpts {
  /** web-sessions dir — where SessionRecord json files live. */
  dir: string
  /** default cwd for new sessions. */
  cwd: string
  /** injectable for tests (offline fake-client createSession). */
  createSession?: typeof defaultCreateSession
  /** forwarded into every createSession so daemon-owned MCP tools (B4) register per session. */
  registerExtraTools?: (registry: ToolRegistry) => void
  /** I2 图片:下面四项由 startServer 建好后透传给每个 createSession(→ SessionManager)。 */
  imageClient?: ModelClient
  imageModel?: string
  readImageBase64?: (id: string) => Promise<{ data: string; mediaType: string }>
  expandAttachments?: (messages: Message[]) => Promise<Message[]>
  /**
   * 会话被**删除**时通知一声（`startServer` 传 `(id) => runs.killSession(id)`）。
   *
   * **只挂在 `delete()` 上，绝不能挂 `release()`。** `release()` 的另外两个调用方是
   * cron 的**纯归还**（`CronScheduler.fire()` 的 finally、`CronService.getRunDetail()`）
   * —— 那时会话还在、用户还会再打开它，把它的 run 杀掉是错的。
   *
   * 用回调而不是直接注入 registry：会话层只需要「删了之后通知一声」，
   * 注入 registry 会让它从此能对 run 做任何事。形态与 `registerExtraTools` 一致。
   */
  onDelete?: (sessionId: string) => void
}

/**
 * Multi-session lifecycle + autosave.
 *
 * Wraps a SessionRegistry (the live in-memory managers) over a persistence dir.
 * - getOrLoad / create register a live SessionManager and wire autosave.
 * - autosave subscribes to each manager and persists a SessionRecord on every
 *   turn-end / checkpoint-recorded (fire-and-forget, never breaks a turn).
 *
 * LIST source-of-truth = the on-disk dir. create() does NOT write an empty record — a brand-new
 * session is live in the registry (reachable by id over WS) but hits disk only when autosave
 * persists it on the first turn-end. So an unused session is intentionally absent from list()
 * (no empty "New chat" clutter); list() reads disk and does not merge registry-only entries.
 */
export class SessionService {
  private readonly dir: string
  private readonly cwd: string
  private readonly registry = new SessionRegistry()
  private readonly createSession: typeof defaultCreateSession
  private readonly registerExtraTools?: (registry: ToolRegistry) => void
  /** I2 图片:透传给每个 createSession 的注入项(startServer 提供)。 */
  private readonly imageClient?: ModelClient
  private readonly imageModel?: string
  private readonly readImageBase64?: (id: string) => Promise<{ data: string; mediaType: string }>
  private readonly expandAttachments?: (messages: Message[]) => Promise<Message[]>
  /** Per-id in-flight guard so concurrent persists don't interleave writes. */
  private readonly persisting = new Set<string>()
  /** Set when a persist was requested while one was already in flight (coalesce). */
  private readonly persistAgain = new Set<string>()
  /** Per-id autosave unsubscribe fn (from mgr.subscribe), so delete() can stop it. */
  private readonly unsubs = new Map<string, () => void>()
  /** Ids that have been deleted — blocks an in-flight persist from rewriting the file. */
  private readonly tombstones = new Set<string>()
  /** Per-id manually-set titles (via rename) — wins over deriveTitle in persist(). */
  private readonly manualTitles = new Map<string, string>()
  /** Per-id small-model-generated titles — pins the title (no re-gen, no deriveTitle
   *  overwrite), but a manual rename still overrides. */
  private readonly generatedTitles = new Map<string, string>()

  constructor(opts: SessionServiceOpts) {
    this.dir = opts.dir
    this.cwd = opts.cwd
    this.createSession = opts.createSession ?? defaultCreateSession
    this.registerExtraTools = opts.registerExtraTools
    this.imageClient = opts.imageClient
    this.imageModel = opts.imageModel
    this.readImageBase64 = opts.readImageBase64
    this.expandAttachments = opts.expandAttachments
    this.onDelete = opts.onDelete
  }

  private readonly onDelete: ((sessionId: string) => void) | undefined

  /**
   * Registry hit → return it. Else try to load from disk; if found, rebuild a
   * live manager (conversation + checkpoints restored), register it, wire
   * autosave, and return. Returns null when the id exists nowhere.
   */
  async getOrLoad(id: string): Promise<SessionManager | null> {
    const live = this.registry.get(id)
    if (live) return live

    const rec = await loadSession(this.dir, id)
    if (!rec) return null

    const mgr = this.createSession({
      sessionId: id,
      cwd: rec.cwd,
      conversation: Conversation.fromJSON({
        version: 1,
        messages: rec.messages,
        totalUsage: rec.totalUsage,
      }),
      checkpoints: rec.checkpoints,
      // Feature B: restore compaction state so the next turn's LLM view is rebuilt correctly.
      compaction: rec.compaction,
      createdAt: rec.createdAt,
      kind: rec.kind,
      // A restored session has already passed its "first message" moment (or was
      // manually titled) → don't auto-generate a title again on its next message.
      titleAlreadySet: rec.messages.length > 0 || !!rec.titleManual || !!rec.titleGenerated,
      registerExtraTools: this.registerExtraTools,
      imageClient: this.imageClient,
      imageModel: this.imageModel,
      readImageBase64: this.readImageBase64,
      expandAttachments: this.expandAttachments,
    })
    // Re-seed manual/generated title from disk so a restart doesn't lose it (and so
    // the next autosave won't overwrite it, nor re-generate). Manual wins over generated.
    if (rec.titleManual) this.manualTitles.set(id, rec.title)
    else if (rec.titleGenerated) this.generatedTitles.set(id, rec.title)
    this.tombstones.delete(id) // reusing this id is legal again
    this.registry.set(id, mgr)
    this.wireAutosave(id, mgr)
    return mgr
  }

  /**
   * Create a fresh session: register a live manager and wire autosave. Does NOT persist an
   * initial record — feature C keeps empty sessions off disk, so a brand-new session is live in
   * the registry (reachable by id over WS) but stays absent from list() until the first turn-end
   * autosave, once it has real content. An explicit `title` is remembered as an initial title.
   */
  async create(opts?: { cwd?: string; title?: string; permissionMode?: import('@zuse/core').PermissionMode; kind?: 'cron' }): Promise<{ id: string }> {
    const id = newSessionId()
    const cwd = opts?.cwd ?? this.cwd
    const mgr = this.createSession({
      sessionId: id,
      cwd,
      permissionMode: opts?.permissionMode,
      kind: opts?.kind,
      registerExtraTools: this.registerExtraTools,
      imageClient: this.imageClient,
      imageModel: this.imageModel,
      readImageBase64: this.readImageBase64,
      expandAttachments: this.expandAttachments,
    })
    this.tombstones.delete(id) // (re)using this id is legal
    this.registry.set(id, mgr)
    this.wireAutosave(id, mgr)
    // Do NOT persist an empty session. The old behavior wrote an initial record on
    // create, so every "+ New chat" and every first-visit bootstrap left an empty
    // record cluttering the list. The session is live in the registry (WS can reach
    // it by id); autosave persists it on the first turn-end, once it has real content.
    // An explicitly supplied title seeds the *generated* title, not a manual one: the first
    // persist writes it (persist priority: manual ?? generated ?? derived), but a small-model
    // title-changed event can still replace it and a manual rename still overrides it — matching
    // the old forcedTitle semantics. Writing it into manualTitles would instead pin it forever
    // and permanently block the auto-generated title.
    if (opts?.title) this.generatedTitles.set(id, opts.title)
    return { id }
  }

  /**
   * Adopt a pre-built SessionManager under `id` (test/seed seam): register it,
   * wire autosave, and persist an initial record. startServer uses this to seed
   * the DEFAULT session from an injected fake-client manager without going
   * through createSession (which would build real settings/model).
   */
  async adopt(id: string, mgr: SessionManager, title = 'New chat'): Promise<void> {
    this.tombstones.delete(id) // (re)using this id is legal
    this.registry.set(id, mgr)
    this.wireAutosave(id, mgr)
    await this.persist(id, mgr, title)
  }

  /** All sessions on disk, sorted updatedAt desc (listSessions already sorts). */
  async list(): Promise<SessionMeta[]> {
    return listSessions(this.dir)
  }

  /** Drop the live manager AND the on-disk record. */
  async delete(id: string): Promise<void> {
    // delete = release（让会话离开内存）+ 删盘。复用 release() 而非再抄一遍那几步：
    // 「会话离开 registry 时要清理什么」将来加第二项时，只该改一个地方。
    this.release(id)
    // **位置与 try/catch 都是刻意的。**
    // 位置：在 `release()` 之后、删盘之前 —— 会话确实要走了，它起的 run 必须先收
    //（否则留下永生孤儿：项目档无墙钟、断连保留，一个 dev server 会永远占着端口，
    //  而 UI 里再也看不到它，因为会话没了）。
    // try/catch：kill 失败**不能**阻止删盘，否则用户永远删不掉这个会话。而且这条链
    // 是 await 在 HTTP 请求栈上的 —— 本轮审计刚修过一条同型的（killTree 的 spawn 失败
    // 没挂 'error'，把整个 daemon 带走）。
    try { this.onDelete?.(id) } catch (err) {
      console.warn(`[zuse-server] 删会话时收 run 失败(${id}):${err instanceof Error ? err.message : String(err)}`)
    }
    // Tombstone the id: any persist already awaiting saveSession() early-returns
    // before the write, closing the in-flight-persist resurrection race.
    this.tombstones.add(id)
    this.persistAgain.delete(id) // drop any pending trailing save for this id
    this.manualTitles.delete(id)
    this.generatedTitles.delete(id)
    await deleteSession(this.dir, id)
  }

  /** 该 id 此刻是否已在 registry 里（live）。只读路径用它判断「这个会话是不是我捞进来的」。 */
  isLive(id: string): boolean {
    return this.registry.get(id) !== undefined
  }

  /**
   * 释放一个 live 会话：停 autosave + 从 registry 移除，但**保留**磁盘文件（区别于 delete）。
   * cron 每次 fire 跑完调用它，避免每次触发都往 registry 永久堆一个 SessionManager。
   * 之后 getOrLoad(id) 仍能从盘重建（drill-down 回看）。
   *
   * **这是会话的生命周期终点，不是「用完归还」**：它会作废全部待投递。只读路径若对一个
   * 本来就 live 的会话调它，等于把别人正在用的会话拆了 —— 先用 isLive() 判断（见 CronService）。
   */
  release(id: string): void {
    // 会话即将离开 registry：所有待投递（自唤醒、在飞的后台 Agent）必须一起作废。
    // 否则它们到点会驱动一整轮既不落盘（autosave 已退订）也送不到任何客户端
    // （无订阅者）的回合。
    // 内存上只对唤醒是承重点：定时器闭包捕获着整个 manager，clearTimeout 之后才可回收。
    // 在飞的后台 Agent 不同 —— 作废只是丢掉它的产出，manager 仍被子代理那侧的 deps 闭包
    // 吊着，直到它自己跑完（自带 10 轮上限）。别指望这一句能把内存放掉。
    this.registry.get(id)?.cancelAllInjections()
    // Stop autosave first so no turn-end fired after this can re-persist the file.
    this.unsubs.get(id)?.()
    this.unsubs.delete(id)
    this.registry.remove(id)
  }

  /**
   * Rename a session's title and persist it as a *manual* title (so subsequent
   * autosave won't overwrite it via deriveTitle). Works whether the session is
   * live or only on disk.
   */
  async rename(id: string, title: string): Promise<void> {
    this.manualTitles.set(id, title)
    this.generatedTitles.delete(id) // a manual title supersedes any generated one
    const live = this.registry.get(id)
    if (live) {
      // Live manager → go through the normal persist path (picks up the manual title). A rename
      // is an explicit user act, so persisting even a still-empty session is intended: it's how a
      // freshly-created session gains disk presence (distinct from the auto-created empties that
      // feature C keeps off disk at create() time). See http server.test.ts CRUD test.
      await this.persist(id, live)
      return
    }
    // Not live → edit the disk record directly without spinning up a manager.
    const rec = await loadSession(this.dir, id)
    if (!rec) return
    await saveSession(this.dir, {
      ...rec,
      title,
      titleManual: true,
      titleGenerated: false,
      updatedAt: new Date().toISOString(),
    })
  }

  // -------------------------------------------------------------------------
  // Autosave
  // -------------------------------------------------------------------------

  private wireAutosave(id: string, mgr: SessionManager): void {
    // Keep the unsubscribe fn so delete() can stop autosave (otherwise a stray
    // turn-end could re-persist a just-deleted session — the "resurrection" bug).
    const unsub = mgr.subscribe((e) => {
      // Never persist a still-empty session (feature C: no empty sessions until they have content).
      // A first turn that ERRORS discards its staged messages but still fires turn-end (and records
      // a checkpoint), and a title can be generated before any content commits — persisting on any
      // of those would write the empty '新对话' record feature C exists to prevent. The in-memory
      // generated title survives; the first content-bearing persist writes it out.
      const hasContent = mgr.getConversation().length > 0
      if ((e.type === 'turn-end' || e.type === 'checkpoint-recorded') && hasContent) {
        void this.persist(id, mgr)
      }
      // The manager generates a title (small model) the moment a message is sent and
      // emits `title-changed`. Record it as the generated title and persist — unless a
      // manual rename already won, or the session was deleted (or it's still empty).
      if (e.type === 'title-changed') {
        if (this.manualTitles.has(id) || this.tombstones.has(id)) return
        this.generatedTitles.set(id, e.title)
        if (hasContent) void this.persist(id, mgr)
      }
    })
    this.unsubs.set(id, unsub)
  }

  /**
   * Build a SessionRecord from the live manager and write it. Fire-and-forget:
   * all errors are swallowed so a failed save never breaks a turn. A per-id
   * in-flight guard coalesces overlapping requests (last-write-wins via a single
   * trailing re-run) so concurrent turn-end + checkpoint events don't race.
   *
   * `forcedTitle` is only passed by create()/adopt() for the initial record;
   * normal autosave recomputes the title from the conversation each time, unless
   * a manual title (set via rename) has pinned it.
   */
  private async persist(id: string, mgr: SessionManager, forcedTitle?: string): Promise<void> {
    // A delete tombstoned this id — never write the file back (the post-delete
    // autosave path). A second check sits right before saveSession() below to
    // also close the in-flight race (delete landing during our own await).
    if (this.tombstones.has(id)) return
    if (this.persisting.has(id)) {
      // A save is already running for this id — mark that another is needed and bail.
      this.persistAgain.add(id)
      return
    }
    this.persisting.add(id)
    try {
      const snap = mgr.getConversation().toJSON()
      // Title priority: explicit create/adopt seed > manual rename > small-model generated > derived.
      // (forcedTitle is only the initial 'New chat', so no conflict with a manual/generated title.)
      const manual = this.manualTitles.get(id)
      const generated = this.generatedTitles.get(id)
      const rec: SessionRecord = {
        version: 1,
        id,
        title: forcedTitle ?? manual ?? generated ?? deriveTitle(snap.messages),
        titleManual: this.manualTitles.has(id),
        titleGenerated: this.generatedTitles.has(id),
        cwd: mgr.getState().cwd,
        model: mgr.getModelId(),
        createdAt: mgr.getCreatedAt(),
        updatedAt: new Date().toISOString(),
        messages: snap.messages,
        totalUsage: snap.totalUsage,
        checkpoints: mgr.getCheckpoints(),
        // Feature B: persist compaction state so the full ledger + view survive a restart.
        compaction: mgr.getCompaction() ?? undefined,
        kind: mgr.getKind(),
      }
      // Re-check after building the record: if delete() tombstoned this id while
      // we were synchronously assembling rec, bail before the write so we don't
      // resurrect the just-deleted file.
      if (this.tombstones.has(id)) return
      await saveSession(this.dir, rec)
    } catch {
      // Autosave is best-effort; a failed write must never surface to the turn.
    } finally {
      this.persisting.delete(id)
      if (this.persistAgain.delete(id)) {
        // A persist was requested while we were writing; run one trailing save so
        // the final state always lands on disk. Never forces a title (autosave path).
        void this.persist(id, mgr)
      }
    }
  }
}

/**
 * Title = first USER message's text, trimmed to ≤60 chars, with submit()'s
 * `[YYYY-MM-DD HH:MM] ` prefix stripped if present. Falls back to 'New chat'
 * when there is no user text yet.
 */
function deriveTitle(messages: SessionRecord['messages']): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const block of m.content) {
      if (block.type === 'text') {
        const text = stripUserStamp(block.text).trim()
        if (text) return text.slice(0, 60)
      }
    }
  }
  return 'New chat'
}
