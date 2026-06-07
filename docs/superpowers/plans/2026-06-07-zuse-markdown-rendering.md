# TUI Markdown 富渲染实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zuse TUI 的助手回复在定稿后渲染成终端富文本(标题/列表/代码块/引用/表格/行内强调),流式期间仍走纯文本。

**Architecture:** 用 `marked.lexer()` 仅做词法分析得到 token 树,手写映射到原生 Ink `<Box>`/`<Text>` 组件。纯字符串数学(列宽、CJK 宽度、折行、表格边框)集中在无副作用的 `layout.ts` 并单测;React 组件层(`inline.tsx`/`blocks.tsx`/`table.tsx`/`Markdown.tsx`)只做 token→组件分派。`StreamRenderer` 按现有 `isStreaming` 字段二选一渲染,hook 不改。

**Tech Stack:** TypeScript(strict)、Ink 5、React 18(react-jsx 自动运行时)、marked(词法器)、string-width(CJK 宽度)、vitest + ink-testing-library。

> **Session 1 协调:** 本计划是 Phase 7「Session 1:StreamRenderer 渲染层重构」的 **Markdown commit 组**。同会话还有 **工具块 CC 风格**(含 `useConversation` 前导理由↔tool_use 关联)与 **Edit diff 渲染** 两块,都改同一个 `StreamRenderer.tsx`,各自 spec→plan、按 commit 拆开。本计划只动助手分支的文本渲染那一行 + 新增 `markdown/` 子目录,不碰 `ToolBlock`、不碰 hook,因此与另两块的编辑面不冲突,可独立先行。详见 [phase-roadmap.md](phase-roadmap.md) 的「Session 1」协调说明。

---

## 关键约定(每个任务都必须遵守)

- **JSX 运行时是 `react-jsx`**:`.tsx` 组件文件**不要** `import React`(参照现有 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx))。需要 React 类型时用 `import type { ReactNode, ReactElement } from 'react'`。
- **`verbatimModuleSyntax: true`**:只用于类型的导入必须写 `import type`。
- **`noUncheckedIndexedAccess: true`**:数组下标访问返回 `T | undefined`,务必 `?? 默认值` 兜底。
- **Prettier**:无分号、单引号、`trailingComma: all`、`printWidth: 100`、2 空格缩进。
- **代码注释一律中文**;**不准用 `any`**。
- **import 用 `.js` 后缀**(即使目标是 `.ts`/`.tsx`),这是本仓库的 Bundler 解析约定(参照 `import { findCommand } from './registry.js'`)。
- **测试文件名必须是 `*.test.ts`**(vitest 的 include 是 `packages/*/src/**/*.test.ts`,不收 `.tsx`)。测试里渲染组件用 `createElement(...)`,**不写 JSX**(`.ts` 文件不转 JSX)。
- **所有命令在仓库根 `e:/ai-study/zuse` 下执行**。单测单文件:`pnpm exec vitest run <相对路径>`。类型检查:`pnpm -F @zuse/tui typecheck`。
- **不要触碰** `packages/tools/src/lsp/*`、`packages/core/src/prompt.ts`、`packages/tools/src/util.ts`(他人未提交的并行工作)。本计划只动 `packages/tui/`。

---

## File Structure

新增目录 `packages/tui/src/components/markdown/`:

| 文件 | 职责 |
|---|---|
| `layout.ts` | 纯函数:`displayWidth`、`decodeEntities`、`listPrefix`、`padCell`、`wrapCell`、`computeColumnWidths`、`buildBorderLine`、`buildRowLines`。无 React、无副作用。 |
| `layout.test.ts` | `layout.ts` 单测。 |
| `inline.tsx` | `renderInline(tokens, keyPrefix)`:行内 token → 嵌套 `<Text>`。 |
| `inline.test.ts` | 行内渲染快照。 |
| `table.tsx` | `<Table token={...} />`:消费 `layout.ts` 算出的列宽,绘制 box-drawing 网格。 |
| `blocks.tsx` | `renderBlocks(tokens)`:块级 token → 组件(含递归引用/列表),table 委托给 `<Table>`。 |
| `Markdown.tsx` | `<Markdown source={string} />`:调 `marked.lexer`、分派、整体 try/catch 回退纯文本。 |
| `Markdown.test.ts` | 端到端渲染快照(每类元素 + 回退 + 空串)。 |

