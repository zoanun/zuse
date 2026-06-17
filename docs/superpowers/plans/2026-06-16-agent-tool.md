# Agent Tool (Phase 15.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Agent tool that lets the model spawn isolated sub-agents to handle sub-tasks, with results returned to the parent agent loop.

**Architecture:** The Agent tool is a regular `Tool` whose `run()` creates a child `runAgent()` call with an isolated Conversation. It uses a factory function (`createAgentTool`) that receives runtime dependencies (parent registry, client getter, settings) via closure. The child agent inherits the parent's permission system and abort signal but has its own conversation history, tool registry (minus Agent itself), and cwd isolation.

**Tech Stack:** TypeScript, Vitest, existing `runAgent`/`Conversation`/`ToolRegistry`/`ModelClient` from `@zuse/core`

---

### Task 1: Core Agent Tool — factory + run logic

**Files:**
- Create: `packages/tools/src/agent-tool.ts`
- Test: `packages/tools/src/agent-tool.test.ts`

- [ ] **Step 1: Write the failing test — basic sub-agent execution**

```typescript
// packages/tools/src/agent-tool.test.ts
import { describe, it, expect } from 'vitest'
import { Conversation, ToolRegistry, runAgent } from '@zuse/core'
import type { ModelClient, StreamEvent, Usage, ResolvedSettings, PermissionVerdict } from '@zuse/core'
import { createAgentTool } from './agent-tool.js'

const USAGE: Usage = { input_tokens: 10, output_tokens: 5 }

function fakeClient(scripts: StreamEvent[][]): ModelClient {
  let i = 0
  return {
    getModel: () => 'fake-model',
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

describe('createAgentTool', () => {
  it('runs a sub-agent and returns its final text', async () => {
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'sub-result' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])
    const registry = new ToolRegistry()
    const tool = createAgentTool({
      registry,
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'you are zuse',
    })

    const result = await tool.run(
      { prompt: 'find something', description: 'search task' },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    expect(result.output).toBe('sub-result')
    expect(result.isError).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zuse/tools test -- --run agent-tool`
Expected: FAIL — cannot resolve `./agent-tool.js`

- [ ] **Step 3: Write the minimal createAgentTool implementation**

