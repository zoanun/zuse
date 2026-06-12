# TUI 流式 Markdown 增量渲染(稳定前缀)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流式期间,已确定完整的 Markdown 块先渲染成富文本,只有正在生成的尾部块保持纯文本。

**Architecture:** 新增 `StreamingMarkdown` 组件:每帧对累积全文跑 `marked.lexer`,按顶层 token 边界切「稳定前缀(走现有 `renderBlocks` 富渲染)+ 尾部 token(`.raw` 纯文本)」。唯一接线点是 `StreamRenderer.tsx` 流式分支一行替换。定稿路径(`<Markdown>`)不变,作为最终正确性兜底。

**Tech Stack:** ink 5 + React 18 + marked 18(均为既有依赖,零新增);测试 vitest + ink-testing-library。

**Spec:** [2026-06-12-zuse-streaming-markdown-design.md](../specs/2026-06-12-zuse-streaming-markdown-design.md)

---

## 关键背景(执行前必读)

**marked 18 的实测切分行为**(已用探针脚本验证,直接影响切分规则):

| 输入 | tokens(type:raw) |
|---|---|
| `"a\n\nb **bold"` | `paragraph:"a"` + `space:"\n\n"` + `paragraph:"b **bold"` |
| `"# t\n\n"` | `heading:"# t"` + `space:"\n\n"` |
| `"a\n"`(单换行收尾) | `paragraph:"a\n"`(**无** space token,换行被吸进 raw) |
| 未闭合 ```` ```js ````(内含空行) | 一个 `code` token 延伸到文末 |
| `"- one\n- two\n\n- three"`(列表内空行) | **一个** `list` token |

由此得出切分规则:

- **尾 token 是 `space`**(≥2 个连续换行)→ 前面所有块都已被封口,**全部**富渲染,无纯文本尾部;
- **否则**最后一个 token 视为「生成中的块」(单个 `\n` 后仍可能被续写,如表格加行),用其 `.raw` 走纯文本;
- 只有 0~1 个有效前缀块时整体纯文本(等价现状);lexer 或 renderBlocks 抛错时整体回退纯文本。

`renderBlocks` 已会跳过 `space` token,前缀里夹着的 space 无需过滤。

---

### Task 1: StreamingMarkdown 组件(TDD)

**Files:**
- Test: `packages/tui/src/components/markdown/StreamingMarkdown.test.ts`
- Create: `packages/tui/src/components/markdown/StreamingMarkdown.tsx`

- [ ] **Step 1: 写失败测试**

新建 `packages/tui/src/components/markdown/StreamingMarkdown.test.ts`(套路对齐同目录 `Markdown.test.ts`:`createElement` + ink-testing-library,加粗断言用 ANSI 片段 `'[1m'`):

```ts
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { render } from 'ink-testing-library'
import { marked } from 'marked'
import { StreamingMarkdown } from './StreamingMarkdown.js'

function frame(source: string): string {
  const { lastFrame, unmount } = render(createElement(StreamingMarkdown, { source }))
  const out = lastFrame() ?? ''
  unmount()
  return out
}

