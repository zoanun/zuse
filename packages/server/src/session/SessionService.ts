import { Conversation } from '@zuse/core'
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
  /** Per-id in-flight guard so concurrent persists don't interleave writes. */
  private readonly persisting = new Set<string>()
  /** Set when a persist was requested while one was already in flight (coalesce). */
  private readonly persistAgain = new Set<string>()

  constructor(opts: SessionServiceOpts) {
    this.dir = opts.dir
    this.cwd = opts.cwd
    this.createSession = opts.createSession ?? defaultCreateSession
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
    })
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
    const mgr = this.createSession({ sessionId: id, cwd })
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
    this.registry.remove(id)
    await deleteSession(this.dir, id)
  }

  // -------------------------------------------------------------------------
  // Autosave
  // -------------------------------------------------------------------------

  private wireAutosave(id: string, mgr: SessionManager): void {
    mgr.subscribe((e) => {
      if (e.type === 'turn-end' || e.type === 'checkpoint-recorded') {
        void this.persist(id, mgr)
      }
    })
  }

  /**
   * Build a SessionRecord from the live manager and write it. Fire-and-forget:
   * all errors are swallowed so a failed save never breaks a turn. A per-id
   * in-flight guard coalesces overlapping requests (last-write-wins via a single
   * trailing re-run) so concurrent turn-end + checkpoint events don't race.
   *
   * `forcedTitle` is only passed by create() for the initial record; normal
   * autosave recomputes the title from the conversation each time.
   */
  private async persist(id: string, mgr: SessionManager, forcedTitle?: string): Promise<void> {
    if (this.persisting.has(id)) {
      // A save is already running for this id — mark that another is needed and bail.
      this.persistAgain.add(id)
      return
    }
    this.persisting.add(id)
    try {
      const snap = mgr.getConversation().toJSON()
      const rec: SessionRecord = {
        version: 1,
        id,
        title: forcedTitle ?? deriveTitle(snap.messages),
        cwd: mgr.getState().cwd,
        model: mgr.getModelId(),
        createdAt: mgr.getCreatedAt(),
        updatedAt: new Date().toISOString(),
        messages: snap.messages,
        totalUsage: snap.totalUsage,
        checkpoints: mgr.getCheckpoints(),
      }
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
