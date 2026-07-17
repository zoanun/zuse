# R2 — 会话能力上下文（SessionCapabilityContext）设计

> **状态**: 设计待用户确认 → writing-plans。
> **归属**: 可扩展性重构总纲（`2026-07-17-extensibility-refactor-roadmap.md`）第二块 R2。
> **依据**: 逐行读 `createSession.ts`、`SessionManager.ts`(:273-289 Agent 内联接线 / :502 canUseTool / :228 sessionAllow / :1282 setTodos)、`agent-tool.ts`(AgentToolDeps)、`todo.ts`(TodoWriteDeps)、`schedule-wakeup.ts`。

## 目标

把"需要会话内部状态"的工具从**逐个特例化**改为**从一个 `SessionCapabilityContext` + 一份能力工具清单统一注册**。让 SessionManager 不再认识任何具体工具的身份——它只提供能力面、跑清单。加一个会话级工具 = 往清单加一项（+ 若需新能力，往 ctx 加一个字段）。

**本轮范围（用户已定：只解耦）**：迁移 **Agent** 与 **TodoWrite**。**ScheduleWakeup 不接**，留给 C1（它需要"注入消息+触发回合"的能力，与 cron 同源，见非目标）。

## 非目标

- **不接 ScheduleWakeup**：不加定时器、不加消息注入能力。R2 建好的 `SessionCapabilityContext` 就是 C1 将来插入 `scheduleWakeup` 能力 + 往清单加 ScheduleWakeup 项的扩展点。
- **不加宽 createSession 的 `registerExtraTools(registry)` 缝**（见下"对总纲的修正"）。
- **不改任何工具的行为、不改 Agent/TodoWrite 的 Deps 接口**（@zuse/tools 的 `createAgentTool`/`createTodoWriteTool` 一字不动）。
- **不动 daemon 工具（MCP/LSP）的接线**。

## 对总纲的修正（如实记）

总纲 R2 节写"加宽 `registerExtraTools(registry)` → `registerExtraTools(registry, ctx)`"。读真码后修正:daemon 工具（MCP/LSP）在 `createSession` 里、**mgr 构造之前**注册，且**不需要会话状态**——现有薄缝对它们刚好够用；而会话级工具（Agent/TodoWrite）需要 `this`，本就该在 **SessionManager 内部**注册（Agent 已在那儿）。两类工具注册时机与依赖来源不同，故**不加宽那个缝**，而是在 SessionManager 内部建 `SessionCapabilityContext`。这更贴合真实结构，爆炸半径也更小（收在 SessionManager 一处 + createSession 减法）。

## 现状（实证）

- `SessionManager` 构造尾部（:279-288）**内联**给 Agent 造 deps：
  ```ts
  if (!this.registry.get('Agent')) {
    this.registry.register(createAgentTool({
      registry: this.registry, getClient: () => this.client, settings: this.settings,
      getSystemPrompt: () => this.systemPrompt, sessionAllow: this.sessionAllow, canUseTool: this.canUseTool,
    }))
  }
  ```
  这个 deps 对象**本质已是会话能力面**，只为单个工具写死。`if (!... get('Agent'))` 是防重复注册的守卫。
- `TodoWrite` 在 `createSession`（:113-114）用 `let mgr!` late-bind 注册：`createTodoWriteTool({ onUpdate: (todos) => mgr.setTodos(todos) })`。
- `setTodos`（SessionManager:1282）已是公有方法；`canUseTool`（:502）私有 arrow（已是稳定绑定引用）；`sessionAllow`（:228）私有数组。
- daemon 缝 `registerExtraTools?: (registry) => void`（createSession:52，:117 调用）——MCP/LSP 走它。

## 设计

### 1. 新文件 `packages/server/src/session/sessionCapabilities.ts`

