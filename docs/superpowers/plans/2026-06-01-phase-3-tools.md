# Phase 3 计划 · Tool 系统 + Agent Loop ⭐

> 核心阶段。第一次让模型能"动手"——调用工具读文件。
> 参考:主 spec §4.2–4.4 + §5.3.3;补充文档 §二(Agent Loop)、§一(故障①④)。

## 0. 目标(本阶段做完能干什么)

跑起来后,问它 "读一下 package.json 讲讲这是什么项目",它会:
1. 决定调 `Read` 工具,发出 `tool_use`。
2. Agent loop 在本地执行 Read,把文件内容作为 `tool_result` 回填。
3. 把 tool_result 连同历史再发给模型,模型基于真实文件内容回答。
4. UI 上能看到"⚙ Read(...)"调用块 + 结果块 + 最终回答。

## 1. 关键架构决策

### 决策 A:引入 `Agent` loop,放在 core(不在 TUI)

现状:`useConversation` **直接调** `client.sendMessages`,自己拼消息、自己在 `message-stop` 落账。
问题:多轮 tool_use 循环(执行→回填→再问)逻辑复杂,且 spec §4.4 明确"UI 不直接调 SDK,只订阅 Agent 事件流"。

→ Phase 3 引入 `core/agent.ts` 的 `runAgent(...)`(async generator):
- 输入:`conversation`、`client`、`registry`、用户输入文本、`config`、`signal`、`maxTurns`。
- 内部跑 tool_use 循环,**对外只 yield 事件流**(text-delta / tool-use / tool-result / message-stop / warning / error)。
- TUI 的 `useConversation` 从"驱动循环"降级为"消费事件、更新 UI"。

这样 Agent loop 能用 fake ModelClient 单测(spec 测试章节要求),且为 Phase 5 权限、Phase 6 多 provider 留好接缝。

### 决策 B:Tool 接口 + Registry 放 core,工具实现放 tools

- `core/tool.ts`:`Tool` / `ToolContext` / `ToolResult` 接口 + `ToolRegistry` 类(纯,可单测)。
- `tools/read.ts`:`ReadTool` 实现 `Tool`。
- `tui`:构造 registry(注册 ReadTool)→ 传给 `runAgent`。

依赖方向不变:`core` 不依赖任何人;`tools → core`;`tui → core, tools`。

### 决策 C:整轮原子落账(延续 Phase 2 的不变量)

Agent loop 在**本地** staged 数组上累积新消息(user → assistant(tool_use) → user(tool_result) → assistant ...),
**全程成功后一次性 append 进 `conversation`**。中途 error 则一条都不落账 → 不留 dangling user / dangling tool_result,
保住 Anthropic 的 user/assistant 交替约束。

### 决策 D:Phase 3 不做权限闸(留给 Phase 5)

`ToolContext` 先只带 `cwd` + `signal`。工具直接执行。Agent loop 里预留权限检查的位置(注释 TODO Phase 5)。

## 2. 故障模式防御(本阶段)

- **① 循环失控**:`maxTurns = 50`(可配)。到顶 → 追加一条 assistant 收尾消息保持交替 + yield `warning`,然后停。
  另外 `signal`(AbortSignal)透传给工具,为 Ctrl+C 中断铺路。
- **④ 工具错误吞**:工具执行包 try/catch,失败转成 `tool_result { is_error: true, content: 错误信息 }` **显式回填给模型**,
  让模型知道失败了,而不是假装成功。未知工具名同样走 is_error。

## 3. 类型变更(core/types.ts)

```ts
// ContentBlock 新增两种(对齐 Anthropic 格式)
| { type: 'tool_use'; id: string; name: string; input: unknown }
| { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

// StreamEvent 新增
| { type: 'tool-use'; id: string; name: string; input: unknown }       // client 发(模型决定调工具)
| { type: 'tool-result'; id: string; name: string; output: string; is_error: boolean }  // Agent 发(执行完)
| { type: 'warning'; message: string }                                 // Agent 发(到 maxTurns)
```

`message-stop` 的 `stop_reason` 为 `'tool_use'` 时,loop 继续;`'end_turn'` 时收工。

## 4. 文件清单(按 sub-step)

| step | 文件 | 动作 |
|---|---|---|
| 3.1 | `core/tool.ts` | 新建:Tool/ToolContext/ToolResult |
| 3.2 | `core/tool.ts` + `core/tool.test.ts` | ToolRegistry(register/get/list/getToolDefinitions)+ 测试 |
| 3.3 | `tools/read.ts` + `tools/read.test.ts` | ReadTool(行号、offset/limit、不存在报错)+ 测试 |
| 3.3 | `tools/index.ts` | 导出 ReadTool + `createDefaultRegistry()` |
| 3.4 | `core/types.ts` | 扩 ContentBlock + StreamEvent |
| 3.4 | `core/anthropic-client.ts` | `sendMessages(msgs, config, tools?)`;映射 tool_use/tool_result 块;finalMessage 抽 tool_use → emit tool-use |
| 3.4 | `core/model-client.ts` | 接口加可选 `tools` 第三参 |
| 3.5 | `core/agent.ts` + `core/agent.test.ts` | runAgent 循环(fake client 单测)|
| 3.5 | `core/index.ts` | 导出 tool.ts / agent.ts |
| 3.6/3.7 | `tui/types.ts` | UIMessage 加工具展示字段 |
| 3.6/3.7 | `tui/hooks/useConversation.ts` | 改用 runAgent;消费 tool-use/tool-result/warning |
| 3.6/3.7 | `tui/components/StreamRenderer.tsx` | 渲染工具调用块/结果块 |
| 3.6 | `tui/App.tsx` | 构造 registry 传入 |
| 3.8 | (含在 3.5/3.3) | is_error 路径 |
| 3.9 | — | typecheck + lint + test 全绿;手动端到端 |

## 5. Read 工具规格(参考 Claude Code FileReadTool)

- input:`{ file_path: string; offset?: number; limit?: number }`,required `file_path`。
- 输出:带行号(`cat -n` 风格,`<行号>\t<内容>`),默认最多读 ~2000 行。
- 错误:文件不存在 / 是目录 / 空文件 → is_error 或明确提示。
- 路径:相对 `ctx.cwd` 解析。Phase 3 不做越权检查(Phase 5)。

## 6. 不做(本阶段)

- Write/Edit/Bash/Glob/Grep(Phase 4)
- 权限闸 / PermissionManager(Phase 5)
- Cache 标记(Phase 6;补充文档 §三已记,先不实现)
- tool_use 输入的流式增量渲染(用 finalMessage 一次拿全,UI 不做 partial JSON)

## 7. 验收

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。
- 新单测:ToolRegistry、ReadTool、runAgent(fake client 模拟一次 tool_use→end_turn 两轮)。
- 手动:配好 .env,`pnpm dev`,让它读一个文件并复述。
