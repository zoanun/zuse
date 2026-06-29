import type { SessionMeta } from '@zuse/protocol'

const KEY = 'zuse.sessionId'

/** Read the persisted session id, or null if none stored / storage unavailable. */
export function getSessionId(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

/** Persist the session id (best-effort; ignores storage failures). */
export function setSessionId(id: string): void {
  try { localStorage.setItem(KEY, id) } catch { /* ignore */ }
}

/** Build the WS URL for a given session id. */
export function wsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return proto + '://' + location.host + '/ws?session=' + encodeURIComponent(sessionId)
}

const JSON_HEADERS = { 'content-type': 'application/json' }

/** Same-origin fetch that throws `<label> failed: <status>` on a non-ok response. */
export async function request(path: string, init: RequestInit, label: string): Promise<Response> {
  const r = await fetch(path, { credentials: 'same-origin', ...init })
  if (!r.ok) throw new Error(`${label} failed: ${r.status}`)
  return r
}

const sessionPath = (id: string): string => '/api/sessions/' + encodeURIComponent(id)

/** POST /api/sessions (optionally rooted at `cwd`) and return the new session id. Throws on failure. */
export async function createSession(cwd?: string): Promise<string> {
  const body = cwd ? JSON.stringify({ cwd }) : '{}'
  const r = await request('/api/sessions', { method: 'POST', headers: JSON_HEADERS, body }, 'create session')
  return ((await r.json()) as { id: string }).id
}

/** GET /api/sessions — list sessions (server sorts by updatedAt desc). Throws on failure. */
export async function listSessions(): Promise<SessionMeta[]> {
  const r = await request('/api/sessions', {}, 'list sessions')
  return (await r.json()) as SessionMeta[]
}

/** DELETE /api/sessions/<id>. Throws on failure. */
export async function deleteSession(id: string): Promise<void> {
  await request(sessionPath(id), { method: 'DELETE' }, 'delete session')
}

/** PATCH /api/sessions/<id> with a new title. Throws on failure. */
export async function renameSession(id: string, title: string): Promise<void> {
  await request(sessionPath(id), { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title }) }, 'rename session')
}
