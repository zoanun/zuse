# Workflow Orchestration API (Phase 15.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createWorkflow()` API that returns `agent()`/`parallel()`/`pipeline()` functions for deterministic multi-agent orchestration with concurrency control.

**Architecture:** A single `workflow.ts` file in `packages/core` exports `createWorkflow(ctx)` which creates a scoped workflow with a shared Semaphore and agent counter. `agent()` wraps `runAgent()` (reusing the same sub-agent pattern from agent-tool.ts). `parallel()` runs thunks concurrently behind the semaphore. `pipeline()` chains stages per-item with no inter-item barrier.

**Tech Stack:** TypeScript, Vitest, existing `runAgent`/`Conversation`/`ToolRegistry` from `@zuse/core`

---

### Task 1: Semaphore + parallel()

**Files:**
- Create: `packages/core/src/workflow.ts`
- Create: `packages/core/src/workflow.test.ts`

- [ ] **Step 1: Write failing tests for Semaphore**

```typescript
// packages/core/src/workflow.test.ts
import { describe, it, expect } from 'vitest'
import { Semaphore } from './workflow.js'

describe('Semaphore', () => {
  it('allows up to N concurrent acquisitions', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0

    const task = async () => {
      const release = await sem.acquire()
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      release()
    }

    await Promise.all([task(), task(), task(), task()])
    expect(maxActive).toBe(2)
  })

  it('processes in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    const task = async (id: number) => {
      const release = await sem.acquire()
      order.push(id)
      release()
    }

    await Promise.all([task(1), task(2), task(3)])
    expect(order).toEqual([1, 2, 3])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd e:\ai-study\zuse && npx vitest run workflow`
Expected: FAIL — cannot resolve `./workflow.js`

- [ ] **Step 3: Implement Semaphore**

```typescript
// packages/core/src/workflow.ts

export class Semaphore {
  private available: number
  private queue: Array<() => void> = []

  constructor(concurrency: number) {
    this.available = Math.max(1, concurrency)
  }

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = () => {
        if (this.available > 0) {
          this.available--
          resolve(() => {
            this.available++
            const next = this.queue.shift()
            if (next) next()
          })
        } else {
          this.queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }
}
```

- [ ] **Step 4: Run Semaphore tests**

Run: `cd e:\ai-study\zuse && npx vitest run workflow`
Expected: PASS

- [ ] **Step 5: Write failing test for parallel()**

Add to `workflow.test.ts`:

```typescript
import { createWorkflow } from './workflow.js'
import { ToolRegistry } from './tool.js'
import type { ModelClient, StreamEvent, Usage, ResolvedSettings } from './types.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

function fakeClient(scripts: StreamEvent[][]): ModelClient {
  let i = 0
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      const script = scripts[i++] ?? []
      for (const e of script) yield e
    },
  }
}

const PERMISSIVE: ResolvedSettings = {
  tools: {},
  permissions: { defaultMode: 'bypassPermissions', allow: [], ask: [], deny: [] },
  providers: {},
}

function makeCtx(client: ModelClient) {
  return {
    registry: new ToolRegistry(),
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'test',
    signal: new AbortController().signal,
    cwd: '.',
    tracker: { markRead() {}, getFingerprint: () => undefined },
  }
}

describe('parallel', () => {
  it('runs thunks concurrently and returns all results', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.parallel([
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ])

    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('returns null for failed thunks without affecting others', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.parallel([
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('also ok'),
    ])

    expect(results).toEqual(['ok', null, 'also ok'])
  })

  it('respects concurrency limit', async () => {
    const wf = createWorkflow({ ...makeCtx(fakeClient([])), concurrency: 2 })

    let active = 0
    let maxActive = 0
    const task = async (id: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return id
    }

    await wf.parallel([() => task('a'), () => task('b'), () => task('c'), () => task('d')])
    expect(maxActive).toBe(2)
  })
})
```

- [ ] **Step 6: Implement createWorkflow with parallel()**

Add to `packages/core/src/workflow.ts`:

