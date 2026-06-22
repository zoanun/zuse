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
  type ModelClient,
  type ResolvedSettings,
  type ProviderConfig,
  type PermissionsConfig,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
  type ErrorCategory,
} from '@zuse/core'
import type { SessionEvent, SessionSnapshot, TodoItemLite, PendingPermissionLite } from './events.js'

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
  snapshotStore: { track: () => Promise<string>; restore: (h: string) => Promise<void> }
  conversation?: Conversation
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
  private readonly snapshotStore: SessionManagerOptions['snapshotStore']
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
  private contextTokens: number | undefined = undefined
  private ineffectiveCompaction = 0
  private totalUsage: Usage | undefined = undefined
  private isThinking = false
  private readonly pending = new Map<string, Pending>()
  private permSeq = 0
  /** In-memory session permission overlay (extra allow rules). Persisted across turns. */
  private readonly sessionAllow: string[] = []

  private readonly listeners = new Set<(e: SessionEvent) => void>()

  constructor(opts: SessionManagerOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.client = opts.client
    this.registry = opts.registry
    this.settings = opts.settings
    this.systemPrompt = opts.systemPrompt
    this.policy = opts.permissionPolicy
    this.snapshotStore = opts.snapshotStore
    this.conversation = opts.conversation ?? new Conversation()
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
      todos: this.todos,
      pendingPermissions,
      messageCount: this.conversation.length,
    }
  }

  /**
   * Resolve a pending interactive permission request.
   * Argument order: (id, verdict) — id first. Note: the sibling TUI API uses
   * verdict-first order; callers must not swap the arguments.
   */
  resolvePermission(id: string, verdict: PermissionVerdict): void {
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
    this.emit({ type: 'context-update', contextTokens: undefined })
    // NOTE: memory flush (candidates → Memory tool) is wired in Task 9.
    // NOTE: checkpoint remap (remapCheckpoints) is wired in Task 9 (no checkpoints exist yet).
    // NOTE: reloading MEMORY.md into systemPrompt after compaction is deferred.
    void candidates

    const msg = `Compacted: ${before} → ${this.conversation.length} messages (${Math.round(savings.savingsRatio * 100)}% saved)`
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
      this.emit({ type: 'context-update', contextTokens: this.contextTokens })

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
}
