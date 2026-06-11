# 可点击查看全文(临时文件链接 + 清理)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 `- [ ]`。

**Goal:** 临时文件 >7 天启动清理;Grep content/count「Found N lines」可点开临时文件;粘贴折叠发送后标签可点开全文。

**Architecture:** 复用现有 `writeToolOutputFile` + `osc8FileLink`;新增 `pruneOldTempFiles` 清理;`toolSummary` 导出「line 摘要是否隐藏内容」判定驱动落盘;`UIMessage.pasteFiles` 承载粘贴 id→临时文件路径。

**Tech Stack:** TS ESM、React 18、Ink 5、vitest。根目录 `e:\ai-study\zuse`,单测 `npx vitest run <path>`,typecheck `pnpm -F @zuse/tui typecheck`。

设计:[docs/superpowers/specs/2026-06-11-clickable-full-output-design.md](../specs/2026-06-11-clickable-full-output-design.md)。约定:中文注释、TDD、评审前不推送、分支 `input-layer-foundation`。

---

## Task 1: 临时文件启动清理(pruneOldTempFiles)

**Files:** Modify `packages/tui/src/toolOutputFile.ts`、`packages/tui/src/index.tsx`;Test `packages/tui/src/toolOutputFile.test.ts`

- [ ] **Step 1: 失败测试** `toolOutputFile.test.ts`(若已存在则追加):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneOldTempFiles } from './toolOutputFile.js'

const DIR = join(tmpdir(), 'zuse')

describe('pruneOldTempFiles', () => {
  beforeEach(() => { mkdirSync(DIR, { recursive: true }) })

  it('删除超龄文件、保留未超龄文件', () => {
    const old = join(DIR, 'prunetest-old.txt')
    const fresh = join(DIR, 'prunetest-fresh.txt')
    writeFileSync(old, 'x'); writeFileSync(fresh, 'y')
    const now = 10_000_000_000_000
    // old 的 mtime 设到 now - 8 天;fresh 设到 now - 1 小时
    const sec = (ms: number) => ms / 1000
    utimesSync(old, sec(now - 8 * 86400_000), sec(now - 8 * 86400_000))
    utimesSync(fresh, sec(now - 3600_000), sec(now - 3600_000))
    pruneOldTempFiles(7 * 86400_000, now)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(fresh, { force: true })
  })

  it('目录不存在不报错', () => {
    const gone = join(tmpdir(), 'zuse-nonexistent-xyz')
    expect(() => pruneOldTempFilesAt(gone, 1000, Date.now())).not.toThrow()
  })
})
```

> 注:第二个用例需要一个能指定目录的内部变体。实现里把核心做成 `pruneOldTempFilesAt(dir, maxAgeMs, now)` 并导出供测试,`pruneOldTempFiles(maxAgeMs, now)` = `pruneOldTempFilesAt(join(tmpdir(),'zuse'), maxAgeMs, now)`。测试顶部 import 补 `pruneOldTempFilesAt`。

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run packages/tui/src/toolOutputFile.test.ts`。

- [ ] **Step 3: 实现** — 在 `toolOutputFile.ts` 追加(`writeToolOutputFile`/`osc8FileLink` 不动):

```ts
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
// ↑ 合并进文件顶部已有的 fs import

/** 删除 dir 下 mtime 早于 now-maxAgeMs 的文件。best-effort:目录/单文件出错均跳过、不抛。 */
export function pruneOldTempFilesAt(dir: string, maxAgeMs: number, now: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录不存在等:无事可做
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p)
    } catch {
      // 单个文件 stat/unlink 失败(权限/被占用):跳过
    }
  }
}

/** 清理 zuse 临时目录里超龄文件(默认目录 tmpdir()/zuse)。 */
export function pruneOldTempFiles(maxAgeMs: number, now: number): void {
  pruneOldTempFilesAt(join(tmpdir(), 'zuse'), maxAgeMs, now)
}
```

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: index.tsx 启动清理** — 在 `render(...)` 之前加:
```ts
import { pruneOldTempFiles } from './toolOutputFile.js'
// ...(proxy 段之后、render 之前)
try {
  // 启动清理:删 7 天前的临时输出文件(Windows %TEMP% 不自动回收,防堆积)。
  pruneOldTempFiles(7 * 24 * 60 * 60 * 1000, Date.now())
} catch {
  // 清理失败不影响启动
}
```

