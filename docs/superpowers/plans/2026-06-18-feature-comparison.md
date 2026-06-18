# Zuse vs CC / OpenCode / OpenClaw / Hermes 功能对比

> **日期**: 2026-06-18
> **基准**: Zuse V2 P0+P1 完成后（1033 测试）
> **数据来源**: 各项目实际源码扫描（E:\ai-study\ 下四份代码）

---

## 完整对比表

| 功能领域 | 能力 | Zuse | CC | OpenCode | OpenClaw | Hermes |
|---------|------|:----:|:--:|:--------:|:--------:|:------:|
| **核心循环** | Agent Loop + Tool Use | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 多轮工具链式调用 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | maxTurns 兜底 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 并发只读工具执行 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **工具集** | Read/Write/Edit | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Glob/Grep | ✅ | ✅ | ✅ | ✅ | ❌ |
| | Bash (shell 执行) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | WebFetch | ✅ | ✅ | ✅ | ❌ | ✅ |
| | WebSearch | ✅ | ✅ | ✅ | ❌ | ✅ |
| | LSP (代码智能) | ✅ | ✅ | ✅ | ❌ | ✅ |
| | TodoWrite (任务追踪) | ✅ | ✅ | ✅ | ✅ | ❌ |
| | NotebookEdit | ❌ | ✅ | ❌ | ❌ | ❌ |
| **安全与权限** | 三层配置 (用户/项目/本地) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 权限模式 (default/acceptEdits/bypass) | ✅ | ✅ | ✅ | ✅ | ❌ |
| | allow/ask/deny 规则文法 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | Bash 安全检查 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Shell 环境快照 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Hooks (pre/post 工具钩子) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Provider** | 多 Provider 抽象 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Anthropic 原生协议 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | OpenAI 协议 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 运行时切换 (/model) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 模型降级 (failover) | ✅ | ✅ | ❌ | ✅ | ❌ |
| | Prompt cache 优化 | ✅ | ✅ | ❌ | ❌ | ❌ |
| **会话管理** | 自动保存 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | --continue / --resume | ✅ | ✅ | ✅ | ✅ | ❌ |
| | /compact 上下文压缩 | ✅ | ✅ | ✅ | ❌ | ✅ |
| | 自动压缩 (窗口占用触发) | ✅ | ✅ | ✅ | ❌ | ✅ |
| **鲁棒性** | 坏 JSON 自纠 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 429/5xx 退避重试 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 流空闲守卫 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Esc 中断 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 错误回传契约 (故障模式④) | ✅ | ✅ | ✅ | ✅ | ❌ |
| | 输出截断整形 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **检查点** | 影子 git 快照 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | /revert 回滚 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **记忆** | 常驻指令 (ZUSE.md/CLAUDE.md) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 结构化记忆 (DB) | ✅ SQLite | ✅ 文件制 | ❌ | ❌ | ✅ SQLite |
| | 四种记忆类型 | ✅ | ✅ | ❌ | ❌ | ✅ |
| | 情景记忆 recall (历史会话搜索) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 记忆容量硬限 | ✅ | ✅ | ❌ | ❌ | ✅ |
| | 记忆年龄标注 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 压缩前记忆冲刷 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 自动巩固 (autoDream) | ✅ | ✅ | ❌ | ✅ | ❌ |
| **Skills** | SKILL.md / 技能系统 | ✅ | ✅ | ❌ | ❌ | ✅ |
| | 模型语义触发 | ✅ | ✅ | ❌ | ❌ | ✅ |
| **多 Agent** | Agent 工具 (子 Agent spawn) | ✅ | ✅ | ✅ | ❌ | ✅ |
| | model 覆盖 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | allowedTools 白名单 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 后台 Agent (runInBackground) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Workflow 编排 (parallel/pipeline) | ✅ API | ✅ JS runtime | ❌ | ❌ | ❌ |
| | Token budget | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 结构化输出 (schema) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Team + SendMessage | ❌ | ✅ | ❌ | ❌ | ❌ |
| | Git worktree 隔离 | ❌ | ✅ | ❌ | ❌ | ❌ |
| **调度** | ScheduleWakeup (延时唤醒) | ✅ | ✅ | ❌ | ✅ 心跳 | ❌ |
| | Cron 定时任务 | ❌ | ✅ | ❌ | ✅ CronService | ❌ |
| **协议** | MCP 客户端 | ✅ stdio | ✅ stdio+SSE | ✅ | ✅ | ✅ |
| | MCP SSE transport | ❌ | ✅ | ✅ | ❌ | ❌ |
| **UI** | 流式 Markdown 渲染 | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 工具块 CC 风格渲染 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Edit 行级彩色 diff | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 多行输入 (Ctrl+Enter) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 粘贴折叠 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 权限对话框选择器 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | /model 交互式选择器 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 可点击文件链接 (OSC 8) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | TUI 中文本地化 | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## 统计

