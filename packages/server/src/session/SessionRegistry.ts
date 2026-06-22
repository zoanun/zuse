import type { SessionManager } from './SessionManager.js'

/** In-memory registry of live sessions, keyed by sessionId. Full persistence/listing is a later spec (S1). */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionManager>()
  set(id: string, mgr: SessionManager): void { this.sessions.set(id, mgr) }
  get(id: string): SessionManager | undefined { return this.sessions.get(id) }
  remove(id: string): void { this.sessions.delete(id) }
  list(): string[] { return [...this.sessions.keys()] }
}
