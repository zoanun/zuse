# R2 会话能力上下文（SessionCapabilityContext）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent / TodoWrite 两个「需要会话内部状态」的工具，从 SessionManager 构造尾部与 createSession 的逐个特例，迁到统一的 `SessionCapabilityContext` + `SESSION_CAPABILITY_TOOLS` 清单，让 SessionManager 只提供能力面、跑清单，不再认识任何具体工具身份。

**Architecture:** 新增 `packages/server/src/session/sessionCapabilities.ts`，导出 `SessionCapabilityContext` 接口（会话作用域能力面，传输无关）与 `SESSION_CAPABILITY_TOOLS`（`Array<(ctx) => Tool>`，每项把能力面映射成一个 Tool）。SessionManager 构造时用私有字段拼出一个 ctx，循环清单注册（保留「名字已存在则跳过」的去重守卫）。createSession 删掉 TodoWrite 的 `let mgr!` late-bind 特例，改回 `const mgr`；daemon 的 `registerExtraTools(registry)` 缝原样不动。行为等价，唯一 cosmetic 变化是会话 registry 里工具的**排列顺序**（TodoWrite 从「默认之后、daemon extra 之前」挪到「daemon extra 之后」）——工具顺序无语义。

**Tech Stack:** TypeScript（纯 TS，无 React、无 WS/HTTP 泄漏）；`@zuse/tools`（`createAgentTool` / `createTodoWriteTool`）；`@zuse/core`（`Tool` / `ModelClient` / `ToolRegistry` / `ResolvedSettings` / `PermissionRequest` / `PermissionVerdict`）；vitest；pnpm。

**依据（逐行读真码，行号以实测为准）:**
- `SessionManager.ts:273-289` — Agent 内联注册块（含 `if (!this.registry.get('Agent'))` 守卫）。
- `SessionManager.ts:44` — `import { ..., createAgentTool } from '@zuse/tools'`。
- `SessionManager.ts:502` — `private canUseTool = (req: PermissionRequest): Promise<PermissionVerdict> => {...}`（稳定绑定 arrow）。
- `SessionManager.ts:194,1282` — `private todos: TodoItemLite[]`；`setTodos(todos: TodoItemLite[]): void`（公有）。
- `SessionManager.ts:79` — `private readonly sessionAllow: string[] = []`。
- `SessionManager.ts:99` — `this.systemPrompt`（可变，failover 后仍取当前值）。
- `createSession.ts:19` — `import { ..., createTodoWriteTool, ... } from '@zuse/tools'`。
- `createSession.ts:113-114` — `let mgr!: SessionManager` + `registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))`。
- `createSession.ts:117` — `opts.registerExtraTools?.(registry)`（daemon MCP/LSP 缝，保留）。
- `createSession.ts:120-122,145` — Agent/ScheduleWakeup 注释；`mgr = new SessionManager({...})`。
- `agent-tool.ts:11-19` — `AgentToolDeps { registry; getClient; settings; getSystemPrompt; sessionAllow?; canUseTool?; onBackground? }`。
- `todo.ts:10-14` — `TodoWriteDeps { onUpdate: (todos: TodoItem[]) => void }`；`TodoItem` 由 `@zuse/tools` 导出。

---

## File Structure

- **新增** `packages/server/src/session/sessionCapabilities.ts` — 唯一职责：定义会话作用域能力面 `SessionCapabilityContext` 和把它映射成会话级工具的清单 `SESSION_CAPABILITY_TOOLS`。传输无关（无 WS/HTTP 概念），可被 SessionManager 单向 import，无反向依赖。
- **新增** `packages/server/src/session/sessionCapabilities.test.ts` — 用 fake ctx 断言清单产出 Agent+TodoWrite 两个工具、名字正确、TodoWrite.onUpdate 透传到 ctx.setTodos。
- **改** `packages/server/src/session/SessionManager.ts` — 用 ctx+循环替换 :273-289 的内联 Agent 注册；import 去掉 `createAgentTool`、加 `SESSION_CAPABILITY_TOOLS`/`SessionCapabilityContext`。
- **改** `packages/server/src/session/createSession.ts` — 删 TodoWrite 注册 + `let mgr!` late-bind（改 `const mgr`）；import 去掉 `createTodoWriteTool`；更新 :120-122 注释。
- **回归** `packages/server/src/session/createSession.test.ts` — 已有「TodoWrite wired to setTodos」「Agent 端到端」「registerExtraTools 缝」三条测试，全程必须保持绿（等价性证明）。

