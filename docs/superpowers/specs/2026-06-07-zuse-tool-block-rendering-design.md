# TUI 工具执行块对齐 CC 风格设计(Phase 7 子项 #1)

> 状态:设计已批准,待落实现计划。
> 上游:[phase-roadmap.md](../plans/phase-roadmap.md) Phase 7「UI 打磨」的「工具执行展示对齐 CC 风格」子项。
> 同属 Session 1(StreamRenderer 渲染层重构)三块之一,另两块为 [#2 Edit diff](./2026-06-07-zuse-edit-diff-rendering-design.md)(待设计)与 [#3 Markdown 双态渲染](./2026-06-07-zuse-markdown-rendering-design.md)。三块共改 `StreamRenderer.tsx`,统一实现、按 commit 拆分。
> 范围:仅**工具调用气泡(`role:'tool'`)的展示骨架与摘要**。助手富文本(#3)、Edit 彩色 diff(#2)各自独立。

## 1. 目标与动机

当前 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 的 `ToolBlock` 把每次工具调用渲染成:`spinner/✓/✗` 标记 + 青色 `Name(args)` + 一行暗色预览(取 output 首行截断 80 字符)。问题:

- 标记体系(`✓/✗`)与 Claude Code 不一致;CC 统一用 `●` 标题行 + `⎿` 结果行。
- 结果预览是「output 首行截断」,对 Read/Glob/Grep 这类工具毫无信息量(首行往往是第一个文件名或第一行代码),不像 CC 给出 `Read 120 lines`、`Found 8 files` 这种**名词短语摘要**。
- 前导理由(模型解释「为什么执行」的 assistant 文本)与紧随其后的工具调用,在视觉上没有成组的节奏感。

目标:**把工具块对齐 CC 观感** —— `●`/`⎿` 骨架、每类工具一行有意义的 OUT 摘要、前导理由与工具垂直贴邻成组、「输出即价值」类工具(Bash 等)在 `⎿` 下给固定行数的真实输出预览。

### 已决策(brainstorm 结论)

- **密度 = 固定紧凑,对齐 CC,无交互式展开。** 不做 `Ctrl+O` 展开;紧凑摘要 + 固定预览行数即终态。
- **标记骨架 = `●` + `⎿`**(CC 原样)。
- **前导↔工具关联在渲染层做,不改 `useConversation`**。

## 2. 视觉骨架:`●` + `⎿`

```
● 我先读下配置,确认 provider 列表          ← 前导理由(assistant 文本,● 标记)

● Read(src/config.ts)                       ← 工具标题行:● + Name(specifier)
  ⎿ Read 120 lines                           ← 结果行:2 空格缩进 + ⎿ + OUT 摘要

● Bash(pnpm test)
  ⎿ ✓ 12 passed                              ← Bash 类:⎿ 下最多 5 行真实输出
     Test Files  3 passed (3)
     Tests  20 passed (20)
     Duration  2.1s
     … +3 行                                  ← 超出部分:暗色省略提示
```

- **标记列**(独占一列,`marginRight=1`,与现有助手分支的悬挂缩进一致):
  - 运行中(`status==='running'`)→ `<Spinner/>`(青)。
  - 完成(`status==='done'` 且非错)→ `●`(绿)。
  - 出错(`isError`)→ `●`(红)。
  - `●` 字形按平台适配:`process.platform==='darwin'` 用 `⏺`,其余用 `●`(对齐 cc-haha 的 `figures.ts`:macOS 的 `⏺` 垂直对齐更好但 Windows/Linux 支持差)。集中为一个常量 `BLACK_CIRCLE`。
- **标题行**:`Name` 青色,`(specifier)` 暗色括注(见 §4)。
- **结果行**:`  ⎿ ` 前缀(2 空格 + `⎿` + 1 空格)引导,暗色;出错时整行红色。多行预览时,续行对齐到 `⎿` 后的内容列(5 空格缩进),对齐 CC 的 `marginLeft={5}`。

## 3. 前导理由 ↔ 工具的关联(渲染层,不改 hook)

数据流既成事实(见 [useConversation.ts](../../../packages/tui/src/hooks/useConversation.ts)):一个回合是 `[assistant 文本气泡] → [tool 气泡] → [assistant 文本气泡] → …` 交替;`tool-use` 事件把当前 assistant 气泡 `isStreaming` 置 `false` 并另推一个 `{role:'tool'}` 气泡。「前导理由」就是紧邻某 tool 气泡之前的那个 assistant 气泡。

**关键结论:这种关联是纯粹的「数组相邻」,无需任何分组逻辑或 hook 改动。** 每个气泡各自独立渲染,只要:

1. assistant 标记与 tool 标记都用 `●`、落在同一左槽(col 0),内容都从 col 2 起;
2. 保持 CC 那样的贴邻节奏。

前导、工具、结果就自然读成一组。因此本子项**不改 `useConversation`,也不在 `MessageList` 加配对/分组遍历**。唯一与节奏相关的微调:确认 assistant 气泡与紧随 tool 气泡之间的 `marginBottom` 维持单行间距即可(沿用现状,不需要为成组而新增逻辑)。

**无前导的情形**:Read/Glob/Grep 连发时常常没有前置 assistant 文本(模型直接连开多个工具)。此时工具块独立成行,**不放任何占位文字**,就是 `● Name(...)` + `⎿ 摘要`。

## 4. specifier(IN 摘要)按工具映射

标题行只显示**主参数**,从不内联展开全部参数(紧凑约束)。镜像各工具已有的 `specifierFor` 语义:

| 工具 | `Name(...)` 内显示 | 取自 input 字段 |
|---|---|---|
| Read / Edit / Write | 文件路径(相对 cwd 的显示路径) | `file_path` |
| Glob / Grep | 模式 | `pattern` |
| Bash | 命令(超长截断) | `command` |
| WebFetch | URL | `url` |
| WebSearch | 查询串 | `query` |
| LSP | `operation symbol` | `operation` + `symbol` |
| 其它/取不到 | 压缩 JSON(≤60 字符,超出加 `…`) | 现有兜底逻辑 |

实现为纯函数 `toolSpecifier(name: string, input: unknown): string`(见 §7),不依赖工具包,按 `name` switch 取字段;取不到回落到现有的 `summarizeInput` JSON 兜底。

## 5. OUT 摘要(`⎿` 行)按工具映射

**渲染期**从 `tool.name` + `tool.input` + `tool.output` 算出摘要(纯函数,不调用工具)。先判错:`tool.isError` 为真,统一取 output 首行、红色显示。否则按工具:

| 工具 | `⎿` 摘要 | 来源算法 |
|---|---|---|
| Read | `Read N lines`;空文件 `(empty file)` | 数 output 行数,去掉尾部 `[truncated: …]` 注记 |
| Glob | `Found N files`;无匹配 `No files matched` | 数路径行(去尾注) |
| Grep · files_with_matches | `Found N files` | 数行(去尾注) |
| Grep · content | `Found N lines` | 数行(去尾注) |
| Grep · count | `Found N matches in M files` | 解析 `path:count` 行,求和 + 文件数 |
| Edit | `Updated <file> (N replacement(s))` | 直接取工具 output(`Edited X (N replacement(s)).`)改写为中性短语 |
| Write | `Wrote N lines` | 数 `input.content` 行数 |
| Bash / WebFetch / WebSearch / LSP | 见 §6(最多 5 行真实输出 + 溢出提示) | output |
| 其它/兜底 | `N lines of output`(单行计数) | 数 output 行 |

**行数计数辅助**:工具输出常带 `\n\n[truncated: …]` / `[safety cap: …]` / `[offset …]` 尾注,或 `(no output)`、`No matches for: …`、`No files match: …` 这类哨兵串。计数前先剥掉匹配 `/\n\n\[[^\]]*\]\s*$/` 的尾注;哨兵串各工具单独识别(返回「无匹配/空」文案而非行数)。

> **与 #2 的边界**:Edit 在 #1 只显示 `Updated <file> (N replacement(s))`,直接复用工具 output,**不计算行级增删**。彩色 diff 与 `+A -R` 统计归 [#2](./2026-06-07-zuse-edit-diff-rendering-design.md);#2 会基于 `input.old_string`/`input.new_string` 在渲染期算真实 diff,替换掉这条占位摘要。两块都改 `ToolBlock`,实现时按 commit 拆开。

## 6. Bash 类「输出即价值」工具的预览(已决策:最多 5 行)

Read/Grep/Glob/Edit/Write 的价值是「做了什么」,单行计数摘要即可;Bash / WebFetch / WebSearch / LSP 的**输出本身才是价值**(测试结果、抓取正文、搜索结果、符号定义)。这几类在 `⎿` 下展示**最多 5 行**真实输出:

- 取 output 去掉尾部状态注记(`[exit code: N]` / `[timed out …]` / `[interrupted]` / `[killed by signal: …]` / `[truncated: …]`)后的正文,按行切。
- 展示前 5 行,每行对齐到 `⎿` 内容列(5 空格缩进)。
- 若正文超过 5 行,末尾追加一行暗色 `… +K 行`(K = 剩余行数)。
- `(no output)` → `⎿ (no output)` 单行。
- 出错时(非零退出/超时)仍走 §5 的错误分支:红色取首行(通常是错误信息),但若正文有多行,沿用同样的 5 行预览 + 红色。

「最多 5 行」固定,不提供展开(对齐已定的紧凑无展开策略)。

## 7. 架构与文件划分

仿照 #3 markdown 把「纯逻辑」与「渲染」解耦:

| 文件 | 职责 |
|---|---|
| `packages/tui/src/components/toolSummary.ts` | **纯函数**:`toolSpecifier(name,input)`(§4)、`summarizeOutput(tool)`(§5,返回 `{ kind:'line', text } \| { kind:'preview', lines:string[], moreCount:number } \| { kind:'error', text }`)、以及行数计数/尾注剥离/哨兵识别辅助。无 React、无副作用、不 import 工具包。 |
| `packages/tui/src/components/toolSummary.test.ts` | `toolSummary.ts` 的单测(vitest,`.test.ts`)。 |
| `packages/tui/src/components/figures.ts` | 平台适配的 `BLACK_CIRCLE`(`darwin` → `⏺`,否则 `●`)等字形常量。若已有合适位置可并入,不强制新建。 |

### 接线点

改 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 的 `ToolBlock`:

- 标记列改为 §2 的 `●`/spinner/颜色规则(替换现有 `✓/✗`)。
- 结果区改为消费 `summarizeOutput(tool)`:`line`/`error` → 单行 `⎿`;`preview` → `⎿` 首行 + 续行(5 空格缩进)+ 可选 `… +K 行`。
- 标题行 `(args)` 改用 `toolSpecifier(tool.name, tool.input)`(替换现有内联的 `summarizeInput`,可把 `summarizeInput` 移入 `toolSummary.ts` 作兜底分支)。

其余分支(user/assistant/system)、助手 `usage` 行**不动**。assistant 分支已用 `●`(黄),与工具块的 `●` 同形,天然成组(§3),不需要改它。

## 8. 测试策略

- **`toolSummary.test.ts`**(纯函数,vitest):
  - `toolSpecifier`:各工具取对的字段;取不到回落 JSON 兜底。
  - `summarizeOutput` 计数:Read 正常/空文件/带 `[truncated]` 尾注;Glob 命中/`No files match`;Grep 三种 `output_mode`(含 `count` 模式解析 `path:count`);Write 数 `input.content` 行;Edit 复用 output 文案。
  - Bash 预览:≤5 行原样;>5 行给 `… +K 行`;`(no output)`;带 `[exit code]`/`[truncated]` 尾注时正确剥离再计数。
  - 错误分支:`isError` 时取首行、标 `kind:'error'`。
- 渲染层不强制快照(ink 渲染由 #3 引入 `ink-testing-library` 时一并覆盖);#1 的逻辑正确性集中在纯函数单测里。

## 9. 范围外 / 后续

- **Edit 彩色 diff、`+A -R` 统计**:归 [#2](./2026-06-07-zuse-edit-diff-rendering-design.md)。
- **交互式展开(`Ctrl+O`)**:不做(紧凑无展开已定)。
- **连续 Read/Search 折叠成一条汇总**(CC 的 `collapseReadSearchGroups`):v1 不做,每次工具调用各占一块;若日后刷屏明显再议。
- **TUI 文案全中文化**:`Read N lines`/`Found N files` 等摘要文案本子项暂保持简洁英文短语(与 CC 一致);是否全中文化留给 Phase 7「文案全中文化」子项统一定夺。
