# Zuse 可扩展性重构 总纲

> **日期**: 2026-07-17
> **性质**: 程序级分解文档（program decomposition），**不是**单个 spec。
> **作用**: 把"让 Zuse 高度可扩展"这件事拆成有序子 spec，锁住依赖、接口契约草案、推进顺序。每块各自 brainstorm→spec→plan→实现。
> **现状依据**: 逐行扫真源码（Explore agent，2026-07-17）+ LangChain 当前 agent middleware 文档（context7）。

---

## 1. 目标

- **加功能 = 写一个新文件 + 注册进去，不改别的文件。**
- **删功能 = 删一个文件（或删一行注册），别处不受影响。**
- **横切关注点（日志/遥测/护栏/自定义权限策略）= 写一个中间件注册进去，不改 agent 循环。**

灵感来自 LangChain 的 agent middleware/lifecycle（`before_agent / before_model / wrap_model_call / wrap_tool_call / after_model / after_agent`，`createMiddleware({...})` 定义、`middleware:[...]` 数组注册、洋葱式组合），但**不照搬全套**（见原则 4）。

## 2. 原则

1. **钩子加在 core，TUI 与 Web 都受益。** `runAgent` 在 `packages/core`，是两个前端的共同消费点。扩展机制落在 core 循环上，二者自动共享；不在某个前端里做。
2. **不统一 TUI/Web 大脑**（沿用 `web-ui-roadmap` §2 的解耦决策）。TUI 的 `useConversation` 与 Web 的 `SessionManager` 保持各自独立的编排状态机；本重构只动它们共同依赖的 core 原语与注册缝，不合并两套编排。
3. **向后兼容、渐进迁移，不大爆炸。** 现有 `RunAgentOptions` 回调、`registerExtraTools`、`createDefaultRegistry` 逐步迁移，每块可独立上线、独立回归。
4. **YAGNI —— Zuse 原生最小钩子集，不照搬 LangChain 全套。** Zuse 是单用户工具，扩展需求就那么几类。只做真实要用的钩子相位，不引入 `wrap_model_call` 洋葱那种为通用框架/海量第三方中间件设计的复杂度。
5. **可测、可审计。** 每块新机制配纯单测；注册表/钩子的注册与触发可观测。

## 3. 现状（4 个耦合痛点，file:line 实证）

1. **`runAgent`（`packages/core/src/agent.ts:155`）没有生命周期钩子总线。** 它是 async generator，对外只有固定的 `RunAgentOptions`（`agent.ts:80-133`）回调（`client`/`registry`/`canUseTool`/`onPersistAllow`/`onCwdChange`/`consumeSteer`/`expandAttachments`）+ yield 的 `StreamEvent`。唯一的 per-tool 钩子是 `canUseTool`（权限专用）。加任何横切关注点都要改 `RunAgentOptions` + 循环体 + 全部 3 个调用方。
2. **`registerExtraTools(registry)`（`createSession.ts:52`）太薄** —— 只递 registry。需要会话状态的工具（**Agent** `SessionManager.ts:279`、**TodoWrite** `createSession.ts:114`）被迫塞进 SessionManager 构造/createSession；**ScheduleWakeup 至今没接**（`createSession.ts:122` 注释确认，缺"往会话注入消息"的回调缝）。
3. **内置工具是中央清单** —— `createDefaultRegistry`（`packages/tools/src/index.ts:74-94`）硬编码 `register(...)`。加内置工具要改这个中央函数 + 顶部 import + 导出块。
4. **provider 是硬编码 switch** —— `createModelClient`（`model-client.ts:32-43`）`switch(provider.protocol)` over `'anthropic'|'openai'`；`ProviderProtocol` union（`types.ts:111`）。加协议要改 union + switch + 新 client 文件。

已有的可插拔件（重构要复用、不重造）：`ToolRegistry`（`tool.ts:127`，工具即纯对象）、`registerExtraTools` 缝、`SessionManager.subscribe/emit`（但只出站 UI 事件、改不了回合行为）、配置式 shell hooks（`preToolUse/postToolUse`，exec 式，硬接在 `gateAndRunTool`）。

## 4. 分解（4 块）

### R3 — 内置工具去中心化（自注册）｜痛点 3｜爆炸半径：小（tools 包）
- **目标**：`createDefaultRegistry` 的硬编码清单 → 每个工具模块**自声明**、一个索引**自动收集**。删一个工具文件 = 少一个工具；加一个工具文件 = 多一个工具，**不改中央函数**。
- **接口契约草案**：每个工具模块导出一个统一形状（如 `export const spec: ToolModule = { make(ctx) => Tool, enabledWhen?(settings) }`）；`collectBuiltinTools()` 用打包期静态汇总（显式 index 数组或构建期 glob，**不引运行时目录扫描**——保持确定性、可 tree-shake）。保留按 settings 启停的过滤。
- **依赖**：无（最先做）。
- **验收**：新增/删除一个内置工具只动它自己的文件 + 一行索引；现有工具集不变、单测绿；web build 不回归。

