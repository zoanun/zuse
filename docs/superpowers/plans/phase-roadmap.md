# Zuse Phase Roadmap

> **用途**: 开发每个Phase前，参考此文档找到对应的补充内容、课程具体文件和知识点位置。

**课程根目录**: `E:\Harness Engineering 强化班_大模型Agent智能体开发实战\【2026正课】Harness Engineering 强化班\`

---

## Phase总览

| Phase | 主题        | 补充文档章节                                | 课程文件路径                                                   | Claude Code源码   |
| ----- | ----------- | ------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| 0     | Scaffolding | 一（故障模式概览）                          | 【专题课】Harness Engineering驾驭工程实战/Part 1/              | —                 |
| 1     | 单轮对话    | 一（故障模式⑧成本）+ 三（Cache雏形）        | 【专题课】Harness Engineering驾驭工程实战/Part 2/              | query.ts框架      |
| 2     | 多轮+上下文 | 四（Token Budget雏形）                      | 【Part 7】智能体长短期记忆管理/Part 1/                         | context/          |
| 3     | Tool系统    | 二（Agent Loop）+ 三（Cache）+ 一（①④故障） | 【专题课】Harness Engineering驾驭工程实战/Part 1+2/            | tools/ + query.ts |
| 4     | 工具集补全  | 一（④工具错误吞）                           | 【专题课】Harness Engineering驾驭工程实战/Part 2/              | BashTool/         |
| 5     | 权限模型    | 一（⑥缺权限闸）+ 11.3（23项安全检查）       | 【专题课】Harness Engineering驾驭工程实战/Part 1/              | bashSecurity.ts   |
| 5.5   | Bash执行环境与隔离 | —（CC 行为对齐，无对应课程）           | —                                                              | ShellSnapshot.ts / shouldUseSandbox.ts / tmuxSocket.ts |
| 6     | 多Provider  | 三（Cache优化）                             | 【专题课】Harness Engineering驾驭工程实战/Part 4/              | —                 |
| 6.5   | 联网工具    | —                                           | —                                                              | WebFetch✅/WebSearch✅ |
| 6.6   | 代码智能LSP | —                                           | —                                                              | tools/LSP         |
| 7     | UI打磨      | —                                           | —                                                              | ink/ components/  |
| 8     | 会话管理    | 四（Token Budget）+ 11.6（压缩策略）        | 【Part 7】+【Part 8】+【专题课】Claude Code架构/Part 3/        | services/compact/ |
| 9     | 项目记忆    | 五（记忆系统SQLite）+ 11.2（四种记忆类型）  | 【专题课】Harness Engineering驾驭工程实战/Part 4/ + 【Part 7】 | memdir/           |
| 10+   | Skills系统  | 六（SKILL.md格式）+ 11.7（Skills实现）      | 【Part 6】Agent Skills/                                        | skills/           |
| 11    | 多Agent编排 | 11.4（多Agent架构）                         | Claude Code专题课Part 3 + LangGraph Part 7                     | Agent/Team/Workflow|
| 12    | 调度与自动化| —                                           | —                                                              | Cron/ScheduleWakeup|

---

## Phase 0: Scaffolding

### 补充文档参考

第一章（故障模式防御矩阵概览）— 了解8个故障模式框架

### 课程知识点

| 知识点                      | 课程文件                                                                                                                                  | 具体位置                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Agent = Model + Harness公式 | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb` | 开篇"三层次能力对比表"                     |
| 8个故障模式概览             | 同上                                                                                                                                      | "naive agent ~50行代码展示8个故障模式"章节 |
| 8大机制概览                 | 同上                                                                                                                                      | "8大机制示意代码片段"章节                  |
| 3支柱框架                   | 同上                                                                                                                                      | "三支柱：CE/AC/GC"章节                     |

### Claude Code源码参考

—（Phase 0纯脚手架，无源码参考）

### 开发要点

- 脚手架搭建，暂不涉及具体机制
- Phase 0完成后，将故障模式矩阵引用加入主设计文档

---

## Phase 1: 单轮对话

### 补充文档参考

- 第一章（故障模式⑧成本失控 → token统计）
- 第三章（Cache优化雏形）

### 课程知识点

| 知识点             | 课程文件                                                                                                                                           | 具体位置                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Agent Loop基础框架 | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "mini-Harness核心循环代码"章节 |
| 流式响应处理       | 同上                                                                                                                                               | "切流式返回AsyncIterable"章节  |
| Token计数基础      | 同上                                                                                                                                               | "usage统计"章节                |
| 故障模式⑧成本失控  | Part 1笔记本                                                                                                                                       | "故障模式⑧：API调用无限制"章节 |

### Claude Code源码参考

`query.ts` 框架结构（1729行）— AsyncGenerator驱动模式

### 开发要点

- core: 非流式 → 流式 sendMessages
- tui: 输入框 + 流式渲染
- token计数（故障模式⑧防御）

---

## Phase 2: 多轮+上下文

### 补充文档参考

第四章（Token Budget雏形）

### 课程知识点

| 知识点           | 课程文件                                                                                                                                           | 具体位置                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 记忆系统基础认知 | `【Part 7】智能体长短期记忆管理\Part 1. 大模型 Agent 长短期记忆管理基础入门\大模型Agent长短期记忆管理基础入门.ipynb`                               | "第50轮对话时失忆"章节                |
| 热记忆vs冷记忆   | 同上                                                                                                                                               | "记忆分层模型"章节                    |
| Token Budget概念 | 同上                                                                                                                                               | "token配额管理"章节                   |
| 会话状态管理     | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "ConversationState持有messages[]"章节 |

### Claude Code源码参考

`context/` 目录（1004行）— 上下文组装与管理

### 开发要点

- ConversationState 持有 messages[]
- token预算雏形
- slash command框架: /clear, /save, /load

---

## Phase 3: Tool系统 ⭐ 核心阶段

### 补充文档参考

- 第二章（Agent Loop完整伪代码 + max_turns限制）
- 第三章（Cache优化策略）
- 第一章（故障模式①循环失控 + ④工具错误吞）

### 课程知识点