修改既有文件:

- `packages/tui/src/components/StreamRenderer.tsx`:助手分支按 `isStreaming` 二选一。
- `packages/tui/src/components/StreamRenderer.test.ts`:新建,测双态。
- `packages/tui/package.json`:加依赖。

---

### Task 1: 安装依赖

**Files:**
- Modify: `packages/tui/package.json`(由 pnpm 自动写入)

- [ ] **Step 1: 安装运行时与测试依赖**

Run(在仓库根):
```bash
pnpm --filter @zuse/tui add marked string-width
pnpm --filter @zuse/tui add -D ink-testing-library
```

- [ ] **Step 2: 冒烟校验三个包可被解析**

Run:
```bash
node -e "import('marked').then(m=>console.log('marked.lexer', typeof m.marked.lexer))"
node -e "import('string-width').then(m=>console.log('string-width', typeof m.default))"
```
Expected:
```
marked.lexer function
string-width function
```

- [ ] **Step 3: 确认 package.json 写入正确**

Run:
```bash
cat packages/tui/package.json
```
Expected: `dependencies` 含 `marked`、`string-width`;`devDependencies` 含 `ink-testing-library`。

- [ ] **Step 4: 提交**

```bash
git add packages/tui/package.json pnpm-lock.yaml
git commit -m "chore(tui): 添加 marked / string-width / ink-testing-library 依赖"
```

---

### Task 2: layout.ts — displayWidth / decodeEntities / listPrefix

**Files:**
- Create: `packages/tui/src/components/markdown/layout.ts`
- Test: `packages/tui/src/components/markdown/layout.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/markdown/layout.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { displayWidth, decodeEntities, listPrefix } from './layout.js'

describe('displayWidth', () => {
  it('半角字符每个算 1 列', () => {
    expect(displayWidth('abc')).toBe(3)
  })
  it('全角/中文字符每个算 2 列', () => {
    expect(displayWidth('中文')).toBe(4)
  })
  it('混合宽度累加正确', () => {
    expect(displayWidth('a中')).toBe(3)
  })
})

describe('decodeEntities', () => {
  it('还原 marked 转义的 5 个 HTML 实体', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;x&quot; &#39;y&#39;')).toBe(`<a> & "x" 'y'`)
  })
  it('先解码其它实体、最后解码 &amp; 避免二次解码', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })
})

describe('listPrefix', () => {
  it('无序列表用圆点', () => {
    expect(listPrefix(false, 0, 1)).toBe('• ')
  })
  it('有序列表用序号,从 start 起算', () => {
    expect(listPrefix(true, 0, 1)).toBe('1. ')
    expect(listPrefix(true, 2, 1)).toBe('3. ')
    expect(listPrefix(true, 0, 5)).toBe('5. ')
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: FAIL — 无法解析 `./layout.js`(模块不存在)。

- [ ] **Step 3: 写最小实现**

Create `packages/tui/src/components/markdown/layout.ts`:
```ts
import stringWidth from 'string-width'

/** 计算字符串在终端的显示宽度(全角/中文字符算 2 列)。 */
export function displayWidth(text: string): number {
  return stringWidth(text)
}

