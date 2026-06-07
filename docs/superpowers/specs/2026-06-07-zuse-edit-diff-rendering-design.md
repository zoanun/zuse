# TUI Edit 工具彩色 diff 渲染设计(Phase 7 子项 #2)

> 状态:设计已批准,待落实现计划。
> 上游:[phase-roadmap.md](../plans/phase-roadmap.md) Phase 7「UI 打磨」。
> 同属 Session 1(StreamRenderer 渲染层重构)三块之一,另两块为 [#1 工具块 CC 风格](./2026-06-07-zuse-tool-block-rendering-design.md)与 [#3 Markdown 双态渲染](./2026-06-07-zuse-markdown-rendering-design.md)。三块共改 `StreamRenderer.tsx`,统一实现、按 commit 拆分。
> 依赖:**建立在 #1 之上** —— #1 已把 Edit 工具块的 `⎿` 摘要占位成 `Updated <file> (N replacement(s))`;本子项把这条占位摘要扩成彩色行级 diff。
> 范围:仅 **Edit 工具块的 diff 渲染**。Write 不在内(见 §6)。

## 1. 目标与动机

[#1](./2026-06-07-zuse-tool-block-rendering-design.md) 落地后,Edit 调用渲染成:

```
● Edit(src/calc.ts)
  ⎿ Updated src/calc.ts (1 replacement(s))
```

只知道「改了」,看不到「改了什么」。CC 会在 Edit 下渲染一段彩色 diff(红删绿增)。目标:**把 Edit 块的 `⎿` 摘要扩成行级彩色 diff**,让人一眼看出这次替换的具体内容。

### 关键约束:渲染期只有 old_string / new_string

[EditTool](../../../packages/tools/src/edit.ts) 自身只返回 `Edited <path> (N replacement(s)).`,**不产出 diff**。但 `tool.input` 带着 `old_string`/`new_string`(见 [types.ts](../../../packages/tui/src/types.ts) 的 `UIToolCall.input`)。diff 在**渲染期**从这两段串直接算 —— 不读文件、不做 IO、不改工具(与 #1 / #3 同样的渲染层思路)。

代价:渲染期**拿不到文件里的真实行号和周边上下文**,所以是「盲 diff」—— 只呈现被替换的这块区域(old_string ↔ new_string),没有行号槽,也没有区域之外的上下文。

### 已决策(brainstorm 结论)

- **形态 = 行级 LCS 内部 diff。** 在 old/new 两段内做行级 LCS:未变行作暗色上下文,只给真正变动的行打 `-`(红)/`+`(绿)。
- **收口 = 全上下文,总限 10 行。** 不修剪未变上下文;总渲染行(上下文+增+删)超 10 行才截,末尾暗色 `… +K 行`。
- **只管 Edit**;Write 维持 #1 的 `Wrote N lines`。
- 位置:**Edit 工具块内**,不另起独立块。

## 2. 渲染形态:行级 LCS 内部 diff

```
● Edit(src/calc.ts)
  ⎿ Updated src/calc.ts  +2 -1
      const x = 1                  ← 未变上下文:暗色,2 空格前缀对齐
    - const y = 2                  ← 删除:红色,'- ' 前缀
    + const y = 3                  ← 新增:绿色,'+ ' 前缀
    + const z = 4
      return x
```

- **`⎿` 行**:`Updated <file>  +A -R`(`A` = 新增行数,`R` = 删除行数;均来自 diff 统计)。
- **diff 行**(在 `⎿` 行下,对齐到 `⎿` 内容列,即 4 空格缩进起):
  - 删除行:红色,前缀 `- `。
  - 新增行:绿色,前缀 `+ `。
  - 未变上下文行:暗色,前缀 `  `(两空格,与 `-`/`+` 等宽对齐)。
- **`replace_all` 多处替换**:diff 区域是单一的 `old_string → new_string`(一个概念性 hunk),渲染该 hunk **一次**即可;`⎿` 行追加 `(×N)` 标注共替换 N 处。`+A -R` 按单个 hunk 计(不 ×N,避免误导)。

## 3. LCS 行级 diff 算法

纯函数,无 React、无 IO、无依赖(手写小 LCS,类比 #3 的 `layout.ts`):

1. **切行**:`old_string` / `new_string` 各按 `\n` 切成行数组。注意尾部 `\n`:`'a\nb\n'.split('\n')` → `['a','b','']`,末尾空串代表「以换行结尾」;算法对空串行照常参与 LCS(空行也是合法的一行),但渲染时末尾纯空行不额外造行。
2. **LCS**:标准动态规划求两行数组的最长公共子序列(逐行按字符串全等比较)。表大小 = `(m+1)×(n+1)`,old/new 都不大(受 §4 上限保护),DP 成本可忽略。
3. **回溯成行序列**:从 DP 表回溯,产出有序的 `DiffRow[]`:
   - 公共行 → `{ kind: 'context', text }`
   - 仅在 old 中 → `{ kind: 'del', text }`
   - 仅在 new 中 → `{ kind: 'add', text }`
   顺序遵循「删除在新增前、上下文按原位」的常规 diff 排布。
4. **统计**:`added` = `add` 行数,`removed` = `del` 行数 → `⎿` 行的 `+A -R`。

导出(全部单测):

- `computeLineDiff(oldStr: string, newStr: string): DiffRow[]`
- `diffStats(rows: DiffRow[]): { added: number; removed: number }`
- `capDiff(rows: DiffRow[], max: number): { rows: DiffRow[]; more: number }` —— 取前 `max` 行,`more` = 截掉的行数(见 §4)。

`type DiffRow = { kind: 'context' | 'add' | 'del'; text: string }`

## 4. 收口:全上下文,总限 10 行

- **不修剪上下文**:`computeLineDiff` 产出的全部行(含未变上下文)按序保留。old/new 通常已是模型发来的紧凑串,绝大多数 Edit 不触顶。
- **总行上限 = 10**:`capDiff(rows, 10)` 取前 10 个 `DiffRow`。
- **溢出提示**:若 `more > 0`,在 diff 行末尾追加一行暗色 `… +{more} 行`。
- 固定 10 行,**不提供展开**(对齐 #1 已定的紧凑无展开策略)。

> 与 #1 的 Bash 预览(最多 5 行)是两套预算:Bash 是「输出即价值」的命令输出,diff 是结构化改动,信息密度不同,故 diff 给到 10 行。两者都走「固定上限 + `… +K 行`」的同一范式。

## 5. 架构与文件划分

| 文件 | 职责 |
|---|---|
| `packages/tui/src/components/editDiff.ts` | **纯函数**:`computeLineDiff`(§3 的 LCS)、`diffStats`、`capDiff`。无 React、无 IO、不 import 工具包。 |
| `packages/tui/src/components/editDiff.test.ts` | `editDiff.ts` 的单测(vitest,`.test.ts`)。 |

### 接线点

改 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) `ToolBlock` 的 Edit 分支(#1 落地后该分支已存在):

- 当 `tool.name === 'Edit'`、`status === 'done'`、非 `isError`、且 `input` 含字符串 `old_string`/`new_string` 时:
  1. `rows = computeLineDiff(old, new)`;`{ added, removed } = diffStats(rows)`;`{ rows: shown, more } = capDiff(rows, 10)`。
  2. `⎿` 行渲染 `Updated <file>  +{added} -{removed}`(`replace_all` 时追加 `(×N)`,N 取自工具 output 解析或 input)。
  3. 其下逐行渲染 `shown`:按 `kind` 着色(del 红 / add 绿 / context 暗)+ 对应前缀,4 空格缩进。
  4. `more > 0` 时追加暗色 `… +{more} 行`。
- **取不到 old/new 或为错误态**:回落到 #1 的行为(`isError` → 红色首行;否则 `Updated <file>`),不渲染 diff。这保证 #2 是对 #1 的纯增强,坏数据不致崩。

`summarizeOutput`(#1 在 `toolSummary.ts` 里的 Edit 分支)与本子项的关系:Edit 的 diff 渲染逻辑足够特化,**直接在 `ToolBlock` 的 Edit 分支调用 `editDiff.ts`**,不挤进 `summarizeOutput` 的通用返回类型。`summarizeOutput` 对 Edit 仍可保留 #1 的 `Updated <file>` 作为 diff 不可用时的兜底文案。

## 6. 范围外 / 后续

- **Write 的 diff**:不做。Write 是整文件覆盖,渲染期拿不到旧内容(`input` 只有新 `content`),无法算 diff;维持 #1 的 `Wrote N lines`。
- **真实行号 / 区域外上下文**:不做(需渲染期读文件,违反无 IO 原则)。
- **字符级(intra-line)高亮**:不做。只到行级 LCS;同一行内的细粒度增删不再着色,YAGNI。
- **语法高亮**:不做(与 #3 一致)。
- **交互式展开**:不做(紧凑无展开已定)。
- **`… +K 行` 等提示文案的全中文化**:与 #1 同,简洁中英按 Phase 7「文案全中文化」子项统一定夺。