- [ ] **Step 6: 检查点 + 提交** — `npx vitest run packages/tui/src/toolOutputFile.test.ts && pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui build`;提交:
```bash
git add packages/tui/src/toolOutputFile.ts packages/tui/src/toolOutputFile.test.ts packages/tui/src/index.tsx
git commit -m "feat(tui): 临时文件 >7 天启动清理(pruneOldTempFiles)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Grep content/count 结果可点击

**Files:** Modify `packages/tui/src/components/toolSummary.ts`、`packages/tui/src/hooks/useConversation.ts`、`packages/tui/src/components/StreamRenderer.tsx`;Test `toolSummary.test.ts`、`StreamRenderer.test.ts`

- [ ] **Step 1: 失败测试**

`toolSummary.test.ts` 追加:
```ts
import { lineSummaryHidesContent } from './toolSummary.js' // 合并进 import

describe('lineSummaryHidesContent', () => {
  const grep = (mode: string, output: string) =>
    ({ name: 'Grep', input: { output_mode: mode }, output, status: 'done' }) as any
  it('Grep content 有命中 → true', () => {
    expect(lineSummaryHidesContent(grep('content', 'a.ts:1: foo\nb.ts:2: bar'))).toBe(true)
  })
  it('Grep count 有命中 → true', () => {
    expect(lineSummaryHidesContent(grep('count', 'a.ts:3'))).toBe(true)
  })
  it('Grep 无命中 → false', () => {
    expect(lineSummaryHidesContent(grep('content', 'No matches for: foo'))).toBe(false)
  })
  it('Grep files 模式 → false', () => {
    expect(lineSummaryHidesContent(grep('files_with_matches', 'a.ts\nb.ts'))).toBe(false)
  })
  it('非 Grep → false', () => {
    expect(lineSummaryHidesContent({ name: 'Read', input: {}, output: 'x', status: 'done' } as any)).toBe(false)
  })
})
```

`StreamRenderer.test.ts` 追加:`line` 摘要(造一个 Grep content + `outputFile` 的 tool 消息)渲染出 OSC-8 链接(帧含 `summary.text` 且含 ESC `]8;;` 序列或路径)。

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 lineSummaryHidesContent**(toolSummary.ts):
```ts
/** 该工具的 line 摘要是否「隐藏了完整内容」、值得落盘给链接(当前:Grep content/count 有命中)。 */
export function lineSummaryHidesContent(tool: UIToolCall): boolean {
  if (tool.name !== 'Grep') return false
  const mode = (tool.input as { output_mode?: unknown }).output_mode
  if (mode !== 'content' && mode !== 'count') return false
  const out = tool.output ?? ''
  return !(out.startsWith('No matches for:') || out.startsWith('[offset '))
}
```

- [ ] **Step 4: useConversation 落盘扩展** — tool-result 处理里:
```ts
import { summarizeOutput, lineSummaryHidesContent } from '../components/toolSummary.js'
// ...
const summary = summarizeOutput(probe)
const truncated =
  (summary.kind === 'preview' || summary.kind === 'files') && summary.moreCount > 0
const hides = summary.kind === 'line' && lineSummaryHidesContent(probe)
const outputFile = truncated || hides ? writeToolOutputFile(name, event.output) : undefined
```

- [ ] **Step 5: OutputCell `line` 分支加链接**(StreamRenderer.tsx)— 把:
```ts
  if (summary.kind === 'line') {
    return <Text dimColor>{summary.text}</Text>
  }