### R2 — 能力注册缝加宽｜痛点 2｜爆炸半径：中（server 为主）
- **目标**：`registerExtraTools(registry)` → `registerExtraTools(registry, capabilityCtx)`。`capabilityCtx` 提供会话作用域依赖：**live client getter**（failover 热替换）、`canUseTool`、`sessionAllow`、**消息注入回调**（解锁 ScheduleWakeup）、`setTodos` 等。把 Agent / TodoWrite / ScheduleWakeup 从 SessionManager 构造/createSession 特例里迁到这个缝上，变成插拔。
- **接口契约草案**：定义 `SessionCapabilityContext`（只读 getter + 回调，**不泄漏 WS/HTTP** —— 遵循 SessionManager 传输无关原则）；R3 的 `ToolModule.make(ctx)` 与它对齐（同一个能力上下文喂给内置与会话级工具）。
- **依赖**：R3（复用统一的工具模块形状 + 能力上下文入参）。
- **验收**：Agent/TodoWrite 迁到缝上、行为不变；**ScheduleWakeup 接上并能真正唤醒会话**；SessionManager 构造里不再特例化这些工具。

### R1 — 生命周期钩子总线｜痛点 1｜爆炸半径：大（core 循环，TUI+Web 都消费）
- **目标**：给 `runAgent` 装一圈**Zuse 原生最小钩子**，中间件写一个、注册进去、不改循环。
- **接口契约草案（最小集，按真实需求裁剪，不照搬 LangChain 6 钩子）**：
  - `onTurnStart / onTurnEnd`、`onModelCallStart / onModelCallEnd`、`onToolCallStart / onToolResult`、`onError`、`onStreamEvent`。
  - 中间件 = 一个对象实现若干可选钩子；`runAgent` 收 `middleware: Middleware[]`，**before 正序、after 逆序**触发；钩子是**观察/改写**语义，先支持观察 + 有限改写（如改 system prompt / 改 messages），**暂不做 `wrap_*` 洋葱**（YAGNI，日后需要再加）。
  - 现有 `canUseTool` / shell `preToolUse/postToolUse` 作为**内置中间件**收编，语义不变。
- **依赖**：R2（能力上下文稳定后再动循环，避免循环签名反复变）。
- **验收**：日志/遥测能以中间件形式注册、不改循环体；`canUseTool` 与 shell hooks 迁为内置中间件后 TUI+Web **双端回归全绿**（Playwright + TUI 单测）。

### R4 — provider 注册表｜痛点 4｜爆炸半径：小、独立
- **目标**：`createModelClient` 的 switch → provider 注册表；加协议 = 注册一个 factory，纯追加，不改 union+switch。
- **依赖**：无（独立，随时插空；建议最后）。
- **验收**：加一个 provider 协议只写新 client + 一行注册；anthropic/openai 行为不变。

## 5. 推进顺序（已定）

**R3 → R2 → R1 →（R4 可选，随时插空）**

理由：先做最便宜、最贴"删/加一个文件"、爆炸半径最小的 R3 拿手感（不碰 core 循环）；R2 解锁会话级工具 + 接上烂尾的 ScheduleWakeup；R1 是最值钱但最危险的脊椎（动 core、TUI+Web 都吃），放在工具线理顺、能力上下文稳定之后最稳；R4 独立。

```
R3(工具自注册) ── R2(能力缝加宽) ── R1(钩子总线)
                                   R4(provider 注册表)  ← 独立,任意时点
```

## 6. 非目标

- 不统一 TUI/Web 编排大脑（见原则 2）。
- 不照搬 LangChain 全套中间件（不做 `wrap_model_call` 洋葱、不引 contextSchema 那套；见原则 4）。
- 不引运行时目录扫描式插件加载（保持确定性、可 tree-shake、可审计）。
- 不做第三方/外部插件市场（单用户工具，YAGNI）。

## 7. 推进方式

1. 本总纲提交后，**逐块 brainstorm → 设计 spec → 实现计划 → 实现**。
2. 顺序 R3 → R2 → R1；R4 随时。
3. **首块详细设计：R3（内置工具自注册）** —— 最轻、无依赖、先跑通"删/加一个文件"的手感。
