# Zuse —— 自研 Coding Agent 设计文档

**日期**：2026-05-21
**作者**：zouyj
**状态**：Draft（待评审）

## 1. 项目目标

Zuse 是一个自研的 coding agent CLI 工具，类似 Claude Code / Aider，但完全从零搭建。

**核心动机**：
- **A（学习）**：搞清楚 Claude Code 这一类 agent 工具内部如何运转——agent loop、tool use、上下文管理、权限模型。
- **B（自用）**：日常开发顺手能用，替代/补充现有工具。
- **C（未来可能）**：基础稳定后，针对特定领域做专用 agent（PDF 处理、小说创作等）。

**衡量成功的标准**：
- A：能完整讲清楚自己实现的每个机制；能从源码角度对比 Claude Code 的设计取舍。
- B：能 dogfood —— 用 zuse 自己开发 zuse 后续功能。

## 2. 非目标 (Non-Goals)

- 不追求功能上"超越"Claude Code，目标是"看懂、学透、自用"。
- 不做团队/多人协作功能。
- 不做云端/SaaS 化。
- 不做 IDE 插件（至少 v1 范围内）。
- 不做模型微调或自训练。

## 3. 形态与技术栈

### 3.1 形态：TUI

**选 TUI 的理由**：
- 强制聚焦在 agent loop 而非 UI 渲染（契合学习目标 A）。
- 最快达到日常可用（契合 B）。
- 不绑死 UI 形态——core 解耦后，未来可以包桌面壳或 web 壳。

### 3.2 技术栈

