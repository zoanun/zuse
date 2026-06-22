# F2 — Headless SessionManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transport-agnostic, headless `SessionManager` in `packages/server` that owns one agent session's full orchestration (turn loop, auto-compaction, failover, checkpoints, memory consolidation, steering, per-session permissions), emitting plain-JSON events for any transport to consume.

**Architecture:** Port `packages/tui/src/hooks/useConversation.ts` orchestration into a framework-agnostic class. React `setState/notify` → event emission; React `ref`s → instance fields. The class wraps `runAgent` (core), reuses core's compaction/permission/memory primitives, and is fully independent of the TUI. Unit-tested with a scripted fake `ModelClient` — no HTTP/WS needed.

**Tech Stack:** TypeScript (ESM, Node ≥22), vitest, `@zuse/core` primitives, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-06-22-F2-session-manager-design.md`
**Roadmap:** `docs/superpowers/specs/2026-06-22-web-ui-roadmap.md`

**Prerequisite note:** Tasks 1–2 are the F0 (relocate pure module) and minimal-F1 (scaffold `packages/server`) prerequisites that F2 cannot build without. The *full* F1 (WS endpoint, auth, daemon) remains a separate later plan — F2 is transport-agnostic and needs none of it to be built or tested.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/failoverCore.ts` (moved from tui) | Pure failover decision logic, now shareable |
| `packages/core/src/failoverCore.test.ts` (moved) | Its tests |
| `packages/server/package.json` | New package manifest |
| `packages/server/tsconfig.json` | TS config |
| `packages/server/src/index.ts` | Package barrel export |
| `packages/server/src/session/events.ts` | `SessionEvent` union + `SessionSnapshot` types |
| `packages/server/src/session/SessionManager.ts` | The orchestration class |
| `packages/server/src/session/SessionManager.test.ts` | Unit tests (fake client) |
| `packages/server/src/session/SessionRegistry.ts` | `Map<id, SessionManager>` router |
| `packages/server/src/session/SessionRegistry.test.ts` | Its tests |
| `packages/server/src/session/testFakes.ts` | Shared test fakes (fake client, fake snapshot store) |

---

## Task 1: F0 — Relocate `failoverCore` to core

**Files:**
- Create: `packages/core/src/failoverCore.ts` (moved content)
- Create: `packages/core/src/failoverCore.test.ts` (moved content)
- Modify: `packages/core/src/index.ts` (add export)
- Delete: `packages/tui/src/hooks/failoverCore.ts`, `packages/tui/src/hooks/failoverCore.test.ts`
- Modify: TUI files importing `failoverCore` (update import path)

- [ ] **Step 1: Inspect current module and its importers**

Run: `cat packages/tui/src/hooks/failoverCore.ts` and `grep -rn "failoverCore" packages/tui/src`
Expected: see the pure exports (`decideFailover`, `modelKey`, `badKeysForFailure`, `resolveFailoverMode`, `ErrorCategory`, etc.) and every import site.

- [ ] **Step 2: Move the files into core (verbatim content, no logic change)**

Run:
```bash
git mv packages/tui/src/hooks/failoverCore.ts packages/core/src/failoverCore.ts
git mv packages/tui/src/hooks/failoverCore.test.ts packages/core/src/failoverCore.test.ts
```
Adjust any relative imports inside the moved files (they import from `./types.js` etc.; in core the relative paths are the same package, so most `./` imports stay valid — verify each resolves).

- [ ] **Step 3: Export from core barrel**

In `packages/core/src/index.ts`, add:
```ts
export * from './failoverCore.js'
```

- [ ] **Step 4: Update TUI import sites**

In every TUI file found in Step 1 (e.g. `packages/tui/src/hooks/useConversation.ts`, `packages/tui/src/components/modelSelectItems.ts`), change the import from the local path to the package:
```ts
// before: import { decideFailover, ... } from './failoverCore.js'
// after:
import { decideFailover, modelKey, badKeysForFailure, resolveFailoverMode } from '@zuse/core'
import type { ErrorCategory } from '@zuse/core'
```

- [ ] **Step 5: Run the relocated tests + full suite**

Run: `pnpm -F @zuse/core test failoverCore` then `pnpm test`
Expected: relocated tests PASS in core; whole suite still green (TUI now imports from `@zuse/core`).

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(core): relocate failoverCore from tui to core (F0)

