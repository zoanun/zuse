import {
  Conversation,
  ToolRegistry,
  decide,
  runAgent,
  resolveContextWindow,
  resolveVision,
  findCompactionCut,
  findCompactionCutByBudget,
  summarizeForCompaction,
  buildFallbackSummary,
  applyCompaction,
  emptyUsage,
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
  generateSessionTitle,
  steerFoldSuffix,
  type ModelClient,
  type Message,
  type MessageAttachment,
  type FileReadTracker,
  type ResolvedSettings,
  type ProviderConfig,
  type PermissionsConfig,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
  type ErrorCategory,
} from '@zuse/core'
import { openMemoryStore, renderMemoryMarkdown, applyMemoryConsolidation, cwdSlug, createAgentTool } from '@zuse/tools'
import type {
  SessionEvent,
  SessionSnapshot,
  TodoItemLite,
  PendingPermissionLite,
  SessionCheckpoint,
  SnapshotStore,
} from './events.js'
import type { SnapshotPart, SnapshotMessage, UploadedImageRef } from '@zuse/protocol'
import type { CompactionMeta } from './sessionStore.js'
import { stripUserStamp, applyUserStamp } from './userStamp.js'

/** Default output token cap for a turn, used when no maxTokens option is provided. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384

/** Output cap for a single image-description round-trip (parsed fallback for non-vision models). */
const IMAGE_DESCRIPTION_MAX_TOKENS = 1024

/**
 * Prompt sent to the auxiliary image model (parsed fallback): ask it to describe an image objectively
 * and completely so the non-vision main model can answer the user's question from the description.
 */
const IMAGE_PROMPT =
  '请客观、完整地描述这张图片的内容（包括文字、图表、界面、代码、人物特征等一切可见细节），以便另一个模型据此回答用户的问题。'

/**
 * Remove the parsed-fallback `<uploaded-images>…</uploaded-images>` block (baked into the model's
 * user text by submit()) for DISPLAY only — the ledger keeps the baked text so the model's history
 * stays faithful; this strips it back out (with its leading `\n\n`) so a late-joining client renders
 * the user's original question, not the machine-baked descriptions. The image metadata is surfaced
 * separately via SnapshotMessage.attachments.
 */
