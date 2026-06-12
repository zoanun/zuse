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
| 8     | 错误回传契约 | 一（故障模式④工具错误吞）                  | —（机制对齐 Crush / OpenCode）                                | Crush edit.go 错误分支 / OpenCode tool/edit.ts |
| 9     | 输出整形/截断 | —（反馈塑形，无直接课程）                  | —                                                              | OpenCode truncate.ts / truncation-dir.ts |
| 10    | 会话管理与上下文压缩 | 四（Token Budget）+ 11.6（压缩策略） | 【Part 7】+【Part 8】+【专题课】Claude Code架构/Part 3/        | services/compact/ + OpenCode compaction.ts |
| 11    | 鲁棒性与恢复 | —（故障注入，无直接课程）                  | —                                                              | retry.ts / stream-idle.ts + OpenCode session/llm/ |
| 12    | 检查点与回滚 | —（进阶/可选，无直接课程）                  | —                                                              | OpenCode snapshot/（影子 git）+ session/revert.ts |
| 13    | 项目记忆    | 五（记忆系统SQLite）+ 11.2（四种记忆类型）  | 【专题课】Harness Engineering驾驭工程实战/Part 4/ + 【Part 7】 | memdir/           |
| 14    | Skills系统  | 六（SKILL.md格式）+ 11.7（Skills实现）      | 【Part 6】Agent Skills/                                        | skills/           |
| 15    | 多Agent编排 | 11.4（多Agent架构）                         | Claude Code专题课Part 3 + LangGraph Part 7                     | Agent/Team/Workflow|
| 16    | 调度与自动化| —                                           | —                                                              | Cron/ScheduleWakeup|

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

三层 `settings.json` 配置（用户 < 项目 < 本地，标量覆盖 / permission 数组拼接 / env 兜底），`.env` 退役；权限模型 `Tool(specifier)` 文法 + `decide()` 判定（禁用 → deny → bypass → allow+会话层 → ask → defaultMode），**deny 硬护栏压过 bypass**；`ask` 交互弹框四档裁决（本次 / 本会话 / 写盘 / 拒绝）；工具暴露开关。设计与全部细节见 spec [→](../specs/2026-06-04-zuse-settings-and-permissions-design.md)。

### ✅ 已补齐（2026-06-09）—— Bash 23 项安全检查

新增 `packages/core/src/bash-security.ts`（对齐 CC `bashSecurity.ts` 的 23 项清单，按能力对齐而非照搬 2,592 行）。`checkBashSecurity()` 跑全部 23 项检查，分两档严重度：**block**（高置信混淆/注入/解析差异：ANSI-C/locale 引用、进程替换 `<()`/`>()`/`=()`、zsh 等号展开、`$IFS`、`/proc/<pid>/environ`、回车符、控制字符、Unicode 空白、zsh 危险内建 zmodload 等、jq system()/危险参数、git commit 内替换…）与 **warn**（日常合法但理论可滥用：重定向、`$f |`、花括号展开、换行等）。`decide()` 在 deny/bypass 之后、allow 之前插入 block 档闸 —— 命中即**压过 allow 强制 ask**（`splitBashCommand` 已处理操作符拼接，故这里只补「拆分器看不见」的混淆层）；warn 档 v1 仅检测、不改判定。ask 原因经 `PermissionRequest.reason` 透传到权限对话框（红色「⚠ 安全检查」行）。30 条安全单测 + 5 条 decide 集成测试，606 用例全绿。

### ✅ 已增强（2026-06-06）—— Bash 复合命令权限拆分 + cwd 持久化

权限闸补上复合命令拆分：`splitBashCommand` 按顶层 `&& || ; |`/换行（引号内不拆）拆子命令，`decide()` 对 Bash 改为「deny 任一子命令命中即拒 / allow 需整条被完整覆盖 / ask 任一子命令命中即问」，堵住 `Bash(git status*)` 放行 `git status && rm -rf ~` 的提权洞；命令含 `$(...)`/反引号时禁用逐子命令自动放行、强制 ask。另：Bash 的 `cd` 经临时文件 `pwd` 回捕 + `ctx.setCwd` 回写，跨命令/跨回合持久化工作目录（仅 bash/sh；pwsh/cmd 不持久）。详见下方 Phase 5.5 把这块归位到「执行环境」专题。

---

## Phase 5.5: Bash 执行环境与隔离（环境快照 / sandbox / tmux）