Pure failover decision logic moves to @zuse/core so the web backend can
share it without depending on the tui package. TUI import sites updated;
behavior unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Scaffold `packages/server` package

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/index.ts`
- Test: `packages/server/src/smoke.test.ts`

- [ ] **Step 1: Write a smoke test that imports the package barrel**

`packages/server/src/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SERVER_PACKAGE } from './index.js'

describe('@zuse/server', () => {
  it('package barrel loads', () => {
    expect(SERVER_PACKAGE).toBe('@zuse/server')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @zuse/server test` (will fail: package not yet defined)
Expected: FAIL — cannot resolve `@zuse/server` / missing files.

- [ ] **Step 3: Create the package manifest**

`packages/server/package.json` (mirror `packages/core/package.json` conventions):
```json
{
  "name": "@zuse/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@zuse/core": "workspace:*",
    "@zuse/tools": "workspace:*"
  }
}
```

- [ ] **Step 4: Create tsconfig**

`packages/server/tsconfig.json` — copy `packages/tui/tsconfig.json` and drop React/JSX-specific options (this is a Node library, no JSX). Verify it extends the same root config the other packages do.

- [ ] **Step 5: Create the barrel**

`packages/server/src/index.ts`:
```ts
export const SERVER_PACKAGE = '@zuse/server'
```

- [ ] **Step 6: Install workspace deps + run the smoke test**

Run: `pnpm install` then `pnpm -F @zuse/server test`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm -F @zuse/server typecheck`
```bash
git add -A
git commit -m "chore(server): scaffold @zuse/server package (minimal F1)

Package skeleton to host the headless SessionManager. WS/auth/daemon
remain a later F1 plan; this is only the build+test shell.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `SessionEvent` types + shared test fakes

**Files:**
- Create: `packages/server/src/session/events.ts`
- Create: `packages/server/src/session/testFakes.ts`
- Test: `packages/server/src/session/events.test.ts`

- [ ] **Step 1: Write the failing test (events are plain JSON-able)**

`packages/server/src/session/events.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { SessionEvent } from './events.js'

describe('SessionEvent', () => {
  it('events serialize to JSON without loss (no functions/class instances)', () => {
    const e: SessionEvent = { type: 'text-delta', text: 'hi' }
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })
  it('permission-request carries id and request', () => {
    const e: SessionEvent = {
      type: 'permission-request',
      id: 'p1',
      req: { toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' },
    }
    expect(JSON.parse(JSON.stringify(e))).toEqual(e)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test events`
Expected: FAIL — `events.js` missing.

- [ ] **Step 3: Define the event union and snapshot types**

`packages/server/src/session/events.ts`:
```ts
import type { PermissionRequest, PermissionVerdict, Usage } from '@zuse/core'

/** Everything SessionManager can emit. All members are plain JSON-able objects. */
export type SessionEvent =
  // passthrough from runAgent (raw output, no UI shaping)
  | { type: 'message-start'; id: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; output: string; is_error?: boolean }
  | { type: 'message-stop'; usage: Usage }
  // turn lifecycle
  | { type: 'turn-start'; isResend: boolean }
  | { type: 'turn-end' }
  // usage / context
  | { type: 'usage-update'; totalUsage: Usage | undefined }
  | { type: 'context-update'; contextTokens: number | undefined }
  // permissions
  | { type: 'permission-request'; id: string; req: PermissionRequest }
  | { type: 'permission-resolved'; id: string; verdict: PermissionVerdict }
  // compaction
  | { type: 'compaction-start' }
  | { type: 'compaction-done'; summaryText: string }
  // failover
  | { type: 'failover'; fromModel: string; toModel: string; reason: string }
  // checkpoints / memory
  | { type: 'checkpoint-recorded'; id: string; messageIndex: number; label: string }
  | { type: 'memory-notice'; text: string }
  // misc
  | { type: 'todos-update'; todos: TodoItemLite[] }
  | { type: 'cwd-change'; cwd: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; category?: string }
  | { type: 'aborted' }
  | { type: 'model-select-needed'; reason: string }

export interface TodoItemLite {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface PendingPermissionLite {
  id: string
  req: PermissionRequest
}

/** Full snapshot for late-joining / reconnecting clients. */
export interface SessionSnapshot {
  sessionId: string
  isThinking: boolean
  model: string
  cwd: string
  totalUsage: Usage | undefined
  contextTokens: number | undefined
  todos: TodoItemLite[]
  pendingPermissions: PendingPermissionLite[]
  messageCount: number
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test events`
Expected: PASS.

- [ ] **Step 5: Add shared test fakes**

`packages/server/src/session/testFakes.ts`:
```ts
import type { ModelClient, Message, StreamEvent } from '@zuse/core'

/** Scripted ModelClient: each sendMessages call yields the next scripted event list.
 *  Mirrors the pattern in packages/core/src/agent.test.ts. */
export function fakeClient(
  scripts: StreamEvent[][],
  model = 'fake-model',
): { client: ModelClient; calls: Message[][] } {
  const calls: Message[][] = []
  let i = 0
  const client: ModelClient = {
    getModel: () => model,
    async *sendMessages(messages, _config, _tools) {
      calls.push(messages)
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
  return { client, calls }
}

/** No-op snapshot store: track() returns a fake hash; restore() is a no-op. */
export function fakeSnapshotStore(): { track: () => Promise<string>; restore: (h: string) => Promise<void> } {
  let n = 0
  return {
    track: async () => `hash${++n}`,
    restore: async () => {},
  }
}
```

> NOTE: match `fakeSnapshotStore`'s shape to the real `SnapshotStore` interface — verify against `packages/tui` checkpoint usage during Step 5 and adjust method names to the actual interface.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): SessionEvent types + test fakes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `SessionManager` skeleton — constructor, subscribe, getState

**Files:**
- Create: `packages/server/src/session/SessionManager.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/server/src/session/SessionManager.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'

function makeSettings(): ResolvedSettings {
  // minimal settings stub; fill required fields per ResolvedSettings shape
  return { providers: {}, permissions: { defaultMode: 'default', allow: [], deny: [] } } as unknown as ResolvedSettings
}

function makeManager(scripts = [] as Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(scripts)
  const mgr = new SessionManager({
    sessionId: 's1',
    cwd: '/work',
    client,
    registry: new ToolRegistry(),
    settings: makeSettings(),
    systemPrompt: 'SYS',
    permissionPolicy: { mode: 'default', interactive: true, config: { defaultMode: 'default', allow: [], deny: [] } },
    snapshotStore: fakeSnapshotStore() as never,
  })
  return { mgr, calls }
}

describe('SessionManager skeleton', () => {
  it('getState returns initial snapshot', () => {
    const { mgr } = makeManager()
    const s = mgr.getState()
    expect(s.sessionId).toBe('s1')
    expect(s.isThinking).toBe(false)
    expect(s.model).toBe('fake-model')
    expect(s.cwd).toBe('/work')
    expect(s.messageCount).toBe(0)
    expect(s.pendingPermissions).toEqual([])
  })

  it('subscribe receives emitted events; unsubscribe stops them', () => {
    const { mgr } = makeManager()
    const seen: string[] = []
    const off = mgr.subscribe((e) => seen.push(e.type))
    // @ts-expect-error reach a test-only emit hook
    mgr._emitForTest({ type: 'warning', message: 'x' })
    off()
    // @ts-expect-error
    mgr._emitForTest({ type: 'warning', message: 'y' })
    expect(seen).toEqual(['warning'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL — `SessionManager.js` missing.

- [ ] **Step 3: Implement the skeleton**

`packages/server/src/session/SessionManager.ts`:
```ts
import {
  Conversation,
  ToolRegistry,
  type ModelClient,
  type ResolvedSettings,
  type PermissionMode,
  type PermissionsConfig,
  type PermissionRequest,
  type PermissionVerdict,
  type Usage,
} from '@zuse/core'
import type { SessionEvent, SessionSnapshot, TodoItemLite, PendingPermissionLite } from './events.js'

export interface PermissionPolicy {
  mode: PermissionMode
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
    this.totalUsage = this.conversation.totalUsage
  }

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) {
      try { l(e) } catch { /* a bad listener must not break orchestration */ }
    }
  }

  /** test-only hook used by unit tests to drive emit() */
  private _emitForTest(e: SessionEvent): void {
    this.emit(e)
  }

  setPermissionPolicy(p: PermissionPolicy): void {
    this.policy = p
  }

  getState(): SessionSnapshot {
    const pendingPermissions: PendingPermissionLite[] = [...this.pending.entries()].map(([id, p]) => ({ id, req: p.req }))
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
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS (both skeleton tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): SessionManager skeleton (state, subscribe, getState)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Permission flow (`canUseTool`, `resolvePermission`)

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `SessionManager.test.ts`:
```ts
describe('SessionManager permissions', () => {
  it('interactive: ask emits permission-request and resolves on resolvePermission', async () => {
    const { mgr } = makeManager()
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // @ts-expect-error reach private canUseTool for unit test
    const p = mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })
    const pendingId = mgr.getState().pendingPermissions[0]?.id
    expect(pendingId).toBeDefined()
    expect(events).toContain('permission-request')
    mgr.resolvePermission(pendingId!, 'allow')
    await expect(p).resolves.toBe('allow')
    expect(mgr.getState().pendingPermissions).toEqual([])
  })

  it('interactive: two concurrent asks resolve independently', async () => {
    const { mgr } = makeManager()
    // @ts-expect-error
    const p1 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'a' }, specifier: 'a', rule: 'Bash(a)', reason: 'ask' })
    // @ts-expect-error
    const p2 = mgr.canUseTool({ toolName: 'Bash', input: { command: 'b' }, specifier: 'b', rule: 'Bash(b)', reason: 'ask' })
    const ids = mgr.getState().pendingPermissions.map((x) => x.id)
    expect(ids.length).toBe(2)
    mgr.resolvePermission(ids[1], 'deny')
    mgr.resolvePermission(ids[0], 'allow')
    await expect(p1).resolves.toBe('allow')
    await expect(p2).resolves.toBe('deny')
  })

  it('non-interactive: ask is decided deterministically without emitting a request', async () => {
    const { mgr } = makeManager()
    mgr.setPermissionPolicy({
      mode: 'default',
      interactive: false,
      config: { defaultMode: 'default', allow: ['Bash(ls)'], deny: [] },
    })
    const events: string[] = []
    mgr.subscribe((e) => events.push(e.type))
    // allowed by allowlist
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'ls' }, specifier: 'ls', rule: 'Bash(ls)', reason: 'ask' })).resolves.toBe('allow')
    // not allowed → deny
    // @ts-expect-error
    await expect(mgr.canUseTool({ toolName: 'Bash', input: { command: 'rm' }, specifier: 'rm', rule: 'Bash(rm)', reason: 'ask' })).resolves.toBe('deny')
    expect(events).not.toContain('permission-request')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL — `canUseTool` / `resolvePermission` not defined.

- [ ] **Step 3: Implement the permission flow**

Add to `SessionManager` (import `matchesRule` from `@zuse/core`):
```ts
  resolvePermission(id: string, verdict: PermissionVerdict): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(verdict)
    this.emit({ type: 'permission-resolved', id, verdict })
  }

  /** Provided to runAgent. Only invoked for 'ask'-classified tool calls. Must be concurrency-safe. */
  private canUseTool = (req: PermissionRequest): Promise<PermissionVerdict> => {
    if (!this.policy.interactive) {
      // Non-interactive (cron/channel): decide deterministically, never block, never emit.
      const allowed = this.policy.config.allow.some((rule) =>
        matchesRule(rule, req.toolName, req.specifier, this.cwd),
      )
      return Promise.resolve(allowed ? 'allow' : 'deny')
    }
    // Interactive: register a pending request, emit it, await external resolution.
    const id = `perm-${++this.permSeq}`
    return new Promise<PermissionVerdict>((resolve) => {
      this.pending.set(id, { req, resolve })
      this.emit({ type: 'permission-request', id, req })
    })
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS (all permission tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): per-session permission flow (interactive + non-interactive)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Turn loop (`submit`) — runAgent passthrough + commit

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `SessionManager.test.ts`:
```ts
import type { StreamEvent } from '@zuse/core'

describe('SessionManager turn loop', () => {
  it('plain text turn emits turn-start, message-start, text-delta, message-stop, turn-end', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'hello' },
      { type: 'message-stop', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
    const { mgr } = makeManager([script])
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))
    await mgr.submit('hi')
    expect(types).toEqual([
      'turn-start', 'message-start', 'text-delta', 'message-stop',
      'usage-update', 'context-update', 'turn-end',
    ])
    expect(mgr.getState().isThinking).toBe(false)
  })

  it('tool-result is emitted with full raw output (no truncation)', async () => {
    const big = 'x'.repeat(5000)
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'tool-use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', id: 't1', output: big, is_error: false },
      { type: 'message-stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { mgr } = makeManager([script])
    let toolOut = ''
    mgr.subscribe((e) => { if (e.type === 'tool-result') toolOut = e.output })
    await mgr.submit('go')
    expect(toolOut.length).toBe(5000)
  })
})
```

> The exact `StreamEvent` member shapes (`tool-use`, `tool-result`) must match `packages/core/src/types.ts`. Verify field names (`id`/`name`/`input`, `output`/`is_error`) against the real union before writing implementation; adjust the passthrough mapping accordingly.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL — `submit` not defined.

- [ ] **Step 3: Implement `submit` turn loop (passthrough subset; compaction/failover added in later tasks)**

Add imports: `runAgent`, and to the class add:
```ts
  steer(text: string): void {
    if (text.trim() === '') return
    this.steerQueue.push(text.trim())
  }

  interrupt(): boolean {
    if (this.abort) { this.abort.abort(); return true }
    return false
  }

  async submit(text: string, _parts?: unknown, opts?: { isResend?: boolean }): Promise<void> {
    this.isThinking = true
    this.emit({ type: 'turn-start', isResend: !!opts?.isResend })

    // (Task 7 inserts auto-compaction here, before reading conversation.)

    const conversation = this.conversation
    const controller = new AbortController()
    this.abort = controller

    let accumulated = ''
    let assistantStarted = false
    let lastInputTokens: number | undefined

    try {
      for await (const event of runAgent({
        conversation,
        client: this.client,
        registry: this.registry,
        userText: `[${new Date().toISOString().slice(0, 16).replace('T', ' ')}] ${text}`,
        config: { model: this.client.getModel(), max_tokens: 16384, system: this.systemPrompt },
        cwd: this.cwd,
        signal: controller.signal,
        settings: this.settings,
        sessionAllow: [],
        onCwdChange: (next: string) => { this.cwd = next; this.emit({ type: 'cwd-change', cwd: next }) },
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
            this.emit({ type: 'tool-use', id: event.id, name: event.name, input: event.input })
            break
          case 'tool-result':
            this.emit({ type: 'tool-result', id: event.id, output: event.output, is_error: event.is_error })
            break
          case 'message-stop':
            lastInputTokens = event.usage.input_tokens + (event.usage.cache_read_input_tokens ?? 0)
            this.emit({ type: 'message-stop', usage: event.usage })
            break
          case 'warning':
            this.emit({ type: 'warning', message: event.message })
            break
          case 'error':
            if (controller.signal.aborted) this.emit({ type: 'aborted' })
            else this.emit({ type: 'error', message: event.message, category: event.category })
            break
        }
      }

      this.contextTokens = lastInputTokens ?? this.contextTokens
      this.totalUsage = conversation.totalUsage
      this.emit({ type: 'usage-update', totalUsage: this.totalUsage })
      this.emit({ type: 'context-update', contextTokens: this.contextTokens })
      void assistantStarted // (used by failover preStream check in Task 8)
    } catch (err) {
      if (controller.signal.aborted) this.emit({ type: 'aborted' })
      else this.emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' })
    } finally {
      this.isThinking = false
      this.abort = null
      this.emit({ type: 'turn-end' })
    }
  }
```

> Match each `event.*` field name and the `StreamEvent` `error.category` type to the verified core union. If `tool-result` uses a different field than `output`, map it here. The passthrough must not import or call any UI/truncation helper.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): SessionManager turn loop (runAgent passthrough)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Auto-compaction trigger + `compact()`

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `SessionManager.test.ts`:
```ts
describe('SessionManager auto-compaction', () => {
  it('compacts before a turn when contextTokens exceeds the window threshold', async () => {
    // Seed enough conversation history + a high contextTokens so the pre-turn check fires.
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'ok' },
      { type: 'message-stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { mgr } = makeManager([script])
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))
    // Drive contextTokens above threshold via a test seam, then submit.
    // @ts-expect-error test seam
    mgr._seedForCompactionTest({ contextTokens: 10_000_000 })
    await mgr.submit('next')
    // compaction-start/done should appear before turn body (best-effort: at least present)
    expect(types).toContain('compaction-start')
  })
})
```

> The compaction test needs a populated conversation longer than the cut point. Use a `_seedForCompactionTest` seam that sets `contextTokens` high AND appends ≥ a few user/assistant message pairs to `this.conversation` (use the real `Conversation` API to push messages) so `findCompactionCut` returns non-null. Verify the `Conversation` push API and the cut helpers' behavior during implementation; if a real summarize call is undesirable in a unit test, inject a fake summarizer or assert only that `compaction-start` is emitted and the conversation instance changed.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL.

- [ ] **Step 3: Implement `compact()` and the pre-turn trigger**

Port `compactConversation` (useConversation.ts:341–424) into a `compact()` method, replacing `setState/notify` with `emit`. Add imports from `@zuse/core`: `summarizeForCompaction`, `findCompactionCut`, `findCompactionCutByBudget`, `applyCompaction`, `extractPreviousSummary`, `splitMemoryCandidates`, `estimateCompactionSavings`, `remapCheckpoints`, `resolveContextWindow`, `COMPACTION_THRESHOLD`, `TAIL_BUDGET_RATIO`.

```ts
  async compact(): Promise<string> {
    const conv = this.conversation
    const messages = conv.getMessages()
    const windowSize = resolveContextWindow(this.settings, this.providerId(), this.client.getModel())
    const tailBudgetChars = Math.round(windowSize * COMPACTION_THRESHOLD * TAIL_BUDGET_RATIO * 4)
    const cut = findCompactionCutByBudget(messages, tailBudgetChars) ?? findCompactionCut(messages)
    if (cut === null) return 'History too short; nothing to compact.'

    this.emit({ type: 'compaction-start' })
    const before = conv.length
    const todoState = this.todos.length > 0
      ? this.todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'} ${t.content}`).join('\n')
      : undefined
    const previousSummary = extractPreviousSummary(messages)
    const raw = await summarizeForCompaction(
      this.client,
      messages.slice(0, cut),
      { model: this.client.getModel(), max_tokens: 16384 },
      undefined,
      previousSummary ?? undefined,
      todoState,
    )
    const { summary, candidates } = splitMemoryCandidates(raw)
    const savings = estimateCompactionSavings(messages, cut, summary.length)
    if (savings.savingsRatio < 0.1) this.ineffectiveCompaction++
    else this.ineffectiveCompaction = 0

    this.conversation = applyCompaction(conv, summary, cut)
    // checkpoints remap handled in Task 9 once checkpoints exist
    this.contextTokens = undefined
    this.emit({ type: 'context-update', contextTokens: undefined })
    // reload MEMORY.md into systemPrompt: re-run loadPromptSections (added when wiring prompt in F1/F3)
    void candidates // memory flush wired in Task 9
    const msg = `Compacted: ${before} → ${this.conversation.length} messages (${Math.round(savings.savingsRatio * 100)}% saved)`
    this.emit({ type: 'compaction-done', summaryText: summary })
    return msg
  }

  private providerId(): string {
    return this.currentProviderId
  }
```

Insert the pre-turn trigger at the top of `submit` (after `turn-start`, before reading `conversation`), porting useConversation.ts:508–531:
```ts
    if (!opts?.isResend) {
      const windowSize = resolveContextWindow(this.settings, this.providerId(), this.client.getModel())
      if ((this.contextTokens ?? 0) > windowSize * COMPACTION_THRESHOLD && this.ineffectiveCompaction < 2) {
        try { this.emit({ type: 'memory-notice', text: await this.compact() }) }
        catch (err) { this.emit({ type: 'warning', message: `auto-compaction failed: ${err instanceof Error ? err.message : String(err)}` }) }
      }
    }
```

Add the `_seedForCompactionTest` seam (test-only) and a real-`Conversation`-aware seeding, and consider injecting a fake summarizer for the unit test (constructor optional `summarize` override) to avoid a live model call.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): auto-compaction trigger + compact() port

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Failover

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `SessionManager.test.ts`:
```ts
describe('SessionManager failover', () => {
  it('preStream quota error swaps client and resends', async () => {
    // First call: pre-stream quota error. Second call (after swap): a normal turn.
    const errScript: StreamEvent[] = [{ type: 'error', message: 'quota exceeded', category: 'quota' }]
    const okScript: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'backup' },
      { type: 'text-delta', text: 'recovered' },
      { type: 'message-stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    // settings must define a provider with [primary, backup] models and failover mode 'auto'.
    const { mgr } = makeManagerWithFailover([errScript, okScript])
    const types: string[] = []
    mgr.subscribe((e) => types.push(e.type))
    await mgr.submit('hi')
    expect(types).toContain('failover')
    expect(types.filter((t) => t === 'turn-start').length).toBe(2) // original + resend
  })
})
```

> Add a `makeManagerWithFailover` helper that builds `settings` with `providers: { p: { models: ['primary','backup'], ... }, failoverMode 'auto' }` and starts the client on `'primary'`. Match `ResolvedSettings`/provider shape exactly to `packages/core/src/types.ts`. The fake client's `getModel()` should reflect the active model so failover targeting works — extend `fakeClient` to allow updating its reported model, or create the backup client via the real `createModelClient` path stubbed in settings.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL.

- [ ] **Step 3: Implement failover**

Port useConversation.ts:561–562, 717–728 (record `failoverDecision` on preStream quota/auth) and 784–840 (post-loop failover). Add `badModels: Map<string, ErrorCategory>` field. Import from `@zuse/core`: `decideFailover`, `modelKey`, `badKeysForFailure`, `resolveFailoverMode`, `createModelClient`, `getProviderConfig`, and the helper `modelNames`.

In the loop's `error` case, replace the simple emit with:
```ts
          case 'error': {
            if (controller.signal.aborted) { this.emit({ type: 'aborted' }); break }
            const cat = event.category ?? 'other'
            const preStream = accumulated === '' && !assistantStarted
            if (preStream && cat !== 'other') failoverDecision = cat as ErrorCategory
            else this.emit({ type: 'error', message: event.message, category: cat })
            break
          }
```

After the loop body (post usage/context emit), before `turn-end`, add the failover block (adapted from 784–840), replacing `notify`→`emit({type:'failover'|'warning'|'model-select-needed'})`, `setCurrentModel`→update internal model tracking, and the recursive `sendMessage(..., {isResend})`→`await this.submit(text, undefined, { isResend: true })`. Reuse the Task 7 window-check-before-resend logic.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): failover (mark bad → decide → swap → resend)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Checkpoints, autosave, memory consolidation, todos, switchModel

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Modify: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `SessionManager.test.ts`:
```ts
describe('SessionManager checkpoints + todos + model', () => {
  it('records a checkpoint after a turn and emits checkpoint-recorded', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'x' },
      { type: 'message-stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const { mgr } = makeManager([script])
    let recorded = 0
    mgr.subscribe((e) => { if (e.type === 'checkpoint-recorded') recorded++ })
    await mgr.submit('do work')
    expect(recorded).toBe(1)
  })

  it('switchModel changes the reported model in getState', () => {
    const { mgr } = makeManagerWithFailover([[]])
    mgr.switchModel('p', 'backup')
    expect(mgr.getState().model).toBe('backup')
  })

  it('revert restores files via the snapshot store and shrinks the conversation', async () => {
    const script: StreamEvent[] = [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: 'x' },
      { type: 'message-stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    // Build a manager whose snapshot store records restore() calls.
    const { client } = fakeClient(script.length ? [script] : [])
    const restoreCalls: string[] = []
    const store = { track: async () => 'hashA', restore: async (h: string) => { restoreCalls.push(h) } }
    const mgr = new SessionManager({
      sessionId: 'sR', cwd: '/w', client, registry: new ToolRegistry(),
      settings: makeSettings(), systemPrompt: 'S',
      permissionPolicy: { mode: 'default', interactive: true, config: { defaultMode: 'default', allow: [], deny: [] } },
      snapshotStore: store as never,
    })
    let cpId = ''
    mgr.subscribe((e) => { if (e.type === 'checkpoint-recorded') cpId = e.id })
    await mgr.submit('do work')
    const before = mgr.getState().messageCount
    await mgr.revert(cpId)
    expect(restoreCalls).toEqual(['hashA'])
    expect(mgr.getState().messageCount).toBeLessThanOrEqual(before)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Checkpoints: before the loop, capture `checkpointIndex = conversation.length`, `trackAt = new Date().toISOString()`, `trackPromise = opts?.isResend ? Promise.resolve(null) : this.snapshotStore.track().catch(() => null)`. After the loop, `const hash = await trackPromise; if (hash) { this.checkpoints.push({ messageIndex: checkpointIndex, hash, at: trackAt, label: text.slice(0,80) }); this.emit({ type:'checkpoint-recorded', id: hash, messageIndex: checkpointIndex, label }) }`. Wire `remapCheckpoints` into `compact()` (Task 7 left a placeholder).
- Autosave: after recording checkpoint, `void autosaveSession(this.sessionId, this.cwd, conversation, this.createdAt, this.checkpoints).catch(() => {})`. (Verify `autosaveSession` signature/location; if it lives in tui, treat persistence as S1 and instead emit a `turn-end` only — note this divergence.)
- Memory consolidation: `void this.maybeConsolidateMemories()` fire-and-forget after the turn; port useConversation.ts:431–484 replacing `notify`→`emit({type:'memory-notice'})`.
- Memory flush in `compact()`: wire the `candidates` loop (useConversation.ts:405–419) via `this.registry.get('Memory')`.
- Todos: register a todos sink. If the TodoWrite tool exposes an `onUpdate` registration like TUI, wire it in the constructor to set `this.todos` and `emit({type:'todos-update', todos})`.
- `switchModel(providerId, model)`: `this.client = createModelClient(getProviderConfig(this.settings, providerId), model); this.currentProviderId = providerId`. getState's `model` reflects it via `client.getModel()`.
- `revert(checkpointId)`: find the checkpoint by id in `this.checkpoints`; `await this.snapshotStore.restore(checkpoint.hash)` to roll back files; truncate `this.conversation` back to `checkpoint.messageIndex` (use the real Conversation truncate API — verify its name); drop checkpoints at/after that index; emit `context-update` with `undefined`. Mirrors TUI `revertToCheckpoint` (useConversation.ts:945).

> `autosaveSession` and the TodoWrite `onUpdate` hook currently live in the TUI layer. Verify whether they are importable from `@zuse/core`. If not, scope persistence + todo-sink wiring to a follow-up (S1 / F3) and in F2 emit the events from explicit setters (`setTodos`, exposed for the transport to call), noting the divergence in the spec's §12.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @zuse/server test SessionManager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): checkpoints, memory flush/consolidation, todos, switchModel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `SessionRegistry`

**Files:**
- Create: `packages/server/src/session/SessionRegistry.ts`
- Test: `packages/server/src/session/SessionRegistry.test.ts`
- Modify: `packages/server/src/index.ts` (export `SessionManager`, `SessionRegistry`, event types)

- [ ] **Step 1: Write the failing test**

`packages/server/src/session/SessionRegistry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SessionRegistry } from './SessionRegistry.js'
import { SessionManager } from './SessionManager.js'
import { fakeClient, fakeSnapshotStore } from './testFakes.js'
import { ToolRegistry } from '@zuse/core'
import type { ResolvedSettings } from '@zuse/core'

function mgr(id: string): SessionManager {
  const { client } = fakeClient([])
  return new SessionManager({
    sessionId: id, cwd: '/w', client, registry: new ToolRegistry(),
    settings: { providers: {}, permissions: { defaultMode: 'default', allow: [], deny: [] } } as unknown as ResolvedSettings,
    systemPrompt: 'S',
    permissionPolicy: { mode: 'default', interactive: true, config: { defaultMode: 'default', allow: [], deny: [] } },
    snapshotStore: fakeSnapshotStore() as never,
  })
}

describe('SessionRegistry', () => {
  it('create/get/remove', () => {
    const reg = new SessionRegistry()
    const m = mgr('s1')
    reg.set('s1', m)
    expect(reg.get('s1')).toBe(m)
    expect(reg.list()).toEqual(['s1'])
    reg.remove('s1')
    expect(reg.get('s1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @zuse/server test SessionRegistry`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/server/src/session/SessionRegistry.ts`:
```ts
import type { SessionManager } from './SessionManager.js'

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionManager>()
  set(id: string, mgr: SessionManager): void { this.sessions.set(id, mgr) }
  get(id: string): SessionManager | undefined { return this.sessions.get(id) }
  remove(id: string): void { this.sessions.delete(id) }
  list(): string[] { return [...this.sessions.keys()] }
}
```

Update `packages/server/src/index.ts`:
```ts
export const SERVER_PACKAGE = '@zuse/server'
export { SessionManager } from './session/SessionManager.js'
export type { SessionManagerOptions, PermissionPolicy } from './session/SessionManager.js'
export { SessionRegistry } from './session/SessionRegistry.js'
export type { SessionEvent, SessionSnapshot, TodoItemLite, PendingPermissionLite } from './session/events.js'
```

- [ ] **Step 4: Run to verify it passes + full suite + typecheck**

Run: `pnpm -F @zuse/server test` then `pnpm test` then `pnpm -r typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): SessionRegistry + package exports (F2 complete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes (gaps flagged for the implementer)

These are known points where the plan defers to verification-at-implementation rather than guessing field shapes from memory:

1. **`StreamEvent` member field names** (tool-use/tool-result/error.category) — verify against `packages/core/src/types.ts` before Tasks 6/8; adjust passthrough mapping.
2. **`SnapshotStore` interface** — `fakeSnapshotStore` must match the real method names; verify in Task 3/9.
3. **`autosaveSession` + TodoWrite `onUpdate`** — currently TUI-layer. If not importable from core, scope persistence/todo-sink to S1/F3 and expose explicit setters in F2 (Task 9 note). Record the divergence in spec §12.
4. **`ResolvedSettings` / provider shape** — the `makeSettings`/`makeManagerWithFailover` stubs must match the real type; fill required fields.
5. **Live summarize call in compaction test** — inject a fake summarizer via an optional constructor override to keep the unit test offline (Task 7).

Each must be resolved by reading the actual core source at implementation time (per project rule: assert file contents only from real reads, never memory).
