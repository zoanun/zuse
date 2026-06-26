import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'
import type { ClientMessage } from '@zuse/protocol'
import { reduce, initialState, type Action } from './reducer.js'
import type { AppState } from './types.js'
import { createWsClient, type WsClient } from '../ws/client.js'
import { getSessionId, setSessionId, createSession, wsUrl } from './session.js'

interface Store {
  state: AppState
  send: (msg: ClientMessage) => void
  dispatch: (a: Action) => void
  /** Create a fresh server session, reconnect to it, and clear local state. */
  newSession: () => Promise<void>
}
const StoreCtx = createContext<Store | null>(null)

let seq = 0
export function nextId(prefix: string): string { return prefix + '-' + (++seq) }

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const clientRef = useRef<WsClient | null>(null)

  useEffect(() => {
    const client = createWsClient({
      // Placeholder; the bootstrap below resolves a session id and reconnect()s
      // to the real /ws?session=<id> URL before opening for real.
      url: wsUrl(getSessionId() ?? ''),
      onMessage: (m) => dispatch({ kind: 'server', msg: m }),
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
      client.reconnect(wsUrl(id ?? ''))
    })()

    return () => { cancelled = true; client.close() }
  }, [])

  const send = (msg: ClientMessage) => clientRef.current?.send(msg)
  const newSession = async () => {
    const id = await createSession()
    setSessionId(id)
    clientRef.current?.reconnect(wsUrl(id))
    dispatch({ kind: 'reset' })
  }
  return <StoreCtx.Provider value={{ state, send, dispatch, newSession }}>{children}</StoreCtx.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used within StoreProvider')
  return s
}