```
改为:
```ts
  if (summary.kind === 'line') {
    // 有落盘文件(如 Grep content/count 隐藏了命中内容)时,整行计数包成可点击链接。
    return tool.outputFile ? (
      <Text dimColor>{osc8FileLink(tool.outputFile, summary.text)}</Text>
    ) : (
      <Text dimColor>{summary.text}</Text>
    )
  }
```

- [ ] **Step 6: 检查点 + 提交** — `npx vitest run packages/tui && pnpm -F @zuse/tui typecheck`;提交:
```bash
git add packages/tui/src/components/toolSummary.ts packages/tui/src/components/toolSummary.test.ts packages/tui/src/hooks/useConversation.ts packages/tui/src/components/StreamRenderer.tsx packages/tui/src/components/StreamRenderer.test.ts
git commit -m "feat(tui): Grep content/count 结果落盘并可点击查看全部命中

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 粘贴折叠发送后可点击展开

**Files:** Modify `packages/tui/src/types.ts`、`packages/tui/src/components/InputBox.tsx`、`packages/tui/src/App.tsx`、`packages/tui/src/hooks/useConversation.ts`、`packages/tui/src/components/StreamRenderer.tsx`;新增纯函数 `packages/tui/src/components/pasteLabels.ts` + 测试;改 `StreamRenderer.test.ts`、`InputBox.test.ts`

- [ ] **Step 1: 纯函数 splitPasteLabels + 失败测试**

`packages/tui/src/components/pasteLabels.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { splitPasteLabels } from './pasteLabels.js'

describe('splitPasteLabels', () => {
  it('无标签:整行一段', () => {
    expect(splitPasteLabels('hello world')).toEqual([{ text: 'hello world' }])
  })
  it('单标签:切出 id', () => {
    expect(splitPasteLabels('前[粘贴#1 · 3 行 · 9 字符]后')).toEqual([
      { text: '前' },
      { text: '[粘贴#1 · 3 行 · 9 字符]', id: 1 },
      { text: '后' },
    ])
  })
  it('多标签', () => {
    const segs = splitPasteLabels('[粘贴#1 · 2 行 · 3 字符][粘贴#2 · 5 行 · 1.0k 字符]')
    expect(segs.map((s) => s.id)).toEqual([1, 2])
  })
})
```

`pasteLabels.ts`:
```ts
/** 把一行 displayText 切成「普通文本 / 粘贴标签(带 id)」段,供回显渲染包链接。 */
export interface LabelSeg {
  text: string
  id?: number
}

// 匹配 [粘贴#<id> · ... 字符] 标签(与 pasteFold.tagLabel 文案对应)。
const LABEL_RE = /\[粘贴#(\d+) · [^\]]*\]/g

export function splitPasteLabels(line: string): LabelSeg[] {
  const segs: LabelSeg[] = []
  let last = 0
  for (const m of line.matchAll(LABEL_RE)) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index) })
    segs.push({ text: m[0], id: parseInt(m[1]!, 10) })
    last = m.index + m[0].length
  }
  if (last < line.length) segs.push({ text: line.slice(last) })
  if (segs.length === 0) segs.push({ text: '' })
  return segs
}
```

- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**(`npx vitest run packages/tui/src/components/pasteLabels.test.ts`)。

- [ ] **Step 3: types.ts** — `UIMessage += pasteFiles?: Record<number, string>`(注释:折叠粘贴 id→临时文件路径,供回显标签渲成可点击链接;仅 user 消息用)。