| 层 | 选型 | 备注 |
|----|------|------|
| 语言 | TypeScript | 严格模式 |
| 运行时 | Node.js（Volta 管理） | 项目内 `package.json` 用 `volta` 字段 pin 版本 |
| 包管理 | pnpm + workspace | monorepo |
| TUI 框架 | [Ink](https://github.com/vadimdemedes/ink) | React for terminal |
| 模型 SDK | `@anthropic-ai/sdk`、`openai` | 通过 Provider 抽象层使用 |
| 测试 | Vitest | 仅 core 写单测 |
| Lint/格式化 | ESLint + Prettier | 标配 |
| Diff 渲染 | `diff` 库 + 自渲染 | 7.1 阶段确定细节 |
| 文件搜索 | `fast-glob`、spawn ripgrep | ripgrep 走子进程 |

### 3.3 项目命名与约定
- 包名前缀：`@zuse/`（如 `@zuse/core`、`@zuse/tui`）
- CLI 命令：`zuse`
- 用户配置目录：`~/.zuse/`
- 项目级 prompt 文件：`ZUSE.md`（仿 `CLAUDE.md`）

## 4. 架构

### 4.1 包结构

```
zuse/
├── packages/
│   ├── core/          # agent loop, conversation, provider abstraction —— 零 UI
│   ├── tools/         # 所有工具实现（Read/Edit/Bash/Grep/...）
│   └── tui/           # Ink 应用 —— 渲染、输入、键位
├── docs/
│   └── superpowers/specs/  # 本设计文档所在位置
├── BACKLOG.md         # 路上想到的新点子记在这里，不立即做
└── package.json
```

**关键解耦原则**：`core` 永远不能 import `tui`。`tools` 不依赖 UI。这样 core+tools 未来可以被任何前端（桌面壳/web 壳/插件）复用。

### 4.2 Core 模块

```
@zuse/core
├── Conversation        # 持有 messages[]，提供 append/clear/save/load
├── Agent               # 主 loop —— 接收 user 输入，驱动 model + tools，输出事件流
├── ModelClient         # interface { sendMessages(messages, tools) → AsyncIterable<Event> }
│   ├── AnthropicClient
│   └── OpenAIClient
├── ToolRegistry        # register/get/list
├── PermissionManager   # pre-tool 决策
└── Events              # text-delta / tool-use / tool-result / stop / error
```

**Agent loop 伪代码**（Phase 3.5 的关键）：

```
loop:
  events = modelClient.sendMessages(conversation.messages, registry.list())
  for event in events:
    emit event 到 UI
    if event.type === "tool_use":
      decision = permissionManager.check(event.tool, event.input)
      if decision === "deny":
        append tool_result(is_error: "user denied")
        continue
      result = registry.get(event.name).run(event.input)
      conversation.append(assistant_message_with_tool_use)
      conversation.append(user_message_with_tool_result(result))
  if last response stop_reason === "end_turn":
    break
```

### 4.3 Tool 接口

```typescript
interface Tool<Input> {
  name: string
  description: string
  inputSchema: JSONSchema   // 模型读这个决定怎么调
  run(input: Input, ctx: ToolContext): Promise<ToolResult>
}

interface ToolContext {
  cwd: string
  signal: AbortSignal      // 用户 Ctrl+C 中断
  permissionManager: PermissionManager
}
```

### 4.4 事件流（UI 看到的）

UI 不直接调 Anthropic SDK，而是订阅 `Agent` 暴露的事件流：

- `text-delta { text }` —— 流式文本片段
- `tool-use { id, name, input }` —— 模型决定调工具
- `tool-result { id, output, is_error }` —— 工具执行结果
- `message-stop { stop_reason, usage }` —— 一轮结束
- `error { message }` —— 异常

这样 UI 完全 provider-agnostic。

## 5. 阶段路线图

**总览**：10 个 phase，约 80 个小步骤，每步 1～3 小时可独立交付。每个小步骤一个 commit；每个 phase 完成打 git tag。

### Phase 0 · 脚手架
- 0.1 初始化 pnpm workspace + 根目录 tsconfig / eslint / prettier
- 0.2 创建 `packages/core`、`packages/tui`、`packages/tools`
- 0.3 tui 跑通 Ink "Hello World"
- 0.4 安装 `@anthropic-ai/sdk`，独立脚本 ping API

### Phase 1 · 单轮对话
- 1.1 core：非流式 `sendOnce(messages)`
- 1.2 core：切流式，返回 AsyncIterable
- 1.3 tui：输入框 + 回车提交
- 1.4 tui：实时渲染流式响应
- 1.5 tui：user / assistant 视觉区分

### Phase 2 · 多轮 + 上下文
- 2.1 core：`ConversationState`
- 2.2 core：每轮追加消息
- 2.3 tui：渲染完整历史
- 2.4 token 计数
- 2.5 slash command 框架
- 2.6 `/clear`
- 2.7 `/save` `/load`

### Phase 3 · 第一个工具：Read ⭐ 核心阶段
- 3.1 定义 `Tool` 接口
- 3.2 `ToolRegistry`
- 3.3 Read 工具 run 函数
- 3.4 core：tools 参数传给 Anthropic
- 3.5 core：tool_use 循环（执行 → tool_result → 回填） ⭐
- 3.6 tui：渲染 tool_use 块
- 3.7 tui：渲染 tool_result 块
- 3.8 工具错误处理
- 3.9 端到端验证

### Phase 4 · 工具集补全
- 4.1 Write 工具
- 4.2 Edit 工具（read-before-edit 校验）
- 4.3 Bash 工具（spawn / cwd / timeout）
- 4.4 Bash 流式输出
- 4.5 Glob 工具（fast-glob）
- 4.6 Grep 工具（spawn ripgrep）
- 4.7 LS 工具
- 4.8 长输出截断、行号等体验优化

### Phase 5 · 权限模型
- 5.1 权限决策接口
- 5.2 core：pre-tool hook
- 5.3 tui：权限对话框
- 5.4 "始终允许" 持久化
- 5.5 权限模式（default / acceptEdits / bypassPermissions）
- 5.6 `/mode` 命令

### Phase 6 · 多 provider
- 6.1 `ModelClient` 接口
- 6.2 AnthropicClient 实现
- 6.3 OpenAIClient 实现
- 6.4 Provider 无关事件类型
- 6.5 `/model` 切换 + 配置持久化
- 6.6（可选）Ollama 客户端

### Phase 7 · UI 打磨
- 7.1 Edit diff 渲染
- 7.2 `/tools` 列表
- 7.3 `/history` 滚动
- 7.4 错误展示样式
- 7.5 Ctrl+C / Ctrl+D / Esc
- 7.6 footer token + model 显示

### Phase 8 · 会话管理
- 8.1 session 按 cwd 分组
- 8.2 session 列表
- 8.3 `--continue`
- 8.4 `--resume <id>`
- 8.5 每轮自动保存

### Phase 9 · 项目记忆
- 9.1 加载 `~/.zuse/SYSTEM.md`
- 9.2 cwd 向上找 `ZUSE.md`
- 9.3 拼接进 system prompt
- 9.4 `/memory` 查看
- 9.5 `/init` 脚手架

### Phase 10+（未来可选）
- Skills / 插件系统
- Sub-agent（并行任务分发）
- 长期记忆机制
- Tauri 桌面壳 / 本地 server + Web UI

## 6. 测试策略

- **core**：用 Vitest 写单测。重点：Conversation 状态、Agent loop（用 fake ModelClient）、ToolRegistry、PermissionManager。
- **tools**：每个工具单测，重点参数校验、错误路径。
- **tui**：不写自动化测试，靠手动 dogfood。
- **CI**：暂不配，本地 `pnpm test` 跑就行。Phase 5 之后再看是否上 GitHub Actions。

## 7. 开发约定

1. **一个小步骤一个 commit**。commit 信息格式：`phase X.Y: <做了什么>`。
2. **Phase 之间打 git tag**：`v0.1-phase0`、`v0.2-phase1` 等。
3. **想法不立即做**：路上冒出的新功能记到根目录 `BACKLOG.md`，跑完当前 phase 再回顾。
4. **遇到不懂的概念停下来读文档**，必要时翻 Claude Code 源码（npm 上有），不硬抄。
5. **不写注释解释 "做了什么"**——代码自解释；只写"为什么"（非显然的约束/取舍）。

## 8. 风险与未决问题

| 风险 | 缓解 |
|------|------|
| Windows 终端兼容性（Ink 在 Windows Terminal 渲染有时有怪问题） | 早期就在目标终端跑，发现问题及时换组件 |
| Anthropic 和 OpenAI 的 tool_use 格式差异比想象大 | Phase 6 拆得细，先单 provider 跑通再抽象 |
| Bash 工具的安全性 | Phase 5 强制权限询问；提供 `bypassPermissions` 但默认关 |
| 会话/记忆设计可能要返工 | 接受。Phase 8-9 时再优化结构，初版怎么简单怎么来 |

## 9. 后续步骤

本 spec 通过后，进入 `writing-plans` 流程，为 **Phase 0** 写详细实现 plan，开始动工。
后续每个 phase 在动工前都单独写一份 plan。
