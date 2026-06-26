import { useState } from 'react'
import type { PermissionVerdict } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { TodosPanel } from './TodosPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer } from './Composer.js'

export function Shell() {
  const { state, send, dispatch } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)

  const onSend = (text: string) => { dispatch({ kind: 'user-send', id: nextId('u'), text }); send({ type: 'send', text }) }
  const onReply = (id: string, verdict: PermissionVerdict) => send({ type: 'permission-reply', id, verdict })

  return (
    <div className={'shell' + (menuOpen ? ' menu-open' : '')}>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <Sidebar
          onNewChat={() => { send({ type: 'reset-session' }); dispatch({ kind: 'reset' }); setMenuOpen(false) }}
          checkpoints={state.checkpoints}
          thinking={state.thinking}
          onRevert={(checkpointId) => send({ type: 'revert', checkpointId })}
        />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} />
        <main className="chat">
          <MessageList messages={state.messages} thinking={state.thinking} />
          {state.pendingPermissions.length > 0 ? (
            <div className="perm-wrap">
              {state.pendingPermissions.map((p) => <PermissionCard key={p.id} pending={p} onReply={onReply} />)}
            </div>
          ) : null}
          <TodosPanel todos={state.todos} />
          <Composer disabled={state.thinking} onSend={onSend} onStop={() => send({ type: 'interrupt' })} />
        </main>
      </div>
    </div>
  )
}
