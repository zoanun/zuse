import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionVerdict } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { isSelectableRow } from './Message.js'
import type { Message as Msg } from '../state/types.js'
import { TodosPanel } from './TodosPanel.js'
import { AgentsPanel } from './AgentsPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer } from './Composer.js'
import { ManageDrawer } from './ManageDrawer.js'
import type { ManagePanel } from './ManageDrawer.js'

/**
 * All message ids in the same "turn" as `id`: the opening user message plus every assistant
 * message up to (not including) the next user message. A reply that used tools mid-stream is
 * several assistant messages, so this groups those split parts (and their question) as one unit
 * for share selection — selecting one part selects the whole exchange.
 */
function turnIdsOf(msgs: ReadonlyArray<Msg>, id: string): string[] {
  const i = msgs.findIndex((m) => m.id === id)
  if (i < 0) return [id]
  let start = i
  while (start > 0 && msgs[start]!.role !== 'user') start-- // back to the turn's user opener (or 0)
  let end = start + 1
  while (end < msgs.length && msgs[end]!.role !== 'user') end++ // up to the next user opener
  // Only ids that are actually SELECTABLE rows in share view (isSelectableRow == MessageList's
  // share filter): a user message, or an assistant message with prose. Tool-only assistant
  // messages have no visible checkbox, so including them would inflate the "已选 N 条" count.
  return msgs.slice(start, end).filter(isSelectableRow).map((m) => m.id)
}

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
  // Scroll anchor for share mode = the QUESTION (the turn's user message), per user preference.
  // Both entering AND leaving share mode remount each row (div↔label) and reset scroll to the top,
  // so we scroll back to this anchor on both transitions. wasShareRef distinguishes a real
  // enter/exit from a mere checkbox toggle (which must NOT move the scroll).
  const shareAnchorRef = useRef<string | null>(null)
  const wasShareRef = useRef(false)
  // Enter share mode pre-selecting the clicked reply's whole turn (question + every assistant
  // part of the answer, including parts split across tool-use iterations).
  const onShare = useCallback((assistantId: string) => {
    const ids = turnIdsOf(messagesRef.current, assistantId)
    // ids[0] is the turn's opener — the user's question (turnIdsOf slices from the user message),
    // which is the scroll anchor per user preference; fall back to the clicked reply.
    shareAnchorRef.current = ids[0] ?? assistantId
    setShareSel(new Set(ids))
  }, [])
  // Toggle by TURN, not by single message: clicking any row checks/unchecks the whole exchange,
  // so a reply split into several assistant messages selects as one unit.
  const toggleSelect = useCallback((id: string) => {
    setShareSel((prev) => {
      if (!prev) return prev
      const ids = turnIdsOf(messagesRef.current, id)
      const allSelected = ids.every((x) => prev.has(x))
      const next = new Set(prev)
      for (const x of ids) { if (allSelected) next.delete(x); else next.add(x) }
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
  // On entering OR leaving share mode, restore the scroll to the anchor (the question) — both
  // transitions remount the rows and reset scroll to the top. A checkbox toggle keeps shareSel
  // truthy (no enter/exit), so wasShareRef gates it out and the scroll stays put.
  useEffect(() => {
    const isShare = !!shareSel
    if (isShare === wasShareRef.current) return // a toggle within share mode — leave scroll alone
    wasShareRef.current = isShare
    const anchor = shareAnchorRef.current
    if (!anchor) return
    requestAnimationFrame(() => document.getElementById('msg-' + anchor)?.scrollIntoView({ block: 'center' }))
    if (!isShare) shareAnchorRef.current = null // left share mode → anchor consumed
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
