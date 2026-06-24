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
  server/   # Web UI 后端（实验中）：headless 会话编排 + HTTP/WS 服务器 + 本地密码鉴权
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

## Web UI 服务器（实验中）

`packages/server`（`@zuse/server`）是一个**与 TUI 解耦**的 Web 后端：常驻 HTTP/WS 服务器 + 本地密码门禁 + headless 会话编排（`SessionManager`，传输无关）。本机为主、可远程访问、单用户。

> 当前进度：**F1 已完成** —— 鉴权 + 鉴权后的 `/ws`（目前是 echo）+ 一个内联 dev 测试页。把 agent 真正接进 `/ws`（F3）和真正的 React 前端（F4）还在路上，所以现在是**半成品**。

### 本地运行

```bash
npx tsx packages/server/src/bin.ts        # 起服务，默认 127.0.0.1:4180
# 浏览器打开 http://127.0.0.1:4180/ → 首次设密码 → 登录 → WS echo 控制台
```

或跑构建产物：

```bash
pnpm -C packages/server build             # tsup 构建到 dist/（按目录，与包名无关）
node packages/server/dist/bin.js          # 也可加 --port <n> --host <h>
```

- 默认仅绑回环 `127.0.0.1`；远程访问需显式 `--host 0.0.0.0`，且**务必加 TLS/隧道**（明文 HTTP 暴露到网络不安全）。
- 鉴权：首次设密码（scrypt 哈希存 `~/.zuse/web-auth.json`），登录后发 HMAC 签名的会话 cookie，服务重启不掉线。`--set-password` 可单独设密码。

### 打包与发布（npm）

`@zuse/server` 已配置成**自包含可发布包**（tsup 把 `@zuse/core` + `@zuse/tools` bundle 进 `dist/`，第三方库作普通依赖）：

```bash
pnpm -C packages/server build             # 产出 dist/{index.js, bin.js, index.d.ts}
cd packages/server && npm pack            # 本地验证 tarball（仅含 dist + package.json）
```

发布到 npm（**当前 `package.json` 里的发布名 `@zouyj/zuse-server` 是占位符，发布前改成你自己的 npm 用户名/scope**）：

```bash
# 1. 改 packages/server/package.json 的 "name" 为你的 scope，如 @你的用户名/zuse-server
# 2. pnpm -F <你的名字> build
# 3. npm login && cd packages/server && npm publish   # scoped 公开已配 access:public
```

发布后即可全局安装运行：

```bash
npm install -g @你的用户名/zuse-server
zuse-server                               # 起服务，浏览器打开 http://127.0.0.1:4180/
```

> 建议等 F3/F4 让它成为真正可用的工具后再发布到公共 registry。

## 设计文档

详见 [docs/superpowers/specs/](docs/superpowers/specs/)，其中 [总设计文档](docs/superpowers/specs/2026-05-21-zuse-design.md) 包含完整的目标、非目标和 roadmap。Web UI 程序的分解见 [Web UI 路线图总纲](docs/superpowers/specs/2026-06-22-web-ui-roadmap.md)。
