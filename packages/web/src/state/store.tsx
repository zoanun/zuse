import { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { ClientMessage, SessionMeta } from '@zuse/protocol'
import { reduce, initialState, type Action } from './reducer.js'
import type { AppState } from './types.js'
import { createWsClient, type WsClient } from '../ws/client.js'
import { getSessionId, setSessionId, createSession, listSessions, deleteSession, renameSession, wsUrl } from './session.js'

interface Store {
  state: AppState
  send: (msg: ClientMessage) => void
  dispatch: (a: Action) => void
  /** Create a fresh server session, reconnect to it, and clear local state. */
  newSession: () => Promise<void>
  /** All sessions, newest (updatedAt) first — as the server returns them. */
  sessions: SessionMeta[]
  /** Id of the session the UI is currently attached to (for highlight). */
  currentSessionId: string
  /** Re-fetch the session list (best-effort; swallows errors). */
  refreshSessions: () => Promise<void>
  /** Attach to an existing session: reconnect WS + clear local state. No-op on current id. */
  switchSession: (id: string) => Promise<void>
  /** Delete a session; if it was current, switch to the newest other (or new chat). */
  removeSession: (id: string) => Promise<void>
  /** Rename a session's title and refresh the list. */
  rename: (id: string, title: string) => Promise<void>
}
const StoreCtx = createContext<Store | null>(null)

let seq = 0
export function nextId(prefix: string): string { return prefix + '-' + (++seq) }

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const clientRef = useRef<WsClient | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => getSessionId() ?? '')
  // Keep the latest sessions list reachable from callbacks without re-binding them.
  const sessionsRef = useRef<SessionMeta[]>([])
  sessionsRef.current = sessions

  const refreshSessions = async (): Promise<void> => {
    try { setSessions(await listSessions()) } catch { /* best-effort */ }
  }

  useEffect(() => {
    const client = createWsClient({
      // Placeholder; the bootstrap below resolves a session id and reconnect()s
      // to the real /ws?session=<id> URL before opening for real.
      url: wsUrl(getSessionId() ?? ''),
      onMessage: (m) => {
        dispatch({ kind: 'server', msg: m })
        // First message of a brand-new session lands → its auto-derived title
        // changes from 'New chat'; refresh the list so the sidebar reflects it.
        if (m.type === 'event' && m.event.type === 'turn-end') void refreshSessions()
      },
      onStatus: (s) => dispatch({ kind: 'connection', status: s }),
    })
    clientRef.current = client

    let cancelled = false
    void (async () => {
      let id = getSessionId()
      if (!id) {
        // We render only once authed (AuthGate gates StoreProvider), so this POST
        // is same-origin + cookie-authed. Fall back to connecting anyway on failure.
        try { id = await createSession(); setSessionId(id) } catch { /* connect to default below */ }
      }
      if (cancelled) return
      if (id) setCurrentSessionId(id)
      client.reconnect(wsUrl(id ?? ''))
      void refreshSessions()
    })()

    return () => { cancelled = true; client.close() }
  }, [])

  const send = (msg: ClientMessage) => clientRef.current?.send(msg)

  const newSession = async (): Promise<void> => {
    const id = await createSession()
    setSessionId(id)
    clientRef.current?.reconnect(wsUrl(id))
    dispatch({ kind: 'reset' })
    setCurrentSessionId(id)
    void refreshSessions()
  }

  const switchSession = async (id: string): Promise<void> => {
    if (id === currentSessionId) return
    setSessionId(id)
    clientRef.current?.reconnect(wsUrl(id))
    dispatch({ kind: 'reset' })
    setCurrentSessionId(id)
    void refreshSessions()
  }

  const removeSession = async (id: string): Promise<void> => {
    await deleteSession(id)
    if (id === currentSessionId) {
      // Pick the newest OTHER session (list is already updatedAt desc).
      const next = sessionsRef.current.find((s) => s.id !== id)
      if (next) await switchSession(next.id)
      else await newSession()
    }
    void refreshSessions()
  }

  const rename = async (id: string, title: string): Promise<void> => {
    await renameSession(id, title)
    void refreshSessions()
  }

  return (
    <StoreCtx.Provider value={{ state, send, dispatch, newSession, sessions, currentSessionId, refreshSessions, switchSession, removeSession, rename }}>
      {children}
    </StoreCtx.Provider>
  )
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used within StoreProvider')
  return s
}