- [ ] **Step 4: InputBox 提交时落盘** — `onSubmit` 签名加第三参 `pasteFiles?`。handleSubmit 改:
```ts
import { writeToolOutputFile } from '../toolOutputFile.js'
// ...
const handleSubmit = (): void => {
  const full = expand(model.buf.text, model.pastes).trim()
  if (full && !isDisabled) {
    let display: string | undefined
    let pasteFiles: Record<number, string> | undefined
    if (model.pastes.size > 0) {
      display = toDisplay(model.buf.text, model.pastes).trim()
      pasteFiles = {}
      for (const [id, content] of model.pastes) {
        const f = writeToolOutputFile('paste', content) // 落盘失败返回 undefined
        if (f) pasteFiles[id] = f
      }
    }
    onSubmit(full, display, pasteFiles)
    setModel((m) => ({ buf: emptyBuffer, pastes: new Map(), nextId: m.nextId }))
    setSelectedIndex(0)
    setDismissedText(null)
  }
}
```
（`InputBoxProps.onSubmit: (text: string, displayText?: string, pasteFiles?: Record<number, string>) => void`。无参命令 acceptCommand 仍单参调用,不变。）

- [ ] **Step 5: 透传** — App.handleSubmit、useConversation.submit/sendMessage 各加第三参 `pasteFiles?`,写进 `UIMessage.pasteFiles`(模型路径 `userText` 不变):
- `App`: `handleSubmit = (text, displayText?, pasteFiles?) => void submit(text, displayText, pasteFiles)`
- `useConversation`: `submit(input, displayText?, pasteFiles?)` → `sendMessage(input, displayText, pasteFiles)`;userMessage 加 `pasteFiles`。

- [ ] **Step 6: StreamRenderer user 渲染包链接** — user 分支按行 `splitPasteLabels`,标签段查 `message.pasteFiles?.[id]`:有则 `osc8FileLink(path, seg.text)`,无则纯文本。示意:
```ts
if (message.role === 'user') {
  const lines = (message.displayText ?? message.text).split('\n')
  const files = message.pasteFiles
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="cyan">{i === 0 ? '› ' : '  '}</Text>
          <Text>
            {splitPasteLabels(line).map((seg, j) => {
              const f = seg.id !== undefined ? files?.[seg.id] : undefined
              return <Text key={j}>{f ? osc8FileLink(f, seg.text) : seg.text}</Text>
            })}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
```
> 注:务必先读现有 user 分支的真实排版(`›` 标记、高亮、缩进),在其结构上替换「整行文本」为「splitPasteLabels 分段渲染」,**保持原有样式**,不要照搬上面示意的排版细节。

- [ ] **Step 7: 测试** — StreamRenderer.test 加:user 消息带 `displayText` 含 `[粘贴#1]` + `pasteFiles:{1:'/tmp/...'}` → 帧含 OSC-8 链接;无 pasteFiles → 纯文本标签。InputBox.test:提交后 onSubmit 第三参含各 id→路径(可 mock `writeToolOutputFile`)。

- [ ] **Step 8: 检查点 + 提交** — `npx vitest run packages/tui && pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui build`;提交:
```bash
git add -A
git commit -m "feat(tui/paste): 折叠粘贴发送后标签可点击展开(落临时文件+OSC-8链接)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 端到端冒烟(手动)

- [ ] `pnpm dev`,真实终端:
  - [ ] Grep content 查询(让模型 grep 并用 content 模式)→「Found N lines」可 ctrl+点击 → 打开 txt 看全部命中行。
  - [ ] 粘贴多行 → 发送 → 滚动区 `[粘贴#1 · …]` 可 ctrl+点击 → 打开 txt 看粘贴原文。
  - [ ] 多段粘贴 → 各自链接各自文件。
  - [ ] 临时文件目录(`%TEMP%\zuse\`)无超 7 天旧文件堆积(可手动放一个旧 mtime 文件、重启 zuse 验证被清)。
  - [ ] 不支持 OSC-8 的场景退化为纯文本,不报错。
- [ ] 收尾:`npx vitest run packages/tui` 全绿、build 成功;不推送,留分支待评审。

---

## 附:自检(spec 覆盖)
- A1 清理 → Task 1 ✅
- A2 Grep content/count 可点(落盘扩展 + line 链接)→ Task 2 ✅
- A3 粘贴展开(splitPasteLabels + pasteFiles + 落盘 + 渲染)→ Task 3 ✅
- 模型侧全文不变 → Task 2/3 均未动 userText/event.output ✅
