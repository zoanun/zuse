import { Conversation, type ToolRegistry } from '@zuse/core'
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

export interface SessionServiceOpts {
  /** web-sessions dir — where SessionRecord json files live. */
  dir: string
  /** default cwd for new sessions. */
  cwd: string
  /** injectable for tests (offline fake-client createSession). */
  createSession?: typeof defaultCreateSession
  /** forwarded into every createSession so daemon-owned MCP tools (B4) register per session. */
  registerExtraTools?: (registry: ToolRegistry) => void
}

/**
 * Multi-session lifecycle + autosave.
 *
 * Wraps a SessionRegistry (the live in-memory managers) over a persistence dir.
 * - getOrLoad / create register a live SessionManager and wire autosave.
 * - autosave subscribes to each manager and persists a SessionRecord on every
 *   turn-end / checkpoint-recorded (fire-and-forget, never breaks a turn).
 *
 * LIST source-of-truth choice (per spec §5): create() saves an initial record
 * immediately, so a session always has a disk record the moment it exists. That
 * makes the on-disk dir the authoritative source for list() — no need to merge
 * in registry-only entries. We take this simpler path.
 */
export class SessionService {
  private readonly dir: string
  private readonly cwd: string
  private readonly registry = new SessionRegistry()
  private readonly createSession: typeof defaultCreateSession
  private readonly registerExtraTools?: (registry: ToolRegistry) => void
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
  }

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
      createdAt: rec.createdAt,
      // A restored session has already passed its "first message" moment (or was
      // manually titled) → don't auto-generate a title again on its next message.
      titleAlreadySet: rec.messages.length > 0 || !!rec.titleManual || !!rec.titleGenerated,
      registerExtraTools: this.registerExtraTools,
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
   * Create a fresh session: register a live manager, wire autosave, and save an
   * initial record immediately so it shows up in list() right away.
   */
  async create(opts?: { cwd?: string; title?: string }): Promise<{ id: string }> {
    const id = newSessionId()
    const cwd = opts?.cwd ?? this.cwd
    const mgr = this.createSession({ sessionId: id, cwd, registerExtraTools: this.registerExtraTools })
    this.tombstones.delete(id) // (re)using this id is legal
    this.registry.set(id, mgr)
    this.wireAutosave(id, mgr)
    // Persist an initial record so disk (the list source-of-truth) knows it exists.
    await this.persist(id, mgr, opts?.title ?? 'New chat')
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
    // Stop autosave first so no turn-end fired after this can re-persist the file.
    this.unsubs.get(id)?.()
    this.unsubs.delete(id)
    this.registry.remove(id)
    // Tombstone the id: any persist already awaiting saveSession() early-returns
    // before the write, closing the in-flight-persist resurrection race.
    this.tombstones.add(id)
    this.persistAgain.delete(id) // drop any pending trailing save for this id
    this.manualTitles.delete(id)
    this.generatedTitles.delete(id)
    await deleteSession(this.dir, id)
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
      // Live manager → go through the normal persist path (picks up the manual title).
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
      if (e.type === 'turn-end' || e.type === 'checkpoint-recorded') {
        void this.persist(id, mgr)
      }
      // The manager generates a title (small model) the moment a message is sent and
      // emits `title-changed`. Record it as the generated title and persist — unless a
      // manual rename already won, or the session was deleted.
      if (e.type === 'title-changed') {
        if (this.manualTitles.has(id) || this.tombstones.has(id)) return
        this.generatedTitles.set(id, e.title)
        void this.persist(id, mgr)
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
        const text = block.text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, '').trim()
        if (text) return text.slice(0, 60)
      }
    }
  }
  return 'New chat'
}
