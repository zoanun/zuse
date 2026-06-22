import {
  Conversation,
  ToolRegistry,
  decide,
  type ModelClient,
  type ResolvedSettings,
  type PermissionsConfig,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
} from '@zuse/core'
import type { SessionEvent, SessionSnapshot, TodoItemLite, PendingPermissionLite } from './events.js'

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

  private cwd: string
  private currentProviderId = 'unknown'
  private abort: AbortController | null = null
  private readonly steerQueue: string[] = []
  private todos: TodoItemLite[] = []
  private contextTokens: number | undefined = undefined
  private ineffectiveCompaction = 0
  private totalUsage: Usage | undefined = undefined
  private isThinking = false
  private readonly pending = new Map<string, Pending>()
  private permSeq = 0

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
}