| 项目 | 总能力项 | 已实现 | 覆盖率 |
|------|---------|--------|--------|
| **Zuse** | 68 | 57 | **84%** |
| **CC** | 68 | 66 | **97%** |
| **OpenCode** | 68 | 33 | **49%** |
| **OpenClaw** | 68 | 22 | **32%** |
| **Hermes** | 68 | 22 | **32%** |

## Zuse 未实现项（11 项）

### 不做（1 项）
- NotebookEdit — 无 Jupyter 使用场景

### P2 按需做（5 项）
- Team + SendMessage — Swarm 模式
- Git worktree 隔离 — 并行写文件冲突防护
- Cron 定时任务 — 需要 daemon/OS 调度
- MCP SSE transport — 多数 server 用 stdio 够
- Workflow JS runtime / resume

### P3 远期（1 项）
- Computer Use / 截图

### 设计取舍（非缺失）
- Workflow JS runtime → Zuse 用 TypeScript API 替代
- CC 的 IDE 插件 / 云端 SaaS → Zuse 非目标，不计入对比

## Zuse 独有优势（vs CC）

| 能力 | 说明 |
|------|------|
| TUI 中文本地化 | CC 全英文 |
| SQLite FTS5 记忆 | 中文 trigram 全文检索，优于 CC 文件制 |

## 前版对比表的错误修正记录

| 原标记 | 修正 | 原因 |
|--------|------|------|
| CC LSP: ❌ | → ✅ | CC 有完整 `src/tools/LSPTool/`（definition/references/symbols） |
| CC 记忆容量硬限: ❌ | → ✅ | CC memdir 有 `MAX_ENTRYPOINT_LINES=200` + `MAX_ENTRYPOINT_BYTES=25000` |
| CC 压缩前记忆冲刷: ❌ | → ✅ | CC `compact.ts` 有 `executePreCompactHooks()` |
| OpenCode Glob/Grep: ❌ | → ✅ | 有 `tool/glob.ts` + `tool/grep.ts` |
| OpenCode WebFetch/Search: ❌ | → ✅ | 有 `tool/webfetch.ts` + `tool/websearch.ts` |
| OpenCode LSP: ❌ | → ✅ | 有 `lsp/lsp.ts` |
| OpenCode 权限模型: ❌ | → ✅ | 有 `permission/index.ts`（allow/ask/deny） |
| OpenCode Bash 安全: ❌ | → ✅ | 有 `tool/shell/prompt.ts` |
| OpenCode 多 Agent: ❌ | → ✅ | 有 `agent/agent.ts` |
| OpenCode TodoWrite: ❌ | → ✅ | 有 `tool/todowrite.ts` |
| OpenCode Hooks: ❌ | → ✅ | 有 plugin hooks 系统 |
| OpenCode MCP: ❌ | → ✅ | 有 `mcp/index.ts` |
| OpenCode 流式 Markdown: ❌ | → ✅ | 有 `markdown-stream.test.ts` |
| OpenClaw Glob/Grep: ❌ | → ✅ | 有 `glob-pattern.ts` + `tools/grep.ts` |
| OpenClaw 权限: ❌ | → ✅ | 有 `permission-relay.ts`（ACP 协议） |
| OpenClaw Bash 安全: ❌ | → ✅ | 有 `bash-process-registry.ts` |
| OpenClaw TodoWrite: ❌ | → ✅ | 有 `anthropic-transport-stream.ts` 中注册 |
| OpenClaw Hooks: ❌ | → ✅ | 有 `docs/cli/hooks.md` |
| OpenClaw MCP: ❌ | → ✅ | 有 `ui/views/mcp.ts` |
| OpenClaw 检查点: ❌ | → ✅ | 有 savepoint 系统 |
| Hermes LSP: ❌ | → ✅ | 有完整 `agent/lsp/` 目录 |
| Hermes WebFetch/Search: ❌ | → ✅ | 有 `web_search_provider.py` |
| Hermes 多 Provider: ❌ | → ✅ | 有 anthropic/bedrock/chat_completions transports |
| Hermes 上下文压缩: ❌ | → ✅ | 有 `context_compressor.py` |
| Hermes Bash 安全: ❌ | → ✅ | 有 `tool_guardrails.py` |
| Hermes Hooks: ❌ | → ✅ | 有 `shell_hooks.py` |
| Hermes MCP: ❌ | → ✅ | 有 `hermes_tools_mcp_server.py` |
| Hermes Skills: ❌ | → ✅ | 有 `skill_bundles.py` + `skill_commands.py` |
| Hermes 多 Agent: ❌ | → ✅ | README 提到 subagent spawning |
| Hermes 会话保存: ❌ | → ✅ | 有 `trajectory.py` JSONL 保存 |