const UPLOADED_IMAGES_RE = /\n\n<uploaded-images>\n[\s\S]*?\n<\/uploaded-images>\s*$/
function stripUploadedImages(text: string): string {
  return text.replace(UPLOADED_IMAGES_RE, '')
}

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
  /** Pre-seed compaction state (feature B), restored from persistence. Absent = never compacted. */
  compaction?: CompactionMeta
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
  /**
   * Optional small-model client + model id for cheap auxiliary tasks (session title
   * generation). Built by createSession from settings.smallModel when configured;
   * absent → generateTitle() is a no-op (caller falls back to first-message truncation).
   */
  titleClient?: ModelClient
  titleModel?: string
  /** True when a title already exists (restored manual/generated record) → don't auto-generate. */
  titleAlreadySet?: boolean
  /**
   * Auxiliary vision-capable client + model for the PARSED fallback (I2): when the main model is
   * NOT vision-capable, each uploaded image is sent to this client to obtain a text description,
   * which is baked into the main model's user text. Absent → images cannot be handled for a
   * non-vision main model (submit emits an error and refuses to send).
   */
  imageClient?: ModelClient
  imageModel?: string
  /**
   * Reads an uploaded image's bytes as base64 (parsed fallback constructs the image block from it).
   * Provided by startServer via UploadService.readBase64; SessionManager never touches the uploads dir.
   */
  readImageBase64?: (id: string) => Promise<{ data: string; mediaType: string }>
  /**
   * Send-time image-expansion hook forwarded to runAgent for the DIRECT route (vision main model):
   * reads each message's `attachments` → base64 → prepends image blocks to a request-only copy.
   * Provided by startServer; the ledger stays base64-free. Absent → direct route sends text only.
   */
  expandAttachments?: (messages: Message[]) => Promise<Message[]>
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
  /** Small-model client + model for title generation; undefined when smallModel unset. */
  private readonly titleClient: ModelClient | undefined
  private readonly titleModel: string | undefined
  /** Parsed-fallback image model (I2): describes images for a non-vision main model. */
  private readonly imageClient: ModelClient | undefined
  private readonly imageModel: string | undefined
  /** Reads an uploaded image as base64 (parsed fallback); injected, uploads dir stays server-owned. */
  private readonly readImageBase64: ((id: string) => Promise<{ data: string; mediaType: string }>) | undefined
  /** Send-time image-expansion hook for the direct route; forwarded to runAgent. */
  private readonly expandAttachments: ((messages: Message[]) => Promise<Message[]>) | undefined
  /** A title exists (generated or manual) → don't auto-generate again. */
  private titleSettled = false
  /** A title-generation call is in flight → don't start a second one. */
  private titlePending = false
  private abort: AbortController | null = null
  // Mid-turn steers awaiting delivery. `echoed` = a "↪ 插话" bubble was already shown for it (it was
  // folded into a tool_result then re-queued after a Stop), so the idle-drain re-delivers it without
  // a second echo. Per-item (not a turn-level flag) so a turn can hold a mix of echoed/un-echoed
  // steers — e.g. one folded early + one queued during the final pure-text reply — each echoed once.
  private readonly steerQueue: { text: string; echoed: boolean }[] = []
  private todos: TodoItemLite[] = []
  /** Shadow-git checkpoint anchors recorded per turn (Phase 12); drives revert(). */
  private checkpoints: SessionCheckpoint[] = []
  /**
   * Feature B compaction state, or null when never compacted. The full ledger (this.conversation)
   * is never folded; this metadata drives the transient per-turn LLM view built in
   * buildContextView(). Persisted + restored so the view survives a daemon restart.
   */
  private compaction: CompactionMeta | null = null
  /** Guards against concurrent memory-consolidation passes (fire-and-forget). */
  private consolidating = false
  private contextTokens: number | undefined = undefined
  private ineffectiveCompaction = 0
  private totalUsage: Usage | undefined = undefined
  private isThinking = false
  // The todo list as it stood BEFORE the current (outer) turn — a reference snapshot (setTodos
  // always swaps in a fresh array, never mutates, so this ref stays intact). On abort we revert to
  // it: the aborted turn's conversation is discarded, so its todo changes must be discarded too,
  // or a reload shows a stale plan from a turn that never committed.
  private todosBeforeTurn: TodoItemLite[] = []
  // The session cwd as it stood BEFORE the current (outer) turn. Reverted on abort for the same
  // reason as todos — a discarded turn should leave no trace: a tool's `cd` (onCwdChange) in it left
  // no ledger record, so the policy is to drop it rather than let a cancelled turn silently move the
  // session's cwd. (cwd is persisted from getState() AFTER this revert, so reload matches the live
  // reverted value. The file-read tracker is deliberately NOT reverted — it's session-scoped by
  // design, keeping read-before-write across turns.)
  private cwdBeforeTurn = ''
  // Bumped by reset() ("new chat"). A running turn captures it at start and checks it before its
  // post-turn tail (abort-revert of todos/cwd, steer re-queue, idle-drain). If reset() ran mid-turn
  // the epoch differs, so the tail bails instead of re-populating the freshly-cleared state.
  private turnEpoch = 0
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
    this.compaction = opts.compaction ?? null
    this.createdAt = opts.createdAt ?? new Date().toISOString()
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    this.currentProviderId = opts.providerId ?? 'unknown'
    this.createClient = opts.createClient ?? createModelClient
    this.titleClient = opts.titleClient
    this.titleModel = opts.titleModel
    this.imageClient = opts.imageClient
    this.imageModel = opts.imageModel
    this.readImageBase64 = opts.readImageBase64
    this.expandAttachments = opts.expandAttachments
    this.titleSettled = !!opts.titleAlreadySet
    // Initialise totalUsage from the conversation only if there is prior usage.
    // Conversation.totalUsage always returns a Usage object (never undefined), so
    // we leave totalUsage as undefined when the conversation is brand-new (all zeros).
    const usage = this.conversation.totalUsage
    if (usage.input_tokens > 0 || usage.output_tokens > 0) {
      this.totalUsage = usage
    }

    // Wire the Agent (sub-agent) tool here, not in createSession: it needs the LIVE model
    // client (failover hot-swaps this.client), the manager's permission flow, and the shared
    // sessionAllow — all private to the manager. getClient/getSystemPrompt are getters so a
    // failover-swapped client and the current prompt are always picked up at call time.
    // onBackground is intentionally omitted: a runInBackground sub-agent is awaited inline
    // (it still runs; it just isn't detached) until the server grows a message-injection seam.
    if (!this.registry.get('Agent')) {
      this.registry.register(createAgentTool({
        registry: this.registry,
        getClient: () => this.client,
        settings: this.settings,
        getSystemPrompt: () => this.systemPrompt,
        sessionAllow: this.sessionAllow,
        canUseTool: this.canUseTool,
      }))
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

  getConversation(): Conversation {
    return this.conversation
  }

  /** Feature B: current compaction state (summary + cut), or null. Persisted by SessionService. */
  getCompaction(): CompactionMeta | null {
    return this.compaction
  }

  /**
   * The conversation to send to the LLM this turn (feature B). With no compaction it IS the full
   * ledger (unchanged behavior). With compaction it's a transient view
   * `[framed summary, ...ledger.slice(cutIndex)]`, rebuilt each turn. applyCompaction seeds the
   * view with the ledger's usage, so we re-seed it to zero: the turn's usage then lands only on
   * the view and submit() folds it back onto the ledger, which stays the authoritative tally.
   */
  private buildContextView(): Conversation {
    const c = this.compaction
    if (c === null) return this.conversation
    // Pass emptyUsage() into applyCompaction so it stamps the framed view directly — avoids the extra
    // deep-clone (framed.getMessages()) that previously existed only to reset totalUsage to zero.
    return applyCompaction(this.conversation, c.summaryText, c.cutIndex, emptyUsage())
  }

  getCheckpoints(): SessionCheckpoint[] {
    return [...this.checkpoints]
  }

  getCreatedAt(): string {
    return this.createdAt
  }

  getModelId(): string {
    return this.client.getModel()
  }

  /**
   * Kick off small-model title generation from the first user message text, ONCE
   * per session. Triggered by submit() the moment the message is sent — it runs in
   * parallel with the turn (no wait for the assistant reply) and, on success, emits
   * `title-changed` so connected clients update live. Fire-and-forget; never throws.
   *
   * Guarded by titleSettled (a title already exists — incl. restored sessions) and
   * titlePending (a call is in flight). A failed/empty generation leaves titleSettled
   * false so a later message can retry; deriveTitle remains the persisted fallback.
   */
  private kickTitleGeneration(text: string): void {
    if (this.titleSettled || this.titlePending) return
    if (!this.titleClient || !this.titleModel) return
    if (!text.trim()) return
    this.titlePending = true
    void (async () => {
      try {
        const title = await generateSessionTitle(this.titleClient!, this.titleModel!, text)
        if (title) {
          this.titleSettled = true
          this.emit({ type: 'title-changed', title })
        }
      } catch {
        // value-add only; never surface
      } finally {
        this.titlePending = false
      }
    })()
  }

  /** Test/seed hook: mark the title as already set so submit() won't auto-generate. */
  markTitleSettled(): void {
    this.titleSettled = true
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
    const out: SnapshotMessage[] = []
    this.conversation.getMessages().forEach(({ role, content, steer, attachments }, i) => {
      const parts: SnapshotPart[] = []
      for (const block of content) {
        if (block.type === 'text') {
          // Fix A: submit() prefixes the model's userText with `[YYYY-MM-DD HH:MM] `; that
          // prefix lives in the committed ledger, so restoring user messages from the snapshot
          // would surface it (the live path renders raw text). Strip exactly that one leading
          // pattern, and only from user text — never touch assistant text.
          // Strip submit()'s stamp prefix, then the parsed-fallback <uploaded-images> block (both
          // live in the ledger but must not surface in the displayed user text). User-only.
          const text = role === 'user' ? stripUploadedImages(stripUserStamp(block.text)) : block.text
          parts.push({ kind: 'text', text })
        } else if (block.type === 'tool_use') {
          parts.push({ kind: 'tool-use', id: block.id, name: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          let output = Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
            : String(block.content)
          // Strip any steer injection folded into this tool_result by EXACT text (from the message's
          // structural `steer` field, not by sniffing) so the scaffolding doesn't show in the card.
          for (const s of steer ?? []) output = output.split(steerFoldSuffix(s)).join('')
          parts.push({ kind: 'tool-result', id: block.tool_use_id, name: '', output, isError: block.is_error ?? false })
        }
        // Unknown block kinds are intentionally skipped.
      }
      // Fix B: a checkpoint anchors before a user turn, so its messageIndex == this user
      // message's ledger index. Attach the hash so the web can render a per-message revert.
      // Match by index regardless of role (only user turns will match by construction).
      const checkpointId = this.checkpoints.find((c) => c.messageIndex === i)?.hash
      // Carry the message's image attachments (route/description; no base64) so the client can render
      // an image thumbnail row. Structurally identical to protocol's MessageAttachment → assign directly.
      out.push({ role, parts, checkpointId, ledgerIndex: i, attachments })
      // Emit each folded steer as its own "↪ 插话" bubble after the carrier message. Driven by the
      // structural `steer` field — a message that merely CONTAINS the marker text (e.g. a Read of
      // steer.ts) has no such field and is left untouched.
      for (const s of steer ?? []) out.push({ role: 'user', parts: [{ kind: 'text', text: s }], steer: true })
    })
    return out
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
    const trimmed = text.trim()
    if (trimmed === '') return
    this.steerQueue.push({ text: trimmed, echoed: false })
  }

  /** Cheap liveness check — true while a turn is running. Lets callers avoid a full getState()
   *  projection just to read this flag (e.g. the ws steer/idle routing). */
  isBusy(): boolean {
    return this.isThinking
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
    // Feature B: compaction is now a separate field (not inside the ledger), so clearing the
    // conversation no longer erases it — a fresh session would otherwise inherit the old summary.
    this.compaction = null
    this.isThinking = false
    // Invalidate any in-flight turn's post-turn tail: its finally/drain run async AFTER this reset,
    // and would otherwise re-queue the discarded steer + re-emit the old todos onto the blank session.
    this.turnEpoch++

    this.emit({ type: 'todos-update', todos: [] })
  }

  /**
   * True when the last measured context usage crossed the compaction threshold and we're not in an
   * ineffective-compaction backoff. SYNC so callers can gate the await — a no-op turn then stays
   * fully synchronous up to `this.abort = controller`, preserving interrupt()'s ordering.
   */
  private overContextThreshold(): boolean {
    const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
    return (this.contextTokens ?? 0) > windowSize * COMPACTION_THRESHOLD && this.ineffectiveCompaction < 2
  }

  /** Run one auto-compaction, surfacing the result as a memory-notice; a failure is warned and
   *  swallowed (never blocks a turn). Callers gate with overContextThreshold() first. */
  private async maybeAutoCompact(signal?: AbortSignal): Promise<void> {
    try {
      this.emit({ type: 'memory-notice', text: await this.compact(signal) })
    } catch (err) {
      if (signal?.aborted) return   // user Stop mid-compaction — the turn already emits 'aborted'; no scary warning
      this.emit({ type: 'warning', message: `auto-compaction failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /**
   * Manual compaction (web `/compact`). Unlike the auto path this ignores the context threshold —
   * the user asked for it. Locks the composer for the duration (turn-start/turn-end, so a concurrent
   * submit is rejected) and is Stop-interruptible (its AbortController is this.abort while running).
   * Result surfaces as a memory-notice; a failure warns; an interrupt emits 'aborted'.
   */
  async compactNow(): Promise<void> {
    if (this.isThinking) { this.emit({ type: 'warning', message: '回合进行中,无法手动压缩' }); return }
    this.isThinking = true
    this.emit({ type: 'turn-start', isResend: false })
    const controller = new AbortController()
    this.abort = controller
    try {
      this.emit({ type: 'memory-notice', text: await this.compact(controller.signal) })
    } catch (err) {
      if (controller.signal.aborted) this.emit({ type: 'aborted' })
      else this.emit({ type: 'warning', message: `压缩失败: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      this.isThinking = false
      this.abort = null
      this.emit({ type: 'turn-end' })
    }
  }

  /**
   * Failover core, shared by submit()'s post-turn resend and compact()'s summarize retry: mark the
   * current model bad for `cat`, pick the next available model in the same provider, and hot-swap
   * this.client to it. Returns {fromModel, toModel, reason} on success, or null when there is no
   * target (dialog failover mode, or every model already bad). Does NOT emit — the caller emits
   * 'failover' / 'model-select-needed' as appropriate.
   */
  private failoverToNext(cat: ErrorCategory): { fromModel: string; toModel: string; reason: string } | null {
    const pid = this.currentProviderId
    const fromModel = this.client.getModel()
    const models = modelNames(this.settings.providers[pid])
    // Mark bad: auth invalidates the whole provider (shared key); others only this model.
    for (const k of badKeysForFailure(pid, fromModel, cat, models)) {
      this.badModels.set(k, k === modelKey(pid, fromModel) ? cat : 'auth')
    }
    const action = decideFailover({
      category: cat,
      mode: resolveFailoverMode(this.settings),
      providerId: pid,
      models,
      currentModel: fromModel,
      bad: new Set(this.badModels.keys()),
    })
    if (action.kind !== 'retry') return null
    this.client = this.createClient(getProviderConfig(this.settings, pid), action.model)
    const reason = cat === 'auth' ? 'API key invalid' : cat === 'quota' ? 'quota exhausted' : 'model unavailable'
    return { fromModel, toModel: action.model, reason }
  }

  async compact(signal?: AbortSignal): Promise<string> {
    const prevCut = this.compaction?.cutIndex ?? 0
    const prevSummary = this.compaction?.summaryText
    // Find the cut on the current in-context view ([summary?, ...ledger.slice(prevCut)]), not on
    // the full ledger — we compact what the model actually sees.
    const viewMessages = this.buildContextView().getMessages()

    // Tail-budget protection scaled to the context window; falls back to a fixed
    // turn count when the budget path finds no cut.
    const windowSize = resolveContextWindow(this.settings, this.currentProviderId, this.client.getModel())
    const tailBudgetChars = Math.round(windowSize * COMPACTION_THRESHOLD * TAIL_BUDGET_RATIO * 4)
    const viewCut = findCompactionCutByBudget(viewMessages, tailBudgetChars) ?? findCompactionCut(viewMessages)
    if (viewCut === null) return 'History too short; nothing to compact.'

    // viewMessages[0] is the prior summary when already compacted (foldStart=1); the new turns to
    // fold are viewMessages[foldStart..viewCut). If that's empty there's nothing new to summarize —
    // bail BEFORE emitting compaction events or re-running the summary, so a no-op /compact doesn't
    // burn a model call, re-store the (possibly stale/fallback) summary, or misreport "已压缩".
    const foldStart = this.compaction !== null ? 1 : 0
    if (viewCut - foldStart <= 0) return '没有新内容需要压缩(距上次压缩以来没有足够的新消息)。'

    const keptCount = viewMessages.length - viewCut   // recent messages kept verbatim after the cut
    this.emit({ type: 'compaction-start', keep: keptCount })

    // TodoWrite state injected into the summary prompt so Pending Items survives.
    const todoIcons: Record<TodoItemLite['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }
    const todoState = this.todos.length > 0
      ? this.todos.map((t) => `${todoIcons[t.status]} ${t.content}`).join('\n')
      : undefined

    // Iterative summary: fold only the NEW turns since the last summary (viewMessages[foldStart..
    // viewCut); foldStart computed above). When a prior summary exists it occupies viewMessages[0].
    const toSummarize = viewMessages.slice(foldStart, viewCut)
    // Summarize WITH failover (B): on a quota/auth/unavailable error, swap to the next available
    // model (exactly what a turn does) and retry, instead of silently degrading. Only when no model
    // can serve it do we drop to the deterministic fallback — and flag it (A) below so the notice
    // isn't misreported as a clean success.
    let raw: string
    let usedFallback = false
    for (;;) {
      try {
        raw = await summarizeForCompaction(
          this.client,
          toSummarize,
          { model: this.client.getModel(), max_tokens: this.maxTokens },
          signal,
          prevSummary,
          todoState,
          { throwOnError: true },
        )
        break
      } catch (err) {
        if (signal?.aborted) throw err   // user Stop — let the caller surface 'aborted', don't degrade
        const cat = (err as { category?: ErrorCategory } | null)?.category
        const fo = cat && cat !== 'other' ? this.failoverToNext(cat) : null
        if (fo) {
          this.emit({ type: 'failover', fromModel: fo.fromModel, toModel: fo.toModel, reason: fo.reason })
          continue   // retry the summary on the newly-swapped model
        }
        // No model left / non-failover error. Feed the mechanical summary viewMessages[0..viewCut) —
        // i.e. INCLUDE the prior summary at viewMessages[0] (when foldStart=1). The model path carries
        // it via the prevSummary arg; the fallback has no such arg, so slicing from foldStart would
        // silently drop all earlier summarized context. slice(0, viewCut) == toSummarize when foldStart=0.
        raw = buildFallbackSummary(viewMessages.slice(0, viewCut), todoState)
        usedFallback = true
        break
      }
    }

    const { summary, candidates } = splitMemoryCandidates(raw)

    // Debounce: track savings; consecutive ineffective compactions disable auto-trigger.
    const savings = estimateCompactionSavings(viewMessages, viewCut, summary.length)
    if (savings.savingsRatio < 0.1) this.ineffectiveCompaction++
    else this.ineffectiveCompaction = 0

    // Translate the view-coordinate cut to a full-ledger index and store it as metadata — the
    // ledger is never folded. viewMessages[foldStart..] correspond to ledger[prevCut..].
    this.compaction = { summaryText: summary, cutIndex: prevCut + (viewCut - foldStart) }
    // Window usage is unknown post-compaction (next turn measures it); clear it so the
    // stale value cannot re-trigger auto-compaction.
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })
    // No checkpoint remap: the full ledger never folds, so checkpoint indices stay stable.

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

    const flushSuffix = flushed > 0 ? `;已存 ${flushed} 条记忆` : ''
    // 只报事实,不报误导的"节省百分比"——那个比例(estimateCompactionSavings)只反映被折叠旧历史
    // 自身的收缩,不是总上下文降幅(保留的近期消息 + 系统提示才是剩余大头)。真实降幅看上下文计量条。
    // Fold count excludes the prior summary at viewMessages[0] (foldStart=1 on 2nd+ compaction),
    // so it reports real old messages folded, not viewCut which counts that summary too.
    const foldedCount = viewCut - foldStart
    const msg = `上下文已压缩:折叠 ${foldedCount} 条旧消息为摘要,保留最近 ${keptCount} 条${flushSuffix}`
    this.emit({ type: 'compaction-done', summaryText: summary })
    // A: only degrade to the mechanical summary when no model could serve it — and say so, so the
    // "已压缩" notice above isn't mistaken for a clean, model-generated summary.
    if (usedFallback) {
      this.emit({ type: 'warning', message: '⚠ 摘要生成失败(所有可用模型均不可用),已用机械兜底摘要,质量较差;模型恢复后可重新 /compact。' })
    }
    return msg
  }

  /**
   * Parsed fallback (I2): describe ONE image via the auxiliary image client. Sends a single message
   * carrying the image block + IMAGE_PROMPT + the user's question, collects the streamed text
   * (throwing on an error event, mirroring title.ts's collect loop), and returns the trimmed
   * description. Callers guard on imageClient/readImageBase64 presence; the `!` asserts are safe there.
   */
  private async describeImage(
    data: string,
    mediaType: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const request: Message[] = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', mediaType, data } },
        { type: 'text', text: `${IMAGE_PROMPT}\n\n用户的问题：${question}` },
      ],
    }]
    let out = ''
    const events = this.imageClient!.sendMessages(
      request,
      { model: this.imageModel!, max_tokens: IMAGE_DESCRIPTION_MAX_TOKENS },
      undefined,
      signal,
    )
    for await (const e of events) {
      if (e.type === 'text-delta') out += e.text
      else if (e.type === 'error') throw new Error(e.message)
    }
    return out.trim()
  }

  /**
   * Run ONE user turn: drive runAgent and forward its stream as SessionEvents
   * (tool output forwarded RAW — no truncation/spill; that is the frontend's job),
   * then emit usage/context, and always emit turn-end in finally.
   */
  async submit(text: string, images?: UploadedImageRef[], opts?: { isResend?: boolean; echo?: boolean }): Promise<void> {
    // Reject EXTERNAL concurrent submits while a turn runs. An isResend call is a
    // RECURSIVE re-entry from inside submit (failover resend) and must be allowed.
    if (this.isThinking && !opts?.isResend) {
      throw new Error('A turn is already in progress')
    }
    this.isThinking = true
    const epoch = this.turnEpoch // if reset() bumps this mid-turn, the post-turn tail below bails
    if (!opts?.isResend) {
      this.todosBeforeTurn = this.todos    // ref snapshot to revert to if this turn is aborted
      this.cwdBeforeTurn = this.cwd        // likewise for the session cwd (a discarded turn's cd reverts)
    }
    this.emit({ type: 'turn-start', isResend: !!opts?.isResend })
    // A steer that raced past turn-end is delivered as a normal turn (ws layer), but the client took
    // the steer path and rendered no bubble — echo it so its transient "queued" preview resolves.
    if (opts?.echo) this.emit({ type: 'user-echo', text })

    // Publish the abort controller SYNCHRONOUSLY, before any await below, so the Stop button works
    // during the pre-send / background-compaction waits too (interrupt() checks this.abort).
    const controller = new AbortController()
    this.abort = controller

    // Title generation fires the moment a message is sent (not on turn-end): generate
    // from this text in parallel with the turn, so the sidebar title updates without
    // waiting for the assistant reply. Guarded to run once per session; resends skip.
    if (!opts?.isResend) this.kickTitleGeneration(text)

    // Auto-compaction: the PRIMARY trigger is post-response (awaited before turn-end — see below), so
    // the next turn usually starts already compacted. This PRE-send call is the FALLBACK for a last
    // turn that ended over-threshold without compacting (restored session's first turn, or after an
    // ineffective-compaction backoff reset). Signal-bound so Stop can cancel it. Resends skip.
    if (!opts?.isResend && this.overContextThreshold()) await this.maybeAutoCompact(controller.signal)
    // If the user hit Stop DURING that pre-send compaction, end the turn cleanly here instead of
    // falling into runAgent with an already-aborted signal (which would emit a 'warning', not
    // 'aborted', leaving the web's "正在压缩…" notice stuck). 'aborted' clears that notice.
    if (controller.signal.aborted) {
      this.isThinking = false
      this.abort = null
      this.emit({ type: 'aborted' })
      this.emit({ type: 'turn-end' })
      // A steer queued DURING that pre-send compaction must not linger in the queue — it would
      // otherwise fold into a later, unrelated turn (the exact bleed idle-drain prevents). Drain it
      // as its own follow-up turn, same as the post-turn path.
      if (!opts?.isResend) await this.drainSteerAsFollowUp()
      return
    }

    // Image routing (I2): split by whether the MAIN model is vision-capable.
    //  - vision → DIRECT: images ride the staged user message as attachments (route:'direct') and are
    //    expanded to native image blocks at send time by the injected expandAttachments hook; text is
    //    NOT baked.
    //  - non-vision → PARSED fallback: each image is described by the auxiliary imageClient and the
    //    descriptions are baked into the main model's user text; attachments record route:'parsed'.
    //    With no imageClient/readImageBase64 configured we cannot handle the image at all → error + bail.
    // No images → both stay undefined and the turn runs exactly as before (regression-safe).
    let effectiveText = text
    let userAttachments: MessageAttachment[] | undefined
    let expandFn: ((messages: Message[]) => Promise<Message[]>) | undefined
    if (images && images.length > 0) {
      const vision = resolveVision(this.settings, this.currentProviderId, this.client.getModel())
      if (vision) {
        userAttachments = images.map((i) => ({ id: i.id, name: i.name, mediaType: i.mediaType, route: 'direct' as const }))
        expandFn = this.expandAttachments
      } else if (!this.imageClient || !this.readImageBase64) {
        // Non-vision main model and no parse fallback wired → cannot handle the image. Refuse to send.
        this.emit({ type: 'error', message: '当前模型不支持图片，且未配置图片解析模型', category: 'other' })
        this.isThinking = false
        this.abort = null
        this.emit({ type: 'turn-end' })
        if (!opts?.isResend) await this.drainSteerAsFollowUp()
        return
      } else {
        // Describe each image via the auxiliary model. A single image's failure records an error
        // string as its description (not aborting the others); Stop cancels via the shared signal.
        const descriptions: string[] = []
        for (const im of images) {
          try {
            const { data, mediaType } = await this.readImageBase64(im.id)
            descriptions.push(await this.describeImage(data, mediaType, text, controller.signal))
          } catch {
            descriptions.push('(图片解析失败)')
          }
        }
        effectiveText =
          `${text}\n\n<uploaded-images>\n` +
          images.map((im, i) => `${i + 1}. ${im.name}：${descriptions[i]}`).join('\n') +
          '\n</uploaded-images>'
        userAttachments = images.map((i, idx) => ({
          id: i.id, name: i.name, mediaType: i.mediaType, route: 'parsed' as const, description: descriptions[idx],
        }))
        // No expandFn: route:'parsed' carries no base64 expansion — the description is already baked.
      }
    }

    // Build the LLM context view AFTER auto-compaction (which may have updated this.compaction).
    // With no compaction this returns the full ledger itself (unchanged behavior); otherwise a
    // transient [summary, ...tail] view whose new tail is folded back into the ledger after the
    // turn. viewPreLen marks the view's length before runAgent appends this turn's messages.
    const conversation = this.buildContextView()
    const viewPreLen = conversation.length

    // Runtime self-awareness: append the LIVE model + context window to the (cached) system prompt
    // so the model always knows its current runtime. Overrides stale knowledge from earlier in the
    // chat — e.g. after an automatic failover swapped the model, or if the window was misstated.
    // Stable between failovers, so the system block stays byte-identical turn-to-turn (cache-friendly)
    // and only changes when the model actually does. (Surface web/tui lives in this.systemPrompt.)
    const windowK = Math.round(this.ctxWindow() / 1000)
    const systemWithRuntime =
      `${this.systemPrompt}\n\n## Current runtime (authoritative)\n` +
      `Model: ${this.client.getModel()}\n` +
      `Context window: ~${windowK}k tokens.\n` +
      `Trust these over any model name or context-window size mentioned earlier in this conversation — ` +
      `earlier values can be stale (e.g. after an automatic model failover).`

    // Checkpoint (Phase 12): snapshot the workspace BEFORE the turn. fire-and-forget;
    // failure degrades to no checkpoint for this turn (D5). The hash is awaited at
    // turn end. Resends skip — the original send's snapshot is the correct anchor.
    // Index into the FULL ledger (never folded → stable), not the transient view.
    const checkpointIndex = this.conversation.length
    const trackAt = new Date().toISOString()
    const trackPromise: Promise<string | null> = opts?.isResend
      ? Promise.resolve(null)
      : this.snapshotStore.track().catch(() => null)

    let accumulated = ''
    let assistantStarted = false
    let lastInputTokens: number | undefined
    // Failover decision: the error branch only RECORDS the category here; the swap/
    // resend runs after the loop ends (never re-enter runAgent inside its own for-await).
    let failoverDecision: ErrorCategory | null = null
    // Set right before the recursive resend so the OUTER finally does not emit a second
    // turn-end (the nested submit already emitted one).
    let resent = false
    // Steers folded into THIS turn's tool_results (via consumeSteer). Tracked so that if the turn
    // is aborted (Stop) — which discards the whole staged turn, folded steer included — we can
    // re-queue them and let idle-drain re-deliver as a fresh turn (this.steerFoldEchoedThisTurn
    // then stops idle-drain from double-echoing what the fold already showed).
    const consumedThisTurn: string[] = []
    // True ONLY when this turn's staged messages were discarded — i.e. Stop landed mid-stream,
    // before the commit block below. A Stop that lands LATER (during post-response auto-compaction)
    // leaves this false, because by then runAgent already committed the turn to the ledger: its
    // todos and folded steer are real history and must NOT be rolled back or re-delivered. Captured
    // right after the runAgent loop, before signal.aborted can flip true during that compaction.
    let abortedMidTurn = false

    try {
      for await (const event of runAgent({
        conversation,
        client: this.client,
        registry: this.registry,
        userText: applyUserStamp(effectiveText),
        userAttachments,
        expandAttachments: expandFn,
        config: { model: this.client.getModel(), max_tokens: this.maxTokens, system: systemWithRuntime },
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
          const combined = this.steerQueue.map((s) => s.text).join('\n')
          this.steerQueue.length = 0
          consumedThisTurn.push(combined) // so an abort can re-queue it (staged is discarded)
          // Folded into a tool_result: echo it now (after the tool cards the client just received)
          // as a "↪ 插话" bubble. Server-driven so it lands at the real injection point, not
          // optimistically mid-stream where it would split the reply.
          this.emit({ type: 'user-echo', text: combined, steer: true })
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
      // Snapshot the abort state BEFORE the commit/compaction below: aborted here means the loop
      // ended on a mid-stream Stop and runAgent discarded the staged turn. A Stop that arrives
      // during the post-response compaction further down won't flip this, so the committed turn's
      // side effects survive (findings: todos rollback / duplicate steer re-delivery).
      abortedMidTurn = controller.signal.aborted

      this.contextTokens = lastInputTokens ?? this.contextTokens
      // Feature B: if we ran against a transient compacted view, fold the turn's new tail back into
      // the full ledger (never folded) and carry the turn's usage onto it. When there was no
      // compaction, `conversation` IS the ledger — runAgent already appended to it, so skip. The
      // view was seeded with zero usage, so its totalUsage equals exactly this turn's usage.
      if (conversation !== this.conversation) {
        // sliceMessages clones only the turn's new tail; getMessages().slice would deep-clone the
        // whole compacted view (summary + kept tail) every post-compaction turn just to drop it.
        for (const m of conversation.sliceMessages(viewPreLen)) this.conversation.append(m)
        this.conversation.addUsage(conversation.totalUsage)
      }
      this.totalUsage = this.conversation.totalUsage
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
      // the client and resend. Shares failoverToNext() with compaction's summarize retry.
      if (failoverDecision) {
        const cat = failoverDecision
        const fo = this.failoverToNext(cat)
        if (fo) {
          this.emit({ type: 'failover', fromModel: fo.fromModel, toModel: fo.toModel, reason: fo.reason })
          // The new model's window may be much smaller. The failed turn committed nothing
          // (history unchanged), so the prior input_tokens still estimate occupancy: if it
          // overflows the new window threshold, compact first so the resend keeps context.
          const newWindow = resolveContextWindow(this.settings, this.currentProviderId, fo.toModel)
          if (this.contextTokens && this.contextTokens > newWindow * COMPACTION_THRESHOLD) {
            await this.maybeAutoCompact()   // shares the emit/error contract with the pre-send & post-response triggers
          }
          // The resend's runAgent reads this.client.getModel() (the new model). Resend.
          this.abort = null
          resent = true
          await this.submit(text, undefined, { isResend: true })
        } else {
          // dialog mode / auth / no available next model: hand off to client model picker.
          const reasonText = cat === 'auth' ? 'API key invalid' : cat === 'quota' ? 'quota exhausted' : 'model unavailable'
          this.emit({ type: 'model-select-needed', reason: reasonText })
        }
      }

      // Auto-compaction PRIMARY trigger: this turn's usage is now measured, so compact in the
      // post-response window if we crossed the threshold. AWAITED here (still inside isThinking=true,
      // before the finally emits turn-end) so it holds mutual exclusion — revert()/retry()/compactNow
      // are all isThinking-guarded, so none can interleave and clobber this.compaction. The next send
      // then starts already compacted. Skip on a failover resend (nested submit ran its own turn) and
      // when the turn was aborted (Stop) — a just-aborted turn must not spawn a spurious "正在压缩…"
      // notice + failure warning. Signal-bound so a Stop during the summary round-trip cancels it.
      if (!resent && !controller.signal.aborted && this.overContextThreshold()) {
        await this.maybeAutoCompact(controller.signal)
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
      // Revert an aborted turn's side effects BEFORE turn-end: the autosave listener reads
      // getState().cwd synchronously on turn-end, so the revert must precede it or the discarded
      // turn's cwd is what gets persisted (a reload then opens the wrong dir). Gated on abortedMidTurn
      // (not signal.aborted): a Stop during post-response compaction aborts an ALREADY-COMMITTED turn,
      // whose todos/cwd are real history and must be kept. Skipped if reset() ran out from under this
      // turn (epoch changed) — its state is void, and re-emitting the old todos/cwd would fight reset.
      if (abortedMidTurn && this.turnEpoch === epoch) {
        if (this.todos !== this.todosBeforeTurn) {
          this.todos = this.todosBeforeTurn
          this.emit({ type: 'todos-update', todos: this.todos })
        }
        if (this.cwd !== this.cwdBeforeTurn) {
          this.cwd = this.cwdBeforeTurn
          this.emit({ type: 'cwd-change', cwd: this.cwd })
        }
      }
      // On a failover resend the nested submit already emitted turn-end; suppress the
      // outer one to avoid a double turn-end. isThinking/abort resets are idempotent.
      if (!resent) this.emit({ type: 'turn-end' })
    }

    // reset() ("new chat") ran mid-turn → this turn's transient tail targets state that's already
    // been thrown away; drop it so it can't resurrect the discarded steer or the old todos.
    if (this.turnEpoch !== epoch) return

    // 用例6: a steer folded into THIS turn's tool_result was discarded when the turn was aborted
    // (Stop). Re-queue those so the idle-drain below re-delivers them as a fresh turn — "stop what
    // you're doing and run my message". They were already echoed as "↪ 插话" bubbles, so they're
    // marked echoed=true and the drain re-delivers them without a second echo.
    if (abortedMidTurn && consumedThisTurn.length > 0) {
      this.steerQueue.unshift(...consumedThisTurn.map((text) => ({ text, echoed: true })))
    }

    // Idle-drain (Phase 2, cc-haha's model): consumeSteer drains the queue at tool-batch boundaries,
    // so a steer sent during a PURE-TEXT reply (no tool_result to fold into) is still queued at turn
    // end. Deliver it now as its OWN fresh turn — addressed right after this reply — instead of
    // letting it bleed into a later, unrelated turn's tool batch. Runs after the finally (isThinking
    // reset) so the recursive submit starts clean. Also covers the aborted-then-re-queued case above.
    // Skipped on a failover resend (the outer call drains).
    if (!opts?.isResend) await this.drainSteerAsFollowUp()
  }

  /**
   * Deliver any steer still queued at turn end as its OWN fresh follow-up turn, so a queued steer
   * never lingers to fold into a later, unrelated turn. Shared by the post-turn idle-drain and the
   * pre-send-compaction abort path (submit()). Delivery is merged (one follow-up turn), but the echo
   * is per-item: each not-yet-echoed steer opens a NORMAL user bubble, while steers already shown as
   * "↪ 插话" bubbles (folded then re-queued after a Stop) are re-delivered WITHOUT a second echo.
   * No-op when the queue is empty.
   *
   * NOTE: on the re-delivered (already-echoed) path submit() writes the steer to the ledger as an
   * ordinary user message, so a reload renders a plain bubble while the live view kept the earlier
   * "↪ 插话" fold bubble — a known live-vs-reload styling divergence, not a correctness issue.
   */
  private async drainSteerAsFollowUp(): Promise<void> {
    if (this.steerQueue.length === 0) return
    const items = this.steerQueue.splice(0)
    const unechoed = items.filter((s) => !s.echoed)
    if (unechoed.length > 0) this.emit({ type: 'user-echo', text: unechoed.map((s) => s.text).join('\n') })
    await this.submit(items.map((s) => s.text).join('\n'))
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
    // Reject a revert while a turn is streaming (mirrors submit()/retry()). The in-flight
    // runAgent loop holds a captured `conversation` ref and, at turn-end, pushes a checkpoint
    // and overwrites totalUsage/contextTokens from that ledger — so truncating state out from
    // under it here would resurrect the reverted turn and desync checkpoints/usage. retry()
    // already guards before it calls revert(), so this never blocks the retry path.
    if (this.isThinking) throw new Error('A turn is already in progress')
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
    // Feature B: if the revert truncated to before the compaction boundary, the stored summary/cut
    // no longer describe the (now-shorter) ledger — drop it so the next turn's view is the full
    // remaining ledger (which re-compacts if still too large).
    if (this.compaction && cp.messageIndex <= this.compaction.cutIndex) this.compaction = null
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined, contextWindow: this.ctxWindow() })
    // Notify clients a revert happened so they can re-sync (wsServer re-pushes a fresh
    // snapshot on this event). Emitted only on the success path — the unknown-id case
    // early-returned above without touching any state.
    this.emit({ type: 'reverted', checkpointId })
  }

  /**
   * Retry the last user turn (web "retry"): revert to that turn's checkpoint — rolling the
   * workspace back and dropping the turn from the ledger — then re-submit the same text from
   * the clean state. This is the safe semantics when the turn changed code: the next attempt
   * starts from the same point, not on top of half-applied edits. No-op when there is no user
   * turn or no checkpoint anchoring it; throws if a turn is already running (mirrors submit()).
   */
  async retry(): Promise<void> {
    if (this.isThinking) throw new Error('A turn is already in progress')
    // Use the LAST checkpoint — it anchors the most recent real user turn. Do NOT scan for the
    // last role:'user' message: tool_result blocks are committed as role:'user' too, so that
    // would land on a tool result (which has no checkpoint) and silently no-op.
    const cp = this.checkpoints[this.checkpoints.length - 1]
    if (!cp) return
    const userMsg = this.conversation.getMessages()[cp.messageIndex]
    if (!userMsg || userMsg.role !== 'user') return
    // Recover the original prompt: join text blocks, strip submit()'s `[YYYY-MM-DD HH:MM] ` prefix.
    const text = stripUserStamp(userMsg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    if (text.trim() === '') return
    await this.revert(cp.hash)   // rolls files back + truncates the ledger to before this turn
    // The revert snapshot dropped the question; submit re-adds it to the ledger but emits no
    // "user message" event, so clients wouldn't show it until a reconnect. Echo it now so the
    // re-submitted question reappears immediately (mirrors send()'s live optimistic add).
    this.emit({ type: 'user-echo', text })
    await this.submit(text)      // fresh attempt from the clean checkpoint
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