> **为什么单列一个 Phase**：这三项都不是「再加一个工具」，而是改 Bash 的**执行模型**——命令在什么环境里跑、被关在多大的盒子里、会不会踩到用户自己的会话。它们紧贴 Phase 4（Bash 工具）与 Phase 5（权限闸），但都比一条工具重得多，且**强平台相关**，故从 Phase 5 拆出来单独排期。
>
> **现实约束（务必先认清，别白做）**：zuse 主力开发机是 **Windows**。三项里只有「环境快照」在 Windows（git-bash）下有完整意义；**sandbox 与 tmux 在 Windows 上没有原生实现**（CC 也是 sandbox 仅 macOS/Linux/WSL2、tmux 仅经 `wsl -e tmux`）。所以本 Phase 的落地顺序与优先级按「确定性收益 × 当前平台可用性」排：**环境快照 ≫ tmux 套接字隔离 > sandbox**。
>
> **课程对应**：无直接课程，全部对齐 Claude Code 行为（源码见各小节）。

### 5.5.1 登录 shell 环境快照（login-shell snapshot）—— ✅ 已完成（2026-06-06，2026-06-07 扩展跨平台）

> **落地状态**：已实现并通过全部检查（259 测试 / typecheck / lint 全绿，**未提交，待评审**）。
> 设计 [specs/2026-06-06-zuse-shell-snapshot-design.md](../specs/2026-06-06-zuse-shell-snapshot-design.md)、
> 计划 [plans/2026-06-06-zuse-shell-snapshot.md](2026-06-06-zuse-shell-snapshot.md)。
>
> **2026-06-07 扩展**：原 v1"仅 Windows git-bash"取舍已撤销，现覆盖 **Windows git-bash + POSIX bash + POSIX zsh**。
> - `resolveShell()` 在 POSIX 上改为优先解析用户登录 shell（`$SHELL`，仅取 bash/zsh，否则按序探测 `/bin/bash`、`/bin/zsh` 等），而非写死 `shell:true`(`/bin/sh`)。`getShellLabel()` 增 `zsh` 识别。仅当 POSIX 上找不到任何 bash/zsh、落到 `/bin/sh`(dash) 时才优雅降级。
> - `buildCwdCapture` 的 cwd 持久化放开到 `bash/zsh/sh`。
>
> **2026-06-07 对齐 Claude Code 真实实现并重写**（参考 `cc-haha/src/utils/bash/ShellSnapshot.ts`）：
> - **采集架构改为脚本内 `>>` 写文件**(不再抓 stdout + MARKER 切 banner)：`dumpScript`/`extractSnapshotBody`/`filterWinptyAliases` 三个导出删除，新增 `snapshotBuilderScript(opts)`(生成交给 `shell -i -l -c` 执行、把 unalias→选项→函数→别名→PATH 依次追加进文件的构建脚本)。`ensureShellSnapshot` 契约不变，`bash.ts` 未动。
> - **`unalias -a` 置顶 + 别名放最后**：统一解掉早前两个解析 bug——bash extglob(仍靠 `shopt -p` 前置 + 过滤补全函数) 与 zsh run-help 碰撞(`unalias -a` 取代旧 `unsetopt/setopt aliases` hack)。
> - **函数过滤** `grep -vE '^_[^_]'`：快照从约 95KB 缩到约 22KB(真机实测)。
> - **有意偏离 CC**：不照搬 bash 逐函数 base64(Windows 逐函数 spawn 致构建 6–8s)，改内建 `declare -f` 循环；不导出 `set -o`/全量 `setopt` 行为开关(errexit/pipefail 会破坏命令包装)；仍用 `-i -l`(非纯 `-l`)以放行 `.bashrc` 非交互守卫。
> - **真机端到端验证(WSL bash 5.2.21 / zsh 5.9)**：func+PATH 两 shell 均通;带系统 bash-completion(extglob) source 无解析错误;带非交互守卫的 `.bashrc` + 不串联的 `.bash_profile` 也能拿到别名(验证 `-i`+显式 source);zsh 别名不展开仍为 §11 已知限制。`shell-snapshot` 单测重写为对 `snapshotBuilderScript` 的结构+顺序断言(9 条)，与 `bash.test` 共 17 测试全绿。
>
> 其余落点：`bash.ts` 导出 `primeShellSnapshot`、`buildCwdCapture` 增 `snapshot` 参拼 `source` 前缀、`pwd`→`\pwd` 绕开用户 alias；`App.tsx` 挂载预热。

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
| 快照内容     | v1 做**最高收益的 PATH + alias + 函数**三样;另需 emit `shopt -p`(bash)/转储窗口内 `unsetopt aliases`(zsh)——这是函数体能 re-source 的**必需**前提,非可选(见设计 §2.1) |
| 落盘位置     | `~/.zuse/shell-snapshots/`（沿用 zuse 配置目录约定），cleanup 注册删除                 |
| shell 适配   | 复用现有 `getShellLabel()`：bash/zsh/sh 各自的 rc 文件名与 `declare -f`/`typeset -f` 差异 |
| Windows      | git-bash 走 `.bashrc`；过滤 `winpty` alias；`ARGV0`/`exec -a` 差异照搬 CC 的分支       |