---

## Task 1: sessionCapabilities.ts —— 能力面 + 工具清单

**Files:**
- Create: `packages/server/src/session/sessionCapabilities.ts`
- Test: `packages/server/src/session/sessionCapabilities.test.ts`

- [ ] **Step 1: Write the failing test**

写 `packages/server/src/session/sessionCapabilities.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { SESSION_CAPABILITY_TOOLS, type SessionCapabilityContext } from './sessionCapabilities.js'
import { ToolRegistry, type ModelClient, type ResolvedSettings } from '@zuse/core'
import type { TodoItem } from '@zuse/tools'

// 造一个只够让清单构造工具的 fake ctx —— 不触发真实模型/权限 I/O。
function fakeCtx(over: Partial<SessionCapabilityContext> = {}): SessionCapabilityContext {
  const captured: { todos?: TodoItem[] } = {}
  return {
    registry: new ToolRegistry(),
    getClient: () => ({}) as unknown as ModelClient,
    getSystemPrompt: () => 'sys',
    settings: {} as unknown as ResolvedSettings,
    sessionAllow: [],
    canUseTool: async () => ({ behavior: 'allow' }) as never,
    setTodos: (todos) => { captured.todos = todos },
    ...over,
    // 把 captured 暴露给断言用（测试内私有约定，不属正式接口）。
    ...(over as object),
  }
}

describe('SESSION_CAPABILITY_TOOLS —— 会话级工具清单', () => {
  it('产出 Agent 与 TodoWrite 两个工具，名字正确、顺序 Agent 在前', () => {
    const ctx = fakeCtx()
    const tools = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx))
    expect(tools.map((t) => t.name)).toEqual(['Agent', 'TodoWrite'])
  })

  it('TodoWrite.onUpdate 透传到 ctx.setTodos', async () => {
    let got: TodoItem[] | undefined
    const ctx = fakeCtx({ setTodos: (todos) => { got = todos } })
    const todoTool = SESSION_CAPABILITY_TOOLS
      .map((make) => make(ctx))
      .find((t) => t.name === 'TodoWrite')!
    await todoTool.run(
      { todos: [{ content: 'do x', status: 'pending' }] },
      {} as never,
    )
    expect(got).toEqual([{ content: 'do x', status: 'pending' }])
  })
})
```

> 说明：`todoTool.run` 的第二参是 `ToolContext`；TodoWrite 不使用它，传 `{} as never` 即可（实现里 onUpdate 只依赖 input.todos）。若运行时报第二参必填/类型不符，改传 `undefined as never`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/src/session/sessionCapabilities.test.ts`
Expected: FAIL —— `Cannot find module './sessionCapabilities.js'`（文件还没建）。

- [ ] **Step 3: Write the implementation**

写 `packages/server/src/session/sessionCapabilities.ts`：

```ts
import { createAgentTool, createTodoWriteTool, type TodoItem } from '@zuse/tools'
import type {
  Tool,
  ModelClient,
  ToolRegistry,
  ResolvedSettings,
  PermissionRequest,
  PermissionVerdict,
} from '@zuse/core'

/**
 * 会话作用域能力面：会话级工具从它构造所需依赖。传输无关（无 WS/HTTP 概念）。
 * getClient/getSystemPrompt 是取值函数：failover 热替换 client、prompt 变更后，
 * 调用时总取当前值。sessionAllow 为共享引用（本会话累积的 allow_session 规则）。
 */
export interface SessionCapabilityContext {
  registry: ToolRegistry
  getClient: () => ModelClient
  getSystemPrompt: () => string
  settings: ResolvedSettings
  sessionAllow: string[]
  canUseTool: (req: PermissionRequest) => Promise<PermissionVerdict>
  setTodos: (todos: TodoItem[]) => void
}