| 知识点              | 课程文件                                                                                                                                           | 具体位置                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Tool接口定义        | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "Tool接口 + ToolRegistry"章节               |
| Agent Loop完整实现  | 同上                                                                                                                                               | "tool_use循环（执行→tool_result→回填）"章节 |
| 故障模式①循环失控   | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb`          | "故障模式①：tool_use无限循环"章节           |
| 故障模式④工具错误吞 | 同上                                                                                                                                               | "故障模式④：工具失败但agent继续"章节        |
| Tool错误处理        | Part 2笔记本                                                                                                                                       | "工具错误处理 + is_error标记"章节           |

### Claude Code源码参考

| 源码文件              | 行数  | 参考内容                     |
| --------------------- | ----- | ---------------------------- |
| `query.ts`            | 1,729 | AsyncGenerator驱动的核心循环 |
| `tools/FileReadTool/` | —     | Read工具实现参考             |
| `utils/messages.ts`   | 5,512 | 消息处理                     |

### 开发要点

- Tool接口定义
- ToolRegistry
- Read工具实现
- Agent Loop: tool_use → tool_result循环
- max_turns=50限制（故障模式①）
- try-except错误捕获（故障模式④）

---

## Phase 4: 工具集补全

### 补充文档参考

第一章（故障模式④工具错误吞）

### 课程知识点

| 知识点        | 课程文件                                                                                                                                           | 具体位置                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Write工具实现 | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "Write工具"章节                         |
| Edit工具实现  | 同上                                                                                                                                               | "Edit工具 + read-before-edit校验"章节   |
| Bash工具spawn | 同上                                                                                                                                               | "Bash工具（spawn / cwd / timeout）"章节 |
| Glob/Grep工具 | 同上                                                                                                                                               | "Glob + Grep工具"章节                   |
| 长输出截断    | 同上                                                                                                                                               | "长输出截断、行号等体验优化"章节        |

### Claude Code源码参考

| 源码文件               | 参考内容       |
| ---------------------- | -------------- |
| `tools/FileEditTool/`  | Edit工具实现   |
| `tools/FileWriteTool/` | Write工具实现  |
| `tools/BashTool/`      | Bash spawn实现 |
| `tools/GlobTool/`      | 文件搜索       |
| `tools/GrepTool/`      | 内容搜索       |

### 开发要点

- Write/Edit/Bash/Glob/Grep/LS工具
- read-before-edit校验
- spawn + cwd + timeout
- 长输出截断

### ✅ 已实现增强（2026-06-06）—— 与 CC 工具能力对齐

按「能力差距 + 高频 + 确定性收益」补齐与 CC 的差距（集中在 Grep）：Grep 加 `output_mode`（`files_with_matches` 默认 / `content` / `count`）、上下文行（rg `-B/-A/-C`）、`type` 过滤、`head_limit`+`offset` 分页；Read 加 `MAX_OUTPUT_CHARS = 100_000` 在行边界兜底。命名沿用本仓 snake_case，对齐能力而非照搬 JSON key。TDD，174 用例全绿。

**推迟到后续 phase**：Read 多模态（图片/PDF/Jupyter）——见 Phase 6.6 开发要点；当前多为文本模型，YAGNI。

---

## Phase 5: 权限模型

### 补充文档参考

- 第一章（故障模式⑥缺权限闸）
- 11.3（Claude Code 23项Bash安全检查）

### 课程知识点

| 知识点                | 课程文件                                                                                                                                           | 具体位置                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 故障模式⑥缺权限闸     | `【专题课】Harness Engineering驾驭工程实战\Part 1. Harness Engineering 驾驭工程-原理与概念\Harness_Engineering_第一节课_原理与概念.ipynb`          | "故障模式⑥：任意工具可执行"章节              |
| PermissionManager设计 | 同上                                                                                                                                               | "pre-tool hook + 权限决策接口"章节           |
| 权限模式设计          | `【专题课】Harness Engineering驾驭工程实战\Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\Harness_Engineering_第二节课_mini-Harness.ipynb` | "权限模式（default/acceptEdits/bypass）"章节 |
| Bash安全检查          | `【专题课】Claude Code架构与源码深度解析\Part 2. Claude Code 浓缩版第 1 节·能力与安全边界\ClaudeCode专题课第2节-架构解析.ipynb`                    | "23项Bash安全检查"章节                       |

### Claude Code源码参考

| 源码文件               | 行数  | 参考内容             |
| ---------------------- | ----- | -------------------- |
| `bashSecurity.ts`      | 2,592 | 23项安全检查完整实现 |
| `bashPermissions.ts`   | —     | 权限管理             |
| `shouldUseSandbox.ts`  | —     | 沙箱判断逻辑         |
| `types/permissions.ts` | —     | 权限类型定义         |

### 开发要点

- PermissionManager接口
- pre-tool hook
- 权限对话框UI
- 权限模式: default / acceptEdits / bypassPermissions
- Bash安全检查（参考23项清单）

### ✅ 已实现（2026-06-04）

三层 `settings.json` 配置（用户 < 项目 < 本地，标量覆盖 / permission 数组拼接 / env 兜底），`.env` 退役；权限模型 `Tool(specifier)` 文法 + `decide()` 判定（禁用 → deny → bypass → allow+会话层 → ask → defaultMode），**deny 硬护栏压过 bypass**；`ask` 交互弹框四档裁决（本次 / 本会话 / 写盘 / 拒绝）；工具暴露开关。**未做**：CC 的 23 项 Bash 安全检查，v1 只用 `deny` 规则做粗护栏。设计与全部细节见 spec [→](../specs/2026-06-04-zuse-settings-and-permissions-design.md)。

### ✅ 已增强（2026-06-06）—— Bash 复合命令权限拆分 + cwd 持久化

权限闸补上复合命令拆分：`splitBashCommand` 按顶层 `&& || ; |`/换行（引号内不拆）拆子命令，`decide()` 对 Bash 改为「deny 任一子命令命中即拒 / allow 需整条被完整覆盖 / ask 任一子命令命中即问」，堵住 `Bash(git status*)` 放行 `git status && rm -rf ~` 的提权洞；命令含 `$(...)`/反引号时禁用逐子命令自动放行、强制 ask。另：Bash 的 `cd` 经临时文件 `pwd` 回捕 + `ctx.setCwd` 回写，跨命令/跨回合持久化工作目录（仅 bash/sh；pwsh/cmd 不持久）。详见下方 Phase 5.5 把这块归位到「执行环境」专题。

---

## Phase 5.5: Bash 执行环境与隔离（环境快照 / sandbox / tmux）

> **为什么单列一个 Phase**：这三项都不是「再加一个工具」，而是改 Bash 的**执行模型**——命令在什么环境里跑、被关在多大的盒子里、会不会踩到用户自己的会话。它们紧贴 Phase 4（Bash 工具）与 Phase 5（权限闸），但都比一条工具重得多，且**强平台相关**，故从 Phase 5 拆出来单独排期。
>
> **现实约束（务必先认清，别白做）**：zuse 主力开发机是 **Windows**。三项里只有「环境快照」在 Windows（git-bash）下有完整意义；**sandbox 与 tmux 在 Windows 上没有原生实现**（CC 也是 sandbox 仅 macOS/Linux/WSL2、tmux 仅经 `wsl -e tmux`）。所以本 Phase 的落地顺序与优先级按「确定性收益 × 当前平台可用性」排：**环境快照 ≫ tmux 套接字隔离 > sandbox**。
>
> **课程对应**：无直接课程，全部对齐 Claude Code 行为（源码见各小节）。

### 5.5.1 登录 shell 环境快照（login-shell snapshot）—— 优先级最高 ⭐

**要解决的痛点**：zuse 现在用 `spawn(shell, ...)` 跑命令，子 shell **不读** `.bashrc`/`.zshrc`/`.profile`，于是用户在交互终端里有的 alias、shell 函数、以及 nvm/volta/mise/pyenv/homebrew 往 PATH 注入的工具，在 zuse 跑的命令里**全看不到**——典型表现：用户终端里 `node`/`pnpm` 能跑，zuse 里 `command not found`。

**CC 怎么做的**（`src/utils/bash/ShellSnapshot.ts`，已读）：

- 启动时执行一次 `binShell -c -l <脚本>`（`-l` 走 login shell），脚本 `source` 用户的 rc 文件，然后把结果**dump 成一个快照 `.sh`**：用户函数（`declare -f`，base64 编码避免特殊字符破坏）、shell 选项（`shopt -p` / `setopt`）、alias（`alias` 列表，Windows 下过滤掉 `winpty` alias 防 "stdin is not a tty"）、以及 `source` 后的 `PATH`（`printf 'export PATH=%q'`）。
- 快照存到 `~/.claude/shell-snapshots/snapshot-<shell>-<ts>-<rand>.sh`，进程退出时 cleanup 删除。
- **此后每条 Bash 命令开头 `source` 这个快照**——等于「一次性付 login shell 的钱，之后每条命令复用」，不必每条都开 login shell（慢）。
- 创建失败（超时 10s / 权限问题）**优雅降级**：照常跑命令，只是没有用户的 alias/函数。

**选型（zuse 落地）**：

| 环节         | 方案                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| 触发时机     | 会话启动时异步建一次快照，缓存路径；Bash 工具首次用前 await 就绪（失败则降级）         |
| 快照内容     | v1 先做**最高收益的 PATH + alias + 函数**三样；shell options 可后置                    |
| 落盘位置     | `~/.zuse/shell-snapshots/`（沿用 zuse 配置目录约定），cleanup 注册删除                 |
| shell 适配   | 复用现有 `getShellLabel()`：bash/zsh/sh 各自的 rc 文件名与 `declare -f`/`typeset -f` 差异 |
| Windows      | git-bash 走 `.bashrc`；过滤 `winpty` alias；`ARGV0`/`exec -a` 差异照搬 CC 的分支       |

**开发要点**：

- 与已做的 **cwd 持久化**（Phase 5.5 归位的那块）协同：命令实际执行串 = `source 快照; cd 到 sessionCwd; <用户命令>; 回捕 pwd`。注意 `source` 与 cwd 回捕的先后、退出码透传（`exit $?`）不能被 `source`/`pwd` 的 0 掩盖。
- 安全：快照是「把用户 rc 的副作用固化」，本身不扩大权限面，但要确保快照文件落在用户私有目录、权限收紧。
- 降级路径必须测：rc 不存在、`source` 报错、超时——都不能让 Bash 工具挂掉。
- **不做**：CC 那套把 `find`/`grep`/`rg` 用 bun 内嵌二进制 `ARGV0` 派发的把戏（zuse 没有内嵌搜索二进制，直接用系统 rg / 自带 Grep 工具即可）。

### 5.5.2 tmux 套接字隔离 —— 中优先级（依赖是否引入 tmux 执行后端）

**两个层面，别混为一谈**：

1. **套接字隔离（轻、该做）**：只要 zuse 允许模型跑 `tmux ...`（哪怕只是普通 Bash 里），就有「误杀用户自己 tmux 会话」的风险（`tmux kill-server` 之类）。CC 的解法（`src/utils/tmuxSocket.ts`，已读）：给 Claude 开**自己的 tmux 套接字** `claude-<PID>`，所有 tmux 命令带 `-L claude-<PID>`，并给所有 Bash 子进程注入指向该套接字的 `TMUX` env，**屏蔽用户原本的 `TMUX`**。这样模型怎么折腾都只动 Claude 自己的 server，碰不到用户的会话。Windows 上 tmux 只存在于 WSL，经 `wsl -e tmux` 调用。
2. **tmux 作为执行后端（重、归 Phase 11）**：CC 用 tmux pane 跑后台/异步命令、以及多 agent（swarm/teammate）的 pane 后端（`src/utils/swarm/backends/TmuxBackend.ts`）。这是**真正的隔离执行模型**，与多 Agent 编排强耦合——**这部分挪到 Phase 11（多Agent与编排）**去做，不在 5.5。

**选型 / 开发要点（仅做第 1 层）**：

- 仅当探测到 `tmux` 可用（或 Windows 上 WSL 内可用）时启用；否则空操作，不影响普通 Bash。
- 启动期创建 `zuse-<PID>` 套接字，注入 `TMUX`/`-L` 到 Bash 执行环境（可并入 5.5.1 的快照/env 注入管线）；退出 cleanup 杀掉该 server。
- **优先级判断**：只有当 zuse 真的鼓励模型用 tmux（如做后台长任务）时才有收益。当前 v1 没有后台任务能力，故**排在环境快照之后**；可与 Phase 11 的 tmux 后端一并立项。

### 5.5.3 OS 级 sandbox —— 低优先级 / Windows 暂不可做

**CC 怎么做的**（`shouldUseSandbox.ts` + `src/utils/sandbox/sandbox-adapter.ts`，已读）：

- 底座是**外部包** `@anthropic-ai/sandbox-runtime`——macOS 用 Seatbelt（`sandbox-exec`），Linux 用 bubblewrap + seccomp + 网络代理（socat）。**支持平台：macOS / Linux / WSL2；Windows 原生不支持**（`isSupportedPlatform()`）。
- adapter 把 CC 的 settings/permission 规则翻译成 sandbox 配置：`allowWrite`/`denyWrite`/`denyRead`（cwd 与临时目录可写、settings.json 与 `.claude/skills` 强制只读防逃逸）、网络 `allowedDomains`/`deniedDomains`（从 WebFetch 规则抽取）。
- 关键价值有二：① **限制副作用面**（命令只能写白名单路径、只能连白名单域名）；② **`autoAllowBashIfSandboxed`**——一旦命令在 sandbox 里跑，就可以**免确认自动放行**只读类命令（因为越权被 OS 挡住了），大幅减少打扰。
- 还有一堆硬化细节：bare-repo 文件投毒防护（`git` 逃逸）、worktree 主仓可写、依赖缺失（bubblewrap/socat 未装）时的显式告警而非静默失效。

**选型（zuse 落地评估）**：

| 维度       | 评估                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| OSS 可用   | macOS：系统自带 `sandbox-exec`（已弃用但可用）；Linux：`bubblewrap`(LGPL)+`socat`。可直接评估复用 `@anthropic-ai/sandbox-runtime`（若其 license/可用），否则自写薄封装 |
| Windows    | **无对等机制**。Windows 上要隔离只能走 WSL2（即在 WSL 里跑 Linux sandbox）或容器；纯 Win32 无解 |
| 与权限闸关系 | sandbox 是 Phase 5 权限闸的**OS 级补强**：权限闸是「问不问」，sandbox 是「就算放行也关在盒子里」。两者叠加才有 `autoAllowBashIfSandboxed` 的体验红利 |

**开发要点 / 排期**：

- **明确推迟**：当前主力平台 Windows 无原生 sandbox，且 zuse v1 已用「deny 硬护栏 + 复合命令拆分」做了粗护栏，sandbox 的边际收益在 Windows 上≈0。**等有 macOS/Linux 部署需求时再立项**。
- 真要做时的最小切口：先做**只读命令检测 + 沙箱内自动放行**（对齐 `autoAllowBashIfSandboxed`），平台限定 macOS/Linux/WSL2，Windows 直接走原有权限闸；依赖缺失要像 CC 那样**显式告警**（避免用户以为开了 sandbox 实际没生效的安全 footgun）。
- 阻塞项：先定「自研薄封装 vs 复用现成 sandbox-runtime」——取决于该包是否独立可用及 license。

### 本 Phase 推进建议（小结）

1. **先做 5.5.1 环境快照**（跨平台、确定性收益、解决 `command not found` 类真痛点，且与已做的 cwd 持久化天然同管线）。
2. **再评估 5.5.2 tmux 套接字隔离**（只在引入 tmux/后台任务时才有收益，可与 Phase 11 合并）。
3. **5.5.3 sandbox 挂起**，等非 Windows 部署场景出现再启动；在那之前以现有权限护栏兜底。

---

## Phase 6: 多Provider

### 补充文档参考

第三章（Cache优化）

### 课程知识点

| 知识点                  | 课程文件                                                                                                                                                           | 具体位置                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Provider抽象层          | `【专题课】Harness Engineering驾驭工程实战\Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\HarnessEngineering第四节-Hermes基础与记忆系统.ipynb` | "ModelClient接口抽象"章节      |
| Anthropic vs OpenAI差异 | 同上                                                                                                                                                               | "tool_use格式差异"章节         |
| Prompt Caching          | 同上                                                                                                                                                               | "Anthropic Prompt Caching"章节 |

### Claude Code源码参考

—（Provider抽象层自研）

### 开发要点

- ModelClient接口抽象
- AnthropicClient + OpenAIClient实现
- Provider无关事件类型
- /model切换
- Cache: cache_control参数

### ✅ 已实现（2026-06-05）

数据驱动 `providers` registry（加 provider = 一条配置 + 一个 env var）；手搓 `AnthropicClient`（原生 + DashScope 兼容，`cache_control` 三断点）与 `OpenAIClient`（`tool_call` 分片累积 + usage 抽取）；`createModelClient` 按 `protocol` 分发；`/model` 运行时切换（`--save` 写盘，不清历史）；footer 显示缓存命中。TDD，126 用例全绿。设计与全部细节见 spec [→](../specs/2026-06-05-zuse-multi-provider-design.md)。

---

## Phase 6.5: 联网工具（WebFetch / WebSearch）

### 补充文档参考

—（设计文档 §2 把"文件上传/多模态"列为 out-of-scope，但联网读取/检索是 coding agent
的常用能力，单列一个轻量 Phase；放在 Phase 6 之后是因为它依赖多 Provider 抽象做抽取，
依赖 Phase 5 权限闸做授权。）

### 课程知识点

无直接对应课程，参考 Claude Code 的 WebFetch/WebSearch 行为对齐。

### Claude Code 行为参考

| 工具         | CC 行为                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| **WebFetch** | 抓 URL → HTML 转 Markdown → 用**小/快模型**按 prompt 抽取答案；约 15 分钟缓存 |
| **WebSearch**| 走 Anthropic 后端搜索，只回 标题/URL，**不抓正文**；正文再交给 WebFetch       |

### 选型（开源免费优先）

| 环节                | OSS/免费方案                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| HTML→Markdown       | `turndown`(MIT) 或 `node-html-markdown`；正文抽取可加 `@mozilla/readability`     |
| 抽取用的小模型      | 复用 Phase 6 的 ModelClient，配一个便宜模型（如各家的 mini/flash 档）            |
| 搜索 provider       | **无现成 OSS 二进制**——需接一个搜索 API。OSS 自托管首选 **SearXNG**（元搜索，   |
|                     | 全开源）；托管免费档可选 Tavily / Brave Search API。**这是个 provider 决策，待定** |

### 开发要点

- WebFetch：fetch → 转 Markdown → 小模型抽取；带短期缓存（防重复抓取）
- WebSearch：封装搜索 provider，返回 标题/URL 列表；正文按需交给 WebFetch
- 两者都走 Phase 5 权限闸（CC 中均为需授权工具）
- provider 配置沿用数据驱动思路：加搜索源 = 一条配置 + 一个 env var
- **阻塞项**：先定搜索 provider（SearXNG 自托管 vs Tavily/Brave 托管）再动 WebSearch

### ✅ 已实现（2026-06-06）—— WebFetch

抓 URL → jsdom+readability 抽正文 → turndown 转 Markdown 交主模型（不在工具内调 LLM）；进程内 15min 缓存；非 `readOnly`，`specifierFor` 按 hostname 收窄；**Cloudflare 邮箱混淆确定性解码**（否则 `python@3.12` 被抹成占位符 `[email protected]`，模型只能幻觉）；不执行 JS、抓不到 SPA 正文时返回提示而非空白。TDD，21 新用例全绿。设计与全部细节见 spec [→](../specs/2026-06-06-zuse-webfetch-design.md)。

### ✅ 已实现（2026-06-06）—— WebSearch + 全局出站代理

WebSearch 落定为托管 API + 数据驱动多后端（Tavily 主 / Brave 回退，加后端 = 一条注册）：只回标题/URL/摘要，正文交 WebFetch；回退链区分可回退（401/403/429/5xx/网络）与不可回退（400/422）；**会话内拉黑**仅对 401/403 永久鉴权失败、不持久化。**全局出站代理** `installProxy` 在 bin 入口装 undici 全局 dispatcher，使所有 `globalThis.fetch`（大模型 API / WebFetch / WebSearch）走代理——Node fetch 不读系统/`HTTP_PROXY` 但读 undici dispatcher。TDD，208 用例全绿。设计与全部细节见 spec [→](../specs/2026-06-06-zuse-websearch-design.md)。

**Phase 6.5 至此完成**（WebFetch + WebSearch + 全局代理全部落地）。

---

## Phase 6.6: 代码智能（LSP）

### 补充文档参考

—（CC 的 LSP 工具：跳转定义 / 找引用 / 类型查询，只读代码智能。归在工具扩展段，紧挨
联网工具；只读、无需授权，主要依赖 Phase 4 的进程 spawn 基建。）

### 课程知识点

无直接对应课程，参考 CC 的 LSP 工具行为。

### 选型（开源免费优先）

| 环节        | OSS/免费方案                                                                       |
| ----------- | ---------------------------------------------------------------------------------- |
| LSP 客户端  | 走标准 LSP（JSON-RPC over stdio），自写薄客户端                                     |
| 语言服务器  | TS/JS：`typescript-language-server`；其余语言按需挂对应 OSS language server         |

### 开发要点

- 薄 LSP 客户端：spawn language server，JSON-RPC 收发（复用 Phase 4 的 spawn 经验）
- 暴露 定义跳转 / 找引用 / 悬停类型 三个高频能力
- 按 cwd 探测项目语言，懒启动对应 server，复用同一进程
- 只读、无副作用 → 不进权限闸

#### ⏳ Read 多模态（从 Phase 4 对齐工作推迟过来）

CC 的 Read 能读图片（PNG/JPG，视觉呈现给多模态模型）、PDF（`pages` 参数）、Jupyter notebook（`.ipynb`，含 cell 输出）；zuse 当前的 Read 仅文本。推迟而非现做的理由：当前 provider 多为纯文本模型，多模态 Read 需要先有视觉模型接入才有意义（YAGNI）。真要做时的要点：

- 按扩展名/MIME 分流：图片 → base64 走多模态 content block；PDF → 取指定页转图或抽文本；`.ipynb` → 解析 cell + 输出。
- 依赖能力探测：仅当当前 provider/模型声明支持视觉时才启用图片路径，否则回退报错提示。
- 与现有文本 Read 同流水线（路径解析、tracker 登记、错误归一）共存，只是 content 形态不同。

---

## Phase 7: UI打磨

### 补充文档参考

—（UI层，课程略讲）

### 课程知识点

无直接对应课程，参考Claude Code源码

### Claude Code源码参考

| 源码目录      | 行数   | 参考内容                  |
| ------------- | ------ | ------------------------- |
| `ink/`        | 19,842 | 终端UI引擎（50x性能优化） |
| `components/` | 81,546 | UI组件库                  |
| `hooks/`      | 19,204 | React Hooks（87个）       |

### 开发要点

- Edit diff渲染
- /tools列表
- /history滚动
- Ctrl+C/Esc处理
- footer显示
- **`/model` 交互式选择器**（设计已定，2026-06-06）
- 权限批准框改 CC 风格可选列表 / 输入框多行编辑 / 工具执行展示对齐 CC / TUI 文案全中文化 / Markdown 富渲染（详见下方各小节，2026-06-06 从 BACKLOG 折叠进来）

#### `/model` 交互式选择器（已敲定的设计决策）

把现在 `/model` 无参时的 40+ 行纯文本 dump 换成一个交互式覆盖层。**形态：键盘驱动 + 输入即模糊过滤 + 滚动视口**：

- 方向键 / `j k` 移动，输入字符即时过滤候选（输 `mimo` → 直接筛到一条），`Enter` 选中切换，`Esc` 取消。
- 超出高度用滚动视口 + 位置指示（`↑更多 / ↓更多`）。
- 当前模型高亮（复用现有 `currentProviderId` + `currentModel` 配对判定）。

**明确不做鼠标点击**，理由（避免 Phase 7 时重新纠结）：

1. Ink 不原生支持鼠标，得手开终端鼠标追踪（SGR 1006）+ 自解析 stdin 原始事件，脆且重。
2. 一旦开 app 鼠标捕获，就抢了终端自身的拖选复制；且 tmux / SSH / 部分终端鼠标事件传不进来。
3. 非 TUI 惯用法（fzf / lazygit / gh / Claude Code 全是键盘驱动）。

**与已有校验逻辑的关系**：选择器从过滤后的列表里选，天然选不到不存在的模型，`mino→mimo` 那类拼错从源头消除。Phase 6 收尾时给 `/model <ref>` 直输路径加的「不在清单 → 警告 / 相近候选则拒绝切换 / 否则切换但不写盘」逻辑（见 [`packages/tui/src/commands/registry.ts`](../../../packages/tui/src/commands/registry.ts)）**保留**，退化为非交互直输路径与脚本/自动化的兜底。

**待定点**：用 `ink-select-input`（已在依赖友好范围）还是自写一个带 filter 的小组件——开发前再定。

#### 权限批准框改成 CC 风格可选列表

现状：[`packages/tui/src/components/PermissionDialog.tsx`](../../../packages/tui/src/components/PermissionDialog.tsx) 用单键裁决（`y` 本次 / `a` 本会话 / `A` 写盘 / `n`·Esc 拒绝），靠用户记快捷键。期望：像 CC 那样弹一个可上下方向键移动、回车选中的下拉选项列表（默认单选；以后需要再扩展多选）。纯交互呈现层打磨——**不动 Phase 5 的权限判定逻辑**（`permission.ts` 的 `decide` 与 `PermissionVerdict` 四档裁决不变），只把呈现从"按键提示"换成"选项列表"，文案保持全中文。

#### 输入框多行编辑 + Alt+Enter 换行

现状：[`packages/tui/src/components/InputBox.tsx`](../../../packages/tui/src/components/InputBox.tsx) 用 `ink-text-input` 单行输入，回车即提交。期望：Alt+Enter 插入换行、输入框随行数增高，回车仍提交。`ink-text-input` 是单行组件做不了，需换方案——自写 `useInput` 维护行缓冲，或换一个多行输入组件。纯 UI，不涉及 core。

#### 工具执行展示对齐 CC 风格

现状：[`packages/tui/src/components/StreamRenderer.tsx`](../../../packages/tui/src/components/StreamRenderer.tsx) 的 `ToolBlock`——运行时一个 spinner、完成后 `✓`/`✗`，旁边一行青色 `Name(args)`，下面只有一行暗色输出首行预览（截 80 字符），看不到"为什么调"和完整 IN/OUT。期望对齐 CC，每次工具调用渲染成一个**带框**的块，含三段：

- **为什么执行**：模型在该工具调用前后的意图说明（助手文本里"我来读一下 X / 接着跑测试"那类前导句）。当前 `StreamRenderer` 把助手文本和工具块分开渲染，需把工具调用和它的前导理由关联起来展示（可能要在 `useConversation` 里把前导文本与紧随的 tool_use 关联，记下这点依赖）。
- **IN**：本次调用的完整入参（不只是单行摘要）。
- **OUT**：工具返回内容，带按工具类型定制的摘要——`Read` 在标题旁直接显示文件名，参照 CC 去掉括号、只写工具名 + 参数（如 `Read src/index.ts` 配 `Read 120 lines`，不要 `Read(src/index.ts)`），`Glob` 报命中文件数（`Found 8 files`），`Grep` 报输出行数（`49 lines of output`），`Edit`/`Write` 显示行变更数（`+2 -3`）；多行折叠可展开，错误态明显标识。
- 整块用边框（类似 CC 的 `●` 标题 + `⎿` 缩进引导）框起来。纯呈现层，不动工具执行逻辑。

#### TUI 文案全中文化

现状散落英文：`App.tsx` 的 `Zuse Chat (Ctrl+C to exit)` / `Error:`；`InputBox.tsx` 的占位符 `Type your message...` / `Waiting for response...`；`UsageFooter.tsx` 的 `Model:` / `Total:` / `No tokens yet` / `Thinking...`；`StreamRenderer.tsx` 的 `Tokens: ... in / ... out` / `error:`。统一改中文。纯文案、零逻辑，顺手在 Phase 7 一起做。

#### Markdown 富渲染

现状：助手回复走 `StreamRenderer.tsx` 的 `<Text>{text}</Text>`，Ink 不解析 markdown，`## 标题`、`**加粗**`、代码块都显示成字面量。