**开发要点**：

- 与已做的 **cwd 持久化**（Phase 5.5 归位的那块）协同：命令实际执行串 = `source 快照; cd 到 sessionCwd; <用户命令>; 回捕 pwd`。注意 `source` 与 cwd 回捕的先后、退出码透传（`exit $?`）不能被 `source`/`pwd` 的 0 掩盖。
- 安全：快照是「把用户 rc 的副作用固化」，本身不扩大权限面，但要确保快照文件落在用户私有目录、权限收紧。
- 降级路径必须测：rc 不存在、`source` 报错、超时——都不能让 Bash 工具挂掉。
- **不做**：CC 那套把 `find`/`grep`/`rg` 用 bun 内嵌二进制 `ARGV0` 派发的把戏（zuse 没有内嵌搜索二进制，直接用系统 rg / 自带 Grep 工具即可）。

### 5.5.2 tmux 套接字隔离 —— ✅ 已完成（2026-06-09，仅第 1 层「套接字隔离」）

> **落地**：新增 `packages/tools/src/tmux-isolation.ts`（对齐 CC `src/utils/tmuxSocket.ts`）。
> 懒初始化：Bash 命令含整词 `tmux` 时（`isTmuxCommand`，从宽匹配，宁可错触发不可漏）先
> `ensureTmuxSocket()` 在专属套接字 `zuse-<PID>` 上建 detached 会话、取 `socket_path`+`pid`，
> 拼成 tmux 原生格式的 `TMUX` 值经 `getZuseTmuxEnv()` 注入并**覆盖**该 Bash 子进程的 `TMUX`
> —— 模型的任何 `tmux` 命令只动 zuse 自己的 server，碰不到用户会话。探测不到 tmux（POSIX
> `tmux -V` / Windows `wsl -e tmux -V`）则全程优雅降级。进程正常退出经 `process.once('exit')`
> + spawnSync `kill-server` 清理（不抢 SIGINT，避免与 Ink 的 Ctrl+C 退出打架）。15 条单测、
> 621 用例全绿。**平台**：POSIX 完整生效；Windows 走 git-bash、tmux 仅在 WSL，故基本 no-op
> （见模块头注）。第 2 层「tmux 作为执行后端」仍归 Phase 15。

#### 原始设计（保留备查）

> 中优先级（依赖是否引入 tmux 执行后端）

**两个层面，别混为一谈**：

1. **套接字隔离（轻、该做）**：只要 zuse 允许模型跑 `tmux ...`（哪怕只是普通 Bash 里），就有「误杀用户自己 tmux 会话」的风险（`tmux kill-server` 之类）。CC 的解法（`src/utils/tmuxSocket.ts`，已读）：给 Claude 开**自己的 tmux 套接字** `claude-<PID>`，所有 tmux 命令带 `-L claude-<PID>`，并给所有 Bash 子进程注入指向该套接字的 `TMUX` env，**屏蔽用户原本的 `TMUX`**。这样模型怎么折腾都只动 Claude 自己的 server，碰不到用户的会话。Windows 上 tmux 只存在于 WSL，经 `wsl -e tmux` 调用。
2. **tmux 作为执行后端（重、归 Phase 15）**：CC 用 tmux pane 跑后台/异步命令、以及多 agent（swarm/teammate）的 pane 后端（`src/utils/swarm/backends/TmuxBackend.ts`）。这是**真正的隔离执行模型**，与多 Agent 编排强耦合——**这部分挪到 Phase 15（多Agent与编排）**去做，不在 5.5。

**选型 / 开发要点（仅做第 1 层）**：