```typescript
import { cpus } from 'node:os'
import { Conversation } from './conversation.js'
import { ToolRegistry } from './tool.js'
import type { FileReadTracker } from './tool.js'
import { runAgent } from './agent.js'
import { createModelClient } from './model-client.js'
import type { ModelClient } from './model-client.js'
import { getProviderConfig } from './settings.js'
import type { ResolvedSettings, PermissionRequest, PermissionVerdict } from './types.js'

const DEFAULT_MAX_AGENTS = 100
const SUB_AGENT_MAX_TURNS = 10
const SUB_AGENT_SUFFIX = `\n\nYou are a sub-agent dispatched to execute a specific task. Your final text reply is the return value — it will be handed back to the caller, not shown to the user. Be concise and structured.`

export interface AgentOpts {
  label?: string
  allowedTools?: string[]
  model?: string
  maxTurns?: number
}

export interface WorkflowContext {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  signal: AbortSignal
  cwd: string
  tracker: FileReadTracker
  sessionAllow?: string[]
  canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>
  concurrency?: number
  maxAgents?: number
}

export function createWorkflow(ctx: WorkflowContext) {
  const concurrency = ctx.concurrency ?? Math.max(1, Math.min(8, cpus().length - 2))
  const sem = new Semaphore(concurrency)
  const maxAgents = ctx.maxAgents ?? DEFAULT_MAX_AGENTS
  let agentCount = 0

  async function agent(prompt: string, opts?: AgentOpts): Promise<string | null> {
    if (agentCount >= maxAgents) {
      throw new Error(`Workflow agent limit reached (${maxAgents})`)
    }
    agentCount++

    const release = await sem.acquire()
    try {
      let client: ModelClient
      if (typeof opts?.model === 'string' && opts.model !== '') {
        const slash = opts.model.indexOf('/')
        if (slash <= 0) return null
        const providerId = opts.model.slice(0, slash)
        const modelName = opts.model.slice(slash + 1)
        if (!modelName) return null
        try {
          const providerConfig = getProviderConfig(ctx.settings, providerId)
          client = createModelClient(providerConfig, modelName)
        } catch {
          return null
        }
      } else {
        client = ctx.getClient()
      }

      const childRegistry = new ToolRegistry()
      const whitelist = opts?.allowedTools
        ? new Set(opts.allowedTools.filter((t) => t !== 'Agent'))
        : null
      for (const tool of ctx.registry.list()) {
        if (tool.name === 'Agent') continue
        if (whitelist && !whitelist.has(tool.name)) continue
        childRegistry.register(tool)
      }

      const conversation = new Conversation()
      let finalText = ''
      for await (const event of runAgent({
        conversation,
        client,
        registry: childRegistry,
        userText: prompt,
        config: {
          model: client.getModel(),
          max_tokens: 16384,
          system: ctx.getSystemPrompt() + SUB_AGENT_SUFFIX,
        },
        cwd: ctx.cwd,
        signal: ctx.signal,
        maxTurns: opts?.maxTurns ?? SUB_AGENT_MAX_TURNS,
        tracker: ctx.tracker,
        settings: ctx.settings,
        sessionAllow: ctx.sessionAllow,
        canUseTool: ctx.canUseTool,
      })) {
        if (event.type === 'text-delta') {
          finalText += event.text
        }
      }

      return finalText || null
    } catch {
      return null
    } finally {
      release()
    }
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk()
        } catch {
          return null
        }
      }),
    )
  }

  async function pipeline<T>(
    items: T[],
    ...stages: Array<(input: any, originalItem: T, index: number) => Promise<any>>
  ): Promise<any[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let current: any = item
        for (const stage of stages) {
          try {
            current = await stage(current, item, index)
          } catch {
            return null
          }
        }
        return current
      }),
    )
  }

  return { agent, parallel, pipeline }
}
```

- [ ] **Step 7: Run all tests**