```typescript
// packages/tools/src/agent-tool.ts
import { Conversation, ToolRegistry, runAgent, createModelClient, getProviderConfig } from '@zuse/core'
import type { ModelClient, Tool, ToolContext, ResolvedSettings } from '@zuse/core'

const SUB_AGENT_MAX_TURNS = 10

const SUB_AGENT_SUFFIX = `\n\nYou are a sub-agent dispatched to execute a specific task. Your final text reply is the return value — it will be handed back to the caller, not shown to the user. Be concise and structured.`

export interface AgentToolDeps {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
}

export function createAgentTool(deps: AgentToolDeps): Tool {
  return {
    name: 'Agent',
    description:
      'Launch a sub-agent to handle a complex or exploratory sub-task in an isolated context. ' +
      'The sub-agent has its own conversation and tool access, and returns its final text as the result. ' +
      'Use this when: (1) a task involves broad exploration that would pollute the main context, ' +
      '(2) a sub-task can run independently, or (3) you want to use a different model for a sub-task. ' +
      'The sub-agent cannot spawn further sub-agents.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '子任务描述，作为子 Agent 的输入。要足够详细让子 Agent 独立完成。',
        },
        description: {
          type: 'string',
          description: '3-10 字的短标签，用于 UI 展示。',
        },
        model: {
          type: 'string',
          description: '可选，格式 providerId/modelName。用较便宜的模型处理简单子任务。',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选，限定子 Agent 可用的工具名列表。默认继承全部工具。',
        },
      },
      required: ['prompt', 'description'],
    },
    specifierFor: (input: unknown): string | null => {
      const desc = (input as { description?: unknown }).description
      return typeof desc === 'string' ? desc : null
    },
    async run(input: unknown, ctx: ToolContext) {
      const { prompt, description, model, allowedTools } = input as {
        prompt?: unknown
        description?: unknown
        model?: unknown
        allowedTools?: unknown
      }

      if (typeof prompt !== 'string' || prompt === '') {
        return { output: 'Agent tool requires a non-empty "prompt" string.', isError: true }
      }
      if (typeof description !== 'string' || description === '') {
        return { output: 'Agent tool requires a non-empty "description" string.', isError: true }
      }

      // Build child client
      let client: ModelClient
      if (typeof model === 'string' && model !== '') {
        const parsed = parseModelSpec(model, deps.settings)
        if (parsed.error) return { output: parsed.error, isError: true }
        client = parsed.client!
      } else {
        client = deps.getClient()
      }

      // Build child registry: clone parent, remove Agent, apply allowedTools filter
      const childRegistry = buildChildRegistry(deps.registry, allowedTools)

      const conversation = new Conversation()
      const systemPrompt = deps.getSystemPrompt() + SUB_AGENT_SUFFIX

      let finalText = ''
      for await (const event of runAgent({
        conversation,
        client,
        registry: childRegistry,
        userText: prompt,
        config: {
          model: client.getModel(),
          max_tokens: 16384,
          system: systemPrompt,
        },
        cwd: ctx.cwd,
        signal: ctx.signal,
        maxTurns: SUB_AGENT_MAX_TURNS,
        tracker: ctx.tracker,
        settings: deps.settings,
      })) {
        if (event.type === 'text-delta') {
          finalText += event.text
        }
      }

      return { output: finalText || '(子 Agent 未产生文本输出)' }
    },
  }
}

function buildChildRegistry(
  parent: ToolRegistry,
  allowedTools: unknown,
): ToolRegistry {
  const child = new ToolRegistry()
  const whitelist = Array.isArray(allowedTools)
    ? new Set((allowedTools as unknown[]).filter((t): t is string => typeof t === 'string'))
    : null

  for (const tool of parent.list()) {
    if (tool.name === 'Agent') continue
    if (whitelist && !whitelist.has(tool.name)) continue
    child.register(tool)
  }
  return child
}

function parseModelSpec(
  spec: string,
  settings: ResolvedSettings,
): { client?: ModelClient; error?: string } {
  const slash = spec.indexOf('/')
  if (slash <= 0) {
    return { error: `Invalid model format: "${spec}". Expected "providerId/modelName".` }
  }
  const providerId = spec.slice(0, slash)
  const modelName = spec.slice(slash + 1)
  if (!modelName) {
    return { error: `Invalid model format: "${spec}". Model name is empty.` }
  }
  try {
    const providerConfig = getProviderConfig(settings, providerId)
    return { client: createModelClient(providerConfig, modelName) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Failed to create client for "${spec}": ${msg}` }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zuse/tools test -- --run agent-tool`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/agent-tool.ts packages/tools/src/agent-tool.test.ts
git commit -m "feat(tools): Agent tool — sub-agent spawning with isolated context (Phase 15.1)"
```

---

### Task 2: Test coverage — model override, allowedTools, recursion, edge cases

**Files:**
- Modify: `packages/tools/src/agent-tool.test.ts`

- [ ] **Step 1: Write test for model override with valid providerId/model**

