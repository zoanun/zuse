# TUI Edit 工具彩色 diff 渲染实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Edit 工具块的 `⎿` 摘要从 #1 的占位文案 `Updated <file> (N replacement(s))` 升级成彩色行级 diff:`Updated <file>  +A -R` 标题行 + 行级 LCS diff(红删、绿增、暗色上下文),全部在渲染期从 `input.old_string`/`input.new_string` 算出,不读文件、不改工具。

**Architecture:** 行级 LCS diff 是纯字符串数学,集中到无副作用的 `editDiff.ts` 并用 vitest 单测;`StreamRenderer.tsx` 的 `ToolResultLine`(#1 引入)在 Edit 分支调用 `editDiff.ts` 渲染彩色行,数据不可用时回落到 #1 的通用摘要。不改 `useConversation`、不改 `types.ts`、不增依赖。

**Tech Stack:** TypeScript(strict)、Ink 5、React 18(react-jsx 自动运行时)、vitest。**无需新增依赖**。

> **Session 1 协调 / 依赖:** 本计划是 Phase 7「Session 1」的 **Edit diff commit 组**,**建立在 #1 工具块计划之上**——必须先完成 [#1 工具块实现计划](2026-06-07-zuse-tool-block-rendering.md)(它在 `StreamRenderer.tsx` 引入了 `ToolBlock` + `ToolResultLine`,且 Edit 在 #1 下已渲染成 `⎿ Updated <file> (N replacement(s))`)。本计划只扩 `ToolResultLine` 的 Edit 分支,与 #3 Markdown(改助手分支)编辑面不冲突。详见 [phase-roadmap.md](phase-roadmap.md) 与 [本子项 spec](../specs/2026-06-07-zuse-edit-diff-rendering-design.md)。

---

## 关键约定(每个任务都必须遵守)

- **JSX 运行时是 `react-jsx`**:`.tsx` 文件**不要** `import React`。需要类型用 `import type { ReactElement } from 'react'`。
- **`verbatimModuleSyntax: true`**:仅类型的导入写 `import type`。
- **`noUncheckedIndexedAccess: true`**:数组下标返回 `T | undefined`。本计划的 DP 表与回溯大量用下标,统一用 `!` 断言(逻辑已保证边界)——遵循下文给出的代码原样,不要改写成 `?? 0` 以免改变 LCS 语义。
- **不准用 `any`**;函数入参与返回显式标注类型。
- **代码注释一律中文**。
- **Prettier**:无分号、单引号、`trailingComma: all`、`printWidth: 100`、2 空格缩进。
- **import 用 `.js` 后缀**(即使目标是 `.ts`/`.tsx`)。
- **测试文件名必须是 `*.test.ts`**;本计划测试全是纯函数测试,不渲染组件、不需要 ink-testing-library(渲染层快照随 #3 引入时统一覆盖)。
- **所有命令在仓库根 `e:/ai-study/zuse` 下执行**。单测单文件:`pnpm exec vitest run <相对路径>`。类型检查:`pnpm -F @zuse/tui typecheck`。
- **`editDiff.ts` 不得 import 工具包(`@zuse/tools`)或 React**:它是纯字符串算法。
- **不要触碰** `packages/tools/src/lsp/*`、`packages/core/src/prompt.ts`、`packages/tools/src/util.ts`、`packages/tools/src/index.ts`、`shell-snapshot.ts`(他人未提交的并行工作)。

---

## File Structure

新增文件(在 `packages/tui/src/components/`):

| 文件 | 职责 |
|---|---|
| `editDiff.ts` | **纯函数**:`computeLineDiff(oldStr, newStr)`(行级 LCS)、`diffStats(rows)`、`capDiff(rows, max)`,导出 `DiffRow` 类型。无 React、无 IO。 |
| `editDiff.test.ts` | `editDiff.ts` 的 vitest 单测。 |

修改既有文件:

- `packages/tui/src/components/StreamRenderer.tsx`:顶部加 import;在 `ToolResultLine`(#1 引入)开头加 Edit 分支,调用 `editDiff.ts` 渲染彩色 diff;数据不可用时回落到既有逻辑。

> **渲染形态(spec §2):**
> ```
> ● Edit(src/calc.ts)
>   ⎿ Updated src/calc.ts  +2 -1
>       const x = 1            ← 未变上下文:暗色,4 空格 + 2 空格前缀
>     - const y = 2            ← 删除:红色,4 空格 + "- " 前缀
>     + const y = 3            ← 新增:绿色,4 空格 + "+ " 前缀
>     + const z = 4
>       return x
> ```
> `replace_all` 多处替换:diff 渲染单一 `old→new` hunk 一次,标题行追加 `(×N)`;`+A -R` 按单 hunk 计(不 ×N)。

---

### Task 1: editDiff.ts — computeLineDiff(行级 LCS)

**Files:**
- Create: `packages/tui/src/components/editDiff.ts`
- Test: `packages/tui/src/components/editDiff.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/editDiff.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { computeLineDiff } from './editDiff.js'

describe('computeLineDiff', () => {
  it('纯新增:尾部加一行', () => {
    expect(computeLineDiff('a\nb', 'a\nb\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
  })
  it('纯删除:去掉中间一行', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'context', text: 'c' },
    ])
  })
  it('替换:删在增前,上下文不动', () => {
    expect(computeLineDiff('a\nx\nb', 'a\ny\nb')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
      { kind: 'context', text: 'b' },
    ])
  })
  it('尾随换行不产生末尾空行', () => {
    expect(computeLineDiff('a\n', 'a\nb\n')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })
  it('保留中间空行(只去尾随换行造的末尾空串)', () => {
    expect(computeLineDiff('a\n\nb', 'a\n\nb')).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: '' },
      { kind: 'context', text: 'b' },
    ])
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/editDiff.test.ts`
Expected: FAIL — 无法解析 `./editDiff.js`。

- [ ] **Step 3: 写最小实现**

Create `packages/tui/src/components/editDiff.ts`:
```ts
/** diff 中的一行:未变上下文 / 新增 / 删除。 */
export type DiffRow = { kind: 'context' | 'add' | 'del'; text: string }

/**
 * 按 \n 切行;去掉尾随换行产生的末尾空串(渲染时不额外造空行),保留中间空行。
 * 例:'a\nb\n' → ['a','b'];'' → [''];'a' → ['a']。
 */
function splitLines(s: string): string[] {
  const lines = s.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 行级 LCS diff:对 old/new 两段做最长公共子序列,未变行作上下文,
 * 变动行打 del(仅 old)/ add(仅 new)。回溯保证「删在增前、上下文按原位」。
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffRow[] {
  const a = splitLines(oldStr)
  const b = splitLines(newStr)
  const m = a.length
  const n = b.length
  // lcs[i][j] = a[i..] 与 b[j..] 的 LCS 长度(后缀表)。
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  // 回溯:相等→context;否则按 LCS 取较优方向,平手时优先 del(保证删在增前)。
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      rows.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) {
    rows.push({ kind: 'del', text: a[i]! })
    i++
  }
  while (j < n) {
    rows.push({ kind: 'add', text: b[j]! })
    j++
  }
  return rows
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/editDiff.test.ts`
Expected: PASS(5 个用例)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/editDiff.ts packages/tui/src/components/editDiff.test.ts
git commit -m "feat(tui): editDiff 行级 LCS diff computeLineDiff"
```

---

### Task 2: editDiff.ts — diffStats / capDiff

**Files:**
- Modify: `packages/tui/src/components/editDiff.ts`
- Test: `packages/tui/src/components/editDiff.test.ts`

- [ ] **Step 1: 追加失败测试**

`editDiff.test.ts` 顶部 import 改为:
```ts
import { computeLineDiff, diffStats, capDiff } from './editDiff.js'
import type { DiffRow } from './editDiff.js'
```
文件末尾追加:
```ts
describe('diffStats', () => {
  it('分别数 add / del,context 不计', () => {
    const rows: DiffRow[] = [
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
      { kind: 'add', text: 'z' },
    ]
    expect(diffStats(rows)).toEqual({ added: 2, removed: 1 })
  })
  it('空 diff 全 0', () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0 })
  })
})