- 选型 A：`marked` + `marked-terminal` 或 `ink-markdown`，省事。
- 选型 B（更贴合"手搓"学习目标）：自渲染。难点是流式——文本由 `text-delta` 逐段拼接，某一刻可能只拿到半个代码围栏，边解析边渲染会闪烁。参考 CC 双态策略：流式期间按纯文本走，`message-stop` 定稿后再重渲染成富文本。这个"流式 vs 定稿"双态值得专门学。

---

## Phase 8: 会话管理

### 补充文档参考

- 第四章（Token Budget完整策略 + 压缩触发条件）
- 11.6（AutoCompact策略）

### 课程知识点

| 知识点                | 课程文件                                                                                                                                               | 具体位置                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| 记忆压缩策略          | `【Part 7】智能体长短期记忆管理\Part 1. 大模型 Agent 长短期记忆管理基础入门\大模型Agent长短期记忆管理基础入门.ipynb`                                   | "压缩策略"章节              |
| 上下文工程基础        | `【Part 8】智能体上下文工程\Part 1. AI Agent 上下文工程管理基础入门\大模型Agent上下文工程基础入门.ipynb`                                               | "Context Window Budget"章节 |
| 组合编排实战          | `【Part 8】智能体上下文工程\Part 2. 大模型 Agent 上下文工程进阶——组合编排实战\大模型 Agent 上下文工程进阶—组合编排实战.ipynb`                          | "system prompt拼接"章节     |
| Claude Code上下文工程 | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "约束工作台"章节            |

