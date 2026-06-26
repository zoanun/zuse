import {
  Conversation,
  ToolRegistry,
  decide,
  runAgent,
  resolveContextWindow,
  findCompactionCut,
  findCompactionCutByBudget,
  summarizeForCompaction,
  applyCompaction,
  extractPreviousSummary,
  splitMemoryCandidates,
  estimateCompactionSavings,
  COMPACTION_THRESHOLD,
  TAIL_BUDGET_RATIO,
  createModelClient,
  getProviderConfig,
  modelNames,
  resolveFailoverMode,
  decideFailover,
  modelKey,
  badKeysForFailure,
  createFileTracker,
  MEMORY_INDEX_CAP,
  shouldConsolidateMemories,
  buildConsolidationPrompt,
  parseConsolidationOps,
  type ModelClient,
  type FileReadTracker,
  type ResolvedSettings,
  type ProviderConfig,
  type PermissionsConfig,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
  type ErrorCategory,
} from '@zuse/core'
import { openMemoryStore, renderMemoryMarkdown, applyMemoryConsolidation, cwdSlug } from '@zuse/tools'
import type {
  SessionEvent,
  SessionSnapshot,
  TodoItemLite,
  PendingPermissionLite,
  SessionCheckpoint,
  SnapshotStore,
} from './events.js'
import type { SnapshotPart, SnapshotMessage } from '@zuse/protocol'

/**
 * Compaction folds messages[0..cut) into a single summary message, so checkpoint
 * indices shift: checkpoints inside the folded range are dropped, those in the kept
 * range are remapped (− cut + 1 for the summary placeholder). Server-local mirror of
 * the TUI's remapCheckpoints (which lives in @zuse/tui and must not be imported here).
 */
export function remapCheckpoints(checkpoints: SessionCheckpoint[], cutIndex: number): SessionCheckpoint[] {
  return checkpoints
    .filter((c) => c.messageIndex >= cutIndex)
    .map((c) => ({ ...c, messageIndex: c.messageIndex - cutIndex + 1 }))
}

/** Default output token cap for a turn, used when no maxTokens option is provided. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384

export interface PermissionPolicy {
  interactive: boolean
  config: PermissionsConfig
}

export interface SessionManagerOptions {
  sessionId: string
  cwd: string
  client: ModelClient
  registry: ToolRegistry
  settings: ResolvedSettings
  systemPrompt: string
  permissionPolicy: PermissionPolicy
  snapshotStore: SnapshotStore
  conversation?: Conversation
  /** Pre-seed checkpoint anchors (e.g. restored from persistence, or for tests). Defaults to []. */
  checkpoints?: SessionCheckpoint[]
  createdAt?: string
  /** Max output tokens per turn. Defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxTokens?: number
  /** Provider id this session runs against. Initialises currentProviderId. Defaults to 'unknown'. */
  providerId?: string
  /**
   * Factory used to build the swapped client on failover. Defaults to core's
   * createModelClient. Injectable so offline tests can return a scripted fake
   * instead of a real provider client.
   */
  createClient?: (providerConfig: ProviderConfig, model: string) => ModelClient
}

interface Pending {
  req: PermissionRequest
  resolve: (v: PermissionVerdict) => void
}

export class SessionManager {
  private readonly sessionId: string
  private conversation: Conversation
  private client: ModelClient
  private readonly registry: ToolRegistry
  private readonly settings: ResolvedSettings
  private systemPrompt: string
  private policy: PermissionPolicy
  private readonly snapshotStore: SnapshotStore
  private readonly createdAt: string
  private readonly maxTokens: number

