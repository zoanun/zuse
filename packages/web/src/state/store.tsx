import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { ClientMessage, SessionMeta } from '@zuse/protocol'
import { reduce, initialState, type Action } from './reducer.js'
import type { AppState } from './types.js'
import { createWsClient, type WsClient } from '../ws/client.js'
import { getSessionId, setSessionId, createSession, listSessions, deleteSession, renameSession, wsUrl } from './session.js'

interface Store {
  state: AppState
  send: (msg: ClientMessage) => void
  dispatch: (a: Action) => void
  /** Create a fresh server session (optionally rooted at `cwd`), reconnect, and clear local state. */
  newSession: (cwd?: string) => Promise<void>
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
  /** Jump to a message in a session: switch session (if needed) and mark the scroll target. */
  searchJump: (sessionId: string, msgId: string) => void
  /** Stable message id (matches Message.id / the 'msg-'+id DOM anchor) MessageList should scroll to, or null. */
  pendingScrollTo: string | null
  /** Clear the pending scroll target (called by MessageList after scrolling). */
  clearScrollTo: () => void
  /** Text to restore into the Composer's input after an empty-interrupt cancel, or null. */
  pendingRestoreInput: string | null
  /** Clear the pending restore-input target (called by Shell after handing it to the Composer). */
  clearRestoreInput: () => void
}
const StoreCtx = createContext<Store | null>(null)

let seq = 0
export function nextId(prefix: string): string { return prefix + '-' + (++seq) }

/**
 * Collision-resistant id for a PERSISTENT ledger message (approach B: the client mints the user
 * message id and it becomes Message.id). Must not use a load-scoped counter (resets on reload →
 * collides with the session's earlier messages). Prefers crypto.randomUUID but falls back for
 * NON-secure contexts (e.g. remote access over a plain-http LAN IP, where randomUUID is undefined).
 */
