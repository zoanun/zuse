import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PermissionVerdict, PermissionMode, UploadedImageRef, PastedTextInput, UploadedFileRef } from '@zuse/protocol'
import { useStore, newMessageId } from '../state/store.js'
import { Header } from './Header.js'
import { Sidebar, type SidebarHandle } from './Sidebar.js'
import { MessageList } from './MessageList.js'
import { isSelectableRow } from './Message.js'
import { isTurnOpener, type Message as Msg } from '../state/types.js'
import { TodosPanel, hasVisibleTodos } from './TodosPanel.js'
import { AgentsPanel, runningAgentCount } from './AgentsPanel.js'
import { PermissionCard } from './PermissionCard.js'
import { Composer, type ComposerHandle, imageFilesFrom, otherFilesFrom } from './Composer.js'
import { ManageDrawer } from './ManageDrawer.js'
import type { ManagePanel } from './ManageDrawer.js'
import { CronPanel } from './CronPanel.js'
import { SLASH_COMMANDS, type SlashCommand, type CommandContext } from './commands.js'
import { nextMode } from './permissionMode.js'
import { BypassBanner } from './BypassBanner.js'
import type { DirPickerHandle } from './DirPicker.js'
import { persistModel } from '../state/manageApi.js'
import { SessionContext } from './Markdown.js'
import { Rail } from '../preview/Rail.js'
import { closeRun, useActiveRun } from '../preview/activePreview.js'
import { closeExec, useActiveExec } from '../preview/activeExec.js'
import { getCleanView, setCleanView } from '../cleanViewPref.js'
import { turnStepsOf } from './turnSteps.js'
import { StepsDrawer } from './StepsDrawer.js'

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
  const { state, send, dispatch, newSession, sessions, currentSessionId, switchSession, removeSession, rename, searchJump, pendingScrollTo, clearScrollTo, pendingRestoreInput, clearRestoreInput, mainView, setMainView } = useStore()
  const [menuOpen, setMenuOpen] = useState(false)
  // 精简视图（默认开）。存 localStorage —— 观感偏好属于这台机器上的这个人，不跟着会话走。
  const [cleanView, setCleanViewState] = useState(getCleanView)
  const toggleCleanView = useCallback(() => {
    setCleanViewState((on) => { setCleanView(!on); return !on })
  }, [])
  // 步骤抽屉：按轮次切分（memo —— Shell 每个流式 delta 都重渲染，切分要遍历全部消息）。
  const turnSteps = useMemo(() => turnStepsOf(state.messages), [state.messages])
  // 关掉精简视图时工具卡片本来就在主画面上，右栏再放一份是同一份东西出现两次。
  const visibleSteps = cleanView ? turnSteps : []
  // null = **跟随最新**。用户手动点过别的 tab 才置成具体 id，否则读第 2 轮时会被
  // 新流进来的内容一把拽走，根本读不完（与"滚动列表粘底"同一个交互模式）。
  const [selectedTurn, setSelectedTurn] = useState<string | null>(null)
  // 选中的轮次不存在了 → 复位到跟随。切会话 / /clear / revert 把那一轮删掉都会落到这里；
  // 不复位的话抽屉空白，而用户**没有"最新 tab"可点**（tab 条已经换了），
  // 只能靠发新消息解锁 —— 一个"看着像坏了"的状态。
  useEffect(() => {
    if (selectedTurn && !turnSteps.some((t) => t.turnId === selectedTurn)) setSelectedTurn(null)
  }, [turnSteps, selectedTurn])
  const onSelectTurn = useCallback((turnId: string) => {
    // 点回最新的那个 = 恢复自动跟随（spec §3.3 的另一半）。
    const isNewest = turnSteps.length > 0 && turnSteps[turnSteps.length - 1]!.turnId === turnId
    setSelectedTurn(isNewest ? null : turnId)
    // 主画面滚到该轮的**用户提问**（不是最后一条回复）—— 与分享模式的锚点取法一致。
    // 复用搜索跳转那条现成通道：`#msg-<id>` + scrollIntoView + 一次性高亮闪烁。
    if (currentSessionId) searchJump(currentSessionId, turnId)
  }, [turnSteps, currentSessionId, searchJump])

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<ManagePanel>('memory')
  // null = not sharing; a Set = share-selection mode with the chosen message ids.
  const [shareSel, setShareSel] = useState<Set<string> | null>(null)

  // 右栏：只认属于当前会话的 run（选择器同步比对，切会话那一帧不会闪上一个会话的预览）。
  const activeRun = useActiveRun(currentSessionId)
  const activeExec = useActiveExec(currentSessionId)
  // 真正把 store 清干净。选择器已经保证了显示正确，这条 effect 负责不让旧 run 长期驻留
  // ——`activePreview` 是模块级单例，**在此之前没有任何人在切会话时清它**（设计 §3.3 / P0-2）。
  // `/clear`（newSession）、revert、switchSession 都会换掉 currentSessionId，走的是同一条路。
  // **两个槽都要清。** 只清预览的话，切会话后右栏会继续挂着上一个会话的运行输出 ——
  // 而它背后还连着一条 SSE。这正是 activePreview 当初踩过的坑，新槽会原样复发。
  useEffect(() => { closeRun(); closeExec() }, [currentSessionId])

  // 右栏的显示条件（设计 §8）：**有预览 或 有待办 或 有在跑的子代理**。
  // 判据**一律来自面板自己导出的谓词**，Shell 不复刻 —— `hasVisibleTodos` 里「全完成也消失」
  // 那条、`runningAgentCount` 背后 currentTurn 的切分与「后台派发跳过」规则，都是踩过坑写出来的
  // （后者刚因为「永久卡在 1 运行中」重写过）。在这里手写一份等于把那些故障请回来。
  // memo 的理由：Shell 每个流式 delta 都重渲染，而 runningAgentCount 要遍历本回合所有 part。
  const runningAgents = useMemo(
    () => runningAgentCount(state.messages, state.backgroundAgents),
    [state.messages, state.backgroundAgents],
  )
  const showTodos = hasVisibleTodos(state.todos)
  // 步骤区并进右栏后，`hasRail` **必须**把它算进来：否则「看完回复想翻工具调用」时
  // 前三个条件通常一个都不成立（没预览、待办全完成、没子代理），整栏不渲染 →
  // 步骤跟着一起消失，而主画面已经把工具卡片收走了 = 两边都没有。
  // `activeExec` 同理**必须**算进来，理由和上面步骤区那条一模一样：点「运行」时通常
  // 没预览、待办可能全完成、可能没子代理 —— 整栏不渲染的话，用户点完运行**什么都看不到**，
  // 而进程已经在他机器上跑起来了。这比「看不到输出」更糟。
  const hasRail = !!activeRun || !!activeExec || showTodos || runningAgents > 0 || visibleSteps.length > 0
  // 只有待办/子代理、没有预览时右栏收窄（设计 §3 的 320px）。
  // 收窄**只能把聊天区变宽**，所以正文列（--col=736px 上限）一格不动 —— PR1 的核心承诺。
  // 真跑输出区和预览一样要宽度（终端文本 320px 一行放不下几个字），所以它也排除收窄。
  const railNarrow = hasRail && !activeRun && !activeExec

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
    const imgs = imageFilesFrom(e.dataTransfer)
    const others = otherFilesFrom(e.dataTransfer)
    if (imgs.length) composerRef.current?.addImages(imgs)
    if (others.length) composerRef.current?.addFiles(others)
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
    cyclePermissionMode: () => onCyclePermissionMode(nextMode(state.permissionMode)),
  }
  const onRunCommand = (cmd: SlashCommand) => cmd.run(commandCtx)
  const currentHistory = historyRef.current.get(currentSessionId ?? '') ?? EMPTY_HISTORY

  const onSend = (text: string, images?: UploadedImageRef[], pastedTexts?: PastedTextInput[], files?: UploadedFileRef[]) => {
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
    // Optimistic attachments for the bubble/preview. Images carry only id/name/mediaType
    // (route/description filled by the authoritative snapshot); pasted-text is fully known now
    // (route + full text). Same for both the mid-turn steer preview and the normal send.
    const imageAtts = images?.map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType })) ?? []
    const pastedAtts = pastedTexts?.map((p, idx) => ({
      id: p.id, name: `粘贴文本 #${idx + 1}`, mediaType: 'text/plain', route: 'pasted' as const, text: p.text,
    })) ?? []
    const fileAtts = files?.map((f) => ({ id: f.id, name: f.name, mediaType: f.mediaType, route: 'file' as const })) ?? []
    const attachments = imageAtts.length || pastedAtts.length || fileAtts.length ? [...imageAtts, ...pastedAtts, ...fileAtts] : undefined
    if (state.thinking) {
      // Mid-turn interjection: attachments ride along on the steer frame; the server queues them and
      // delivers as a follow-up turn (submit handles images/pastedTexts). The optimistic ↪插话 preview
      // carries the attachments for immediate feedback. Generate the id ONCE and use it for both the
      // wire message and the optimistic dispatch, so the server's later user-echo (same messageId)
      // and this preview describe the same logical message.
      // Collision-resistant id: this becomes the PERSISTENT ledger Message.id (approach B), used as
      // React key, DOM anchor, and checkpoint-anchor lookup — a load-scoped counter would reset on
      // reload and collide with the session's earlier messages. newMessageId falls back gracefully
      // in non-secure contexts (remote http LAN access) where crypto.randomUUID is unavailable.
      const id = newMessageId('ps')
      dispatch({ kind: 'steer-queued', id, text, attachments })
      send({ type: 'steer', text, messageId: id, images, pastedTexts, files })
      return
    }
    const id = newMessageId('u')
    dispatch({ kind: 'user-send', id, text, attachments })
    send({ type: 'send', text, messageId: id, images, pastedTexts, files })
  }
  // Model switch from the Header picker. Temporary switch takes effect on this session immediately
  // (WS 'switch-model' — the server rebuilds its client but emits no event, so we optimistically
  // reflect it in the Header). `persist` also writes the choice to project settings for new sessions.
  const onSwitchModel = (providerId: string, model: string, persist: boolean) => {
    send({ type: 'switch-model', providerId, model })
    dispatch({ kind: 'model-changed', model, providerId })
    if (persist) persistModel(providerId, model).catch(() => dispatch({ kind: 'notice', text: '永久保存默认模型失败', noticeKind: 'error' }))
  }
  // 权限档切换。**不做乐观更新** —— 与 switch-model 不同，服务端对这条帧会拒绝（非交互会话、
  // 非法 mode），乐观改本地状态会留下一个界面显示「全自主」、实际还在「询问」的骗人档位。
  // 服务端接受后会发 permission-mode-changed，reducer 据此更新。
  const onCyclePermissionMode = (mode: PermissionMode) => send({ type: 'set-permission-mode', mode })
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
  // Empty-interrupt cancel: server sent back the in-flight text via restore-input — hand it to the
  // Composer (which only fills it in if the input is still empty) and consume the directive.
  useEffect(() => {
    if (pendingRestoreInput !== null) {
      composerRef.current?.restoreInput(pendingRestoreInput)
      clearRestoreInput()
    }
  }, [pendingRestoreInput, clearRestoreInput])
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
            <div className="dropzone-text">松开以上传附件</div>
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
          onJump={(id, msgId) => { searchJump(id, msgId); setMenuOpen(false) }}
          onOpenCron={() => { setShareSel(null); setMainView('cron'); setMenuOpen(false) }}
        />
      <div className="main">
        <Header state={state} onMenu={() => setMenuOpen((o) => !o)} onOpenManage={() => setDrawerOpen(true)} onChangeCwd={startNewChat} onSwitchModel={onSwitchModel} onCyclePermissionMode={onCyclePermissionMode} cleanView={cleanView} onToggleCleanView={toggleCleanView} dirPickerRef={dirPickerRef} />
        {/* Header 正下方、聊天区之上 —— 横跨整个主区，看不见它需要主动无视。 */}
        <BypassBanner mode={state.permissionMode} count={state.autoAllowedCount} onExit={() => onCyclePermissionMode('default')} />
        {/*
          `.main-body` **永远渲染**，只有 `.rail` 子节点是条件的（设计 §4.1 / P0-1）。
          写成 `hasRail ? <div className="main-body">{chat}{rail}</div> : <main className="chat">…</main>`
          会在右栏每次出现/消失时**卸载并重建 MessageList + Composer**，丢掉 Composer 里没发出的
          草稿、`.stream` 的滚动位置（MessageList.tsx:20-21），一个回合里能发生好几次。

          窄屏覆盖式**只由 CSS 的 `@container` 换外观**（styles.css），这里不分叉出第二棵子树 ——
          换子树会让 PreviewFrame 的 token 重生 → 新 document → demo 归零（设计 §4.3 / P0-4）。
        */}
        <div className={'main-body' + (hasRail ? ' has-rail' : '') + (railNarrow ? ' rail-narrow' : '')}>
        <SessionContext.Provider value={currentSessionId}>
        {mainView === 'cron' ? <main className="chat"><CronPanel /></main> : (
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
            cleanView={cleanView}
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
          {/*
            待办 / 子代理的**窄行回退位**（设计 §8 第 6 问）。宽行下由 CSS 隐藏，主角是右栏那份。
            为什么两份都渲染、由 CSS 二选一，而不是按宽度在 JS 里选一处挂：判据是 `.main-body`
            的**容器宽度**（`@container`），JS 里读不到它就得上 ResizeObserver；更要命的是
            按宽度分叉会让右栏的 PreviewFrame 跟着换位置 → token 重生 → demo 归零（P0-4）。
            这两个面板是纯函数组件、无 iframe 无内部状态，多渲染一份的代价只是几个 DOM 节点，
            隐藏那份是 `display:none`，不进无障碍树也不参与布局。
          */}
          <div className="narrow-panels">
            <TodosPanel todos={state.todos} />
            <AgentsPanel messages={state.messages} backgroundAgents={state.backgroundAgents} />
            {/*
              步骤区也要有窄行回退位，而且它比待办更**必须**：待办没显示只是少个提醒，
              步骤没显示 = 主画面已经把工具卡片过滤掉了、右栏又不出场 = **两边都没有**，
              工具调用在界面上彻底消失。实测过这个状态：视口 1140 时本行 884px 触发窄行，
              `.main-body.rail-narrow .rail{display:none}`（那条规则是"右栏此刻已经空了"
              年代写的，那时它只装待办）把整栏连同步骤一起抹掉，主画面里 `.stream .tool` 为 0。
              默认收成一行：窄窗口本来就矮，别一上来就挤掉聊天。
            */}
            <StepsDrawer turns={visibleSteps} selectedId={selectedTurn} onSelect={onSelectTurn} defaultCollapsed />
          </div>
          {state.pendingSteers.length > 0 ? (
            <div className="pending-steers">
              {state.pendingSteers.map((p) => (
                <div key={p.id} className="pending-steer">
                  <span className="pending-steer-tag">↪ 插话</span>
                  {p.text ? <span className="pending-steer-text">{p.text}</span> : null}
                  {p.attachments?.length ? (
                    <span className="pending-steer-attach">📎 {p.attachments.length} 个附件</span>
                  ) : null}
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
        )}
        </SessionContext.Provider>
        {/* cron 视图下也保留右栏 —— PR2 与 PR1 的选择保持一致（设计 §8 要求 PR2 表态）。
            对预览，不渲染就是**卸载** iframe（demo 状态全丢），而不是「藏起来」；run 还活着，
            用户也还需要那个「收起预览」按钮才能停掉它。
            对待办/子代理，理由是它们本就是「后台此刻在干什么」的环境感知：去定时任务页看一眼
            正是最需要知道「上一轮还有子代理在跑」的时候，藏掉等于把搬家的理由自己抹掉。
            代价：cron 页正文会被右栏挤窄一点。 */}
        {hasRail ? (
          <Rail
            run={activeRun}
            exec={activeExec}
            todos={state.todos}
            messages={state.messages}
            backgroundAgents={state.backgroundAgents}
            steps={visibleSteps}
            selectedTurn={selectedTurn}
            onSelectTurn={onSelectTurn}
          />
        ) : null}
        </div>
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