  private cwd: string
  private currentProviderId = 'unknown'
  /** Models marked bad this session: key `${providerId}/${model}` → why. Feeds decideFailover. */
  private readonly badModels = new Map<string, ErrorCategory>()
  private readonly createClient: (providerConfig: ProviderConfig, model: string) => ModelClient
  private abort: AbortController | null = null
  private readonly steerQueue: string[] = []
  private todos: TodoItemLite[] = []
  /** Shadow-git checkpoint anchors recorded per turn (Phase 12); drives revert(). */
  private checkpoints: SessionCheckpoint[] = []
  /** Guards against concurrent memory-consolidation passes (fire-and-forget). */
  private consolidating = false
  private contextTokens: number | undefined = undefined
  private ineffectiveCompaction = 0
  private totalUsage: Usage | undefined = undefined
  private isThinking = false
  private readonly pending = new Map<string, Pending>()
  private permSeq = 0
  /** In-memory session permission overlay (extra allow rules). Persisted across turns. */
  private readonly sessionAllow: string[] = []
  /**
   * ONE FileReadTracker for the whole session (matches the TUI's per-session tracker).
   * Passed to every runAgent turn and reused for the compaction memory flush so
   * read-before-write (the optimistic lock) survives across turns — otherwise runAgent
   * would allocate a fresh tracker per turn (agent.ts: `opts.tracker ?? createFileTracker()`)
   * and forget what was read last turn.
   */
  private readonly tracker: FileReadTracker = createFileTracker()

  private readonly listeners = new Set<(e: SessionEvent) => void>()

