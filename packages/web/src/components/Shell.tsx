import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionVerdict, UploadedImageRef } from '@zuse/protocol'
import { useStore, nextId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar, type SidebarHandle } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { isSelectableRow } from './Message.js'
import { isTurnOpener, type Message as Msg } from '../state/types.js'
import { TodosPanel } from './TodosPanel.js'
import { AgentsPanel } from './AgentsPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer, type ComposerHandle, imageFilesFrom } from './Composer.js'
import { ManageDrawer } from './ManageDrawer.js'
import type { ManagePanel } from './ManageDrawer.js'
import { SLASH_COMMANDS, type SlashCommand, type CommandContext } from './commands.js'
import type { DirPickerHandle } from './DirPicker.js'

/**
 * All message ids in the same "turn" as `id`: the opening user message plus every assistant
 * message up to (not including) the next user message. A reply that used tools mid-stream is
 * several assistant messages, so this groups those split parts (and their question) as one unit
 * for share selection — selecting one part selects the whole exchange.
 */
function turnIdsOf(msgs: ReadonlyArray<Msg>, id: string): string[] {
  const i = msgs.findIndex((m) => m.id === id)
  if (i < 0) return [id]
  // A turn opens on a real user message; a mid-turn steer bubble is part of the turn, NOT a
  // boundary (isTurnOpener), so it doesn't split the exchange into two share groups.
  let start = i
  while (start > 0 && !isTurnOpener(msgs[start]!)) start-- // back to the turn's user opener (or 0)
  let end = start + 1
  while (end < msgs.length && !isTurnOpener(msgs[end]!)) end++ // up to the next user opener
  // Only ids that are actually SELECTABLE rows in share view (isSelectableRow == MessageList's
  // share filter): a user message, or an assistant message with prose. Tool-only assistant
  // messages have no visible checkbox, so including them would inflate the "已选 N 条" count.
  return msgs.slice(start, end).filter(isSelectableRow).map((m) => m.id)
}

const EMPTY_HISTORY: string[] = []

export function Shell() {
  const { state, send, dispatch, newSession, sessions, currentSessionId, switchSession, removeSession, rename, searchJump, pendingScrollTo, clearScrollTo } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<ManagePanel>('memory')
  // null = not sharing; a Set = share-selection mode with the chosen message ids.
  const [shareSel, setShareSel] = useState<Set<string> | null>(null)

  const historyRef = useRef<Map<string, string[]>>(new Map())
  const dirPickerRef = useRef<DirPickerHandle>(null)
  const sidebarRef = useRef<SidebarHandle>(null)
  const composerRef = useRef<ComposerHandle>(null)
  // Whole-page image drop: dragging a file anywhere over the app shows an overlay and, on drop,
  // hands the image files to the composer. dragDepth counts enter/leave across nested children
  // (dragleave fires when crossing into a child), so the overlay only clears when the cursor truly
  // leaves the window. Only file drags (not text/selection) trigger it.
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const isFileDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault() // required for the drop event to fire
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    composerRef.current?.addImages(imageFilesFrom(e.dataTransfer))
  }
  const focusHistorySearch = useCallback(() => {
    setMenuOpen(true)
    // Focus the search box once the (now-open) Sidebar has it on-screen (parity with /work's ref).
    requestAnimationFrame(() => sidebarRef.current?.focusSearch())
  }, [])
  // One place new-chat behavior lives, shared by the /clear command, the sidebar button, and the dir
  // picker (which passes an explicit cwd) — so all three entry points stay in lockstep.
  const startNewChat = (cwd?: string) => { setShareSel(null); void newSession(cwd ?? (state.cwd || undefined)); setMenuOpen(false) }
  // Plain object, not memoized: newSession's identity churns every render (unmemoized store fn), so
  // a useMemo here never held — and Composer isn't memoized, so a stable ctx buys nothing. Rebuilding
  // this tiny object per render is free.
  const commandCtx: CommandContext = {
    send,
    newSession: () => startNewChat(),
    openPanel: (panel) => { setActivePanel(panel); setDrawerOpen(true) },
    focusHistorySearch,
    showHelp: () => dispatch({ kind: 'notice', text: SLASH_COMMANDS.map((c) => `${c.name} — ${c.desc}`).join('\n'), noticeKind: 'help' }),
    openDirPicker: () => dirPickerRef.current?.open(),
  }
  const onRunCommand = (cmd: SlashCommand) => cmd.run(commandCtx)
  const currentHistory = historyRef.current.get(currentSessionId ?? '') ?? EMPTY_HISTORY

  const onSend = (text: string, images?: UploadedImageRef[]) => {
    // A slash command can still reach onSend even though the menu normally runs it via onRunCommand:
    // an Esc-dismissed menu then Enter, a trailing space that stops the prefix matching, or the send
    // button. Intercept and run it here too, so the command fires instead of being posted as a
    // literal chat message to the model.
    const cmd = SLASH_COMMANDS.find((c) => c.name === text.trim())
    if (cmd) { onRunCommand(cmd); return }
    // Record into this session's in-memory history (commands returned above, so history stays clean).
    // Cap to the most recent 100 so a long-lived session doesn't grow the array unbounded.
    const key = currentSessionId ?? ''
    const arr = historyRef.current.get(key) ?? []
    historyRef.current.set(key, [...arr, text].slice(-100))
    if (state.thinking) {
      // Mid-turn steer stays text-only this iteration (no images on steer); if any were passed we
      // simply drop them here — disabling the attach affordance while thinking is the Composer's job.
      dispatch({ kind: 'steer-queued', id: nextId('ps'), text })
      send({ type: 'steer', text })
      return
    }
    // Optimistic attachments carry only id/name/mediaType — at send time we don't yet know whether
    // the server will direct-upload or parse each image, so route/description are omitted and filled
    // in later when the authoritative snapshot echoes the message back.
    dispatch({ kind: 'user-send', id: nextId('u'), text, attachments: images?.map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType })) })
    send({ type: 'send', text, images })
  }
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
    <div
      className={'shell' + (menuOpen ? ' menu-open' : '')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging ? (
        <div className="dropzone-overlay" aria-hidden="true">
          <div className="dropzone-card">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <div className="dropzone-text">松开以上传图片</div>
          </div>
        </div>
      ) : null}
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <Sidebar
          ref={sidebarRef}
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewChat={() => startNewChat()}
          onSwitch={(id) => { setShareSel(null); void switchSession(id); setMenuOpen(false) }}
          onDelete={(id) => { void removeSession(id) }}
          onRename={(id, title) => { void rename(id, title) }}
          onJump={(id, idx) => { searchJump(id, idx); setMenuOpen(false) }}
        />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} onOpenManage={() => setDrawerOpen(true)} onChangeCwd={startNewChat} dirPickerRef={dirPickerRef} />
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
          {state.pendingSteers.length > 0 ? (
            <div className="pending-steers">
              {state.pendingSteers.map((p) => (
                <div key={p.id} className="pending-steer">
                  <span className="pending-steer-tag">↪ 插话</span>
                  <span className="pending-steer-text">{p.text}</span>
                </div>
              ))}
            </div>
          ) : null}
          <Composer
            ref={composerRef}
            thinking={state.thinking}
            onSend={onSend}
            onStop={() => send({ type: 'interrupt' })}
            history={currentHistory}
            commands={SLASH_COMMANDS}
            onRunCommand={onRunCommand}
          />
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
