# Zuse vs CC / OpenCode / OpenClaw / Hermes 功能对比

> **日期**: 2026-06-18
> **基准**: Zuse V2 P0+P1 完成后（1033 测试）

---

## 完整对比表

| 功能领域 | 能力 | Zuse | CC | OpenCode | OpenClaw | Hermes |
|---------|------|:----:|:--:|:--------:|:--------:|:------:|
| **核心循环** | Agent Loop + Tool Use | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 多轮工具链式调用 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | maxTurns 兜底 | ✅ 50 | ✅ | ✅ | ✅ | ✅ |
| | 并发只读工具执行 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **工具集** | Read/Write/Edit | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Glob/Grep | ✅ | ✅ | ✅ | ❌ | ❌ |
| | Bash (shell 执行) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | WebFetch | ✅ | ✅ | ❌ | ❌ | ❌ |
| | WebSearch | ✅ | ✅ | ❌ | ❌ | ❌ |
| | LSP (代码智能) | ✅ | ❌ | ❌ | ❌ | ❌ |
| | TodoWrite (任务追踪) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | NotebookEdit | ❌ | ✅ | ❌ | ❌ | ❌ |
| **安全与权限** | 三层配置 (用户/项目/本地) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 权限模式 (default/acceptEdits/bypass) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | allow/ask/deny 规则文法 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Bash 安全检查 | ✅ 23 项 | ✅ 23 项 | ❌ | ❌ | ❌ |
| | Shell 环境快照 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Hooks (pre/post 工具钩子) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Provider** | 多 Provider 抽象 | ✅ | ✅ | ✅ | ❌ | ✅ |
| | Anthropic 原生协议 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | OpenAI 协议 | ✅ | ✅ | ✅ | ❌ | ✅ |
| | 运行时切换 (/model) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 模型降级 (failover) | ✅ dialog/auto | ✅ | ❌ | ❌ | ❌ |
| | Prompt cache 优化 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **会话管理** | 自动保存 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | --continue / --resume | ✅ | ✅ | ✅ | ❌ | ❌ |
| | /compact 上下文压缩 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 自动压缩 (窗口占用触发) | ✅ | ✅ | ✅ | ❌ | ❌ |
| **鲁棒性** | 坏 JSON 自纠 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 429/5xx 退避重试 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 流空闲守卫 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Esc 中断 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 错误回传契约 (故障模式④) | ✅ | ✅ | ✅ | ✅ | ❌ |
| | 输出截断整形 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **检查点** | 影子 git 快照 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | /revert 回滚 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **记忆** | 常驻指令 (ZUSE.md) | ✅ | ✅ CLAUDE.md | ❌ | ❌ | ❌ |
| | 结构化记忆 (SQLite FTS5) | ✅ | ✅ 文件制 | ❌ | ✅ | ✅ |
| | 四种记忆类型 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 情景记忆 recall (历史会话搜索) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 记忆容量硬限 | ✅ | ❌ | ❌ | ✅ 8k | ✅ preview |
| | 记忆年龄标注 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 压缩前记忆冲刷 | ✅ | ❌ | ❌ | ✅ | ❌ |
| | 自动巩固 (autoDream) | ✅ | ❌ | ❌ | ✅ | ❌ |
| **Skills** | SKILL.md 扫描与加载 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 模型语义触发 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | /skills 命令列表 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **多 Agent** | Agent 工具 (子 Agent spawn) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | model 覆盖 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | allowedTools 白名单 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 后台 Agent (runInBackground) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Workflow 编排 (parallel/pipeline) | ✅ API | ✅ JS runtime | ❌ | ❌ | ❌ |
| | Token budget | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 结构化输出 (schema) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Team + SendMessage | ❌ | ✅ | ❌ | ❌ | ❌ |
| | Git worktree 隔离 | ❌ | ✅ | ❌ | ❌ | ❌ |
| | Workflow JS runtime | ❌ | ✅ | ❌ | ❌ | ❌ |
| | Workflow resume | ❌ | ✅ | ❌ | ❌ | ❌ |
| **调度** | ScheduleWakeup (延时唤醒) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Cron 定时任务 | ❌ | ✅ | ❌ | ❌ | ❌ |
| **协议** | MCP 客户端 (stdio) | ✅ | ✅ stdio+SSE | ❌ | ❌ | ❌ |
| | MCP SSE transport | ❌ | ✅ | ❌ | ❌ | ❌ |
| | MCP resource/prompt | ❌ | ✅ | ❌ | ❌ | ❌ |
| **UI** | 流式 Markdown 渲染 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 工具块 CC 风格渲染 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Edit 行级彩色 diff | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 多行输入 (Ctrl+Enter) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 粘贴折叠 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 权限对话框选择器 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | /model 交互式选择器 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 可点击文件链接 (OSC 8) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 完整输出落盘 + 点击查看 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | TodoWrite 任务列表渲染 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | TUI 中文本地化 | ✅ | ❌ 英文 | ❌ | ❌ | ❌ |
| **其他** | Computer Use / 截图 | ❌ | ✅ | ❌ | ❌ | ❌ |
| | IDE 插件 | ❌ | ✅ | ❌ | ❌ | ❌ |
| | 云端/SaaS | ❌ | ✅ | ❌ | ❌ | ❌ |

---

## 统计

| 项目 | 总能力项 | 已实现 | 覆盖率 |
|------|---------|--------|--------|
| **Zuse** | 73 | 59 | **81%** |
| **CC** | 73 | 70 | 96% |
| **OpenCode** | 73 | 19 | 26% |
| **OpenClaw** | 73 | 12 | 16% |
| **Hermes** | 73 | 10 | 14% |

## Zuse 未实现项（14 项）

### 不做（3 项）
- NotebookEdit — 无 Jupyter 使用场景
- IDE 插件 — 非目标
- 云端/SaaS — 非目标

### P2 按需做（4 项）
- Team + SendMessage — Swarm 模式，当前无场景
- Git worktree 隔离 — 并行写文件冲突防护
- Cron 定时任务 — 需要 daemon/OS 调度
- MCP SSE transport — 多数 MCP server 用 stdio 就够

### P3 远期（3 项）
- Computer Use / 截图 — 需要多模态 + 工具链
- MCP resource/prompt — MCP 非 tools 能力
- Workflow JS runtime / resume — 当前 API 模式够用

### 已跳过设计决策（1 项）
- Workflow JS runtime — Zuse 用 TypeScript API 替代 CC 的 eval 模式，设计取舍而非缺失

---

## Zuse 独有优势

| 能力 | Zuse | CC |
|------|------|-----|
| LSP 代码智能工具 | ✅ | ❌ |
| TUI 中文本地化 | ✅ | ❌ 英文 |
| 记忆容量硬限 | ✅ | ❌ |
| 压缩前记忆冲刷 | ✅ (对齐 OpenClaw) | ❌ |
| 自动巩固 autoDream | ✅ (对齐 OpenClaw) | ❌ |
| SQLite FTS5 记忆存储 | ✅ 中文 trigram 可搜 | ❌ 文件制 |
