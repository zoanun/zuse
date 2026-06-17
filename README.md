# Zuse

从零手搓的 coding agent CLI，类似 Claude Code / Aider。学习项目，同时日常自用。

## 为什么造这个

- **学透原理** — 搞清楚 agent loop、tool use、上下文管理、权限模型这些东西在工程上到底怎么落地
- **日常能用** — 用 Zuse 自己开发 Zuse（dogfooding）
- **可扩展** — 基础稳定后可以往特定领域做专用 agent

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript (strict) |
| 运行时 | Node.js 22+ (Volta pin) |
| 包管理 | pnpm workspace (monorepo) |
| TUI | [Ink](https://github.com/vadimdemedes/ink) — React for terminal |
| 模型 | Anthropic SDK / OpenAI 协议，通过 Provider 抽象层 |
| 测试 | Vitest |
| Lint | ESLint + Prettier |

## 项目结构

```
packages/
  core/     # agent loop、会话、权限、provider 抽象、上下文压缩
  tools/    # 工具实现（Read/Write/Edit/Glob/Grep/Bash/WebFetch/LSP/Skills...）
  tui/      # Ink 终端 UI、Markdown 渲染、命令菜单
```

## 主要能力

- **Agent Loop** — 模型提出 tool call → 执行 → 结果回传 → 循环，单轮上限 50 次
- **完整工具集** — Read / Write / Edit / Glob / Grep / Bash / WebFetch / WebSearch / LSP
- **多 Provider** — Anthropic 原生、DashScope、DeepSeek、Ollama、vLLM；`/model` 运行时切换
- **三层配置 + 权限** — 用户层 / 项目层 / 本地层配置，`Tool(specifier)` 规则文法四档裁决
- **会话管理** — 自动保存、`--continue` 续接、`/resume` 列表、`/compact` 上下文压缩
- **检查点与回滚** — 每回合自动快照（影子 git），`/revert` 精确回退工作区 + 对话
- **项目记忆** — 常驻指令（ZUSE.md）+ 结构化记忆（SQLite FTS5）+ 历史会话全文检索
- **Skills 系统** — 用户级 / 项目级技能目录，模型按语义自主触发
- **流式 Markdown** — token 级增量富文本渲染
- **鲁棒性** — 坏 JSON 自纠、429/5xx 退避重试、流空闲守卫、Esc 中断

## 快速开始

```bash
pnpm install
pnpm dev          # 开发模式（热重载）
pnpm build && pnpm start   # 构建后运行
```

需要设置 `ANTHROPIC_API_KEY` 环境变量（或对应 provider 的 key）。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm test` | 跑测试 |
| `pnpm typecheck` | 类型检查 |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier 格式化 |

## 设计文档

详见 [docs/superpowers/specs/](docs/superpowers/specs/)，其中 [总设计文档](docs/superpowers/specs/2026-05-21-zuse-design.md) 包含完整的目标、非目标和 roadmap。