/**
 * 会话级工具清单：每项把能力上下文映射成一个 Tool。数组顺序即注册顺序。
 * 加会话级工具 = 往这里加一项（并按需给 SessionCapabilityContext 加字段）。
 * ScheduleWakeup 待 C1（需 ctx 加「注入消息+触发回合」的能力）。
 */
export const SESSION_CAPABILITY_TOOLS: Array<(ctx: SessionCapabilityContext) => Tool> = [
  (ctx) =>
    createAgentTool({
      registry: ctx.registry,
      getClient: ctx.getClient,
      settings: ctx.settings,
      getSystemPrompt: ctx.getSystemPrompt,
      sessionAllow: ctx.sessionAllow,
      canUseTool: ctx.canUseTool,
    }),
  (ctx) => createTodoWriteTool({ onUpdate: ctx.setTodos }),
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/server/src/session/sessionCapabilities.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: Typecheck the package**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 无错误退出。

> 注：server 包名是 `@zouyj/zuse-server`。若该 filter 报「No projects matched」，用 `pnpm --filter @zuse/server exec tsc --noEmit`，以真实退出输出为准。

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session/sessionCapabilities.ts packages/server/src/session/sessionCapabilities.test.ts
git commit -m "feat(session): SessionCapabilityContext + SESSION_CAPABILITY_TOOLS (R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SessionManager —— 用 ctx + 清单替换内联 Agent 注册

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts:44`（import）
- Modify: `packages/server/src/session/SessionManager.ts:273-289`（构造尾部）

- [ ] **Step 1: 先跑既有回归测试确认基线绿**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts packages/server/src/session/createSession.test.ts`
Expected: PASS（记下条数作基线；尤其 createSession 的「Agent 端到端」「TodoWrite wired to setTodos」两条）。

- [ ] **Step 2: 调整 import（去掉 createAgentTool，加清单/类型）**

把 `SessionManager.ts:44`：

```ts
import { openMemoryStore, renderMemoryMarkdown, applyMemoryConsolidation, cwdSlug, createAgentTool } from '@zuse/tools'
```

改为（删 `createAgentTool`）：

```ts
import { openMemoryStore, renderMemoryMarkdown, applyMemoryConsolidation, cwdSlug } from '@zuse/tools'
```

并在该 import 附近（`./events.js` import 之后，或紧接 `@zuse/tools` 行下）新增：

```ts
import { SESSION_CAPABILITY_TOOLS, type SessionCapabilityContext } from './sessionCapabilities.js'
```

- [ ] **Step 3: 替换构造尾部的内联 Agent 注册块**

把 `SessionManager.ts:273-288`（从注释 `// Wire the Agent (sub-agent) tool here...` 到 Agent 注册块结束的 `}`）整段：

```ts
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
```

替换为：

```ts
    // Register session-scoped tools (Agent, TodoWrite) from the capability list. These need the
    // manager's private state — the LIVE model client (failover hot-swaps this.client), the
    // permission flow, the shared sessionAllow, the todo sink — so they wire here, not in
    // createSession. getClient/getSystemPrompt are thunks so a failover-swapped client and the
    // current prompt are picked up at call time. The `registry.get(name)` guard keeps this
    // idempotent (a re-used registry already holding a tool isn't double-registered).
    const capabilityCtx: SessionCapabilityContext = {
      registry: this.registry,
      getClient: () => this.client,
      getSystemPrompt: () => this.systemPrompt,
      settings: this.settings,
      sessionAllow: this.sessionAllow,
      canUseTool: this.canUseTool,
      setTodos: (todos) => this.setTodos(todos),
    }
    for (const make of SESSION_CAPABILITY_TOOLS) {
      const tool = make(capabilityCtx)
      if (!this.registry.get(tool.name)) this.registry.register(tool)
    }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 无错误。（若报 `createAgentTool` 未使用/未定义，说明还有残留引用；grep `createAgentTool` 应只剩注释——见 Step 6。）

- [ ] **Step 5: 跑回归测试确认等价**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts packages/server/src/session/createSession.test.ts`
Expected: PASS，条数与 Step 1 基线一致。关键：createSession 的「Agent 端到端」仍绿（Agent 仍被注册）；「TodoWrite wired to setTodos」此刻可能仍走 createSession 的旧 late-bind（Task 3 才删），此步只验证 Agent 迁移不回归。

- [ ] **Step 6: 确认无 createAgentTool 残留引用**

Run: `git grep -n "createAgentTool" packages/server/src`
Expected: 无输出（或仅注释里提及）。若 SessionManager 仍有 import 残留，删掉。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/session/SessionManager.ts
git commit -m "refactor(session): SessionManager registers session tools via capability list (R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: createSession —— 删 TodoWrite 特例 + late-bind

**Files:**
- Modify: `packages/server/src/session/createSession.ts:17-24`（import）
- Modify: `packages/server/src/session/createSession.ts:112-122`（late-bind + TodoWrite + 注释）
- Modify: `packages/server/src/session/createSession.ts:145`（`mgr = ` → `const mgr =`）

- [ ] **Step 1: 去掉 createTodoWriteTool import**

把 `createSession.ts:17-24`：

```ts
import {
  createDefaultRegistry,
  createTodoWriteTool,
  getShellLabel,
  scanSkills,
  createSnapshotStore,
  cwdSlug,
} from '@zuse/tools'
```

改为（删 `createTodoWriteTool`）：

```ts
import {
  createDefaultRegistry,
  getShellLabel,
  scanSkills,
  createSnapshotStore,
  cwdSlug,
} from '@zuse/tools'
```

- [ ] **Step 2: 删 late-bind 声明与 TodoWrite 注册，更新注释**

把 `createSession.ts:112-122`：

```ts
  // late-bind：TodoWrite.onUpdate 要回调到下面才构造的 manager（镜像 TUI 的 ref 套路）。
  let mgr!: SessionManager
  registry.register(createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) }))
  // daemon-provided extra tools (B4 MCP server tools + B3 Lsp/LspInstall). Best-effort —
  // a bad registration must not break session construction.
  try { opts.registerExtraTools?.(registry) } catch (err) {
    console.warn(`[zuse-server] registerExtraTools 失败:${err instanceof Error ? err.message : String(err)}`)
  }
  // 注：Agent（子代理）工具由 SessionManager 构造时自行注册 —— 它需反向访问 manager 的
  // live client（failover 会热替换）/权限流/sessionAllow，放在 manager 内闭包最自然。
  // ScheduleWakeup（B2）仍未接 —— 它需要把唤醒消息注入会话的回调，建议并入 C1 cron 一起做。
```

替换为：

```ts
  // daemon-provided extra tools (B4 MCP server tools + B3 Lsp/LspInstall). Best-effort —
  // a bad registration must not break session construction.
  try { opts.registerExtraTools?.(registry) } catch (err) {
    console.warn(`[zuse-server] registerExtraTools 失败:${err instanceof Error ? err.message : String(err)}`)
  }
  // 注：会话级工具（Agent 子代理 + TodoWrite）由 SessionManager 构造时经能力清单
  // （SESSION_CAPABILITY_TOOLS）统一注册 —— 它们需反向访问 manager 的 live client（failover
  // 会热替换）/权限流/sessionAllow/todo 汇聚点，放在 manager 内构造最自然。
  // ScheduleWakeup（B2）仍未接 —— 它需要把唤醒消息注入会话的回调，建议并入 C1 cron 一起做。
```

- [ ] **Step 3: `let mgr!` → `const mgr`**

把 `createSession.ts:145`：

```ts
  mgr = new SessionManager({
```

改为：

```ts
  const mgr = new SessionManager({
```

（`let mgr!: SessionManager` 已在 Step 2 删除，此处直接声明常量。文件末 `return mgr` 不变。）

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 无错误。（若报 `mgr` 在赋值前使用/未声明，说明 Step 2 删 `let mgr!` 与 Step 3 改 `const mgr` 没配套；两处必须一起改。）

- [ ] **Step 5: 跑 createSession 回归测试**

Run: `pnpm exec vitest run packages/server/src/session/createSession.test.ts`
Expected: PASS，条数与 Task 2 Step 1 基线一致。关键三条全绿：
  - 「registers TodoWrite wired to setTodos (todos-update emitted)」—— TodoWrite 现经 SessionManager 能力清单注册，onUpdate 仍到同一个 `setTodos`，todos-update 事件照常发。
  - 「registers the Agent tool so a sub-agent runs end-to-end」—— Agent 照常。
  - 「calls registerExtraTools with the session registry」—— daemon 缝原样保留。

- [ ] **Step 6: 确认无 createTodoWriteTool 残留引用**

Run: `git grep -n "createTodoWriteTool" packages/server/src`
Expected: 无输出（sessionCapabilities.ts 用的是它，但那在 Task 1 已提交、且该 grep 限定 server/src 会包含它——所以预期输出只有 `sessionCapabilities.ts` 一行；createSession.ts 应无输出）。

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/session/createSession.ts
git commit -m "refactor(session): createSession drops TodoWrite late-bind (R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 全量门禁 + 收尾核对

**Files:** 无改动（验证任务）

- [ ] **Step 1: server 全量 typecheck**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 2: server 全量单测**

Run: `pnpm exec vitest run packages/server`
Expected: PASS。以真实输出的通过/失败计数为准（基线约 346；skills 类环境性预存失败若出现，按 CLAUDE.md 附输出后豁免，不得掩盖本次改动可能引入的失败）。

- [ ] **Step 3: tools 包未改，无需重跑；确认改动面**

Run: `git diff master --stat`
Expected: 仅 `packages/server/src/session/{sessionCapabilities.ts,sessionCapabilities.test.ts,SessionManager.ts,createSession.ts}` 四个文件（+ 本计划/spec 文档）。无 `packages/web` 改动 → **Playwright N/A**。

- [ ] **Step 4: 等价性人肉复核**

确认：注册的工具集合 = Read/Write/Edit/Glob/Grep/Bash/WebFetch/Memory(+条件 Skill/WebSearch/Lsp/LspInstall) + Agent + TodoWrite + daemon extra，一个不多一个不少；TodoWrite.onUpdate 仍到 `setTodos`；Agent deps 逐字段一致。唯一变化：会话 registry 里 Agent/TodoWrite 的排列位置移到 daemon extra 之后（cosmetic，工具顺序无语义）。确认无对「会话工具顺序」做快照断言的既有测试（Step 2 全绿即已证明）。

---

## Self-Review（写完计划后自查，已执行）

**1. Spec coverage：**
- spec「新文件 sessionCapabilities.ts（接口 + 清单）」→ Task 1 ✓
- spec「SessionManager 用 ctx+循环替换 :273-289，删 createAgentTool import，去重守卫泛化」→ Task 2 ✓
- spec「createSession 删 :113-114 + `let mgr!`→`const mgr`、删 createTodoWriteTool import、更新注释、registerExtraTools 保留」→ Task 3 ✓
- spec「ScheduleWakeup 不接，留 C1」→ 计划未接，注释与 spec 一致 ✓
- spec「测试：sessionCapabilities 单测 + SessionManager/createSession 回归 + 门禁」→ Task 1 单测、Task 2/3 回归、Task 4 门禁 ✓
- spec「cosmetic 顺序变化，按集合+接线断言」→ Task 4 Step 4 复核 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个改代码步骤都给了完整原文→改后全文；测试给了完整代码。✓

**3. Type consistency：** `SessionCapabilityContext` 字段（registry/getClient/getSystemPrompt/settings/sessionAllow/canUseTool/setTodos）在 Task 1 定义、Task 2 构造，逐字段一致；`SESSION_CAPABILITY_TOOLS` 名称在三处一致；`setTodos: (todos: TodoItem[]) => void` 与 `TodoWriteDeps.onUpdate` 及 `SessionManager.setTodos(TodoItemLite[])` 兼容（现存 late-bind 已如此调用，证明 TodoItem→TodoItemLite 可赋值）。✓
