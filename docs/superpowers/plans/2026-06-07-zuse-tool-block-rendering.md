# TUI 工具执行块 CC 风格实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 zuse TUI 的工具调用块从 `✓/✗ + Name(json) + output 首行` 改造成 Claude Code 风格:`●` 标记 + `Name(主参数)` 标题 + `⎿` 行的按工具语义化 OUT 摘要(Read/Glob/Grep/Edit/Write 给名词短语,Bash 类给最多 5 行真实输出)。

**Architecture:** 纯逻辑(参数摘要、OUT 摘要、行计数、尾注剥离)集中到无副作用的 `toolSummary.ts` 并用 vitest 单测;平台适配的圆点常量放 `figures.ts`;`StreamRenderer.tsx` 的 `ToolBlock` 只做「消费纯函数结果 → 渲染」。不改 `useConversation`、不改 `MessageList`、不动 `types.ts`。

**Tech Stack:** TypeScript(strict)、Ink 5、React 18(react-jsx 自动运行时)、vitest。**无需新增依赖**。

> **Session 1 协调:** 本计划是 Phase 7「Session 1:StreamRenderer 渲染层重构」的 **工具块 commit 组**,实现顺序排在最前。同会话另有 **#2 Edit diff**(建立在本计划的 `ToolBlock` Edit 分支之上)与 **#3 Markdown 双态**(只改助手分支,独立)。三块都改同一个 `StreamRenderer.tsx`,但编辑面不同:本计划改 `ToolBlock`(工具分支)+ 顶部 import;#3 改助手分支 + 顶部 import;#2 在本计划落地后扩 `ToolBlock` 的 Edit 分支。按 commit 拆开。详见 [phase-roadmap.md](phase-roadmap.md) 的「Session 1」协调说明,以及 [本子项 spec](../specs/2026-06-07-zuse-tool-block-rendering-design.md)。

---

## 关键约定(每个任务都必须遵守)