describe('StreamingMarkdown 稳定前缀切分', () => {
  it('空 source 渲染为空', () => {
    expect(frame('')).toBe('')
  })
  it('单个未完成块:整体纯文本,字面 # 保留、无加粗', () => {
    const out = frame('# 还在生成的标题')
    expect(out).toContain('# 还在生成的标题')
    expect(out).not.toContain('[1m')
  })
  it('完整标题 + 未完成段落:前缀富渲染,尾部保留字面 **', () => {
    const out = frame('# 标题\n\n正文 **粗体没写完')
    expect(out).toContain('[1m') // 标题已加粗
    expect(out).not.toContain('# 标题') // 字面 # 消失
    expect(out).toContain('**粗体没写完') // 尾部纯文本
  })
  it('未闭合代码围栏(内含空行)整体保持纯文本,不被空行错切', () => {
    const out = frame('前一段。\n\n```js\nconst a = 1\n\nconst b = 2')
    expect(out).toContain('```js')
    expect(out).toContain('const b = 2')
  })
  it('已完成表格 + 生成中的段落:表格出现列分隔线,尾部纯文本', () => {
    const out = frame('| A | B |\n|---|---|\n| 1 | 2 |\n\n下一段还在生成')
    expect(out).toContain('│')
    expect(out).toContain('下一段还在生成')
  })
  it('以空行收尾:最后一个真实块立即富渲染(列表出圆点)', () => {
    const out = frame('- one\n- two\n\n')
    expect(out).toContain('•')
    expect(out).toContain('one')
  })
  it('生成中的列表(无后续块)整体保持纯文本', () => {
    const out = frame('- one\n- two')
    expect(out).toContain('- one')
    expect(out).not.toContain('•')
  })
  it('lexer 抛错时整体回退纯文本', () => {
    const spy = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(frame('# x\n\ny')).toContain('# x')
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run(仓库根目录): `pnpm vitest run packages/tui/src/components/markdown/StreamingMarkdown.test.ts`
Expected: FAIL,报错为找不到模块 `./StreamingMarkdown.js`。

- [ ] **Step 3: 写实现**

新建 `packages/tui/src/components/markdown/StreamingMarkdown.tsx`:

```tsx
import { Text } from 'ink'
import { marked } from 'marked'
import type { Token } from 'marked'
import { useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderBlocks } from './blocks.js'

interface PrefixCache {
  raw: string
  nodes: ReactNode[]
}

/**
 * 流式期间的 Markdown 增量渲染:已被后续内容封口的块(稳定前缀)走富渲染,
 * 最后一个可能未完成的块保持纯文本。每帧全文重新 lexer,切分偏差下一帧自动纠正;
 * 定稿后 StreamRenderer 会换用 <Markdown> 整体重渲染兜底。
 */
export function StreamingMarkdown({ source }: { source: string }): ReactElement | null {
  // 按前缀 raw 缓存已渲染节点:前缀只在「新块封口」时变化,绝大多数帧直接复用。
  const cache = useRef<PrefixCache>({ raw: '', nodes: [] })
  if (source === '') return null

  let tokens: Token[]
  try {
    tokens = marked.lexer(source, { gfm: true, breaks: false })
  } catch {
    return <Text>{source}</Text>
  }

  // 尾 token 是 space(≥2 个连续换行)说明所有块都已封口;
  // 否则最后一个块视为生成中(单个 \n 后仍可能被续写,如表格加行)。
  const last = tokens[tokens.length - 1]
  const sealed = last !== undefined && last.type === 'space'
  const prefix = sealed ? tokens : tokens.slice(0, -1)
  if (prefix.length === 0) return <Text>{source}</Text>

  const prefixRaw = prefix.map((t) => t.raw).join('')
  try {
    if (prefixRaw !== cache.current.raw) {
      cache.current = { raw: prefixRaw, nodes: renderBlocks(prefix) }
    }
  } catch {
    return <Text>{source}</Text>
  }
  return (
    <>
      {cache.current.nodes}
      {!sealed && <Text>{last.raw}</Text>}
    </>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tui/src/components/markdown/StreamingMarkdown.test.ts`
Expected: PASS,8 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/markdown/StreamingMarkdown.tsx packages/tui/src/components/markdown/StreamingMarkdown.test.ts
git commit -m "feat(tui): StreamingMarkdown 组件,流式期按 token 边界富渲染稳定前缀"
```

---

### Task 2: StreamRenderer 接线

**Files:**
- Modify: `packages/tui/src/components/StreamRenderer.tsx`(import 区 + 第 304 行流式分支)
- Test: `packages/tui/src/components/StreamRenderer.test.ts`(「助手双态」describe 块)

- [ ] **Step 1: 扩展现有测试(先失败)**

`StreamRenderer.test.ts` 的 `describe('StreamRenderer 助手双态')` 里,现有两个用例**保留不动**(`- item` 单块流式仍应纯文本),新增一个:

```ts
  it('流式期间已封口的前缀块富渲染,尾部块保持纯文本', () => {
    const out = frame({ text: '# 标题\n\n- item', isStreaming: true })
    expect(out).toContain('[1m') // 标题已加粗
    expect(out).toContain('- item') // 尾部列表仍是字面纯文本
    expect(out).not.toContain('•')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/tui/src/components/StreamRenderer.test.ts`
Expected: 新用例 FAIL(现状流式分支全纯文本,无 `[1m`),原有用例 PASS。

- [ ] **Step 3: 改接线**

`packages/tui/src/components/StreamRenderer.tsx`:

import 区(第 12 行 `Markdown` import 之后)加:

```tsx
import { StreamingMarkdown } from './markdown/StreamingMarkdown.js'
```

第 304 行流式分支,改前:

```tsx
        {/* 流式期间走纯文本(快、稳、不抖);定稿后重渲染成富 Markdown。 */}
        {message.isStreaming ? <Text>{message.text}</Text> : <Markdown source={message.text} />}
```

改后:

```tsx
        {/* 流式期按 token 边界增量富渲染(尾部未完成块保持纯文本);定稿后整体重渲染兜底。 */}
        {message.isStreaming ? (
          <StreamingMarkdown source={message.text} />
        ) : (
          <Markdown source={message.text} />
        )}
```

其余一概不动:定稿分支、`usage` 行、Spinner/`●` 前缀、user/tool/system 分支。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/tui/src/components/StreamRenderer.test.ts`
Expected: PASS(含原有两个用例——`- item` 单块流式时整体仍是纯文本,行为兼容)。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/StreamRenderer.tsx packages/tui/src/components/StreamRenderer.test.ts
git commit -m "feat(tui): 流式分支接入 StreamingMarkdown,已完成块即时富渲染"
```

---

### Task 3: 全量回归 + spec 修正

**Files:**
- Modify: `docs/superpowers/specs/2026-06-12-zuse-streaming-markdown-design.md`(§6 一处断言描述)

- [ ] **Step 1: 修正 spec 里的表格断言描述**

spec §6 写了「表格出现边框字符 `┌│└`」,但现有表格渲染器**刻意不画** `┌` 网格(见 `Markdown.test.ts` 的 `not.toContain('┌')`),只用 `│` 列分隔。把 spec 该行改为:

```
- 已完成表格 + 生成中的下一段 → 表格出现列分隔线 `│`;
```

- [ ] **Step 2: 全量回归**

Run(仓库根目录,三连):

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: 全部通过,零新增告警。

- [ ] **Step 3: 手动冒烟(可选但推荐)**

`pnpm dev` 起 TUI,让模型输出一段含标题+表格+代码块的长回复,观察:标题/表格在生成过程中逐块变富文本、正在生成的块保持纯文本、无闪烁回跳、定稿后与之前观感一致。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-06-12-zuse-streaming-markdown-design.md
git commit -m "docs(tui): 修正流式渲染 spec 的表格断言描述"
```
