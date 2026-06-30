import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionVerdict } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { TodosPanel } from './TodosPanel.js'
import { AgentsPanel } from './AgentsPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer } from './Composer.js'
import { ManageDrawer } from './ManageDrawer.js'
import type { ManagePanel } from './ManageDrawer.js'

export function Shell() {
  const { state, send, dispatch, newSession, sessions, currentSessionId, switchSession, removeSession, rename, searchJump, pendingScrollTo, clearScrollTo } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<ManagePanel>('memory')
  // null = not sharing; a Set = share-selection mode with the chosen message ids.
  const [shareSel, setShareSel] = useState<Set<string> | null>(null)

  const onSend = (text: string) => { dispatch({ kind: 'user-send', id: nextId('u'), text }); send({ type: 'send', text }) }
  const onReply = (id: string, verdict: PermissionVerdict) => send({ type: 'permission-reply', id, verdict })
  // Stable so React.memo(Message) holds across streaming re-renders (send is stable).
  const onRevert = useCallback((checkpointId: string) => send({ type: 'revert', checkpointId }), [send])
  const onRetry = useCallback(() => send({ type: 'retry' }), [send])

  // onShare must be stable (passed to every memoized assistant Message) — read messages from a
  // ref instead of closing over state.messages, which changes on every stream delta.
  const messagesRef = useRef(state.messages)
  messagesRef.current = state.messages
  // Enter share mode pre-selecting the clicked reply + its question (nearest user message above).
  const onShare = useCallback((assistantId: string) => {
    const msgs = messagesRef.current
    const i = msgs.findIndex((m) => m.id === assistantId)
    const ids = new Set<string>()
    if (i >= 0) {
      ids.add(msgs[i]!.id)
      for (let j = i - 1; j >= 0; j--) if (msgs[j]!.role === 'user') { ids.add(msgs[j]!.id); break }
    }
    setShareSel(ids)
  }, [])
  const toggleSelect = useCallback((id: string) => {
    setShareSel((prev) => {
      if (!prev) return prev
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])
  const confirmShare = () => {
    if (shareSel && shareSel.size > 0) {
      const subset = state.messages.filter((m) => shareSel.has(m.id))
      void import('../state/exportChat.js').then((m) => m.downloadChatHtml(subset))
    }
    setShareSel(null)
  }
  // Esc cancels share-selection mode.
  useEffect(() => {
    if (!shareSel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShareSel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shareSel])

  return (
    <div className={'shell' + (menuOpen ? ' menu-open' : '')}>
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <Sidebar
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewChat={() => { setShareSel(null); void newSession(state.cwd || undefined); setMenuOpen(false) }}
          onSwitch={(id) => { setShareSel(null); void switchSession(id); setMenuOpen(false) }}
          onDelete={(id) => { void removeSession(id) }}
          onRename={(id, title) => { void rename(id, title) }}
          onJump={(id, idx) => { searchJump(id, idx); setMenuOpen(false) }}
        />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} onOpenManage={() => setDrawerOpen(true)} onChangeCwd={(cwd) => { setShareSel(null); void newSession(cwd) }} />
        <main className="chat">
          {shareSel ? (
            <div className="share-bar">
              <span className="share-bar-label">选择要分享的消息 · 已选 {shareSel.size} 条 · 按 Esc 取消</span>
              <div className="share-bar-actions">
                <button type="button" className="share-go" onClick={confirmShare} disabled={shareSel.size === 0}>导出所选</button>
                <button type="button" className="share-cancel" onClick={() => setShareSel(null)}>取消</button>
              </div>
            </div>
          ) : null}
          <MessageList
            messages={state.messages}
            thinking={state.thinking}
            pendingCount={state.pendingPermissions.length}
            onRevert={onRevert}
            onShare={onShare}
            onRetry={onRetry}
            shareMode={!!shareSel}
            selected={shareSel ?? undefined}
            onToggleSelect={toggleSelect}
            scrollToId={pendingScrollTo}
            onScrolled={clearScrollTo}
          />
          {state.pendingPermissions.length > 0 ? (
            <div className="perm-wrap">
              {state.pendingPermissions.map((p) => <PermissionCard key={p.id} pending={p} onReply={onReply} />)}
            </div>
          ) : null}
          <TodosPanel todos={state.todos} />
          <AgentsPanel messages={state.messages} />
          <Composer disabled={state.thinking} onSend={onSend} onStop={() => send({ type: 'interrupt' })} />
        </main>
      </div>
      <ManageDrawer
        open={drawerOpen}
        activePanel={activePanel}
        onClose={() => setDrawerOpen(false)}
        onSelectPanel={setActivePanel}
        cwd={state.cwd}
      />
    </div>
  )
}