- **JSX 运行时是 `react-jsx`**:`.tsx` 组件文件**不要** `import React`(参照现有 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx))。需要 React 类型时用 `import type { ReactNode, ReactElement } from 'react'`。
- **`verbatimModuleSyntax: true`**:只用于类型的导入必须写 `import type`。
- **`noUncheckedIndexedAccess: true`**:数组/对象下标访问返回 `T | undefined`,务必 `!` 断言(仅在逻辑已保证非空处)或 `?? 默认值` 兜底。本计划的 DP/回溯代码大量用到,注意。
- **不准用 `any`**;**所有函数入参与返回显式标注类型**。
- **代码注释一律中文**。
- **Prettier**:无分号、单引号、`trailingComma: all`、`printWidth: 100`、2 空格缩进。
- **import 用 `.js` 后缀**(即使目标是 `.ts`/`.tsx`),这是本仓库的 Bundler 解析约定(参照现有 `import { Spinner } from './Spinner.js'`)。
- **测试文件名必须是 `*.test.ts`**(vitest 的 include 是 `packages/*/src/**/*.test.ts`,不收 `.tsx`)。本计划的测试全是纯函数测试,**不渲染组件、不需要 ink-testing-library**(渲染层快照由 #3 引入 `ink-testing-library` 时统一覆盖,见 [spec §8](../specs/2026-06-07-zuse-tool-block-rendering-design.md))。
- **所有命令在仓库根 `e:/ai-study/zuse` 下执行**。单测单文件:`pnpm exec vitest run <相对路径>`。类型检查:`pnpm -F @zuse/tui typecheck`。
- **`toolSummary.ts` 不得 import 工具包(`@zuse/tools`)**:它仅靠 `tool.name` 字符串 + `tool.input`/`tool.output` 在渲染期推导,保持渲染层与工具实现解耦(spec §7)。
- **不要触碰** `packages/tools/src/lsp/*`、`packages/core/src/prompt.ts`、`packages/tools/src/util.ts`、`packages/tools/src/index.ts`、`shell-snapshot.ts`(他人未提交的并行工作)。本计划只动 `packages/tui/`。

---

## File Structure

新增文件(均在 `packages/tui/src/components/`):

| 文件 | 职责 |
|---|---|
| `figures.ts` | 平台适配常量 `BLACK_CIRCLE`(`darwin` → `⏺`,否则 `●`)。无逻辑、无测试。 |
| `toolSummary.ts` | **纯函数**:`toolSpecifier(name, input)`(IN 摘要)、`summarizeOutput(tool)`(OUT 摘要,返回判别联合 `OutputSummary`)、及辅助 `stripTrailingNotes`/`countLines`/`previewLines`。无 React、无副作用、不 import 工具包。 |
| `toolSummary.test.ts` | `toolSummary.ts` 的 vitest 单测。 |

修改既有文件:

- `packages/tui/src/components/StreamRenderer.tsx`:重写 `ToolBlock`(标记列、标题、`⎿` 结果区),删除内联的 `summarizeInput`/`preview` 旧逻辑。其余分支(user/assistant/system)与 `StreamRenderer` 主体**不动**。

> **OUT 摘要算法依据(各工具 output 的确切格式,已核对源码):**
> - **Read** [read.ts](../../../packages/tools/src/read.ts):正文为每行 `"<行号>\t<文本>"` 用 `\n` 连接;空文件 → `(file is empty: <path>)`;截断尾注 `\n\n[truncated: …]`。
> - **Glob** [glob.ts](../../../packages/tools/src/glob.ts):路径用 `\n` 连接;无匹配 → `No files match: <pattern>`;截断尾注 `\n\n[truncated: showing first 100 of N matches]`。
> - **Grep** [grep.ts](../../../packages/tools/src/grep.ts):`files_with_matches` 列路径、`content` 为 `path:line:text`、`count` 为 `path:count`;无匹配 → `No matches for: <pattern>`;越界 → `[offset N is past the M result(s)]`;尾注 `\n\n[truncated: …]` 或 `\n\n[safety cap: …]`。
> - **Edit** [edit.ts](../../../packages/tools/src/edit.ts):成功 → `Edited <path> (N replacement(s)).`;`input` 有 `file_path`/`old_string`/`new_string`/`replace_all`。
> - **Write** [write.ts](../../../packages/tools/src/write.ts):成功 → `Wrote N bytes to <path>`(本计划**不用** output,改数 `input.content` 行数)。
> - **Bash** [bash.ts](../../../packages/tools/src/bash.ts):合并 stdout/stderr;空且成功 → `(no output)`;尾注 `\n[exit code: N]` / `\n[timed out after Nms]` / `\n[interrupted]` / `\n[killed by signal: S]` / `\n…[truncated: output exceeded 30000 chars]`(可叠加截断 + 退出码两条)。

---

### Task 1: figures.ts — 平台适配圆点常量

**Files:**
- Create: `packages/tui/src/components/figures.ts`

(无独立测试:仅一个平台分支常量,由后续 `ToolBlock` 使用 + typecheck 覆盖。)

- [ ] **Step 1: 写实现**

Create `packages/tui/src/components/figures.ts`:
```ts
/**
 * 工具/助手标题行的圆点标记。
 * macOS 用 ⏺(终端里垂直对齐更好),其余平台用 ●(Windows/Linux 字体支持更稳)。
 * 对齐 cc-haha 的 figures.ts 取舍。
 */
export const BLACK_CIRCLE: string = process.platform === 'darwin' ? '⏺' : '●'
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 3: 提交**

```bash
git add packages/tui/src/components/figures.ts
git commit -m "feat(tui): 平台适配圆点常量 BLACK_CIRCLE"
```

---

### Task 2: toolSummary.ts — 辅助函数 stripTrailingNotes / countLines / previewLines

**Files:**
- Create: `packages/tui/src/components/toolSummary.ts`
- Test: `packages/tui/src/components/toolSummary.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/toolSummary.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { stripTrailingNotes, countLines, previewLines } from './toolSummary.js'

describe('stripTrailingNotes', () => {
  it('剥掉 Read 的 \\n\\n[truncated: …] 尾注', () => {
    expect(stripTrailingNotes('1\tfoo\n2\tbar\n\n[truncated: showing lines 1-2 of 9]')).toBe(
      '1\tfoo\n2\tbar',
    )
  })
  it('剥掉 Bash 的 \\n[exit code: 1] 尾注', () => {
    expect(stripTrailingNotes('boom\n[exit code: 1]')).toBe('boom')
  })
  it('叠加的截断 + 退出码两条尾注都剥掉', () => {
    expect(stripTrailingNotes('out\n…[truncated: output exceeded 30000 chars]\n[exit code: 2]')).toBe(
      'out',
    )
  })
  it('正文里行内的方括号不被误删', () => {
    expect(stripTrailingNotes('5\tconst x = arr[i]')).toBe('5\tconst x = arr[i]')
  })
  it('无尾注时原样返回', () => {
    expect(stripTrailingNotes('a\nb')).toBe('a\nb')
  })
})

describe('countLines', () => {
  it('空串记 0 行', () => {
    expect(countLines('')).toBe(0)
  })
  it('单行记 1,多行按 \\n 数', () => {
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\nc')).toBe(3)
  })
})

describe('previewLines', () => {
  it('不超上限时全给,moreCount=0', () => {
    expect(previewLines('a\nb\nc', 5)).toEqual({ lines: ['a', 'b', 'c'], moreCount: 0 })
  })
  it('超上限时截前 N 行,余下计入 moreCount', () => {
    expect(previewLines('1\n2\n3\n4\n5\n6\n7', 5)).toEqual({
      lines: ['1', '2', '3', '4', '5'],
      moreCount: 2,
    })
  })
  it('空串给空数组', () => {
    expect(previewLines('', 5)).toEqual({ lines: [], moreCount: 0 })
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: FAIL — 无法解析 `./toolSummary.js`(模块不存在)。

- [ ] **Step 3: 写最小实现**

Create `packages/tui/src/components/toolSummary.ts`:
```ts
import type { UIToolCall } from '../types.js'

/** OUT 摘要的判别联合:单行计数 / 多行预览 / 错误单行。 */
export type OutputSummary =
  | { kind: 'line'; text: string }
  | { kind: 'preview'; lines: string[]; moreCount: number }
  | { kind: 'error'; text: string }

/** 匹配输出尾部的方括号状态/截断注记(可选前导 … 与多个换行)。 */
const TRAILING_NOTE_RE = /\n+…?\[[^\]]*\]\s*$/

/** 剥掉输出尾部的方括号状态/截断注记(可叠加多条),供行计数与预览前清洗。 */
export function stripTrailingNotes(output: string): string {
  let s = output
  while (TRAILING_NOTE_RE.test(s)) s = s.replace(TRAILING_NOTE_RE, '')
  return s
}

/** 数行数:空串 0,否则按 \n 切。调用方应先 stripTrailingNotes。 */
export function countLines(body: string): number {
  if (body === '') return 0
  return body.split('\n').length
}

/** 取正文前 maxLines 行作预览,余下行数记入 moreCount。调用方应先 stripTrailingNotes。 */
export function previewLines(body: string, maxLines: number): { lines: string[]; moreCount: number } {
  const all = body === '' ? [] : body.split('\n')
  return { lines: all.slice(0, maxLines), moreCount: Math.max(0, all.length - maxLines) }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: PASS(3 个 describe 全绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/toolSummary.ts packages/tui/src/components/toolSummary.test.ts
git commit -m "feat(tui): toolSummary 辅助函数(尾注剥离/行计数/预览)"
```

---

### Task 3: toolSummary.ts — toolSpecifier(IN 摘要)

**Files:**
- Modify: `packages/tui/src/components/toolSummary.ts`
- Test: `packages/tui/src/components/toolSummary.test.ts`

- [ ] **Step 1: 追加失败测试**

`toolSummary.test.ts` 顶部 import 改为:
```ts
import {
  stripTrailingNotes,
  countLines,
  previewLines,
  toolSpecifier,
} from './toolSummary.js'
```
文件末尾追加:
```ts
describe('toolSpecifier', () => {
  it('Read/Edit/Write 取 file_path', () => {
    expect(toolSpecifier('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolSpecifier('Edit', { file_path: 'src/b.ts' })).toBe('src/b.ts')
    expect(toolSpecifier('Write', { file_path: 'src/c.ts' })).toBe('src/c.ts')
  })
  it('Glob/Grep 取 pattern', () => {
    expect(toolSpecifier('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(toolSpecifier('Grep', { pattern: 'foo' })).toBe('foo')
  })
  it('Bash 取 command,超长截断到 60 + …', () => {
    expect(toolSpecifier('Bash', { command: 'pnpm test' })).toBe('pnpm test')
    const long = 'echo ' + 'x'.repeat(80)
    expect(toolSpecifier('Bash', { command: long })).toBe(long.slice(0, 60) + '…')
  })
  it('WebFetch 取 url、WebSearch 取 query', () => {
    expect(toolSpecifier('WebFetch', { url: 'http://x.y' })).toBe('http://x.y')
    expect(toolSpecifier('WebSearch', { query: 'ink ui' })).toBe('ink ui')
  })
  it('LSP 取 "operation symbol"', () => {
    expect(toolSpecifier('LSP', { operation: 'definition', symbol: 'foo' })).toBe('definition foo')
  })
  it('未知工具回落到压缩 JSON(≤60)', () => {
    expect(toolSpecifier('Mystery', { a: 1 })).toBe('{"a":1}')
  })
  it('取不到主参数时回落 JSON', () => {
    expect(toolSpecifier('Read', { x: 1 })).toBe('{"x":1}')
  })
  it('input 非对象时返回空串', () => {
    expect(toolSpecifier('Read', null)).toBe('')
    expect(toolSpecifier('Read', 'nope')).toBe('')
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: FAIL — `toolSpecifier` 未导出。

- [ ] **Step 3: 追加实现**

在 `toolSummary.ts` 末尾追加:
```ts
/** specifier 与 JSON 兜底的展示长度上限。 */
const SPECIFIER_MAX = 60

/** 把对象压成 ≤60 字符的 JSON(超出加 …),作为 specifier 兜底。 */
function fallbackJson(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj)
  return json.length > SPECIFIER_MAX ? json.slice(0, SPECIFIER_MAX) + '…' : json
}

/** 取字符串字段,非字符串返回 undefined。 */
function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/** 标题行括注:按工具显示主参数;取不到回落到压缩 JSON。 */
export function toolSpecifier(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return strField(obj, 'file_path') ?? fallbackJson(obj)
    case 'Glob':
    case 'Grep':
      return strField(obj, 'pattern') ?? fallbackJson(obj)
    case 'Bash': {
      const cmd = strField(obj, 'command')
      if (cmd === undefined) return fallbackJson(obj)
      return cmd.length > SPECIFIER_MAX ? cmd.slice(0, SPECIFIER_MAX) + '…' : cmd
    }
    case 'WebFetch':
      return strField(obj, 'url') ?? fallbackJson(obj)
    case 'WebSearch':
      return strField(obj, 'query') ?? fallbackJson(obj)
    case 'LSP': {
      const op = strField(obj, 'operation')
      const sym = strField(obj, 'symbol')
      if (op && sym) return `${op} ${sym}`
      return op ?? fallbackJson(obj)
    }
    default:
      return fallbackJson(obj)
  }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/toolSummary.ts packages/tui/src/components/toolSummary.test.ts
git commit -m "feat(tui): toolSpecifier 按工具取主参数"
```

---

### Task 4: toolSummary.ts — summarizeOutput(错误 + 计数类工具)

**Files:**
- Modify: `packages/tui/src/components/toolSummary.ts`
- Test: `packages/tui/src/components/toolSummary.test.ts`

**说明:** 本任务实现 `summarizeOutput` 的错误分支 + Read/Glob/Grep/Edit/Write/通用兜底。Bash 类预览分支留到 Task 5。为此本任务先建立 `summarizeOutput` 主函数与 `isOutputValueTool` 判定,Bash 类暂时也走「兜底单行」,Task 5 再替换为预览(届时改一处 switch 分支)。

- [ ] **Step 1: 追加失败测试**

`toolSummary.test.ts` 顶部 import 改为(追加 `summarizeOutput` 与类型):
```ts
import {
  stripTrailingNotes,
  countLines,
  previewLines,
  toolSpecifier,
  summarizeOutput,
} from './toolSummary.js'
import type { UIToolCall } from '../types.js'
```
文件末尾追加:
```ts
// 构造一个已完成的工具调用,便于测试 summarizeOutput。
function done(partial: Partial<UIToolCall> & { name: string }): UIToolCall {
  return { status: 'done', input: {}, ...partial }
}

describe('summarizeOutput · 错误分支', () => {
  it('非输出价值类工具出错 → kind:error,取首行', () => {
    const s = summarizeOutput(done({ name: 'Read', isError: true, output: 'File not found: x\n更多' }))
    expect(s).toEqual({ kind: 'error', text: 'File not found: x' })
  })
})

describe('summarizeOutput · Read', () => {
  it('正常计行', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '1\tfoo\n2\tbar' }))).toEqual({
      kind: 'line',
      text: 'Read 2 lines',
    })
  })
  it('单行用单数', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '1\tfoo' }))).toEqual({
      kind: 'line',
      text: 'Read 1 line',
    })
  })
  it('带 truncated 尾注时只数正文行', () => {
    const out = '1\ta\n2\tb\n\n[truncated: showing lines 1-2 of 9; pass offset: 3 to continue]'
    expect(summarizeOutput(done({ name: 'Read', output: out }))).toEqual({
      kind: 'line',
      text: 'Read 2 lines',
    })
  })
  it('空文件哨兵 → (empty file)', () => {
    expect(summarizeOutput(done({ name: 'Read', output: '(file is empty: src/x.ts)' }))).toEqual({
      kind: 'line',
      text: '(empty file)',
    })
  })
})

