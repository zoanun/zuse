import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react'
import type { ClientMessage } from '@zuse/protocol'
import { reduce, initialState, type Action } from './reducer.js'
import type { AppState } from './types.js'
import { createWsClient, type WsClient } from '../ws/client.js'

interface Store { state: AppState; send: (msg: ClientMessage) => void; dispatch: (a: Action) => void }
const StoreCtx = createContext<Store | null>(null)

let seq = 0
export function nextId(prefix: string): string { return prefix + '-' + (++seq) }

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState)
  const clientRef = useRef<WsClient | null>(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const client = createWsClient({
      url: proto + '://' + location.host + '/ws',
      onMessage: (m) => dispatch({ kind: 'server', msg: m }),
      onStatus: (s) => dispatch({ kind: 'connection', status: s }),
    })
    clientRef.current = client
    client.connect()
    return () => client.close()
  }, [])

  const send = (msg: ClientMessage) => clientRef.current?.send(msg)
  return <StoreCtx.Provider value={{ state, send, dispatch }}>{children}</StoreCtx.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreCtx)
  if (!s) throw new Error('useStore must be used within StoreProvider')
  return s
}