Run: `cd e:\ai-study\zuse && npx vitest run workflow`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/workflow.ts packages/core/src/workflow.test.ts
git commit -m "feat(core): Workflow API — Semaphore + parallel() + createWorkflow (Phase 15.2)"
```

---

### Task 2: pipeline() + agent() tests

**Files:**
- Modify: `packages/core/src/workflow.test.ts`

- [ ] **Step 1: Write pipeline tests**

```typescript
describe('pipeline', () => {
  it('chains stages per item', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.pipeline(
      [1, 2, 3],
      async (n) => n * 10,
      async (n) => `result:${n}`,
    )

    expect(results).toEqual(['result:10', 'result:20', 'result:30'])
  })

  it('passes originalItem and index to later stages', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))

    const results = await wf.pipeline(
      ['a', 'b'],
      async (item) => item.toUpperCase(),
      async (prev, orig, idx) => `${prev}-${orig}-${idx}`,
    )

    expect(results).toEqual(['A-a-0', 'B-b-1'])
  })

  it('skips remaining stages on error, returns null for that item', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    const stage2Calls: number[] = []

    const results = await wf.pipeline(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('fail')
        return n * 10
      },
      async (n, _orig, idx) => {
        stage2Calls.push(idx)
        return n + 1
      },
    )

    expect(results).toEqual([11, null, 31])
    expect(stage2Calls).toEqual([0, 2])
  })

  it('runs items concurrently (no inter-item barrier)', async () => {
    const wf = createWorkflow(makeCtx(fakeClient([])))
    const order: string[] = []

    let item2Stage1Resolve!: () => void
    const item2Stage1 = new Promise<void>((r) => { item2Stage1Resolve = r })

    const results = await wf.pipeline(
      ['fast', 'slow'],
      async (item) => {
        if (item === 'slow') await item2Stage1
        order.push(`s1:${item}`)
        return item
      },
      async (item) => {
        order.push(`s2:${item}`)
        if (item === 'fast') item2Stage1Resolve()
        return item
      },
    )

    expect(results).toEqual(['fast', 'slow'])
    expect(order.indexOf('s2:fast')).toBeLessThan(order.indexOf('s1:slow'))
  })
})
```

- [ ] **Step 2: Write agent() integration test**

```typescript
describe('agent', () => {
  it('runs a sub-agent and returns final text', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'hello from sub' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBe('hello from sub')
  })

  it('returns null when sub-agent produces no text', async () => {
    const client = fakeClient([
      [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBeNull()
  })

  it('returns null on error', async () => {
    const client = fakeClient([
      [{ type: 'error', message: 'boom' }],
    ])
    const wf = createWorkflow(makeCtx(client))

    const result = await wf.agent('do something')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Write maxAgents limit test**

```typescript
describe('maxAgents', () => {
  it('throws when agent limit is exceeded', async () => {
    const client = fakeClient(
      Array.from({ length: 5 }, () => [
        { type: 'text-delta' as const, text: 'ok' },
        { type: 'message-stop' as const, stop_reason: 'end_turn', usage: USAGE },
      ]),
    )
    const wf = createWorkflow({ ...makeCtx(client), maxAgents: 3 })

    const results = await wf.parallel([
      () => wf.agent('a'),
      () => wf.agent('b'),
      () => wf.agent('c'),
      () => wf.agent('d'),
      () => wf.agent('e'),
    ])

    const nonNull = results.filter(Boolean)
    expect(nonNull).toHaveLength(3)
    const nulls = results.filter((r) => r === null)
    expect(nulls).toHaveLength(2)
  })
})
```

- [ ] **Step 4: Run all tests**

Run: `cd e:\ai-study\zuse && npx vitest run workflow`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow.test.ts
git commit -m "test(core): Workflow API — pipeline, agent, maxAgents tests"
```

---

### Task 3: Export + roadmap

**Files:**
- Modify: `packages/core/src/index.ts` — add workflow export
- Modify: `docs/superpowers/plans/phase-roadmap.md` — mark 15.2 complete

- [ ] **Step 1: Add export to index.ts**

In `packages/core/src/index.ts`, add:

```typescript
export * from './workflow.js'
```

- [ ] **Step 2: Update roadmap**

In `docs/superpowers/plans/phase-roadmap.md`, after the 15.1 section, add:

```markdown
### ✅ 15.2 Workflow 编排 API（2026-06-17）

- `createWorkflow(ctx)` 工厂：返回 `agent()` / `parallel()` / `pipeline()`
- `Semaphore` 并发控制（FIFO 公平队列）
- `parallel()`: barrier 模式，单个失败返回 null
- `pipeline()`: 无 inter-item barrier，stage 链式执行，错误跳过后续 stage
- `agent()`: 包装 runAgent，隔离 Conversation + 工具集裁剪
- `maxAgents` 兜底（缺省 100）防失控循环
```

- [ ] **Step 3: Run full test suite + typecheck**

Run: `cd e:\ai-study\zuse && npx vitest run && pnpm typecheck`
Expected: ALL PASS, no type errors

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts docs/superpowers/plans/phase-roadmap.md
git commit -m "docs: Phase 15.2 Workflow API 完成,导出 + roadmap 更新"
```