describe('summarizeOutput · Glob', () => {
  it('命中计文件数', () => {
    expect(summarizeOutput(done({ name: 'Glob', output: 'a.ts\nb.ts\nc.ts' }))).toEqual({
      kind: 'line',
      text: 'Found 3 files',
    })
  })
  it('无匹配哨兵 → No files matched', () => {
    expect(summarizeOutput(done({ name: 'Glob', output: 'No files match: *.zzz' }))).toEqual({
      kind: 'line',
      text: 'No files matched',
    })
  })
})

describe('summarizeOutput · Grep', () => {
  it('files_with_matches(默认)计文件数', () => {
    expect(summarizeOutput(done({ name: 'Grep', output: 'a.ts\nb.ts' }))).toEqual({
      kind: 'line',
      text: 'Found 2 files',
    })
  })
  it('content 模式计命中行数', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'content' }, output: 'a.ts:1:x\na.ts:2:y' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 2 lines' })
  })
  it('count 模式求和匹配数与文件数', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'count' }, output: 'a.ts:3\nb.ts:2' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 5 matches in 2 files' })
  })
  it('count 模式容忍 Windows 盘符路径(按最后一个冒号切)', () => {
    const t = done({ name: 'Grep', input: { output_mode: 'count' }, output: 'C:\\src\\a.ts:4' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Found 4 matches in 1 file' })
  })
  it('无匹配哨兵 → No matches found', () => {
    expect(summarizeOutput(done({ name: 'Grep', output: 'No matches for: zzz' }))).toEqual({
      kind: 'line',
      text: 'No matches found',
    })
  })
})