### Claude Code源码参考

| 源码目录/文件       | 参考内容            |
| ------------------- | ------------------- |
| `services/compact/` | AutoCompact压缩服务 |
| `utils/messages.ts` | MicroCompact实现    |

### 开发要点

- session按cwd分组
- --continue / --resume参数
- 每轮自动保存
- Token Budget分配
- 压缩策略: keep_recent_n + summarize_middle

---

## Phase 9: 项目记忆

### 补充文档参考

- 第五章（记忆系统SQLite + FTS5 + 表结构）
- 11.2（四种记忆类型定义）

### 课程知识点

| 知识点              | 课程文件                                                                                                                                                           | 具体位置                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Hermes记忆系统架构  | `【专题课】Harness Engineering驾驭工程实战\Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\HarnessEngineering第四节-Hermes基础与记忆系统.ipynb` | "SQLite + FTS5全文搜索"章节     |
| Nudge机制           | 同上                                                                                                                                                               | "自动review并更新MEMORY.md"章节 |
| 四维评价尺          | 同上                                                                                                                                                               | "GC/AC/CE/入口治理"章节         |
| mem0集成实战        | `【Part 7】智能体长短期记忆管理\Part 2. Agent 记忆管理系统进阶——mem0+Claude Code 集成实战\大模型Agent长短期记忆管理进阶实战.ipynb`                                 | "mem0记忆管理"章节              |
| Claude Code记忆系统 | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb`             | "第四章：约束记忆"章节          |

### Claude Code源码参考

| 源码文件                         | 参考内容           |
| -------------------------------- | ------------------ |
| `memdir/memdir.ts`               | 记忆目录核心逻辑   |
| `memdir/memoryTypes.ts`          | 四种记忆类型定义   |
| `memdir/memoryScan.ts`           | 记忆扫描           |
| `memdir/findRelevantMemories.ts` | 相关记忆检索       |
| `services/autoDream/`            | Auto Dream记忆巩固 |

### 开发要点

- 加载 ~/.zuse/SYSTEM.md
- cwd向上找 ZUSE.md
- SQLite + FTS5存储
- Nudge机制（自动更新MEMORY.md）

---

## Phase 10+: Skills系统

### 补充文档参考

- 第六章（SKILL.md格式 + 目录结构）
- 11.4（多Agent架构）
- 11.7（Skills实现）

### 课程知识点

| 知识点               | 课程文件                                                                                                                                               | 具体位置                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Agent Skills基础入门 | `【Part 6】Agent Skills\Part 1. 大模型 Agent Skills 基础入门\大模型Agent_Skills_基础入门.ipynb`                                                        | 全部内容                   |
| Skills设计实战       | `【Part 6】Agent Skills\Part 2. 大模型 Agent Skills 设计实战\大模型AgentSkills设计实战.ipynb`                                                          | 全部内容                   |
| SKILL.md格式详解     | 同上Part 1的"其他资料/other/skills/skill-creator-pro/SKILL.md"                                                                                         | frontmatter + workflow结构 |
| 多Agent架构          | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "Coordinator Mode"章节     |
| LangGraph多Agent     | `【专题课】Agent框架 LangGraph应用实战\7. LangGraph Multi-Agent Systems 开发实战.ipynb`                                                                | "Multi-Agent Systems"章节  |

### Claude Code源码参考

| 源码目录/文件                    | 参考内容      |
| -------------------------------- | ------------- |
| `skills/` (4,066行)              | Skill系统实现 |
| `coordinator/coordinatorMode.ts` | 多Agent编排   |
| `tools/AgentTool/`               | 子Agent生成   |
| `tools/SendMessageTool/`         | Agent间通信   |

### 开发要点

- SKILL.md格式定义
- 技能加载机制
- 技能匹配触发
- 多Agent Coordinator模式 → 抽到 **Phase 11** 单独做

---

## Phase 11: 多Agent与编排

### 补充文档参考

11.4（多Agent架构）

### 课程知识点

| 知识点               | 课程文件                                                                                                                                               | 具体位置                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 多Agent架构          | `【专题课】Claude Code架构与源码深度解析\Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb` | "Coordinator Mode"章节    |
| LangGraph多Agent     | `【专题课】Agent框架 LangGraph应用实战\7. LangGraph Multi-Agent Systems 开发实战.ipynb`                                                                | "Multi-Agent Systems"章节 |

### Claude Code 工具对照

| 工具                          | 作用                                       |
| ----------------------------- | ------------------------------------------ |
| **Agent**（= 老的 Task）      | 生成子 Agent 执行隔离的子任务，返回结果      |
| **TeamCreate / TeamDelete**   | 创建/销毁可寻址的 agent team                 |
| **SendMessage**               | 子 Agent 间 / 与子 Agent 通信                |
| **Workflow**                  | 确定性多 Agent 编排脚本（fan-out / pipeline）|

### Claude Code 源码参考

| 源码目录/文件                    | 参考内容      |
| -------------------------------- | ------------- |
| `coordinator/coordinatorMode.ts` | 多Agent编排   |
| `tools/AgentTool/`               | 子Agent生成   |
| `tools/SendMessageTool/`         | Agent间通信   |

### 开发要点

- Agent/Task 工具：子 Agent 隔离上下文跑子任务，结果回填父循环（max_turns、token 预算独立）
- team 注册表 + SendMessage 通信通道
- Workflow：确定性编排（parallel / pipeline 原语），子 Agent 并发上限 + 总数兜底
- 自研为主——无现成 OSS 二进制可换（与 CC 一致，多 Agent 编排是手搓）
- **tmux pane 执行后端**（从 Phase 5.5.2 引来）：CC 用 tmux pane 跑 teammate（`swarm/backends/TmuxBackend.ts`）。若 zuse 的多 Agent 要做「每个 teammate 一个可见 pane / 后台持久执行」，在此实现 pane 后端；与 5.5.2 的 tmux 套接字隔离（`zuse-<PID>` 专属 socket）共用同一套 tmux 基建。Windows 经 `wsl -e tmux`。

---

## Phase 12: 调度与自动化（Cron / Wakeup）

### 补充文档参考

—（CC 的 Cron / ScheduleWakeup：定时触发与自唤醒。属于自动化能力，依赖会话管理
（Phase 8）能 resume，放在最后。）

### Claude Code 工具对照

| 工具                                | 作用                       |
| ----------------------------------- | -------------------------- |
| **CronCreate / CronDelete / CronList** | 注册/删除/列出定时任务      |
| **ScheduleWakeup**                  | 会话内自唤醒（延时再跑）    |

### 选型（开源免费优先）

| 环节       | OSS/免费方案                                                          |
| ---------- | -------------------------------------------------------------------- |
| 进程内调度 | `node-cron` / `croner`（轻量、MIT）                                   |
| 持久化触发 | 或委托 OS 调度器（Windows 任务计划 / cron），zuse 以 `--resume` 拉起 |

### 开发要点

- Cron 任务表：cron 表达式 + 目标会话 + 触发动作，持久化到 ~/.zuse/
- ScheduleWakeup：相对延时的一次性唤醒
- 触发时以 `--resume` 拉起对应会话（依赖 Phase 8 会话管理）
- 自动化跑务必走 Phase 5 权限闸，避免无人值守下的越权

---

## 快速查阅索引

### 按知识点查课程

| 知识点              | 课程文件                                                            |
| ------------------- | ------------------------------------------------------------------- |
| Agent Loop核心循环  | 【专题课】Harness Engineering驾驭工程实战/Part 2/mini-Harness.ipynb |
| 8个故障模式全览     | 【专题课】Harness Engineering驾驭工程实战/Part 1/原理与概念.ipynb   |
| 权限模型设计        | 【专题课】Harness Engineering驾驭工程实战/Part 1 + Part 2           |
| 23项Bash安全检查    | 【专题课】Claude Code架构与源码深度解析/Part 2/架构解析.ipynb       |
| Token Budget + 压缩 | 【Part 7】+【Part 8】+ Claude Code专题课Part 3                      |
| SQLite记忆系统      | 【专题课】Harness Engineering驾驭工程实战/Part 4/Hermes.ipynb       |
| 四种记忆类型        | Claude Code专题课Part 3 + Hermes Part 4                             |
| Skills SKILL.md格式 | 【Part 6】Agent Skills/Part 1/其他资料/skill-creator-pro/SKILL.md   |
| 多Agent Coordinator | Claude Code专题课Part 3 + LangGraph Part 7                          |

### 按源码查参考

| 源码文件                 | Zuse对应Phase |
| ------------------------ | ------------- |
| query.ts (1729行)        | Phase 1, 3    |
| bashSecurity.ts (2592行) | Phase 5       |
| context/ (1004行)        | Phase 2, 8    |
| services/compact/        | Phase 8       |
| memdir/ (1736行)         | Phase 9       |
| skills/ (4066行)         | Phase 10+     |
| coordinator/             | Phase 10+     |

---

## 课程文件完整路径索引

### Harness Engineering专题课

```
【专题课】Harness Engineering驾驭工程实战\
├── Part 1. Harness Engineering 驾驭工程-原理与概念\
│   └── Harness_Engineering_第一节课_原理与概念.ipynb
│       ├── 知识点: Agent=Model+Harness公式
│       ├── 知识点: 8个故障模式
│       ├── 知识点: 8大机制
│       └── 知识点: 3支柱(CE/AC/GC)
│
├── Part 2. Harness Engineering 驾驭工程-手搓 Mini Harness\
│   └── Harness_Engineering_第二节课_mini-Harness.ipynb
│       ├── 知识点: Agent Loop实现
│       ├── 知识点: Tool接口定义
│       ├── 知识点: 工具集(Read/Write/Edit/Bash/Glob/Grep)
│       └── 知识点: 权限模式框架
│
├── Part 4. Harness Engineering 驾驭工程 · Hermes Agent 智能体拆解实战\
│   └── HarnessEngineering第四节-Hermes基础与记忆系统.ipynb
│       ├── 知识点: SQLite+FTS5记忆系统
│       ├── 知识点: Nudge机制
│       ├── 知识点: Provider抽象层
│       └── 知识点: 四维评价尺
```

### Part 7 + Part 8 记忆与上下文

```
【Part 7】智能体长短期记忆管理\
├── Part 1. 大模型 Agent 长短期记忆管理基础入门\
│   └── 大模型Agent长短期记忆管理基础入门.ipynb
│       ├── 知识点: 热记忆vs冷记忆
│       ├── 知识点: 记忆分层模型
│       └── 知识点: 压缩策略
│
└── Part 2. Agent 记忆管理系统进阶——mem0+Claude Code 集成实战\
    └── 大模型Agent长短期记忆管理进阶实战.ipynb
        └── 知识点: mem0集成

