import { useCallback, useState } from 'react'
import type { PermissionVerdict } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { TodosPanel } from './TodosPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer } from './Composer.js'

export function Shell() {
  const { state, send, dispatch, newSession, sessions, currentSessionId, switchSession, removeSession, rename } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)

  const onSend = (text: string) => { dispatch({ kind: 'user-send', id: nextId('u'), text }); send({ type: 'send', text }) }
  const onReply = (id: string, verdict: PermissionVerdict) => send({ type: 'permission-reply', id, verdict })
  // Stable so React.memo(Message) holds across streaming re-renders (send is stable).
  const onRevert = useCallback((checkpointId: string) => send({ type: 'revert', checkpointId }), [send])

  return (
    <div className={'shell' + (menuOpen ? ' menu-open' : '')}>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewChat={() => { void newSession(); setMenuOpen(false) }}
          onSwitch={(id) => { void switchSession(id); setMenuOpen(false) }}
          onDelete={(id) => { void removeSession(id) }}
          onRename={(id, title) => { void rename(id, title) }}
        />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} />
        <main className="chat">
          <MessageList messages={state.messages} thinking={state.thinking} pendingCount={state.pendingPermissions.length} onRevert={onRevert} />
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