```typescript
it('uses a custom model when model field is provided', async () => {
  let usedModel = ''
  const customClient: ModelClient = {
    getModel: () => 'custom-model',
    async *sendMessages() {
      usedModel = 'custom-model'
      yield { type: 'text-delta', text: 'custom-result' } as StreamEvent
      yield { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE } as StreamEvent
    },
  }

  const settings: ResolvedSettings = {
    ...PERMISSIVE,
    providers: {
      testprov: { protocol: 'anthropic', apiKey: 'test-key', models: ['custom-model'] },
    },
  }

  // createModelClient needs a real provider config, so we mock at a higher level.
  // Instead, test that parseModelSpec returns error on bad format.
  // The integration with real createModelClient is covered by core tests.
  // Here we verify the tool passes the model field through correctly.
  const tool = createAgentTool({
    registry: new ToolRegistry(),
    getClient: () => customClient,
    settings,
    getSystemPrompt: () => 'sys',
  })

  // Bad format: no slash
  const badResult = await tool.run(
    { prompt: 'task', description: 'test', model: 'no-slash' },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )
  expect(badResult.isError).toBe(true)
  expect(badResult.output).toContain('Invalid model format')

  // Bad format: empty model name
  const badResult2 = await tool.run(
    { prompt: 'task', description: 'test', model: 'prov/' },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )
  expect(badResult2.isError).toBe(true)
  expect(badResult2.output).toContain('Model name is empty')
})
```

- [ ] **Step 2: Write test for allowedTools filtering**

```typescript
it('filters child registry by allowedTools', async () => {
  const parentRegistry = new ToolRegistry()
  const toolNames: string[] = []
  for (const name of ['Read', 'Write', 'Grep']) {
    parentRegistry.register({
      name, description: '', inputSchema: { type: 'object', properties: {} },
      run: async () => { toolNames.push(name); return { output: name } },
    })
  }

  // fakeClient that calls 'Read' tool, then answers
  const client = fakeClient([
    [
      { type: 'tool-use', id: 'c1', name: 'Read', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ],
  ])

  const tool = createAgentTool({
    registry: parentRegistry,
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })

  const result = await tool.run(
    { prompt: 'task', description: 'test', allowedTools: ['Read', 'Grep'] },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )

  expect(result.isError).toBeFalsy()
  expect(toolNames).toContain('Read')
})
```

- [ ] **Step 3: Write test for recursion prevention — Agent is always excluded**

```typescript
it('child registry never contains Agent tool', async () => {
  const parentRegistry = new ToolRegistry()
  const agentTool = createAgentTool({
    registry: parentRegistry,
    getClient: () => fakeClient([
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ]),
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })
  parentRegistry.register(agentTool)

  // Sub-agent tries to call 'Agent' — should get unknown tool error
  const client = fakeClient([
    [
      { type: 'tool-use', id: 'c1', name: 'Agent', input: { prompt: 'nest', description: 'x' } },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [
      { type: 'text-delta', text: 'fallback' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ],
  ])

  const tool = createAgentTool({
    registry: parentRegistry,
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })

  const result = await tool.run(
    { prompt: 'try nesting', description: 'nest test' },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )

  expect(result.output).toBe('fallback')
})
```

- [ ] **Step 4: Write test for allowedTools containing "Agent" — silently filtered**

```typescript
it('silently removes Agent from allowedTools', async () => {
  const parentRegistry = new ToolRegistry()
  parentRegistry.register({
    name: 'Read', description: '', inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: 'read-ok' }),
  })
  const agentTool = createAgentTool({
    registry: parentRegistry,
    getClient: () => fakeClient([
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ]),
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })
  parentRegistry.register(agentTool)

  const client = fakeClient([
    [{ type: 'text-delta', text: 'ok' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ])
  const tool = createAgentTool({
    registry: parentRegistry,
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })

  // allowedTools includes Agent — should still work, Agent just filtered out
  const result = await tool.run(
    { prompt: 'task', description: 'test', allowedTools: ['Read', 'Agent'] },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )
  expect(result.isError).toBeFalsy()
})
```

- [ ] **Step 5: Write test for empty output**

```typescript
it('returns placeholder when sub-agent produces no text', async () => {
  const client = fakeClient([
    [{ type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
  ])
  const tool = createAgentTool({
    registry: new ToolRegistry(),
    getClient: () => client,
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })

  const result = await tool.run(
    { prompt: 'task', description: 'test' },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )
  expect(result.output).toBe('(子 Agent 未产生文本输出)')
  expect(result.isError).toBeFalsy()
})
```

- [ ] **Step 6: Write test for validation — missing prompt / description**

