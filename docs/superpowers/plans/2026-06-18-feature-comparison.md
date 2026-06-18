# Zuse vs CC / OpenCode / OpenClaw / Hermes 功能对比

> **日期**: 2026-06-18（第三版，基于源码逐项核实）
> **基准**: Zuse V2 P0+P1 完成后（1033 测试）
> **数据来源**: 各项目实际源码扫描（E:\ai-study\ 下四份代码）

---

## 完整对比表

| 功能领域 | 能力 | Zuse | CC | OpenCode | OpenClaw | Hermes |
|---------|------|:----:|:--:|:--------:|:--------:|:------:|
| **核心循环** | Agent Loop + Tool Use | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 多轮工具链式调用 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | maxTurns 兜底 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 并发只读工具执行 | ✅ | ✅ | ❌ | ✅ | ✅ |
| **工具集** | Read/Write/Edit | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Glob/Grep | ✅ | ✅ | ✅ | ✅ | ❌ |
| | Bash (shell 执行) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | WebFetch | ✅ | ✅ | ✅ | ✅ | ✅ |
| | WebSearch | ✅ | ✅ | ✅ | ✅ | ✅ |
| | LSP (代码智能) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | TodoWrite (任务追踪) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | NotebookEdit | ❌ | ✅ | ❌ | ❌ | ❌ |
| **安全与权限** | 三层配置 (用户/项目/本地) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 权限模式 (default/acceptEdits/bypass) | ✅ | ✅ | ✅ | ✅ | ❌ |
| | allow/ask/deny 规则文法 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | Bash 安全检查 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Shell 环境快照 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Hooks (pre/post 工具钩子) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Provider** | 多 Provider 抽象 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Anthropic 原生协议 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | OpenAI 协议 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 运行时切换 (/model) | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 模型降级 (failover) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | Prompt cache 优化 | ✅ | ✅ | ✅ | ✅ | ✅ |
| **会话管理** | 自动保存 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | --continue / --resume | ✅ | ✅ | ✅ | ✅ | ❌ |
| | /compact 上下文压缩 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 自动压缩 (窗口占用触发) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **鲁棒性** | 坏 JSON 自纠 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 429/5xx 退避重试 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 流空闲守卫 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | Esc 中断 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 错误回传契约 (故障模式④) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | 输出截断整形 | ✅ | ✅ | ✅ | ✅ | ✅ |
| **检查点** | 影子 git 快照 | ✅ | ✅ | ✅ | ✅ | ✅ |
| | /revert 回滚 | ✅ | ✅ | ✅ | ❌ | ❌ |
| **记忆** | 常驻指令 (ZUSE.md/CLAUDE.md) | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 结构化记忆 (DB) | ✅ SQLite | ✅ 文件制 | ❌ | ✅ | ✅ |
| | 四种记忆类型 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 情景记忆 recall (历史会话搜索) | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 记忆容量硬限 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 记忆年龄标注 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 压缩前记忆冲刷 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 自动巩固 (autoDream) | ✅ | ✅ | ❌ | ✅ | ❌ |
| **Skills** | SKILL.md / 技能系统 | ✅ | ✅ | ❌ | ✅ | ✅ |
| | 模型语义触发 | ✅ | ✅ | ❌ | ✅ | ✅ |
| **多 Agent** | Agent 工具 (子 Agent spawn) | ✅ | ✅ | ✅ | ✅ | ✅ |
| | model 覆盖 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | allowedTools 白名单 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 后台 Agent (runInBackground) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | Workflow 编排 (parallel/pipeline) | ✅ API | ✅ JS runtime | ❌ | ✅ | ❌ |
| | Token budget | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 结构化输出 (schema) | ✅ | ✅ | ❌ | ❌ | ❌ |
| | Team + SendMessage | ❌ | ✅ | ❌ | ❌ | ❌ |
| | Git worktree 隔离 | ❌ | ✅ | ❌ | ❌ | ❌ |
| **调度** | ScheduleWakeup (延时唤醒) | ✅ | ✅ | ❌ | ✅ 心跳 | ❌ |
| | Cron 定时任务 | ❌ | ✅ | ❌ | ✅ CronService | ✅ |
| **协议** | MCP 客户端 | ✅ stdio | ✅ stdio+SSE | ✅ | ✅ | ✅ |
| | MCP SSE transport | ❌ | ✅ | ✅ | ❌ | ❌ |
| **UI** | 流式 Markdown 渲染 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | 工具块 CC 风格渲染 | ✅ | ✅ | ❌ | ✅ | ❌ |
| | Edit 行级彩色 diff | ✅ | ✅ | ❌ | ✅ | ❌ |
| | 多行输入 (Ctrl+Enter) | ✅ | ✅ | ✅ | ❌ | ❌ |
| | 粘贴折叠 | ✅ | ✅ | ❌ | ❌ | ❌ |
| | 权限对话框选择器 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | /model 交互式选择器 | ✅ | ✅ | ✅ | ✅ | ❌ |
| | 可点击文件链接 (OSC 8) | ✅ | ✅ | ❌ | ✅ | ❌ |
| | TUI 中文本地化 | ✅ | ❌ | ❌ | ✅ | ✅ |

---

## 统计

| 项目 | 总能力项 | 已实现 | 覆盖率 |
|------|---------|--------|--------|
| **CC** | 68 | 66 | **97%** |
| **OpenClaw** | 68 | 57 | **84%** |
| **Zuse** | 68 | 57 | **84%** |
| **Hermes** | 68 | 40 | **59%** |
| **OpenCode** | 68 | 37 | **54%** |

## Zuse 未实现项（11 项）

### 不做（1 项）
- NotebookEdit — 无 Jupyter 使用场景

### P2 按需做（5 项）
- Team + SendMessage — Swarm 模式
- Git worktree 隔离 — 并行写文件冲突防护
- Cron 定时任务 — 需要 daemon/OS 调度
- MCP SSE transport — 多数 server 用 stdio 够
- Workflow JS runtime / resume

### 设计取舍（非缺失）
- Workflow JS runtime → Zuse 用 TypeScript API 替代

## Zuse 独有优势（vs CC）

| 能力 | 说明 |
|------|------|
| SQLite FTS5 记忆 | 中文 trigram 全文检索，优于 CC 文件制 |

## 第三版修正记录（vs 第二版）

| 项目 | 修正数 | 主要修正 |
|------|--------|----------|
| OpenClaw | +35 项 ❌→✅ | 几乎全面低估：WebFetch/Search、LSP、Shell 快照、压缩、JSON 自纠、流守卫、记忆全套、Skills、多 Agent、Workflow、i18n 等 |
| Hermes | +18 项 ❌→✅ | Shell 快照、/model 切换、failover、cache、JSON 自纠、重试、流守卫、中断、截断、检查点、TodoWrite、Cron、i18n 等 |
| OpenCode | +5 项 ❌→✅ | Shell 快照、Prompt cache、后台 Agent、/model 选择器、权限对话框 |
| CC | 无变化 | — |