```ts
import { createAgentTool, createTodoWriteTool, type TodoItem } from '@zuse/tools'
import type { Tool, ModelClient, ToolRegistry, ResolvedSettings, PermissionRequest, PermissionVerdict } from '@zuse/core'

/** 会话作用域能力面：会话级工具从它构造所需依赖。传输无关（无 WS/HTTP 概念）。 */
export interface SessionCapabilityContext {
  registry: ToolRegistry
  getClient: () => ModelClient        // live client（failover 热替换，调用时取）
  getSystemPrompt: () => string       // 当前 system prompt（调用时取）
  settings: ResolvedSettings
  sessionAllow: string[]              // 本会话累积的 allow_session 规则（共享引用）
  canUseTool: (req: PermissionRequest) => Promise<PermissionVerdict>
  setTodos: (todos: TodoItem[]) => void
}

/**
 * 会话级工具清单：每项把能力上下文映射成一个 Tool。
 * 加会话级工具 = 往这里加一项（并按需给 SessionCapabilityContext 加字段）。
 * 顺序即注册顺序。ScheduleWakeup 待 C1（需 ctx 加 scheduleWakeup 能力）。
 */
export const SESSION_CAPABILITY_TOOLS: Array<(ctx: SessionCapabilityContext) => Tool> = [
  (ctx) => createAgentTool({
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

### 2. SessionManager：用 ctx + 清单替换内联 Agent 注册（:279-288）

```ts
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
  if (!this.registry.get(tool.name)) this.registry.register(tool) // 保留去重守卫（泛化到每个能力工具）
}
```
- SessionManager 改为 `import { SESSION_CAPABILITY_TOOLS, type SessionCapabilityContext } from './sessionCapabilities.js'`，删掉对 `createAgentTool` 的 import。
- 去重守卫从"仅 Agent"泛化为"每个能力工具名已存在则跳过"——语义等价、更稳。

### 3. createSession：删 TodoWrite 特例 + late-bind

- 删 :113-114（`let mgr!` 声明与 `createTodoWriteTool` 注册）。
- `let mgr!: SessionManager` → 直接 `const mgr = new SessionManager({...})`（late-bind 只为 TodoWrite 而设，移走后不需要）。
- 删对 `createTodoWriteTool` 的 import。
- `registerExtraTools(registry)`（:117）**原样保留**（daemon MCP/LSP）。
- :120-122 的注释更新：Agent/TodoWrite 现经 SessionManager 的能力清单注册；ScheduleWakeup 仍留 C1。

## 行为一致性（含一处 cosmetic 变化，如实标）

- **注册的工具集不变**：Agent + TodoWrite + 默认 + daemon extra，一个不多一个不少。
- **接线不变**：TodoWrite.onUpdate 仍到 `setTodos`（原经 mgr late-bind，现经 ctx，同一目标）；Agent deps 逐字段一致。
- **一处 cosmetic 变化**：会话 registry 里工具的**排列顺序**会变——原先 TodoWrite 紧跟默认工具、在 daemon extra 之前；现在 Agent+TodoWrite 在 SessionManager 构造时注册，落在 daemon extra 之后。工具在 API 定义列表里的**顺序无语义**（模型按名字/描述选），故视为可接受的 cosmetic 变化。**验收断言按"工具集合 + 接线"而非精确顺序**；实现时确认无既有测试对会话工具顺序做快照断言（若有则一并处理）。

## 测试

- **sessionCapabilities 单测**：`SESSION_CAPABILITY_TOOLS` 用一个 fake ctx 跑，断言产出 `Agent` 与 `TodoWrite` 两个工具、名字正确；`createTodoWriteTool` 的 onUpdate 透传到 ctx.setTodos（调用工具触发 setTodos 收到 todos）。
- **SessionManager 单测**：构造一个 manager（注入 fake client），断言其 registry `get('Agent')` 与 `get('TodoWrite')` 均非空；TodoWrite 运行后 `setTodos` 被调用（可经既有 todo 事件路径断言）；去重守卫——用已含 Agent 的 registry 构造不抛。
- **createSession 单测/既有**:构造会话后工具集含 Agent+TodoWrite（与重构前集合一致）；`let mgr!` 移除后无回归。
- **门禁**:`@zuse/server` `tsc --noEmit` + `@zuse/tools` tsc；`pnpm exec vitest run packages/server`（346 基线）+ `packages/tools`（builtin-tools 10；skills 6 预存环境性失败豁免）。仅 server+tools 变更、无 web → **Playwright N/A**。

## 涉及文件

- 新增：`packages/server/src/session/sessionCapabilities.ts`（`SessionCapabilityContext` + `SESSION_CAPABILITY_TOOLS`）。
- 改：`packages/server/src/session/SessionManager.ts`（:279-288 换成 ctx+循环；import 调整）。
- 改：`packages/server/src/session/createSession.ts`（删 TodoWrite 注册 + late-bind；import 调整；注释更新）。
- 测试：`sessionCapabilities.test.ts`（新增）；`SessionManager.test.ts` / `createSession` 相关补断言。