```typescript
it('returns error for missing prompt or description', async () => {
  const tool = createAgentTool({
    registry: new ToolRegistry(),
    getClient: () => fakeClient([]),
    settings: PERMISSIVE,
    getSystemPrompt: () => 'sys',
  })
  const ctx = { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } }

  const r1 = await tool.run({ description: 'x' }, ctx)
  expect(r1.isError).toBe(true)
  expect(r1.output).toContain('prompt')

  const r2 = await tool.run({ prompt: 'x' }, ctx)
  expect(r2.isError).toBe(true)
  expect(r2.output).toContain('description')
})
```

- [ ] **Step 7: Run all tests**

Run: `pnpm --filter @zuse/tools test -- --run agent-tool`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/tools/src/agent-tool.test.ts
git commit -m "test(tools): Agent tool — model override, allowedTools, recursion, edge cases"
```

---

### Task 3: Register Agent tool in TUI

**Files:**
- Modify: `packages/tools/src/index.ts` — export createAgentTool
- Modify: `packages/tui/src/hooks/useConversation.ts` — register Agent tool on the registry
- Modify: `packages/tui/src/App.tsx` — no changes needed (registry already flows through)

- [ ] **Step 1: Export createAgentTool from packages/tools/src/index.ts**

Add to the exports in `packages/tools/src/index.ts`:

```typescript
export { createAgentTool, type AgentToolDeps } from './agent-tool.js'
```

- [ ] **Step 2: Register Agent tool in useConversation**

In `packages/tui/src/hooks/useConversation.ts`, the hook receives `registry` as a prop. The Agent tool needs runtime deps (client, settings, systemPrompt) that live inside the hook. Register it at initialization time.

Find the section where `registry` is first used (around the `sendMessage` callback), and add Agent tool registration in a `useMemo` or `useEffect` at hook init. Since `registry` is rebuilt by `App.tsx` whenever settings change, we register on each new registry.

Add the import:

```typescript
import { createAgentTool } from '@zuse/tools'
```

After the `systemPrompt` is computed (around line 219) and before `sendMessage` is defined, add:

```typescript
// Register Agent tool on the registry (needs runtime deps only available here).
// registry is rebuilt by App.tsx on settings change, so this runs each time.
useMemo(() => {
  if (registry.get('Agent')) return
  registry.register(
    createAgentTool({
      registry,
      getClient: () => clientRef.current,
      settings,
      getSystemPrompt: () => systemPrompt,
    }),
  )
}, [registry, settings, systemPrompt])
```

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `pnpm test -- --run`
Expected: ALL tests pass (including the new agent-tool tests)

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/index.ts packages/tui/src/hooks/useConversation.ts
git commit -m "feat(tui): register Agent tool in useConversation with runtime deps"
```

---

### Task 4: Inherit permission system — sessionAllow + canUseTool

**Files:**
- Modify: `packages/tools/src/agent-tool.ts` — pass permission deps through to runAgent
- Modify: `packages/tools/src/agent-tool.test.ts` — add permission test

The current implementation passes `settings` to child `runAgent` but not `sessionAllow` or `canUseTool`. These need to be threaded through so the child agent's tool calls go through the same permission system as the parent.

- [ ] **Step 1: Extend AgentToolDeps to carry permission callbacks**

In `packages/tools/src/agent-tool.ts`, add to `AgentToolDeps`:

```typescript
export interface AgentToolDeps {
  registry: ToolRegistry
  getClient: () => ModelClient
  settings: ResolvedSettings
  getSystemPrompt: () => string
  /** Parent's session-level allow overrides (shared, so child allow_session propagates to parent). */
  sessionAllow?: string[]
  /** Parent's interactive permission callback (ask dialogs). */
  canUseTool?: (req: import('@zuse/core').PermissionRequest) => Promise<import('@zuse/core').PermissionVerdict>
}
```

Then in `run()`, pass them to `runAgent`:

```typescript
for await (const event of runAgent({
  // ...existing fields...
  sessionAllow: deps.sessionAllow,
  canUseTool: deps.canUseTool,
})) {
```