export function newMessageId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${uuid}`
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const clientRef = useRef<WsClient | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => getSessionId() ?? '')
  // S4: 点击搜索命中后,记下要滚到的消息 DOM id。独立于 reducer state,故 attachTo 的
  // dispatch({kind:'reset'}) 清空 messages 后它仍存活,待新快照消息渲染出来再被 MessageList 消费。
  const [pendingScrollTo, setPendingScrollTo] = useState<string | null>(null)
  // Empty-interrupt cancel: server emits restore-input with the text that was in flight, so the
  // Composer can put it back for editing. Independent of reducer state, mirroring pendingScrollTo.
  const [pendingRestoreInput, setPendingRestoreInput] = useState<string | null>(null)
  // Keep the latest sessions list + current id reachable from the (once-bound) WS
  // onMessage closure without re-creating the client.
  const sessionsRef = useRef<SessionMeta[]>([])
  sessionsRef.current = sessions
  const currentIdRef = useRef<string>(currentSessionId)
  currentIdRef.current = currentSessionId
  // Guards the auto-recovery below so a persistent server error can't spin a create/attach loop.
  // recoveringRef blocks CONCURRENT recovery; recoveredOnceRef makes it ONE-SHOT — after a single
  // auto-recovery, further session_not_found errors fall through to the normal dispatch (red error),
  // so a freshly-created session that is ALSO not found can't drive an unbounded create-new loop.
  const recoveringRef = useRef(false)
  const recoveredOnceRef = useRef(false)
  // Holds the latest newSession so the once-bound onMessage closure (below) can call it. newSession
  // is declared after this effect, so referencing it directly would be a stale/forward binding.
  const newSessionRef = useRef<(cwd?: string) => Promise<void>>(async () => {})

  const refreshSessions = async (): Promise<void> => {
    // Ignore a malformed (non-array) response rather than corrupting `sessions` into a
    // non-iterable — displaySessions/.some() and the Sidebar map both assume an array.
    try { const list = await listSessions(); if (Array.isArray(list)) setSessions(list) } catch { /* best-effort */ }
  }

  useEffect(() => {
    const client = createWsClient({
      // Placeholder; the bootstrap below resolves a session id and reconnect()s
      // to the real /ws?session=<id> URL before opening for real.
      url: wsUrl(getSessionId() ?? ''),
      onMessage: (m) => {
        // Auto-recover from a stale session id: the last-used id in localStorage may point at a
        // session the daemon no longer has (an empty session was never persisted, then a restart;
        // or it was deleted). Instead of dead-ending on the red "session unavailable" error, forget
        // it and spin up a fresh session. Guard against a create/attach loop.
        if (m.type === 'error' && (m.code === 'session_not_found' || /no session|session unavailable/i.test(m.message)) && !recoveringRef.current && !recoveredOnceRef.current) {
          recoveringRef.current = true
          recoveredOnceRef.current = true // one-shot: never auto-recover again (avoids create-loop)
          void (async () => {
            // Reuse newSession (create + attach: setSessionId, reconnect, reset, setCurrentSessionId,
            // refreshSessions) — the full attach semantics, not a partial inline reimplementation.
            try { await newSessionRef.current() } catch { /* leave the error visible if even creating a session fails */ }
            finally { recoveringRef.current = false }
          })()
          return
        }
        dispatch({ kind: 'server', msg: m })
        if (m.type === 'event' && m.event.type === 'restore-input') setPendingRestoreInput(m.event.text)
        if (m.type === 'event' && m.event.type === 'title-changed') {
          // The event carries the new title — patch the current session's row in place.
          // (Re-fetching here would race the server's async persist and could read the
          // old title; the event value is authoritative for the UI.)
          const title = m.event.title
          setSessions((prev) => prev.map((s) => (s.id === currentIdRef.current ? { ...s, title } : s)))
        }
        // Turn end → refresh for message-count + the deterministic fallback title.
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

  // Stable identity (clientRef never changes) so memoized consumers — e.g.
  // React.memo(Message) via Shell's onRevert — aren't invalidated every render.
  const send = useCallback((msg: ClientMessage) => clientRef.current?.send(msg), [])

  // Point the WS at `id`, clear local state, remember it, and refresh the list.
  // Shared by newSession (after creating one) and switchSession.
  const attachTo = (id: string): void => {
    // Drop any unconsumed search-jump target: a plain switch/new-chat must not later flash a
    // message at that stale index. searchJump re-sets it AFTER calling attachTo (same batched
    // event → the re-set wins), so a genuine jump still scrolls.
    setPendingScrollTo(null)
    setSessionId(id)
    clientRef.current?.reconnect(wsUrl(id))
    dispatch({ kind: 'reset' })
    setCurrentSessionId(id)
    void refreshSessions()
  }

  const newSession = async (cwd?: string): Promise<void> => {
    attachTo(await createSession(cwd))
  }
  // Keep the recovery closure (bound once in the mount effect) pointed at the current newSession.
  newSessionRef.current = newSession

  /** 跳到某会话的某条消息:切会话(若需要)并标记滚动目标。msgId 即搜索命中(SearchHit.id)携带的
   *  稳定账本消息 id,与快照 SnapshotMessage.id / MessageList 的 'msg-'+id DOM 锚点同源,不再依赖
   *  会漂移的数组下标。同会话不 attachTo:重连会 reset+重拉快照,把一次性 flash 冲掉(且当前会话
   *  消息已在)。 */
  const searchJump = (sessionId: string, msgId: string): void => {
    if (sessionId !== currentSessionId) attachTo(sessionId) // clears pendingScrollTo…
    setPendingScrollTo(msgId)                               // …so set it AFTER (batched → wins)
  }

  const switchSession = async (id: string): Promise<void> => {
    if (id === currentSessionId) return
    attachTo(id)
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

  // Show the current session in the sidebar even before it is persisted. Feature C keeps empty
  // sessions off disk, so a brand-new "+ 新对话" isn't in the server list yet — synthesize a row
  // for it so the click gives immediate feedback. It merges into the real row once the first
  // turn-end persists it (refreshSessions then includes it, so this branch drops), and simply
  // vanishes on reload if the session never got content.
  const displaySessions: SessionMeta[] = currentSessionId && !sessions.some((s) => s.id === currentSessionId)
    ? [{ id: currentSessionId, title: '', createdAt: '', updatedAt: '', cwd: state.cwd ?? '', messageCount: 0 }, ...sessions]
    : sessions

  return (
    <StoreCtx.Provider value={{ state, send, dispatch, newSession, sessions: displaySessions, currentSessionId, refreshSessions, switchSession, removeSession, rename, searchJump, pendingScrollTo, clearScrollTo: () => setPendingScrollTo(null), pendingRestoreInput, clearRestoreInput: () => setPendingRestoreInput(null) }}>
      {children}
    </StoreCtx.Provider>
  )
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used within StoreProvider')
  return s
}