  constructor(opts: SessionManagerOptions) {
    // Spec §9's "client uninitialised → emit error, reject" row is unreachable by
    // construction: client is a required (non-null) constructor arg, so no runtime guard.
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.client = opts.client
    this.registry = opts.registry
    this.settings = opts.settings
    this.systemPrompt = opts.systemPrompt
    this.policy = opts.permissionPolicy
    this.snapshotStore = opts.snapshotStore
    this.conversation = opts.conversation ?? new Conversation()
    this.checkpoints = opts.checkpoints ?? []
    this.createdAt = opts.createdAt ?? new Date().toISOString()
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    this.currentProviderId = opts.providerId ?? 'unknown'
    this.createClient = opts.createClient ?? createModelClient
    // Initialise totalUsage from the conversation only if there is prior usage.
    // Conversation.totalUsage always returns a Usage object (never undefined), so
    // we leave totalUsage as undefined when the conversation is brand-new (all zeros).
    const usage = this.conversation.totalUsage
    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.totalUsage = usage
    }
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        // A bad listener must not break orchestration.
      }
    }
  }

  /** Test-only hook used by unit tests to drive emit() before submit() exists. */
  private _emitForTest(e: SessionEvent): void {
    this.emit(e)
  }

  /** Test-only seam: seed contextTokens high to exercise the pre-turn auto-compaction trigger. */
  private _setContextTokensForTest(n: number): void {
    this.contextTokens = n
  }

  setPermissionPolicy(p: PermissionPolicy): void {
    this.policy = p
  }

  /** 当前模型的上下文窗口大小(token);供前端算 ctx 占用百分比。 */
  private ctxWindow(): number {
    return resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
  }

  getState(): SessionSnapshot {
    const pendingPermissions: PendingPermissionLite[] = [...this.pending.entries()].map(([id, p]) => ({
      id,
      req: p.req,
    }))
    return {
      sessionId: this.sessionId,
      isThinking: this.isThinking,
      model: this.client.getModel(),
      cwd: this.cwd,
      totalUsage: this.totalUsage,
      contextTokens: this.contextTokens,
      contextWindow: this.ctxWindow(),
      todos: this.todos,
      pendingPermissions,
      messageCount: this.conversation.length,
      messages: this.projectMessages(),
      checkpoints: this.checkpoints.map((c) => ({ id: c.hash, label: c.label })),
    }
  }

  /**
   * Project the committed conversation into wire-shaped SnapshotMessages so a late-
   * joining client can render the full history on attach. Each ContentBlock maps to a
   * SnapshotPart; unknown block kinds are skipped (a message with no mappable blocks
   * still emits {role, parts:[]} to preserve user/assistant ordering). tool_result blocks
   * carry no tool name in the core ContentBlock, so name is '' here.
   */
  private projectMessages(): SnapshotMessage[] {
    return this.conversation.getMessages().map(({ role, content }, i) => {
      const parts: SnapshotPart[] = []
      for (const block of content) {
        if (block.type === 'text') {
          // Fix A: submit() prefixes the model's userText with `[YYYY-MM-DD HH:MM] `; that
          // prefix lives in the committed ledger, so restoring user messages from the snapshot
          // would surface it (the live path renders raw text). Strip exactly that one leading
          // pattern, and only from user text — never touch assistant text.
          const text = role === 'user'
            ? block.text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, '')
            : block.text
          parts.push({ kind: 'text', text })
        } else if (block.type === 'tool_use') {
          parts.push({ kind: 'tool-use', id: block.id, name: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          const output = Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : String(block.content)
          parts.push({ kind: 'tool-result', id: block.tool_use_id, name: '', output, isError: block.is_error ?? false })
        }
        // Unknown block kinds are intentionally skipped.
      }
      // Fix B: a checkpoint anchors before a user turn, so its messageIndex == this user
      // message's ledger index. Attach the hash so the web can render a per-message revert.
      // Match by index regardless of role (only user turns will match by construction).
      const checkpointId = this.checkpoints.find((c) => c.messageIndex === i)?.hash
      return { role, parts, checkpointId }
    })
  }

  /**
   * Resolve a pending interactive permission request.
   * Argument order: (id, verdict) — id first. Note: the sibling TUI API uses
   * verdict-first order; callers must not swap the arguments.
   */
  resolvePermission(id: string, verdict: PermissionVerdict): void {
    // NOTE on session-scope: a verdict of allow_session/allow_persist makes core's
    // gateAndRunTool push the matched rule into this.sessionAllow (the same array we
    // pass to runAgent every turn), so the rule auto-allows identical calls for the rest
    // of the session. allow_persist additionally writes the rule to disk via core's
    // default onPersistAllow (appendAllowRule), since submit does not override it.
    if (verdict !== 'allow' && verdict !== 'deny' && verdict !== 'allow_session' && verdict !== 'allow_persist') return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(verdict)
    this.emit({ type: 'permission-resolved', id, verdict })
  }

  /** Provided to runAgent. Only invoked for 'ask'-classified tool calls. Must be concurrency-safe. */
  private canUseTool = (req: PermissionRequest): Promise<PermissionVerdict> => {
    if (!this.policy.interactive) {
      // Non-interactive: delegate to core's canonical decide() so that:
      // - Bash compound commands are subcommand-split (no prefix-bypass of "safe && evil")
      // - deny list is honored (deny has higher priority than allow)
      // - defaultMode / bypassPermissions are respected
      // No human is attached, so anything not auto-allowed (ask) becomes deny.
      const tool = this.registry.get(req.toolName)
      if (!tool) return Promise.resolve('deny')
      const settings = { ...this.settings, permissions: this.policy.config }
      const { decision } = decide(tool, req.specifier, settings, [], this.cwd)
      return Promise.resolve(decision === 'allow' ? 'allow' : 'deny')
    }
    // Interactive: park the request; a connected client will resolve it via resolvePermission().
    // NOTE: pending requests are NOT torn down when a client disconnects — by design, a
    // dropped client's request stays pending and is resolved on reconnect. Teardown is
    // intentionally deferred to the session-lifecycle / transport layer.
    const id = `perm-${++this.permSeq}`
    return new Promise<PermissionVerdict>((resolve) => {
      this.pending.set(id, { req, resolve })
      this.emit({ type: 'permission-request', id, req })
    })
  }

  /** Queue a mid-turn steer message; runAgent consumes it after each tool batch. */
  steer(text: string): void {
    if (text.trim() === '') return
    this.steerQueue.push(text.trim())
  }

  /** Abort the in-flight turn, if any. Returns true if a turn was aborted. */
  interrupt(): boolean {
    if (this.abort) {
      this.abort.abort()
      return true
    }
    return false
  }

  /**
   * "New chat": forget the conversation and ALL transient turn state while keeping the
   * environment (model client, tool registry, settings, systemPrompt, cwd, provider). Any
   * in-flight turn is interrupted first so it stops dirtying state we are about to clear.
   * After clearing, emits a todos-update with an empty list so connected clients drop their
   * todos panel; future snapshots will report messageCount 0, so no extra event is needed
   * for the conversation itself (the frontend resets its message view locally).
   */
  reset(): void {
    // Abort any running turn BEFORE clearing — an in-progress turn would otherwise keep
    // writing into the conversation/usage/checkpoints we are about to throw away.
    this.interrupt()

    // Settle any parked permission prompts with 'deny' BEFORE dropping them. interrupt()'s
    // abort signal does not reach canUseTool's awaited promise, so merely clearing this.pending
    // would orphan the resolve handle and hang the aborted turn's async stack forever (its
    // finally never runs → this.abort stays dirty). Resolving 'deny' lets the gate return a
    // decline so the turn unwinds naturally against the already-aborted signal.
    for (const [id, p] of this.pending) {
      p.resolve('deny')
      this.emit({ type: 'permission-resolved', id, verdict: 'deny' })
    }
    this.pending.clear()

    this.conversation = new Conversation()
    this.todos = []
    this.totalUsage = undefined
    this.contextTokens = undefined
    this.checkpoints = []
    this.steerQueue.length = 0
    this.sessionAllow.length = 0
    this.badModels.clear()
    this.ineffectiveCompaction = 0
    this.isThinking = false

    this.emit({ type: 'todos-update', todos: [] })
  }

  /**
   * Compact the conversation: summarize old history, keep recent turns verbatim.
   * Port of the TUI's compactConversation (minus React). Replaces this.conversation
   * with a new compacted ledger and resets contextTokens (next turn re-measures).
   * On a too-short history it returns a message and does nothing. The summary request
   * always succeeds (summarizeForCompaction falls back to a deterministic summary).
   */
  async compact(): Promise<string> {
    const conv = this.conversation
    const messages = conv.getMessages()

    // Tail-budget protection scaled to the context window; falls back to a fixed
    // turn count when the budget path finds no cut.
    const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
    const tailBudgetChars = Math.round(windowSize * COMPACTION_THRESHOLD * TAIL_BUDGET_RATIO * 4)
    const cut = findCompactionCutByBudget(messages, tailBudgetChars) ?? findCompactionCut(messages)
    if (cut === null) return 'History too short; nothing to compact.'

    this.emit({ type: 'compaction-start' })
    const before = conv.length

    // TodoWrite state injected into the summary prompt so Pending Items survives.
    const todoIcons: Record<TodoItemLite['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }
    const todoState = this.todos.length > 0
      ? this.todos.map((t) => `${todoIcons[t.status]} ${t.content}`).join('\n')
      : undefined

    // Iterative summary: if the ledger already opens with a prior summary, update it.
    const previousSummary = extractPreviousSummary(messages)
    const raw = await summarizeForCompaction(
      this.client,
      messages.slice(0, cut),
      { model: this.client.getModel(), max_tokens: this.maxTokens },
      undefined,
      previousSummary ?? undefined,
      todoState,
    )

    const { summary, candidates } = splitMemoryCandidates(raw)

    // Debounce: track savings; consecutive ineffective compactions disable auto-trigger.
    const savings = estimateCompactionSavings(messages, cut, summary.length)
    if (savings.savingsRatio < 0.1) this.ineffectiveCompaction++
    else this.ineffectiveCompaction = 0

    this.conversation = applyCompaction(conv, summary, cut)
    // Window usage is unknown post-compaction (next turn measures it); clear it so the
    // stale value cannot re-trigger auto-compaction.
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })

    // Checkpoint remap: applyCompaction folds [0..cut) into one summary message, so
    // indices shift. Drop folded-range checkpoints, remap kept-range ones.
    this.checkpoints = remapCheckpoints(this.checkpoints, cut)

    // Memory flush (Phase 13): the summary request also extracted persistent facts;
    // persist them via the Memory tool. Failure is silent — flush is value-add and must
    // never drag down compaction itself (D5). Port of useConversation's flush block.
    let flushed = 0
    const memTool = this.registry.get('Memory')
    if (memTool && candidates.length > 0) {
      // Reuse the session-scoped tracker (one abort signal shared across the whole
      // flush; the signal is flush-scoped, not per-save).
      const flushSignal = new AbortController().signal
      for (const c of candidates) {
        try {
          const res = await memTool.run(
            { action: 'save', type: c.type, content: c.content, hook: c.hook },
            { cwd: this.cwd, signal: flushSignal, tracker: this.tracker, setCwd: () => {} },
          )
          if (!res.isError) flushed++
        } catch {
          // Flush is best-effort; one bad candidate must never break the rest.
        }
      }
    }

    // NOTE: reloading MEMORY.md into systemPrompt after compaction is deferred (the
    // server's systemPrompt is built by the transport/owner, not here).

    const flushSuffix = flushed > 0 ? `; saved ${flushed} memories` : ''
    const msg = `Compacted: ${before} → ${this.conversation.length} messages (${Math.round(savings.savingsRatio * 100)}% saved)${flushSuffix}`
    this.emit({ type: 'compaction-done', summaryText: summary })
    return msg
  }

  /**
   * Run ONE user turn: drive runAgent and forward its stream as SessionEvents
   * (tool output forwarded RAW — no truncation/spill; that is the frontend's job),
   * then emit usage/context, and always emit turn-end in finally.
   */
  async submit(text: string, _parts?: unknown, opts?: { isResend?: boolean }): Promise<void> {
    // Reject EXTERNAL concurrent submits while a turn runs. An isResend call is a
    // RECURSIVE re-entry from inside submit (failover resend) and must be allowed.
    if (this.isThinking && !opts?.isResend) {
      throw new Error('A turn is already in progress')
    }
    this.isThinking = true
    this.emit({ type: 'turn-start', isResend: !!opts?.isResend })

    // Auto-compaction (Phase 10B): if the last turn's measured context usage crossed
    // the window threshold, compact BEFORE sending. Skip on resend (failover): the just-
    // failed turn added no usage and resends must be fast. A failed compaction does not
    // block the send — we warn and proceed on the original history.
    if (!opts?.isResend) {
      const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
      if ((this.contextTokens ?? 0) > windowSize * COMPACTION_THRESHOLD && this.ineffectiveCompaction < 2) {
        try {
          this.emit({ type: 'memory-notice', text: await this.compact() })
        } catch (err) {
          this.emit({ type: 'warning', message: `auto-compaction failed: ${err instanceof Error ? err.message : String(err)}` })
        }
      }
    }

    // The ledger ref must be read AFTER auto-compaction: compact() swaps this.conversation
    // for a new instance, so reading earlier would run the turn against the stale ledger.
    const conversation = this.conversation

    // Checkpoint (Phase 12): snapshot the workspace BEFORE the turn. fire-and-forget;
    // failure degrades to no checkpoint for this turn (D5). The hash is awaited at
    // turn end. Resends skip — the original send's snapshot is the correct anchor.
    const checkpointIndex = conversation.length
    const trackAt = new Date().toISOString()
    const trackPromise: Promise<string | null> = opts?.isResend
      ? Promise.resolve(null)
      : this.snapshotStore.track().catch(() => null)

    const controller = new AbortController()
    this.abort = controller

    let accumulated = ''
    let assistantStarted = false
    let lastInputTokens: number | undefined
    // Failover decision: the error branch only RECORDS the category here; the swap/
    // resend runs after the loop ends (never re-enter runAgent inside its own for-await).
    let failoverDecision: ErrorCategory | null = null
    // Set right before the recursive resend so the OUTER finally does not emit a second
    // turn-end (the nested submit already emitted one).
    let resent = false

    try {
      for await (const event of runAgent({
        conversation,
        client: this.client,
        registry: this.registry,
        userText: `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${text}`,
        config: { model: this.client.getModel(), max_tokens: this.maxTokens, system: this.systemPrompt },
        cwd: this.cwd,
        signal: controller.signal,
        settings: this.settings,
        // Session-scoped tracker (see field decl): keeps read-before-write across turns.
        tracker: this.tracker,
        // NOTE: sessionAllow accumulates across turns. core's gateAndRunTool mutates the
        // SAME array we pass here (push on allow_session/allow_persist), and we pass the
        // stable this.sessionAllow every turn — so allow_session rules persist for the
        // session. allow_persist additionally persists the rule to disk via core's default
        // onPersistAllow (appendAllowRule), which runAgent applies since we don't override it.
        sessionAllow: this.sessionAllow,
        onCwdChange: (next: string) => {
          this.cwd = next
          this.emit({ type: 'cwd-change', cwd: next })
        },
        consumeSteer: () => {
          if (this.steerQueue.length === 0) return null
          const combined = this.steerQueue.join('\n')
          this.steerQueue.length = 0
          return combined
        },
        canUseTool: this.canUseTool,
      })) {
        switch (event.type) {
          case 'message-start':
            assistantStarted = true
            accumulated = ''
            this.emit({ type: 'message-start', id: event.id, model: event.model })
            break
          case 'text-delta':
            accumulated += event.text
            this.emit({ type: 'text-delta', text: event.text })
            break
          case 'tool-use':
            this.emit({ type: 'tool-use', id: event.id, name: event.name, input: event.input, invalid_args: event.invalid_args })
            break
          case 'tool-result':
            this.emit({ type: 'tool-result', id: event.id, name: event.name, output: event.output, is_error: event.is_error })
            break
          case 'message-stop':
            lastInputTokens = event.usage.input_tokens + (event.usage.cache_read_input_tokens ?? 0)
            this.emit({ type: 'message-stop', stop_reason: event.stop_reason, usage: event.usage })
            break
          case 'warning':
            this.emit({ type: 'warning', message: event.message })
            break
          case 'error': {
            if (controller.signal.aborted) { this.emit({ type: 'aborted' }); break }
            const cat: ErrorCategory = (event.category as ErrorCategory | undefined) ?? 'other'
            // Only consider failover when nothing has streamed yet: quota/auth/unavailable
            // all surface at stream open. A mid-stream error only shows (resending would
            // duplicate emitted content). Record now; act after the loop.
            const preStream = accumulated === '' && !assistantStarted
            if (preStream && cat !== 'other') failoverDecision = cat
            else this.emit({ type: 'error', message: event.message, category: cat })
            break
          }
        }
      }

      this.contextTokens = lastInputTokens ?? this.contextTokens
      this.totalUsage = conversation.totalUsage
      this.emit({ type: 'usage-update', totalUsage: this.totalUsage })
      this.emit({ type: 'context-update', contextTokens: this.contextTokens, contextWindow: this.ctxWindow() })

      // Record the checkpoint (Phase 12): only if track() succeeded. Even an errored
      // turn records — the snapshot anchors "before this turn", so checkpointIndex ==
      // ledger length and revert's truncation degrades to a no-op while the file roll-
      // back undoes the half-finished turn. await usually returns immediately.
      const hash = await trackPromise
      if (hash) {
        const label = text.replace(/\s+/g, ' ').trim().slice(0, 80)
        this.checkpoints.push({ messageIndex: checkpointIndex, hash, at: trackAt, label })
        this.emit({ type: 'checkpoint-recorded', id: hash, messageIndex: checkpointIndex, label })
      }

      // Failover: the for-await has ended (client returned), so it is safe to swap
      // the client and resend. Port of useConversation's post-loop failover block.
      if (failoverDecision) {
        const cat = failoverDecision
        const pid = this.currentProviderId
        // The model that just failed = the client currently in use (auto chain-failover
        // hot-swaps this.client, so getModel() is the true failed model, not a stale local).
        const failedModel = this.client.getModel()
        const models = modelNames(this.settings.providers[pid])
        // Mark bad: auth invalidates the whole provider (shared key); others only this model.
        for (const k of badKeysForFailure(pid, failedModel, cat, models)) {
          this.badModels.set(k, k === modelKey(pid, failedModel) ? cat : 'auth')
        }
        const reasonText = cat === 'auth' ? 'API key invalid' : cat === 'quota' ? 'quota exhausted' : 'model unavailable'
        const action = decideFailover({
          category: cat,
          mode: resolveFailoverMode(this.settings),
          providerId: pid,
          models,
          currentModel: failedModel,
          bad: new Set(this.badModels.keys()),
        })
        if (action.kind === 'retry') {
          this.emit({ type: 'failover', fromModel: failedModel, toModel: action.model, reason: reasonText })
          // Hot-swap the client within the same provider (no persist, providerId unchanged).
          this.client = this.createClient(getProviderConfig(this.settings, pid), action.model)
          // The new model's window may be much smaller. The failed turn committed nothing
          // (history unchanged), so the prior input_tokens still estimate occupancy: if it
          // overflows the new window threshold, compact first so the resend keeps context.
          const newWindow = resolveContextWindow(this.settings, pid, action.model)
          if (this.contextTokens && this.contextTokens > newWindow * COMPACTION_THRESHOLD) {
            try {
              this.emit({ type: 'memory-notice', text: await this.compact() })
            } catch (err) {
              this.emit({ type: 'warning', message: `compaction before resend failed: ${err instanceof Error ? err.message : String(err)}` })
            }
          }
          // The resend's runAgent reads this.client.getModel() (the new model). Resend.
          this.abort = null
          resent = true
          await this.submit(text, undefined, { isResend: true })
        } else {
          // dialog mode / auth / no available next model: hand off to client model picker.
          this.emit({ type: 'model-select-needed', reason: reasonText })
        }
      }

      // Memory consolidation (Phase 13, lightweight autoDream): after a real turn (not a
      // resend that re-enters submit), maybe run a background tidy of the memory index.
      // fire-and-forget — failure is fully silent, it must never become a new failure point.
      if (!resent) void this.maybeConsolidateMemories()
    } catch (err) {
      if (controller.signal.aborted) this.emit({ type: 'aborted' })
      else this.emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    } finally {
      this.isThinking = false
      this.abort = null
      // On a failover resend the nested submit already emitted turn-end; suppress the
      // outer one to avoid a double turn-end. isThinking/abort resets are idempotent.
      if (!resent) this.emit({ type: 'turn-end' })
    }
  }

  /**
   * Switch the active model (manual model picker / model-select-needed handoff).
   * Rebuilds the client against the chosen provider/model. getState().model reflects
   * client.getModel(), so no extra bookkeeping is needed. No persist — session-scoped.
   */
  switchModel(providerId: string, model: string): void {
    this.client = this.createClient(getProviderConfig(this.settings, providerId), model)
    this.currentProviderId = providerId
  }

  /**
   * Mirror the model's todo list into session state and notify subscribers. Public
   * seam: the SessionManager receives a pre-built registry and does not own the
   * TodoWrite tool, so whoever constructs the registry must wire the tool's onUpdate
   * to this method (see createTodoWriteTool({ onUpdate })). Automatic in-manager wiring
   * is intentionally deferred to avoid the manager owning tool construction.
   */
  setTodos(todos: TodoItemLite[]): void {
    this.todos = todos
    this.emit({ type: 'todos-update', todos })
  }

  /**
   * Revert to a checkpoint (Phase 12, /revert): roll the workspace back FIRST, then
   * truncate the ledger — if restore() throws, the ledger must stay intact (files did
   * not roll back, so neither can history). Drops checkpoints at/after the revert point
   * and clears the measured context (next turn re-measures). No-op on unknown id.
   * Mirrors useConversation's revertToCheckpoint.
   */
  async revert(checkpointId: string): Promise<void> {
    const cp = this.checkpoints.find((c) => c.hash === checkpointId)
    if (!cp) return
    await this.snapshotStore.restore(cp.hash)
    const conv = this.conversation
    this.conversation = Conversation.fromJSON({
      version: 1,
      messages: conv.getMessages().slice(0, cp.messageIndex),
      // Cost ledger, not window ledger: money already spent does not un-spend on revert.
      totalUsage: conv.totalUsage,
    })
    // Checkpoints at/after the revert point are invalidated (incl. same-index error-turn ones).
    this.checkpoints = this.checkpoints.filter((c) => c.messageIndex < cp.messageIndex)
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })
    // Notify clients a revert happened so they can re-sync (wsServer re-pushes a fresh
    // snapshot on this event). Emitted only on the success path — the unknown-id case
    // early-returned above without touching any state.
    this.emit({ type: 'reverted', checkpointId })
  }

  /**
   * Background memory consolidation (Phase 13, lightweight autoDream): when the memory
   * index is near its cap and ≥24h since the last run, send ONE tool-less request asking
   * the model to emit DELETE/SAVE op lines, then apply them deterministically. Guarded by
   * a consolidating flag; fully fire-and-forget — every failure is swallowed, it must
   * never become a new failure point. Emits memory-notice instead of the TUI's UI notify.
   * Port of useConversation's maybeConsolidateMemories (deps come from @zuse/tools + core,
   * not @zuse/tui — server already depends on @zuse/tools).
   */
  private async maybeConsolidateMemories(): Promise<void> {
    if (this.consolidating) return
    this.consolidating = true
    let store: ReturnType<typeof openMemoryStore> | null = null
    try {
      store = openMemoryStore()
      const rows = store.all()
      if (rows.length === 0) return
      const projection = renderMemoryMarkdown(rows)
      const lastRunAt = store.getMeta('consolidated_at')
      if (!shouldConsolidateMemories({ projectionChars: projection.length, indexCap: MEMORY_INDEX_CAP, lastRunAt })) {
        return
      }
      // Write the watermark first: even a failed run is debounced for 24h (debounce
      // wins over success — we never want this to nag every turn).
      store.setMeta('consolidated_at', new Date().toISOString())
      const prompt = buildConsolidationPrompt(rows)
      store.close()
      store = null // do not hold the sqlite connection during the model request
      this.emit({ type: 'memory-notice', text: 'Memory index near capacity; consolidating in background…' })
      let text = ''
      for await (const e of this.client.sendMessages(
        [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        { model: this.client.getModel(), max_tokens: Math.min(this.maxTokens, 2000) },
      )) {
        if (e.type === 'text-delta') text += e.text
        else if (e.type === 'error') return
      }
      const ops = parseConsolidationOps(text)
      if (ops.deletes.length === 0 && ops.saves.length === 0) {
        this.emit({ type: 'memory-notice', text: 'Memory consolidation: model judged no changes needed.' })
        return
      }
      const { saved, deleted } = applyMemoryConsolidation(ops, cwdSlug(this.cwd))
      this.emit({ type: 'memory-notice', text: `Memory consolidated: ${saved} merged/added, ${deleted} removed.` })
    } catch {
      // Consolidation is value-add; any failure must not become a new failure point.
    } finally {
      store?.close()
      this.consolidating = false
    }
  }
}