【Part 8】智能体上下文工程\
├── Part 1. AI Agent 上下文工程管理基础入门\
│   └── 大模型Agent上下文工程基础入门.ipynb
│       ├── 知识点: Context Window Budget
│       └── 知识点: 压缩触发条件
│
└── Part 2. 大模型 Agent 上下文工程进阶——组合编排实战\
    └── 大模型 Agent 上下文工程进阶—组合编排实战.ipynb
        └── 知识点: system prompt拼接
```

### Part 6 Agent Skills

```
【Part 6】Agent Skills\
├── Part 1. 大模型 Agent Skills 基础入门\
│   ├── 大模型Agent_Skills_基础入门.ipynb
│   └── 其他资料/other/skills/skill-creator-pro/SKILL.md
│       ├── 知识点: SKILL.md格式(frontmatter+workflow)
│       ├── 知识点: 技能加载机制
│       └── 知识点: Progressive Disclosure
│
└── Part 2. 大模型 Agent Skills 设计实战\
    └── 大模型AgentSkills设计实战.ipynb
```

### Claude Code专题课

```
【专题课】Claude Code架构与源码深度解析\
├── Part 2. Claude Code 浓缩版第 1 节·能力与安全边界\
│   └── ClaudeCode专题课第2节-架构解析.ipynb
│       ├── 知识点: 23项Bash安全检查
│       └── 知识点: 权限类型定义
│
├── Part 3. Claude Code 浓缩版第 3 节·多智能体与上下文工程\
│   └── Claude Code 专题课第 3 节：多智能体与上下文工程.ipynb
│       ├── 知识点: 约束工作台(上下文管理)
│       ├── 知识点: 约束记忆(四种记忆类型)
│       ├── 知识点: Coordinator Mode多Agent
│       └── 知识点: AutoCompact压缩策略
```

---

_开发每个Phase前，先查阅对应课程文件的具体知识点章节，再写详细实现计划。_