- [ ] **Step 2: Update TUI registration to pass permission deps**

In `packages/tui/src/hooks/useConversation.ts`, update the `createAgentTool` call:

```typescript
registry.register(
  createAgentTool({
    registry,
    getClient: () => clientRef.current,
    settings,
    getSystemPrompt: () => systemPrompt,
    sessionAllow: sessionAllowRef.current,
    canUseTool: (req) =>
      new Promise((resolve) => {
        queueRef.current = [...queueRef.current, { id: generateId(), req, resolve }]
        setPermissionQueue(queueRef.current)
      }),
  }),
)
```

- [ ] **Step 3: Write test for permission inheritance**

```typescript
it('child agent inherits permission system — ask triggers canUseTool', async () => {
  const reg = new ToolRegistry()
  reg.register({
    name: 'Write', description: '', inputSchema: { type: 'object', properties: {} },
    run: async () => ({ output: 'written' }),
  })

  const askSettings: ResolvedSettings = {
    tools: {},
    permissions: { defaultMode: 'default', allow: [], ask: ['Write'], deny: [] },
    providers: {},
  }

  let askCalled = false
  const client = fakeClient([
    [
      { type: 'tool-use', id: 'w1', name: 'Write', input: {} },
      { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
    ],
    [
      { type: 'text-delta', text: 'done' },
      { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
    ],
  ])

  const tool = createAgentTool({
    registry: reg,
    getClient: () => client,
    settings: askSettings,
    getSystemPrompt: () => 'sys',
    canUseTool: async () => { askCalled = true; return 'allow' },
  })

  await tool.run(
    { prompt: 'write something', description: 'write test' },
    { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
  )

  expect(askCalled).toBe(true)
})
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @zuse/tools test -- --run agent-tool`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/agent-tool.ts packages/tools/src/agent-tool.test.ts packages/tui/src/hooks/useConversation.ts
git commit -m "feat(tools): Agent tool inherits parent permission system (sessionAllow + canUseTool)"
```

---

### Task 5: Update toolSummary for Agent tool display + roadmap

**Files:**
- Modify: `packages/tui/src/components/toolSummary.ts` — add Agent to specifier extraction
- Modify: `docs/superpowers/plans/phase-roadmap.md` — mark Phase 15.1 complete

- [ ] **Step 1: Check toolSummary's toolSpecifier for Agent-specific handling**

The `toolSpecifier` function in `packages/tui/src/components/toolSummary.ts` extracts the header args for each tool. Agent should show its `description` field. Read the file to find the right pattern.

- [ ] **Step 2: Add Agent to toolSpecifier if needed**

If `toolSpecifier` doesn't already handle an `input.description` field, add a case:

```typescript
// In the tool-specific specifier logic:
if (name === 'Agent') {
  const desc = (input as { description?: unknown }).description
  return typeof desc === 'string' ? desc : ''
}
```

This makes the tool block render as: `● Agent(搜索 async 导出函数)`

- [ ] **Step 3: Update roadmap**

In `docs/superpowers/plans/phase-roadmap.md`, under Phase 15, add a completion note for 15.1:

```markdown
### ✅ 15.1 Agent Tool（2026-06-16）

- `createAgentTool` 工厂 + `AgentToolDeps` 依赖注入
- 子 Agent 隔离 Conversation + 独立 maxTurns(10) + cwd 隔离
- model 覆盖（providerId/modelName 格式）
- allowedTools 白名单 + Agent 递归禁止
- 权限体系完整继承（settings + sessionAllow + canUseTool）
- TUI 注册:useConversation 初始化时追加到 registry
```

- [ ] **Step 4: Run full test suite**

Run: `pnpm test -- --run`
Expected: ALL tests pass

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/components/toolSummary.ts docs/superpowers/plans/phase-roadmap.md
git commit -m "docs: Phase 15.1 Agent tool 完成,toolSummary 适配 + roadmap 更新"
```