describe('capDiff', () => {
  it('不超上限时原样返回,more=0', () => {
    const rows: DiffRow[] = [
      { kind: 'add', text: '1' },
      { kind: 'add', text: '2' },
    ]
    expect(capDiff(rows, 10)).toEqual({ rows, more: 0 })
  })
  it('超上限时截前 max 行,more 记溢出数', () => {
    const rows: DiffRow[] = Array.from({ length: 12 }, (_, k) => ({
      kind: 'context' as const,
      text: String(k),
    }))
    const out = capDiff(rows, 10)
    expect(out.rows).toHaveLength(10)
    expect(out.more).toBe(2)
    expect(out.rows[9]).toEqual({ kind: 'context', text: '9' })
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/editDiff.test.ts`
Expected: FAIL — `diffStats` / `capDiff` 未导出。

- [ ] **Step 3: 追加实现**

在 `editDiff.ts` 末尾追加:
```ts
/** 统计新增 / 删除行数(供标题行的 +A -R)。 */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}

/** 收口:取前 max 行,more = 截掉的行数(为 0 表示未截)。 */
export function capDiff(rows: DiffRow[], max: number): { rows: DiffRow[]; more: number } {
  if (rows.length <= max) return { rows, more: 0 }
  return { rows: rows.slice(0, max), more: rows.length - max }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/editDiff.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/editDiff.ts packages/tui/src/components/editDiff.test.ts
git commit -m "feat(tui): editDiff 的 diffStats / capDiff"
```

---

### Task 3: 接入 ToolResultLine 的 Edit 分支

**Files:**
- Modify: `packages/tui/src/components/StreamRenderer.tsx`(顶部 import + `ToolResultLine` 增 Edit 分支 + 新增 `EditDiffBlock`)

**说明:** #1 已让 `ToolResultLine` 把 Edit 渲染成 `⎿ Updated <file> (N replacement(s))`(走 `summarizeOutput` 的 line 分支)。本任务在 `ToolResultLine` 开头插入 Edit 专用分支:有可用的字符串 `old_string`/`new_string` 时渲染彩色 diff,否则**保持原样回落**到 #1 的通用摘要(坏数据不崩,纯增强)。无渲染单测(diff 数学已由 `editDiff.test.ts` 覆盖;ink 快照随 #3 统一补),验收靠 typecheck + eslint。

- [ ] **Step 1: 改 import**

把 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 顶部(#1 落地后的 import 区)加入两行——在 `import { summarizeOutput, toolSpecifier } from './toolSummary.js'` 之后:
```tsx
import { computeLineDiff, diffStats, capDiff } from './editDiff.js'
import type { ReactElement } from 'react'
```

- [ ] **Step 2: 在 ToolResultLine 开头加 Edit 分支**

把 `ToolResultLine` 函数体开头(`const summary = summarizeOutput(tool)` 这一行**之前**)插入:
```tsx
  // Edit:有可用 old/new 时渲染彩色行级 diff(#2);否则回落到通用摘要。
  if (tool.name === 'Edit' && !tool.isError) {
    const diff = renderEditDiff(tool)
    if (diff) return diff
  }
```

- [ ] **Step 3: 新增 renderEditDiff 组件函数**

在 `ToolResultLine` 函数**之后**新增:
```tsx
/** Edit 一次替换的处数:从工具 output "Edited X (N replacement(s))." 解析;取不到记 1。 */
function countReplacements(output: string | undefined): number {
  const m = (output ?? '').match(/\((\d+) replacement/)
  return m?.[1] ? Number(m[1]) : 1
}

/**
 * 渲染 Edit 的彩色行级 diff。数据(字符串 old/new)不可用时返回 null,
 * 让 ToolResultLine 回落到 #1 的通用摘要。
 */
function renderEditDiff(tool: UIToolCall): ReactElement | null {
  const input = tool.input as {
    old_string?: unknown
    new_string?: unknown
    file_path?: unknown
    replace_all?: unknown
  }
  if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null

  const file = typeof input.file_path === 'string' ? input.file_path : ''
  const rows = computeLineDiff(input.old_string, input.new_string)
  const { added, removed } = diffStats(rows)
  const { rows: shown, more } = capDiff(rows, 10)
  // replace_all 多处替换:标题行追加 (×N);+A -R 仍按单 hunk 计。
  const times = countReplacements(tool.output)
  const suffix = input.replace_all === true && times > 1 ? ` (×${times})` : ''

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`  ⎿ Updated ${file}  `}
        <Text color="green">{`+${added}`}</Text>
        {' '}
        <Text color="red">{`-${removed}`}</Text>
        {suffix}
      </Text>
      {shown.map((r, i) => {
        const prefix = r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '
        const color = r.kind === 'add' ? 'green' : r.kind === 'del' ? 'red' : undefined
        return (
          <Text key={i} color={color} dimColor={r.kind === 'context'}>
            {`    ${prefix}${r.text}`}
          </Text>
        )
      })}
      {more > 0 && <Text dimColor>{`    … +${more} 行`}</Text>}
    </Box>
  )
}
```

- [ ] **Step 4: 类型检查 + lint + 全量回归**

Run:
```bash
pnpm -F @zuse/tui typecheck
pnpm exec eslint packages/tui/src/components/editDiff.ts packages/tui/src/components/StreamRenderer.tsx
pnpm exec vitest run packages/tui
```
Expected: 类型无错、lint 无错、测试全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/StreamRenderer.tsx
git commit -m "feat(tui): Edit 工具块渲染彩色行级 diff(+A -R)"
```

---

## Self-Review(写完计划后的对照检查)

- **Spec 覆盖**:§2 渲染形态(`Updated <file> +A -R` + 4 空格缩进的红删/绿增/暗上下文、`replace_all` 的 `(×N)`)→Task 3;§3 LCS 算法(切行含尾随换行处理、DP、回溯、统计)→Task 1+2;§4 收口(全上下文、总限 10、`… +K 行`、不展开)→Task 2 的 `capDiff(rows,10)` + Task 3 的 `more` 渲染;§5 文件划分(`editDiff.ts` + 接线点、坏数据回落)→Task 1–3;§6 范围外(Write diff、真实行号、字符级高亮、语法高亮、交互展开)均不在任务内。
- **占位符扫描**:无 TBD/TODO;每个代码步骤给出完整代码。
- **类型一致性**:`DiffRow` 在 Task 1 定义、Task 2 统计/截断、Task 3 渲染,字段(`kind`/`text`)一致。`computeLineDiff`/`diffStats`/`capDiff` 签名跨任务一致;`renderEditDiff` 返回 `ReactElement | null`,与 `ToolResultLine` 的 `if (diff) return diff` 消费一致。
- **依赖前置**:Task 3 依赖 #1 已建立的 `ToolResultLine` 与 `UIToolCall` import;若 #1 未落地,Task 3 的插入点不存在——执行顺序必须 #1 → #2。

## 完成后

Edit 工具块在 `⎿` 下呈现彩色行级 diff,一眼可见本次替换的增删内容。#3 Markdown 改助手分支,独立 commit;三块合起来即 Session 1 的「StreamRenderer 渲染层重构」。