- 仅当探测到 `tmux` 可用（或 Windows 上 WSL 内可用）时启用；否则空操作，不影响普通 Bash。
- 启动期创建 `zuse-<PID>` 套接字，注入 `TMUX`/`-L` 到 Bash 执行环境（可并入 5.5.1 的快照/env 注入管线）；退出 cleanup 杀掉该 server。
- **优先级判断**：只有当 zuse 真的鼓励模型用 tmux（如做后台长任务）时才有收益。当前 v1 没有后台任务能力，故**排在环境快照之后**；可与 Phase 15 的 tmux 后端一并立项。

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

**Windows + WSL2 究竟能不能用 sandbox（已核源码，2026-06-06）**：

先厘清平台判定（`src/utils/platform.ts`，已读）：`getPlatform()` 看 `process.platform`——`win32` 直接判 `windows`（不支持）；`'wsl'` 只在 `process.platform === 'linux'` 且 `/proc/version` 含 `microsoft`/`wsl` 时返回。**关键含义：CC 必须是「跑在 WSL2 里的 Linux 进程」才会被认成 `wsl`；从 Windows 侧调 `wsl.exe` 的原生 CC 仍是 `win32`，不算数。** 据此，"在 Windows 机器上用沙箱"有三种形态，收益天差地别：

| 形态                                | 平台判定 | sandbox  | 代价 / 问题                                                                                                      |
| ----------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| ① 原生 Windows CC 调 `wsl.exe`       | `win32`  | ❌ 无    | 进程仍是 Win32，`isSupportedPlatform()` 直接 false；显式开 `sandbox.enabled` 会报 "win32 not supported" 告警       |
| ② 在 WSL2 里跑 CC，但代码在 `/mnt/e/...` | `wsl`    | ⚠️ 半残  | 9P/drvfs **性能断崖**（git/node_modules/构建慢数倍）；bubblewrap **不支持 glob 路径规则**（`getLinuxGlobPatternWarnings`）；敏感路径 deny 按 Linux home 算，与 Windows 侧 `~/.ssh` **方向错位**，等于没保护到 |
| ③ 在 WSL2 里跑 CC，代码在 Linux fs（`~/projects/...`） | `wsl`    | ✅ 正解  | sandbox 按设计生效（bubblewrap+seccomp+socat 全在原生 Linux fs 上）；性能正常；deny 路径方向对得上。**代价：等于开第二套开发环境**——Node/pnpm/Volta/工具链全要在 WSL2 Linux 里重装，本质是"在这台 Windows 上做 Linux 开发" |

结论：`/mnt` 挂载路径（形态②）是**最差折中**——性能最差、沙箱半残、保护错位；不要走。要 sandbox 只有形态③一条正路，而它是一次实打实的**开发环境迁移决策**，不是顺手挂一下能带过的。这进一步印证 5.5.3 推迟的判断：对主力 Windows 原生的 zuse，sandbox 要么不做，要么等于承诺"以后在 Linux/WSL2 里开发"。WSL2 前提清单（将来真做时）：必须 WSL2 非 WSL1（WSL1 报 "requires WSL2"）→ 在发行版内 `apt install bubblewrap socat` → 代码置于 Linux fs → 避免 glob 路径规则。

### 本 Phase 推进建议（小结）

1. **先做 5.5.1 环境快照**（跨平台、确定性收益、解决 `command not found` 类真痛点，且与已做的 cwd 持久化天然同管线）。
2. **再评估 5.5.2 tmux 套接字隔离**（只在引入 tmux/后台任务时才有收益，可与 Phase 15 合并）。
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

#### Session 1：StreamRenderer 渲染层重构（协调说明，2026-06-07）

下面的 **工具执行展示对齐 CC** + **Edit diff 渲染** + **Markdown 富渲染** 三块都落在同一个文件 [`StreamRenderer.tsx`](../../../packages/tui/src/components/StreamRenderer.tsx)，并行做会互相冲突，故合并为一个工作会话「Session 1：渲染层重构」，内部按 commit 拆分（至少：工具块 / Edit diff / Markdown），逐块各自 spec→plan。三块均**不改 `useConversation`**（前导理由↔tool_use 是纯数组相邻、渲染层即可处理；详见 #1 spec §3）。

设计就绪度（三块设计均已就绪，2026-06-07）：

