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

/** POST /api/sessions and return the new session id. Throws on failure. */
export async function createSession(): Promise<string> {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) throw new Error('create session failed: ' + r.status)
  const d = (await r.json()) as { id: string }
  return d.id
}