describe('summarizeOutput · Edit/Write', () => {
  it('Edit 复用 output 的替换数,改写为 Updated <file>', () => {
    const t = done({
      name: 'Edit',
      input: { file_path: 'src/x.ts' },
      output: 'Edited src/x.ts (2 replacement(s)).',
    })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Updated src/x.ts (2 replacement(s))' })
  })
  it('Write 数 input.content 行数', () => {
    const t = done({ name: 'Write', input: { content: 'a\nb\nc' }, output: 'Wrote 5 bytes to x' })
    expect(summarizeOutput(t)).toEqual({ kind: 'line', text: 'Wrote 3 lines' })
  })
})

describe('summarizeOutput · 通用兜底', () => {
  it('未知工具数行数', () => {
    expect(summarizeOutput(done({ name: 'Mystery', output: 'a\nb\nc\nd' }))).toEqual({
      kind: 'line',
      text: '4 lines of output',
    })
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: FAIL — `summarizeOutput` 未导出。

- [ ] **Step 3: 追加实现**

在 `toolSummary.ts` 末尾追加:
```ts
/** Bash 类「输出即价值」工具:输出本身就是要看的内容(Task 5 给多行预览)。 */
function isOutputValueTool(name: string): boolean {
  return name === 'Bash' || name === 'WebFetch' || name === 'WebSearch' || name === 'LSP'
}

/** "1 line" / "N lines" 之类的单复数;不规则复数(match→matches)传第三参。 */
function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular + 's')}`
}

function readSummary(output: string): OutputSummary {
  if (output.startsWith('(file is empty:')) return { kind: 'line', text: '(empty file)' }
  return { kind: 'line', text: `Read ${plural(countLines(stripTrailingNotes(output)), 'line')}` }
}

function globSummary(output: string): OutputSummary {
  if (output.startsWith('No files match:')) return { kind: 'line', text: 'No files matched' }
  return { kind: 'line', text: `Found ${plural(countLines(stripTrailingNotes(output)), 'file')}` }
}

function grepSummary(tool: UIToolCall): OutputSummary {
  const output = tool.output ?? ''
  if (output.startsWith('No matches for:') || output.startsWith('[offset ')) {
    return { kind: 'line', text: 'No matches found' }
  }
  const body = stripTrailingNotes(output)
  const mode = (tool.input as { output_mode?: unknown }).output_mode
  if (mode === 'count') {
    let matches = 0
    let files = 0
    for (const line of body.split('\n')) {
      const idx = line.lastIndexOf(':') // 路径可能含 ':'(Windows 盘符),取最后一个
      if (idx === -1) continue
      const n = Number(line.slice(idx + 1))
      if (Number.isFinite(n)) {
        matches += n
        files += 1
      }
    }
    return { kind: 'line', text: `Found ${plural(matches, 'match', 'matches')} in ${plural(files, 'file')}` }
  }
  const n = countLines(body)
  if (mode === 'content') return { kind: 'line', text: `Found ${plural(n, 'line')}` }
  return { kind: 'line', text: `Found ${plural(n, 'file')}` }
}

function editSummary(tool: UIToolCall): OutputSummary {
  const file = strField(tool.input as Record<string, unknown>, 'file_path') ?? ''
  const m = (tool.output ?? '').match(/\((\d+) replacement/)
  const n = m?.[1] ?? '1'
  return { kind: 'line', text: `Updated ${file} (${n} replacement(s))` }
}

function writeSummary(tool: UIToolCall): OutputSummary {
  const content = (tool.input as { content?: unknown }).content
  const n = typeof content === 'string' ? countLines(content) : 0
  return { kind: 'line', text: `Wrote ${plural(n, 'line')}` }
}

/** 渲染期从 name + input + output 推导 `⎿` 行摘要(纯函数,不调用工具)。 */
export function summarizeOutput(tool: UIToolCall): OutputSummary {
  const output = tool.output ?? ''
  if (tool.isError) {
    // Bash 类即便出错也保留多行预览(报错/测试正文常多行,Task 5 实现);
    // 其余工具错误取首行,渲染层据 tool.isError 着红。
    if (!isOutputValueTool(tool.name)) {
      return { kind: 'error', text: output.split('\n')[0] ?? '' }
    }
  }
  switch (tool.name) {
    case 'Read':
      return readSummary(output)
    case 'Glob':
      return globSummary(output)
    case 'Grep':
      return grepSummary(tool)
    case 'Edit':
      return editSummary(tool)
    case 'Write':
      return writeSummary(tool)
    default:
      // Bash / WebFetch / WebSearch / LSP 的预览在 Task 5 替换此处;
      // 现在与未知工具一并走单行计数兜底("N lines of output")。
      return { kind: 'line', text: `${plural(countLines(stripTrailingNotes(output)), 'line')} of output` }
  }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: PASS(新增的所有 describe 全绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/toolSummary.ts packages/tui/src/components/toolSummary.test.ts
git commit -m "feat(tui): summarizeOutput 错误分支与计数类工具摘要"
```

---

### Task 5: toolSummary.ts — Bash 类多行预览

**Files:**
- Modify: `packages/tui/src/components/toolSummary.ts`
- Test: `packages/tui/src/components/toolSummary.test.ts`

- [ ] **Step 1: 追加失败测试**

`toolSummary.test.ts` 末尾追加:
```ts
describe('summarizeOutput · Bash 类预览', () => {
  it('正文 ≤5 行原样预览', () => {
    expect(summarizeOutput(done({ name: 'Bash', output: 'a\nb\nc' }))).toEqual({
      kind: 'preview',
      lines: ['a', 'b', 'c'],
      moreCount: 0,
    })
  })
  it('正文 >5 行截前 5,余下记 moreCount', () => {
    const out = '1\n2\n3\n4\n5\n6\n7'
    expect(summarizeOutput(done({ name: 'Bash', output: out }))).toEqual({
      kind: 'preview',
      lines: ['1', '2', '3', '4', '5'],
      moreCount: 2,
    })
  })
  it('剥掉 [exit code] 尾注后再切预览', () => {
    const out = 'line1\nline2\n[exit code: 1]'
    expect(summarizeOutput(done({ name: 'Bash', isError: true, output: out }))).toEqual({
      kind: 'preview',
      lines: ['line1', 'line2'],
      moreCount: 0,
    })
  })
  it('(no output) 哨兵 → 单行', () => {
    expect(summarizeOutput(done({ name: 'Bash', output: '(no output)' }))).toEqual({
      kind: 'line',
      text: '(no output)',
    })
  })
  it('WebFetch/WebSearch/LSP 同走预览', () => {
    expect(summarizeOutput(done({ name: 'WebFetch', output: 'x\ny' }))).toEqual({
      kind: 'preview',
      lines: ['x', 'y'],
      moreCount: 0,
    })
  })
  it('出错且无正文(仅退出码)→ error 单行', () => {
    expect(summarizeOutput(done({ name: 'Bash', isError: true, output: '\n[exit code: 1]' }))).toEqual({
      kind: 'error',
      text: '',
    })
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: FAIL — Bash 当前走单行兜底,与预期的 `kind:'preview'` 不符。

- [ ] **Step 3: 改实现 — 加预览函数**

在 `toolSummary.ts` 里 `summarizeOutput` 之前加:
```ts
/** Bash 类工具的 `⎿` 下预览:最多 5 行真实输出。 */
const PREVIEW_MAX = 5

function bashPreview(output: string, isError: boolean): OutputSummary {
  if (output === '(no output)') return { kind: 'line', text: '(no output)' }
  const body = stripTrailingNotes(output)
  if (body === '') {
    // 仅有状态尾注、无正文:出错取首行(渲染层着红),否则视作无输出。
    return isError
      ? { kind: 'error', text: output.split('\n')[0] ?? '' }
      : { kind: 'line', text: '(no output)' }
  }
  const { lines, moreCount } = previewLines(body, PREVIEW_MAX)
  return { kind: 'preview', lines, moreCount }
}
```

- [ ] **Step 4: 改实现 — summarizeOutput 接入预览**

把 `summarizeOutput` 的 default 分支替换为:
```ts
    case 'Bash':
    case 'WebFetch':
    case 'WebSearch':
    case 'LSP':
      return bashPreview(output, tool.isError ?? false)
    default:
      return { kind: 'line', text: `${plural(countLines(stripTrailingNotes(output)), 'line')} of output` }
```

- [ ] **Step 5: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/toolSummary.test.ts`
Expected: PASS(全部 describe 绿)。

- [ ] **Step 6: 类型检查**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 7: 提交**

```bash
git add packages/tui/src/components/toolSummary.ts packages/tui/src/components/toolSummary.test.ts
git commit -m "feat(tui): Bash 类工具最多 5 行输出预览"
```

---

### Task 6: 接入 StreamRenderer 的 ToolBlock

**Files:**
- Modify: `packages/tui/src/components/StreamRenderer.tsx`(顶部 import + 重写 `ToolBlock` + 删除 `summarizeInput`)

**说明:** 本任务把 `ToolBlock` 改成消费 `figures.ts` + `toolSummary.ts`。无渲染单测(spec §8:#1 逻辑正确性已由 `toolSummary.test.ts` 覆盖,ink 渲染快照随 #3 引入 `ink-testing-library` 时统一补)。验收靠 typecheck + eslint。

> **与 #3 / #2 的编辑面边界:** 本任务只动 ① 顶部 import 区(新增两行);② `ToolBlock` 函数(整体重写)。**不要动** `StreamRenderer` 主体的 assistant/user/system 分支(那是 #3 的编辑面)。`ToolResultLine` 里预留的 Edit diff 接入点由 #2 后续扩展。

- [ ] **Step 1: 改 import**

把 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 顶部:
```tsx
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import type { UIMessage, UIToolCall } from '../types.js'
```
改为:
```tsx
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'
import { BLACK_CIRCLE } from './figures.js'
import { summarizeOutput, toolSpecifier } from './toolSummary.js'
import type { UIMessage, UIToolCall } from '../types.js'
```

- [ ] **Step 2: 删除旧的 summarizeInput 函数**

删掉这一段(连同其上方注释):
```tsx
/** 把一个工具的参数压成一行摘要，例如 Read(src/index.ts)。 */
function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.file_path === 'string') return obj.file_path
    const json = JSON.stringify(obj)
    return json.length > 60 ? json.slice(0, 60) + '…' : json
  }
  return ''
}
```

- [ ] **Step 3: 重写 ToolBlock**

把整个 `ToolBlock` 函数(从 `function ToolBlock({ tool }: { tool: UIToolCall }) {` 到其闭合 `}`)替换为:
```tsx
function ToolBlock({ tool }: { tool: UIToolCall }) {
  // 标记列:运行中 spinner(青);完成 ●(绿);出错 ●(红)。独占一列,悬挂缩进。
  const marker =
    tool.status === 'running' ? (
      <Spinner />
    ) : (
      <Text color={tool.isError ? 'red' : 'green'}>{BLACK_CIRCLE}</Text>
    )

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box marginRight={1}>{marker}</Box>
      <Box flexDirection="column">
        <Text color="cyan">
          {tool.name}
          <Text dimColor>({toolSpecifier(tool.name, tool.input)})</Text>
        </Text>
        {tool.status === 'done' && <ToolResultLine tool={tool} />}
      </Box>
    </Box>
  )
}

/** `⎿` 结果区:按 summarizeOutput 的判别联合渲染单行 / 多行预览 / 错误行。 */
function ToolResultLine({ tool }: { tool: UIToolCall }) {
  const summary = summarizeOutput(tool)
  if (summary.kind === 'error') {
    return <Text color="red">{`  ⎿ ${summary.text}`}</Text>
  }
  if (summary.kind === 'line') {
    // line 类不会来自错误(错误走 error/preview),恒为暗色。
    return <Text dimColor>{`  ⎿ ${summary.text}`}</Text>
  }
  // preview:首行带 ⎿,续行对齐到内容列(5 空格);Bash 类错误时整体着红,否则暗色。
  const color = tool.isError ? 'red' : undefined
  return (
    <Box flexDirection="column">
      {summary.lines.map((line, i) => (
        <Text key={i} color={color} dimColor={!tool.isError}>
          {i === 0 ? `  ⎿ ${line}` : `     ${line}`}
        </Text>
      ))}
      {summary.moreCount > 0 && <Text dimColor>{`     … +${summary.moreCount} 行`}</Text>}
    </Box>
  )
}
```

- [ ] **Step 4: 类型检查 + lint + 全量回归**

Run:
```bash
pnpm -F @zuse/tui typecheck
pnpm exec eslint packages/tui/src/components/figures.ts packages/tui/src/components/toolSummary.ts packages/tui/src/components/StreamRenderer.tsx
pnpm exec vitest run packages/tui
```
Expected: 类型无错、lint 无错、测试全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/StreamRenderer.tsx
git commit -m "feat(tui): 工具块改用 ● / ⎿ 骨架与语义化 OUT 摘要"
```

---

## Self-Review(写完计划后的对照检查)

- **Spec 覆盖**:§2 骨架→Task 1+6;§4 specifier→Task 3;§5 OUT 摘要→Task 4;§6 Bash 预览→Task 5;§7 文件划分→figures.ts/toolSummary.ts;§8 测试策略(纯函数单测、渲染不强制快照)→Task 2–5 单测 + Task 6 仅 typecheck/lint。§3 前导↔工具关联(纯数组相邻、不改 hook)→无需代码改动,Task 6 沿用现状的 `marginBottom`,已在 spec 说明,无遗漏任务。§9 范围外项(Edit 彩色 diff、Ctrl+O 展开、折叠汇总、全中文化)均不在任务内。
- **占位符扫描**:无 TBD/TODO;每个代码步骤给出完整代码。
- **类型一致性**:`OutputSummary` 判别联合三种 kind 在 Task 2 定义、Task 4/5 产出、Task 6 消费,字段名一致(`line.text` / `preview.lines`+`moreCount` / `error.text`)。`summarizeOutput`/`toolSpecifier`/`stripTrailingNotes`/`countLines`/`previewLines` 签名跨任务一致。

## 完成后

工具块呈现对齐 CC:`●`/spinner 标记 + `Name(主参数)` + `⎿` 语义化摘要,Bash 类给 5 行预览。随后 **#2 Edit diff** 在 `ToolResultLine` 的 Edit 分支接入彩色行级 diff,**#3 Markdown** 改助手分支,各自独立 commit。