- **Markdown 富渲染**：设计 + spec + plan 已完成（spec [`2026-06-07-zuse-markdown-rendering-design.md`](../specs/2026-06-07-zuse-markdown-rendering-design.md)、plan [`2026-06-07-zuse-markdown-rendering.md`](2026-06-07-zuse-markdown-rendering.md)），选型已定为**自渲染**（marked 词法器 + 手写 Ink 组件）。
- **工具块 CC 风格**：spec + plan 已完成（spec [`2026-06-07-zuse-tool-block-rendering-design.md`](../specs/2026-06-07-zuse-tool-block-rendering-design.md)、plan [`2026-06-07-zuse-tool-block-rendering.md`](2026-06-07-zuse-tool-block-rendering.md)）。骨架 `●`+`⎿`、渲染层零分组、按工具 OUT 摘要映射、Bash 类预览 5 行;纯逻辑抽到 `toolSummary.ts` + 平台圆点 `figures.ts`。**实现顺序排最前**(#2 依赖它)。
- **Edit diff 渲染**：spec + plan 已完成（spec [`2026-06-07-zuse-edit-diff-rendering-design.md`](../specs/2026-06-07-zuse-edit-diff-rendering-design.md)、plan [`2026-06-07-zuse-edit-diff-rendering.md`](2026-06-07-zuse-edit-diff-rendering.md)）。建立在 #1 之上;行级 LCS 内部 diff（红删/绿增/暗上下文）、全上下文总限 10 行、从 `input.old_string`/`new_string` 渲染期计算;纯逻辑抽到 `editDiff.ts`。仅 Edit,Write 不做。

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

现状：[`packages/tui/src/components/StreamRenderer.tsx`](../../../packages/tui/src/components/StreamRenderer.tsx) 的 `ToolBlock`——运行时一个 spinner、完成后 `✓`/`✗`，旁边一行青色 `Name(args)`，下面只有一行暗色输出首行预览（截 80 字符），看不到"为什么调"和完整 IN/OUT。期望对齐 CC，每次工具调用渲染成一个块。

**已敲定设计决策（2026-06-07，brainstorm 中）：**

1. **显示密度 = 固定紧凑、对齐 CC、不做交互式展开**（滚动日志里历史块无法再聚焦交互）。每块固定为：前导理由（若有）+ 一行标题 `Tool args` + 按工具定制的结果摘要行；超长 OUT 截断成「+N lines」。
2. **前导理由↔工具的关联放在渲染层,不改 `useConversation`。** 数据流是 `[assistant 文本气泡]→[tool 气泡]…` 交替,前导理由就是紧挨 tool 气泡前面那个 assistant 气泡。设计细化后确认:这种关联是纯「数组相邻」,**无需任何分组遍历** —— 每个气泡各自独立渲染,只要 assistant 与 tool 标记都用 `●`、落同一左槽、内容从 col 2 起,前导+工具+结果就自然读成一组。故 `MessageList` 也不改。hook 维持无状态。

**设计已定（2026-06-07）= spec [`2026-06-07-zuse-tool-block-rendering-design.md`](../specs/2026-06-07-zuse-tool-block-rendering-design.md)。** 骨架 `●`+`⎿`(`●` 平台适配:darwin `⏺`);specifier 按工具取主参数;OUT 摘要按工具映射(Read `Read N lines` / Glob·Grep `Found N …` / Write `Wrote N lines` / Edit `Updated <file> (N replacement(s))`,`+A -R` 彩色 diff 归 #2);Bash 等「输出即价值」类工具在 `⎿` 下固定预览最多 5 行 + 暗色 `… +K 行`;错误态取首行红色;无前导时工具块独立成行、不放占位。纯逻辑抽到 `toolSummary.ts` 单测覆盖。待 Session 1 统一实现。

#### TUI 文案全中文化

现状散落英文：`App.tsx` 的 `Zuse Chat (Ctrl+C to exit)` / `Error:`；`InputBox.tsx` 的占位符 `Type your message...` / `Waiting for response...`；`UsageFooter.tsx` 的 `Model:` / `Total:` / `No tokens yet` / `Thinking...`；`StreamRenderer.tsx` 的 `Tokens: ... in / ... out` / `error:`。统一改中文。纯文案、零逻辑，顺手在 Phase 7 一起做。

#### Markdown 富渲染

现状：助手回复走 `StreamRenderer.tsx` 的 `<Text>{text}</Text>`，Ink 不解析 markdown，`## 标题`、`**加粗**`、代码块都显示成字面量。

**选型已定（2026-06-07）= 自渲染（Route A）**：用 `marked.lexer()` 仅做词法分析，手写映射到原生 Ink 组件（而非 `marked-terminal`/`ink-markdown` 的预渲染定宽 ANSI 串——后者不随终端宽度 reflow）。范围 = 第二档元素集 + GFM 表格，**不做语法高亮**。流式用双态策略（流式期纯文本，`message-stop` 定稿后重渲染富文本），契合现有 `isStreaming` 字段、无需改 hook。详见 spec [`2026-06-07-zuse-markdown-rendering-design.md`](../specs/2026-06-07-zuse-markdown-rendering-design.md) 与 plan [`2026-06-07-zuse-markdown-rendering.md`](2026-06-07-zuse-markdown-rendering.md)。

---

> **Phase 8–12 = 一条「harness 加固轨」**：插在功能阶段（Skills/多Agent）之前。理由——skills 与多 Agent 会放大 harness 的任何弱点（编排出错时，你 debug 的是「编排逻辑 + harness 缺陷」两层叠加，理不清）。先把**错误回传 / 输出塑形 / 上下文压缩 / 故障恢复 / 回滚**这五根承重柱浇硬，再往上盖。除 Phase 10（=原「会话管理」并入压缩）外均无直接课程，机制对齐已通读的 Crush / OpenCode 源码。**起手做 Phase 8**（最自包含、单位代码学到最多、不依赖下游）。

## Phase 8: 错误回传契约（Observation Contract）

### 补充文档参考

第一章（故障模式④工具错误吞）—— 本 Phase 是对故障④的系统性收口：不止「别静默吞错」，而是把每个工具的失败都变成模型能据此行动的 observation。

### 课程知识点

无直接对应课程；机制层面对齐 Crush / OpenCode 的工具错误分支（已随对照源码通读）。核心原则一句话：**工具交还给模型的一切（成功输出 / 报错 / 截断块）都是写给模型读的 observation，不是写给开发者的日志。** 这条做好，agent 才有自愈能力；做不好，模型再强也会在第三步崩。

### 源码参考（OpenCode / Crush）

| 源码文件                              | 参考内容                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Crush `internal/agent/tools/edit.go`  | 失败回的是**纠正指令**（`you must read the file before editing it. Use the View tool first`）而非裸异常 / stack trace |
| OpenCode `tool/edit.ts` 错误分支      | 失败路径如何包装成自然语言 observation                                                          |

### 开发要点

- 过一遍 `packages/tools/src/` 里**每个工具的失败路径**：不抛裸异常、不回 stack trace，改回一句**带下一步指令**的话。
- 覆盖的失败面：文件不存在、未读先改、坏路径、权限拒绝、命令不存在、坏入参。
- 权限拒绝信息也走同一契约（与 Phase 5 的 `PermissionVerdict` 拒绝路径对齐，拒绝原因要「给模型读」）。
- 验证（TDD）：每个工具一条触发失败的测试，断言返回里含「模型能据此行动的下一步」，而非断言抛了异常。

### ✅ 已实现（2026-06-12）

全量审计 `packages/tools/src/` + `core/agent.ts` 所有 `isError: true` 路径后发现:多数
工具(Edit/Write 的 read-before-edit、Read/Glob 截断尾、WebSearch 拉黑、Lsp 安装指引)
**本来就是按契约写的**,本期只收口真有差距的几处——core:`Unknown tool` 列出可用工具
清单(模型可自纠工具名);settings deny 点明「硬护栏 + do not retry + 换路子/找用户改
配置」;user deny 点明「本次裁决 + 问用户意图」。tools:Read 文件不存在指引 Glob、
readFile 抛错(EACCES 等)不再裸抛到 agent 兜底层、NUL 字节判二进制拒读且不 markRead
(不给 Edit 假通行证);Edit old_string 未命中点破空白/缩进漂移并指引重读拷原文、读后
被删指引 Write 重建;Bash 超时点明 timeout 入参可调、exit 127 点破 command not found。
设计决策(D1 改文案不改结构 / D2 两档拒绝语义分开 / D5 仅 127 点破其余码不猜)与文案
规格见 spec [→](../specs/2026-06-12-zuse-error-observation-contract-design.md)。
TDD,新增 10 断言点,820 用例全绿。坏 JSON tool_use 回喂归 Phase 11,大输出塑形归 Phase 9。

---

## Phase 9: 输出整形 / 截断（Feedback Shaping）

### 补充文档参考

—（反馈塑形，无直接课程。与 Phase 8 是兄弟：Phase 8 管「失败怎么说」，本 Phase 管「大输出怎么塑形成信号」。上下文管的是「留多少 token」，这条管的是「单条结果怎么截断/摘要成模型用得上的信号」。）

### 源码参考（OpenCode）

| 源码文件                          | 参考内容                       |
| --------------------------------- | ------------------------------ |
| OpenCode `tool/truncate.ts`       | 按 byte 预算的截断策略         |
| OpenCode `tool/truncation-dir.ts` | 大目录 / 大列表的塑形          |

### 开发要点

- 统一截断策略：head + tail + 「已截断，完整输出见 X / 共 N 行」，按 byte 预算裁，而非粗暴砍尾。
- 与 Phase 4 已做的 Read `MAX_OUTPUT_CHARS` / Grep 分页**归一到同一套塑形逻辑**，别各 truncate 各的。
- 验证：喂一个超大输出（如 5000 行文件 / 10MB stdout），断言模型拿到的是可读摘要 + 关键首尾，且没炸 token 预算。

### ✅ 已实现（2026-06-12）

审计后把「归一」精确化为**同一策略族而非同一个函数**:可寻址输出(Read 行窗口 /
Grep head_limit+offset / Glob 条数上限)分页+续读指引已是正确塑形,不动;**不可寻址
blob**(Bash stdout、WebFetch 正文)归一到新模块 `packages/tools/src/truncate.ts`——
`shapeHeadTail`(整段)与 `StreamShaper`(流式,内存恒有界:head 缓冲 + tail 字符串
环形缓冲),head/tail 均行边界收口(让步上限预算 20%),统一 `[truncated: 总量/首尾
尺寸/落盘路径]` marker。**Bash** 从「30k 触顶丢弃全部尾部」(测试失败摘要、报错堆栈
恰在尾部)改为 head 10k + tail 20k 尾重头轻,截断时**完整输出落盘** `~/.zuse/tool-output/`
(总量首次越过 headChars 即懒落盘——再晚 tail 环开始丢字符就不全;未触顶删白开文件;
落盘失败优雅降级),模型用 Read/Grep(自带分页)续查——把不可寻址转化成可寻址。
**WebFetch** 换共享 shapeHeadTail 只留头(尾部多为页脚杂讯),中文注记换统一英文 marker。
设计与决策见 spec [→](../specs/2026-06-12-zuse-output-shaping-design.md)。TDD,
新增 11 用例(truncate 单测 9 + Bash 集成 2),831 用例全绿。spill 文件自动清理记为后续优化。

---

## Phase 10: 会话管理与上下文压缩

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

| 源码目录/文件               | 参考内容                                              |
| --------------------------- | ----------------------------------------------------- |
| `services/compact/`         | AutoCompact压缩服务                                   |
| `utils/messages.ts`         | MicroCompact实现                                      |
| OpenCode `session/compaction.ts` | `preserve_recent_tokens` / `PRUNE_PROTECT` 保留策略 |
| OpenCode `session/overflow.ts`   | 溢出判定（input+output+cache.read+cache.write）     |

### 开发要点

- session按cwd分组
- --continue / --resume参数
- 每轮自动保存
- Token Budget分配
- 压缩策略: keep_recent_n + summarize_middle

### ✅ 已实现（2026-06-12）

**A. 会话管理**:自动会话存 `~/.zuse/sessions/auto/<cwd-slug>/<session-id>.json`
(SessionRecord v2 带 cwd/createdAt/updatedAt;命名存档 /save /load 的 v1 原样保留)。
每回合提交后 fire-and-forget autosave(空会话不落盘、失败静默);/clear 换新会话 id
(旧历史保留可续接);`--continue` 载最新、`--resume <序号|id>` 指定续接(沿用 id 续写
同一文件)、`--resume` 无参打印列表;会话内 `/resume` 列表+续接。列表按 updatedAt
倒序、损坏文件跳过。**有意不做**启动交互式选择器(记 UI backlog)。

**B. 上下文压缩**:`packages/core/src/compaction.ts`——`findCompactionCut` 只认
「user 且首块 text」的真实回合起点(tool_result 回填不算,切点永不劈开 tool 配对),
保留最近 2 个回合;`summarizeForCompaction` 单独请求生成结构化摘要(目标/决策/改动
文件/未完成/约束),失败抛出绝不半压;`applyCompaction` 摘要替换老历史,totalUsage
不清零(成本账非窗口账)。窗口占用用**上一回合实测** input+cache 读(不估算),
窗口大小**模型级配置**(`models` 条目可写 `{ name, contextWindow }`,查找顺序
模型级 → provider 级 → 缺省 512k;小窗口模型如 DeepSeek V3 须显式声明),占用 >80% 在下一次 sendMessage
开头自动压缩(重发跳过;失败提示后照原历史发送);`/compact` 手动随时可压。压缩
只换账本不动屏幕 scrollback。设计见 spec
[→](../specs/2026-06-12-zuse-session-and-compaction-design.md)。TDD,新增 20 用例
(sessionStore 11 + compaction 9),851 用例全绿。

---

## Phase 11: 鲁棒性与恢复（Fault Injection & Recovery）

### 补充文档参考

—（无直接课程，故障注入测试为主。前提认知：harness 要假设**模型和环境都会出错**，不只是模型。放在压缩（Phase 10）之后，因为压缩本身就是一个新的出错面。）

### 源码参考

| 源码文件                                        | 参考内容                                          |
| ----------------------------------------------- | ------------------------------------------------- |
| zuse `packages/core/src/retry.ts` / `stream-idle.ts` | 现有重试 / 流卡死检测，本 Phase 补测试锁住行为 |
| OpenCode `session/llm/`                         | 重试 / 流处理对照                                  |

### 开发要点（直接做成故障注入测试）

- 流中途 kill → 断言 Esc 真能取消（`sendMessages` 传 `signal` 那段已做，补测试锁住，防 for-await 永久阻塞回归）。
- 模型回了**坏 JSON 的 tool_use** → 断言不崩，且回模型一句「你的工具入参不是合法 JSON，请重发」。
- 撞 max_tokens → 断言告警、不把半截回复当最终答案（已做，补测试）。
- 429 / 5xx → 退避重试；区分**可重试**（网络 / 限流 / 5xx）与**不可重试**（400/422）。

---

## Phase 12: 检查点与回滚（Checkpoint / Revert）—— 进阶 / 可选

### 补充文档参考

—（进阶，无课程。把现有 staged 暂存从「出错不提交」升级到「已提交的过去回合也能回滚」。这是已通读过的 OpenCode 影子 git 那套，正好当一个**完全手写、不让 CC 端到端代劳**的练习。）

### 源码参考（OpenCode）

| 源码文件                        | 参考内容                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| OpenCode `snapshot/index.ts`    | 影子 git（独立 `--git-dir` + `--work-tree` 指向真实工作区）做 track / restore / diff |
| OpenCode `session/processor.ts` | 每回合 LLM 流前后各打一次快照、hash 存到 message                       |
| OpenCode `session/revert.ts`    | 按 message 回滚某一历史回合                                            |

### 开发要点

- 每回合落地前后打快照（影子 git，或自存 staged-diff）。两条路权衡：影子 git 省事、diff/revert 免费，但每回合两次 git 开销、且语义是「快照」非「事务」；自存 diff 更可控，但要自己保证 effect 全集进了缓冲。
- 与现有 staged 暂存的分工：暂存解决「本回合出错不落地」，本 Phase 解决「已落地的过去回合也能撤」。
- 验证：让一个回合改了文件后再报错 → 断言 worktree 干净；再断言能把某个**已提交的**历史回合 revert 掉。

---

## Phase 13: 项目记忆

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

## Phase 14: Skills系统

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
- 多Agent Coordinator模式 → 抽到 **Phase 15** 单独做

---

## Phase 15: 多Agent与编排

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

## Phase 16: 调度与自动化（Cron / Wakeup）

### 补充文档参考

—（CC 的 Cron / ScheduleWakeup：定时触发与自唤醒。属于自动化能力，依赖会话管理
（Phase 10）能 resume，放在最后。）

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
- 触发时以 `--resume` 拉起对应会话（依赖 Phase 10 会话管理）
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
| context/ (1004行)        | Phase 2, 10    |
| services/compact/        | Phase 10       |
| memdir/ (1736行)         | Phase 13       |
| skills/ (4066行)         | Phase 14     |
| coordinator/             | Phase 15     |

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