/** 还原 marked 转义的 5 个 HTML 实体;&amp; 放最后解码,避免二次解码。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 列表项前缀:有序为 "N. "(从 start 起算),无序为 "• "。 */
export function listPrefix(ordered: boolean, index: number, start: number): string {
  return ordered ? `${start + index}. ` : '• '
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: PASS(3 个 describe 全绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/layout.ts packages/tui/src/components/markdown/layout.test.ts
git commit -m "feat(tui): layout 纯函数 displayWidth/decodeEntities/listPrefix"
```

---

### Task 3: layout.ts — padCell / wrapCell

**Files:**
- Modify: `packages/tui/src/components/markdown/layout.ts`
- Test: `packages/tui/src/components/markdown/layout.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `layout.test.ts` 顶部 import 改为:
```ts
import {
  displayWidth,
  decodeEntities,
  listPrefix,
  padCell,
  wrapCell,
} from './layout.js'
```
在文件末尾追加:
```ts
describe('padCell', () => {
  it('left 在右侧补空格到定宽', () => {
    expect(padCell('ab', 5, 'left')).toBe('ab   ')
  })
  it('right 在左侧补空格', () => {
    expect(padCell('ab', 5, 'right')).toBe('   ab')
  })
  it('center 两侧补空格,余数偏右', () => {
    expect(padCell('ab', 6, 'center')).toBe('  ab  ')
    expect(padCell('ab', 5, 'center')).toBe(' ab  ')
  })
  it('按显示宽度补齐(中文算 2 列)', () => {
    expect(padCell('中', 5, 'left')).toBe('中   ')
  })
  it('文本宽于目标宽度时原样返回', () => {
    expect(padCell('abcd', 2, 'left')).toBe('abcd')
  })
})

describe('wrapCell', () => {
  it('按显示宽度折行', () => {
    expect(wrapCell('abcdef', 3)).toEqual(['abc', 'def'])
  })
  it('全角字符不被从中间劈开', () => {
    expect(wrapCell('中文测试', 4)).toEqual(['中文', '测试'])
  })
  it('混合宽度按累计宽度折行', () => {
    expect(wrapCell('a中b', 3)).toEqual(['a中', 'b'])
  })
  it('空串返回单个空行', () => {
    expect(wrapCell('', 4)).toEqual([''])
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: FAIL — `padCell` / `wrapCell` 未导出。

- [ ] **Step 3: 写最小实现**

在 `layout.ts` 末尾追加:
```ts
/** 单元格对齐方式。 */
export type CellAlign = 'left' | 'center' | 'right'

/** 把文本按显示宽度补齐到 width;文本本身更宽则原样返回。 */
export function padCell(text: string, width: number, align: CellAlign): string {
  const pad = width - displayWidth(text)
  if (pad <= 0) return text
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  return text + ' '.repeat(pad)
}

/** 按显示宽度折行;不从全角字符中间劈开(按 Unicode 码点遍历)。 */
export function wrapCell(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  let lineWidth = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    // 当前行非空且再加这个字符会超宽,则先换行。
    if (line !== '' && lineWidth + w > width) {
      lines.push(line)
      line = ''
      lineWidth = 0
    }
    line += ch
    lineWidth += w
  }
  if (line !== '' || lines.length === 0) lines.push(line)
  return lines
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/layout.ts packages/tui/src/components/markdown/layout.test.ts
git commit -m "feat(tui): layout 的 padCell/wrapCell(含 CJK 宽度)"
```

---

### Task 4: layout.ts — computeColumnWidths / buildBorderLine / buildRowLines

**Files:**
- Modify: `packages/tui/src/components/markdown/layout.ts`
- Test: `packages/tui/src/components/markdown/layout.test.ts`

**说明(列宽与边框开销必须一致):** 一行数据绘制为 `'│' + 每列 (' ' + padCell + ' ') + '│'`,竖线数 = 列数 + 1。故总宽 = Σ列宽 + 3×列数 + 1,`overhead = 3*cols + 1`。边框段宽 = 列宽 + 2(覆盖左右各 1 空格)。

- [ ] **Step 1: 追加失败测试**

`layout.test.ts` import 改为(追加三个):
```ts
import {
  displayWidth,
  decodeEntities,
  listPrefix,
  padCell,
  wrapCell,
  computeColumnWidths,
  buildBorderLine,
  buildRowLines,
} from './layout.js'
```
文件末尾追加:
```ts
describe('computeColumnWidths', () => {
  it('总宽够用时取每列最大显示宽度', () => {
    expect(computeColumnWidths([['a', 'bb'], ['ccc', 'd']], 200)).toEqual([3, 2])
  })
  it('含中文列按显示宽度算', () => {
    expect(computeColumnWidths([['中文'], ['x']], 200)).toEqual([4])
  })
  it('超总宽时按自然宽度比例压缩', () => {
    // 单列自然宽 4,overhead=3*1+1=4,maxWidth=5 → 内容预算=1 → [1]
    expect(computeColumnWidths([['aaaa'], ['bb']], 5)).toEqual([1])
  })
})

describe('buildBorderLine', () => {
  it('top 用 ┌┬┐,段宽=列宽+2', () => {
    expect(buildBorderLine([3, 2], 'top')).toBe('┌─────┬────┐')
  })
  it('mid 用 ├┼┤', () => {
    expect(buildBorderLine([3, 2], 'mid')).toBe('├─────┼────┤')
  })
  it('bottom 用 └┴┘', () => {
    expect(buildBorderLine([3, 2], 'bottom')).toBe('└─────┴────┘')
  })
})

describe('buildRowLines', () => {
  it('单行:竖线包裹、每格两侧留空格', () => {
    expect(buildRowLines(['a', 'bb'], [3, 2], ['left', 'left'])).toEqual(['│ a   │ bb │'])
  })
  it('单元格超宽时折成多物理行,空缺补空白', () => {
    expect(buildRowLines(['abcdef', 'x'], [3, 1], ['left', 'left'])).toEqual([
      '│ abc │ x │',
      '│ def │   │',
    ])
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: FAIL — 三个新函数未导出。

- [ ] **Step 3: 写最小实现**

在 `layout.ts` 末尾追加:
```ts
/** 边框线种类:顶 / 中分隔 / 底。 */
export type BorderKind = 'top' | 'mid' | 'bottom'

/**
 * 计算各列宽度。rows 含表头,每行是各列文本。
 * 总宽(Σ列宽 + 3×列数 + 1)超过 maxWidth 时,按自然宽度比例压缩内容预算。
 */
export function computeColumnWidths(rows: string[][], maxWidth: number): number[] {
  const cols = rows[0]?.length ?? 0
  if (cols === 0) return []
  const natural: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = 0
    for (const row of rows) w = Math.max(w, displayWidth(row[c] ?? ''))
    natural[c] = w
  }
  const overhead = cols * 3 + 1
  const naturalSum = natural.reduce((a, b) => a + b, 0)
  if (naturalSum + overhead <= maxWidth) return natural
  // 超宽:把可用内容预算按自然宽度比例分给各列,每列至少 1。
  const contentBudget = Math.max(cols, maxWidth - overhead)
  const denom = naturalSum || 1
  return natural.map((w) => Math.max(1, Math.floor((w / denom) * contentBudget)))
}

/** 拼一条边框线,段宽 = 列宽 + 2(覆盖左右各 1 空格)。 */
export function buildBorderLine(widths: number[], kind: BorderKind): string {
  const corners: Record<BorderKind, [string, string, string]> = {
    top: ['┌', '┬', '┐'],
    mid: ['├', '┼', '┤'],
    bottom: ['└', '┴', '┘'],
  }
  const [left, mid, right] = corners[kind]
  const segments = widths.map((w) => '─'.repeat(w + 2))
  return left + segments.join(mid) + right
}

/** 拼一行数据(可能折成多物理行):'│' + 每列 (' ' + 对齐填充 + ' ') + '│'。 */
export function buildRowLines(
  cells: string[],
  widths: number[],
  aligns: CellAlign[],
): string[] {
  const wrapped = cells.map((cell, i) => wrapCell(cell, widths[i] ?? 0))
  const height = Math.max(1, ...wrapped.map((w) => w.length))
  const lines: string[] = []
  for (let r = 0; r < height; r++) {
    const parts = widths.map((w, i) => {
      const fragment = wrapped[i]?.[r] ?? ''
      return ' ' + padCell(fragment, w, aligns[i] ?? 'left') + ' '
    })
    lines.push('│' + parts.join('│') + '│')
  }
  return lines
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/layout.test.ts`
Expected: PASS(全部 describe 绿)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/layout.ts packages/tui/src/components/markdown/layout.test.ts
git commit -m "feat(tui): layout 的表格列宽/边框/行绘制纯函数"
```

---

### Task 5: inline.tsx — renderInline

**Files:**
- Create: `packages/tui/src/components/markdown/inline.tsx`
- Test: `packages/tui/src/components/markdown/inline.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/markdown/inline.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { renderInline } from './inline.js'

// 用 marked 解析一段 Markdown,取出段落的行内 token,渲染成一帧字符串。
function inlineFrame(md: string): string {
  const tokens = marked.lexer(md)
  const para = tokens.find((t) => t.type === 'paragraph')
  if (!para || para.type !== 'paragraph') throw new Error('未解析出 paragraph')
  const { lastFrame, unmount } = render(createElement(Text, null, renderInline(para.tokens, 'k')))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('renderInline', () => {
  it('加粗输出 ANSI bold 且保留文字', () => {
    const out = inlineFrame('**bold**')
    expect(out).toContain('bold')
    expect(out).toContain('[1m') // bold
  })
  it('删除线输出 ANSI strikethrough', () => {
    const out = inlineFrame('~~gone~~')
    expect(out).toContain('gone')
    expect(out).toContain('[9m') // strikethrough
  })
  it('行内代码保留文字', () => {
    expect(inlineFrame('`code`')).toContain('code')
  })
  it('链接渲染文字与 (url)', () => {
    const out = inlineFrame('[text](http://x.y)')
    expect(out).toContain('text')
    expect(out).toContain('(http://x.y)')
  })
  it('HTML 实体被解码回原字符', () => {
    expect(inlineFrame('a < b & c')).toContain('a < b & c')
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/inline.test.ts`
Expected: FAIL — 无法解析 `./inline.js`。

- [ ] **Step 3: 写最小实现**

Create `packages/tui/src/components/markdown/inline.tsx`:
```tsx
import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { decodeEntities } from './layout.js'

/** 把 marked 行内 token 数组递归映射成嵌套的 <Text>。 */
export function renderInline(tokens: Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}-i${i}`
    switch (tok.type) {
      case 'strong':
        return (
          <Text key={key} bold>
            {renderInline((tok as Tokens.Strong).tokens, key)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} italic>
            {renderInline((tok as Tokens.Em).tokens, key)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} strikethrough>
            {renderInline((tok as Tokens.Del).tokens, key)}
          </Text>
        )
      case 'codespan':
        return (
          <Text key={key} backgroundColor="gray" color="white">
            {` ${decodeEntities((tok as Tokens.Codespan).text)} `}
          </Text>
        )
      case 'link': {
        const link = tok as Tokens.Link
        return (
          <Text key={key}>
            <Text underline color="blue">
              {renderInline(link.tokens, key)}
            </Text>
            <Text dimColor>{` (${link.href})`}</Text>
          </Text>
        )
      }
      case 'br':
        return <Text key={key}>{'\n'}</Text>
      default: {
        // text / escape / 其它:有嵌套就递归,否则解码后输出纯文本。
        const t = tok as Tokens.Text
        if (t.tokens && t.tokens.length > 0) {
          return <Text key={key}>{renderInline(t.tokens, key)}</Text>
        }
        return <Text key={key}>{decodeEntities(t.text ?? tok.raw ?? '')}</Text>
      }
    }
  })
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/inline.test.ts`
Expected: PASS(5 个用例)。

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/inline.tsx packages/tui/src/components/markdown/inline.test.ts
git commit -m "feat(tui): 行内 Markdown 渲染 renderInline"
```

---

### Task 6: table.tsx — Table 组件

**Files:**
- Create: `packages/tui/src/components/markdown/table.tsx`

(无独立测试:表格的字符串数学已在 `layout.test.ts` 全覆盖;组件层的整体渲染由 Task 8 的 `Markdown.test.ts` 覆盖。)

- [ ] **Step 1: 写实现**

Create `packages/tui/src/components/markdown/table.tsx`:
```tsx
import { Box, Text } from 'ink'
import type { Tokens } from 'marked'
import {
  computeColumnWidths,
  buildBorderLine,
  buildRowLines,
  decodeEntities,
  type CellAlign,
} from './layout.js'

interface TableProps {
  token: Tokens.Table
}

/** GFM 表格:手绘 box-drawing 网格,列宽与 CJK 宽度由 layout 纯函数算好。 */
export function Table({ token }: TableProps) {
  const aligns: CellAlign[] = token.align.map((a) => a ?? 'left')
  const headerCells = token.header.map((cell) => decodeEntities(cell.text))
  const bodyRows = token.rows.map((row) => row.map((cell) => decodeEntities(cell.text)))
  // 终端可用宽度;取不到(管道/重定向)按 80 算,再留 2 列边距。
  const maxWidth = (process.stdout.columns ?? 80) - 2
  const widths = computeColumnWidths([headerCells, ...bodyRows], maxWidth)

  const headerLines = buildRowLines(headerCells, widths, aligns)
  const bodyLineGroups = bodyRows.map((row) => buildRowLines(row, widths, aligns))

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{buildBorderLine(widths, 'top')}</Text>
      {headerLines.map((line, i) => (
        <Text key={`h-${i}`} bold>
          {line}
        </Text>
      ))}
      <Text>{buildBorderLine(widths, 'mid')}</Text>
      {bodyLineGroups.map((lines, r) =>
        lines.map((line, i) => <Text key={`b-${r}-${i}`}>{line}</Text>),
      )}
      <Text>{buildBorderLine(widths, 'bottom')}</Text>
    </Box>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 3: 提交**

```bash
git add packages/tui/src/components/markdown/table.tsx
git commit -m "feat(tui): 表格组件 Table(手绘网格 + CJK 列宽)"
```

---

### Task 7: blocks.tsx — renderBlocks

**Files:**
- Create: `packages/tui/src/components/markdown/blocks.tsx`

(块级渲染由 Task 8 的 `Markdown.test.ts` 端到端覆盖。)

- [ ] **Step 1: 写实现**

Create `packages/tui/src/components/markdown/blocks.tsx`:
```tsx
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { renderInline } from './inline.js'
import { Table } from './table.js'
import { decodeEntities, listPrefix } from './layout.js'

/** 标题按层级着色:H1–H2 青,H3–H4 蓝,H5–H6 白。 */
function headingColor(depth: number): string {
  if (depth <= 2) return 'cyan'
  if (depth <= 4) return 'blue'
  return 'white'
}

/** 把 marked 块级 token 数组映射成 Ink 组件;未知类型回退其 raw 文本。 */
export function renderBlocks(tokens: Token[]): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `b-${i}`
    switch (tok.type) {
      case 'heading': {
        const h = tok as Tokens.Heading
        return (
          <Box key={key} marginBottom={1}>
            <Text bold color={headingColor(h.depth)}>
              {renderInline(h.tokens, key)}
            </Text>
          </Box>
        )
      }
      case 'paragraph': {
        const p = tok as Tokens.Paragraph
        return (
          <Box key={key} marginBottom={1}>
            <Text>{renderInline(p.tokens, key)}</Text>
          </Box>
        )
      }
      case 'text': {
        // 紧凑列表项的内容是 text token:有嵌套行内就递归,否则解码纯文本。
        const t = tok as Tokens.Text
        return (
          <Text key={key}>
            {t.tokens ? renderInline(t.tokens, key) : decodeEntities(t.text)}
          </Text>
        )
      }
      case 'code': {
        const c = tok as Tokens.Code
        return (
          <Box
            key={key}
            flexDirection="column"
            marginBottom={1}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            {c.lang ? <Text dimColor>{c.lang}</Text> : null}
            <Text>{c.text}</Text>
          </Box>
        )
      }
      case 'blockquote': {
        const bq = tok as Tokens.Blockquote
        return (
          <Box key={key} flexDirection="row" marginBottom={1}>
            <Text color="gray">│ </Text>
            <Box flexDirection="column">{renderBlocks(bq.tokens)}</Box>
          </Box>
        )
      }
      case 'list': {
        const l = tok as Tokens.List
        const start = typeof l.start === 'number' ? l.start : 1
        return (
          <Box key={key} flexDirection="column" marginBottom={1}>
            {l.items.map((item, idx) => (
              <Box key={`${key}-${idx}`} flexDirection="row">
                <Text>{listPrefix(l.ordered, idx, start)}</Text>
                <Box flexDirection="column">{renderBlocks(item.tokens)}</Box>
              </Box>
            ))}
          </Box>
        )
      }
      case 'hr':
        return (
          <Box key={key} marginBottom={1}>
            <Text dimColor>{'─'.repeat((process.stdout.columns ?? 80) - 2)}</Text>
          </Box>
        )
      case 'table':
        return <Table key={key} token={tok as Tokens.Table} />
      case 'space':
        return null
      default:
        return <Text key={key}>{tok.raw}</Text>
    }
  })
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 3: 提交**

```bash
git add packages/tui/src/components/markdown/blocks.tsx
git commit -m "feat(tui): 块级 Markdown 渲染 renderBlocks"
```

---

### Task 8: Markdown.tsx — 入口组件 + 端到端测试

**Files:**
- Create: `packages/tui/src/components/markdown/Markdown.tsx`
- Test: `packages/tui/src/components/markdown/Markdown.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/markdown/Markdown.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { Markdown } from './Markdown.js'

function frame(source: string): string {
  const { lastFrame, unmount } = render(createElement(Markdown, { source }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('Markdown', () => {
  it('标题:加粗且保留文字', () => {
    const out = frame('# Title')
    expect(out).toContain('Title')
    expect(out).toContain('[1m')
  })
  it('无序列表:圆点前缀 + 各项文字', () => {
    const out = frame('- one\n- two')
    expect(out).toContain('•')
    expect(out).toContain('one')
    expect(out).toContain('two')
  })
  it('有序列表:序号前缀', () => {
    const out = frame('1. a\n2. b')
    expect(out).toContain('1.')
    expect(out).toContain('2.')
  })
  it('嵌套列表:出现至少两个圆点', () => {
    const out = frame('- a\n  - b')
    expect(out).toContain('a')
    expect(out).toContain('b')
    expect((out.match(/•/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
  it('代码块:保留代码文字', () => {
    expect(frame('```\nhello\n```')).toContain('hello')
  })
  it('引用块:左侧竖线 + 文字', () => {
    const out = frame('> quoted')
    expect(out).toContain('│')
    expect(out).toContain('quoted')
  })
  it('表格:绘制网格且保留表头与单元格', () => {
    const out = frame('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('┌')
    expect(out).toContain('│')
    expect(out).toContain('A')
    expect(out).toContain('1')
  })
  it('表格含中文不报错且保留中文', () => {
    const out = frame('| 名 | x |\n|---|---|\n| 一 | yy |')
    expect(out).toContain('名')
    expect(out).toContain('一')
  })
  it('空 source 渲染为空', () => {
    expect(frame('')).toBe('')
  })
  it('lexer 抛错时回退为纯文本', () => {
    const spy = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(frame('# x')).toContain('# x')
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/Markdown.test.ts`
Expected: FAIL — 无法解析 `./Markdown.js`。

- [ ] **Step 3: 写最小实现**

Create `packages/tui/src/components/markdown/Markdown.tsx`:
```tsx
import { Text } from 'ink'
import { marked } from 'marked'
import type { ReactElement } from 'react'
import { renderBlocks } from './blocks.js'

interface MarkdownProps {
  source: string
}

/** 把一段已定稿的 Markdown 渲染成终端富文本;解析失败时整体回退纯文本。 */
export function Markdown({ source }: MarkdownProps): ReactElement | null {
  if (source === '') return null
  try {
    const tokens = marked.lexer(source, { gfm: true, breaks: false })
    return <>{renderBlocks(tokens)}</>
  } catch {
    return <Text>{source}</Text>
  }
}
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm exec vitest run packages/tui/src/components/markdown/Markdown.test.ts`
Expected: PASS(10 个用例)。

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/Markdown.tsx packages/tui/src/components/markdown/Markdown.test.ts
git commit -m "feat(tui): Markdown 入口组件 + 端到端渲染测试"
```

---

### Task 9: 接入 StreamRenderer(流式双态)

**Files:**
- Modify: `packages/tui/src/components/StreamRenderer.tsx:1-3`(加 import)、`:82-93`(助手分支)
- Test: `packages/tui/src/components/StreamRenderer.test.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/tui/src/components/StreamRenderer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { StreamRenderer } from './StreamRenderer.js'
import type { UIMessage } from '../types.js'

function frame(partial: Partial<UIMessage>): string {
  const message: UIMessage = {
    id: '1',
    role: 'assistant',
    text: '',
    isStreaming: false,
    ...partial,
  }
  const { lastFrame, unmount } = render(createElement(StreamRenderer, { message }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('StreamRenderer 助手双态', () => {
  it('定稿后把 Markdown 渲染成富文本(列表出现圆点)', () => {
    const out = frame({ text: '- item', isStreaming: false })
    expect(out).toContain('•')
  })
  it('流式期间按原始纯文本渲染(保留 "- item",不出圆点)', () => {
    const out = frame({ text: '- item', isStreaming: true })
    expect(out).toContain('- item')
    expect(out).not.toContain('•')
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `pnpm exec vitest run packages/tui/src/components/StreamRenderer.test.ts`
Expected: FAIL — 定稿用例拿不到 `•`(当前助手分支恒为纯 `<Text>`)。

- [ ] **Step 3: 改实现 — 加 import**

在 [StreamRenderer.tsx](../../../packages/tui/src/components/StreamRenderer.tsx) 顶部,`import type { UIMessage, UIToolCall } from '../types.js'` 之后加一行:
```tsx
import { Markdown } from './markdown/Markdown.js'
```

- [ ] **Step 4: 改实现 — 助手分支按 isStreaming 二选一**

把助手分支里这一行:
```tsx
        <Text>{message.text}</Text>
```
替换为:
```tsx
        {/* 流式期间走纯文本(快、稳、不抖);定稿后重渲染成富 Markdown。 */}
        {message.isStreaming ? <Text>{message.text}</Text> : <Markdown source={message.text} />}
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `pnpm exec vitest run packages/tui/src/components/StreamRenderer.test.ts`
Expected: PASS(2 个用例)。

Run: `pnpm -F @zuse/tui typecheck`
Expected: 无错误退出。

- [ ] **Step 6: 全量回归 + lint**

Run:
```bash
pnpm exec vitest run packages/tui
pnpm -F @zuse/tui typecheck
pnpm exec eslint packages/tui/src/components/markdown packages/tui/src/components/StreamRenderer.tsx
```
Expected: 测试全绿、类型无错、lint 无错。

- [ ] **Step 7: 提交**

```bash
git add packages/tui/src/components/StreamRenderer.tsx packages/tui/src/components/StreamRenderer.test.ts
git commit -m "feat(tui): 助手回复定稿后渲染富 Markdown(流式仍走纯文本)"
```

---

## 完成后

所有任务完成后,助手回复在 `message-stop` / 转入工具调用定稿时会渲染富 Markdown,流式期间保持纯文本。后续 Phase 7 其余子项(`/model` 选择器、权限对话框、多行输入、工具块对齐、TUI 文案全中文化)各自独立 spec→plan,不在本计划内。
