# 文本粘贴折叠(第二期)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 `- [ ]` 勾选。

**Goal:** 多行粘贴在输入框折叠成 `[粘贴#id · N行 · M字符]` 标签,可原子编辑;提交时展开全文发模型、滚动区回显折叠标签。

**Architecture:** 占位符纯逻辑集中在新模块 `pasteFold.ts`(哨兵 span + pastes Map + 原子编辑 + 展开/展示映射);渲染复用第一期 `splitForRender`(把带哨兵的 buf 经 `toDisplay`/`toDisplayCursor` 转成展示 buf);粘贴事件经 inputBus 分流到新 `usePaste`;`UIMessage` 加 `displayText` 承载折叠回显。

**Tech Stack:** TypeScript ESM、React 18、Ink 5、vitest。命令在仓库根 `e:\ai-study\zuse` 执行,单测 `npx vitest run <path>`,typecheck `pnpm -F @zuse/tui typecheck`。

权威设计:[docs/superpowers/specs/2026-06-10-paste-collapse-phase2-design.md](../specs/2026-06-10-paste-collapse-phase2-design.md)。

**约定:** 代码注释中文;评审前不推送(本地分支提交);严格 TDD。本期在分支 `input-layer-foundation` 上继续。

---

## Task 1: pasteFold 纯逻辑(标签 / 折叠 / 展开 / 展示映射)

**Files:**
- Create: `packages/tui/src/components/pasteFold.ts`
- Test: `packages/tui/src/components/pasteFold.test.ts`

- [ ] **Step 1: 写失败测试** `packages/tui/src/components/pasteFold.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  PASTE_START,
  PASTE_END,
  tagLabel,
  foldPaste,
  expand,
  toDisplay,
  toDisplayCursor,
} from './pasteFold.js'
import { emptyBuffer } from './textBuffer.js'

describe('tagLabel', () => {
  it('行数=换行数+1,字数=字符数', () => {
    expect(tagLabel(1, 'a\nb\nc')).toBe('粘贴#1 · 3 行 · 5 字符')
  })
  it('字数 ≥1000 显示 x.xk', () => {
    expect(tagLabel(2, 'x'.repeat(1234))).toBe('粘贴#2 · 1 行 · 1.2k 字符')
  })
})

describe('foldPaste', () => {
  it('在光标处插入哨兵 span,id 自增,内容入 Map', () => {
    const r = foldPaste(emptyBuffer, new Map(), 1, 'a\nb')
    expect(r.buf.text).toBe(`${PASTE_START}1${PASTE_END}`)
    expect(r.buf.cursor).toBe(r.buf.text.length)
    expect(r.pastes.get(1)).toBe('a\nb')
    expect(r.nextId).toBe(2)
  })
  it('剥除内容里自带的哨兵字符', () => {
    const r = foldPaste(emptyBuffer, new Map(), 1, `a${PASTE_START}b${PASTE_END}\nc`)
    expect(r.pastes.get(1)).toBe('ab\nc')
  })
  it('在已有文本光标处插入', () => {
    const r = foldPaste({ text: 'xy', cursor: 1 }, new Map(), 3, 'p\nq')
    expect(r.buf.text).toBe(`x${PASTE_START}3${PASTE_END}y`)
  })
})

describe('expand', () => {
  it('span → 全文', () => {
    const pastes = new Map([[1, 'a\nb']])
    expect(expand(`X${PASTE_START}1${PASTE_END}Y`, pastes)).toBe('Xa\nbY')
  })
  it('未知 id 退化为字面', () => {
    expect(expand(`${PASTE_START}9${PASTE_END}`, new Map())).toBe(`${PASTE_START}9${PASTE_END}`)
  })
})

describe('toDisplay', () => {
  it('span → [标签]', () => {
    const pastes = new Map([[1, 'a\nb']])
    expect(toDisplay(`X${PASTE_START}1${PASTE_END}`, pastes)).toBe('X[粘贴#1 · 2 行 · 3 字符]')
  })
})

describe('toDisplayCursor', () => {
  const pastes = new Map([[1, 'a\nb']]) // label 长度固定
  const labelLen = `[粘贴#1 · 2 行 · 3 字符]`.length
  const text = `x${PASTE_START}1${PASTE_END}y` // x=0, span=[1,4), y=4
  it('光标在 span 前', () => {
    expect(toDisplayCursor(text, 1, pastes)).toBe(1)
  })
  it('光标在 span 后', () => {
    expect(toDisplayCursor(text, 4, pastes)).toBe(1 + labelLen)
  })
  it('光标在末尾', () => {
    expect(toDisplayCursor(text, 5, pastes)).toBe(1 + labelLen + 1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run packages/tui/src/components/pasteFold.test.ts`(找不到模块)。

- [ ] **Step 3: 写实现** `packages/tui/src/components/pasteFold.ts`:

```ts
import { insert, type TextBuffer } from './textBuffer.js'

// PUA 哨兵:包裹折叠粘贴的自增 id。正常文本不会出现这两个码位;粘贴内容自带时折叠前剥除。
export const PASTE_START = ''
export const PASTE_END = ''

export type PasteMap = ReadonlyMap<number, string>

// 匹配一个占位符 span:START + 十进制 id + END
const SPAN_RE = /(\d+)/g

export interface Span {
  start: number
  end: number
  id: number
}

/** 扫出 text 里所有占位符 span(按出现顺序)。 */
export function spans(text: string): Span[] {
  const out: Span[] = []
  for (const m of text.matchAll(SPAN_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, id: parseInt(m[1]!, 10) })
  }
  return out
}

/** 标签文案:粘贴#{id} · {N} 行 · {M} 字符(M≥1000 → x.xk)。 */
export function tagLabel(id: number, content: string): string {
  const numLines = content.split('\n').length
  const chars = content.length
  const charStr = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars)
  return `粘贴#${id} · ${numLines} 行 · ${charStr} 字符`
}

/** 折叠一次粘贴:剥哨兵、分配 id、存内容、在光标处插入哨兵 span。 */
export function foldPaste(
  buf: TextBuffer,
  pastes: PasteMap,
  nextId: number,
  content: string,
): { buf: TextBuffer; pastes: Map<number, string>; nextId: number } {
  const clean = content.split(PASTE_START).join('').split(PASTE_END).join('')
  const id = nextId
  const span = PASTE_START + id + PASTE_END
  const text = buf.text.slice(0, buf.cursor) + span + buf.text.slice(buf.cursor)
  const newPastes = new Map(pastes)
  newPastes.set(id, clean)
  return { buf: { text, cursor: buf.cursor + span.length }, pastes: newPastes, nextId: nextId + 1 }
}

/** 哨兵 span → 全文(发模型);未知 id 退化为字面。 */
export function expand(text: string, pastes: PasteMap): string {
  return text.replace(SPAN_RE, (full, idStr) => {
    const c = pastes.get(parseInt(idStr, 10))
    return c === undefined ? full : c
  })
}

/** 哨兵 span → 可见标签串 [label];未知 id 退化为字面。 */
export function toDisplay(text: string, pastes: PasteMap): string {
  return text.replace(SPAN_RE, (full, idStr) => {
    const id = parseInt(idStr, 10)
    const c = pastes.get(id)
    return c === undefined ? full : `[${tagLabel(id, c)}]`
  })
}

/** 光标偏移 → toDisplay 后字符串的偏移(光标不在 span 内部,故可逐段累加)。 */
export function toDisplayCursor(text: string, cursor: number, pastes: PasteMap): number {
  const sp = spans(text)
  let disp = 0
  let i = 0
  let si = 0
  while (i < cursor) {
    if (si < sp.length && sp[si]!.start === i) {
      const { id, start, end } = sp[si]!
      const c = pastes.get(id)
      disp += c === undefined ? end - start : `[${tagLabel(id, c)}]`.length
      i = end
      si++
    } else {
      disp++
      i++
    }
  }
  return disp
}

// 注:insert 仅为占位符模块的相邻能力预留(pasteReduce 在 Task 2 内补全),Task 1 暂未直接用到。
void insert
```

> 注:`void insert` 一行仅为避免「import 未使用」告警的占位,Task 2 会真正用到 `insert` 等并删去该行。若实现者觉得突兀,可改为在 Task 1 先不 import `insert`、Task 2 再加——二者等价,随实现者。

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run packages/tui/src/components/pasteFold.test.ts`(全绿)。
- [ ] **Step 5: 检查点** — 上面测试 + `pnpm -F @zuse/tui typecheck` 零错误。
- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/components/pasteFold.ts packages/tui/src/components/pasteFold.test.ts
git commit -m "feat(tui/paste): pasteFold 纯逻辑(标签/折叠/展开/展示映射)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: pasteFold 原子编辑(pasteReduce)

**Files:**
- Modify: `packages/tui/src/components/pasteFold.ts`
- Test: `packages/tui/src/components/pasteFold.test.ts`

- [ ] **Step 1: 追加失败测试**(在 pasteFold.test.ts 末尾):

```ts
import { pasteReduce } from './pasteFold.js' // 合并进顶部 import

const P = (id: number) => `${PASTE_START}${id}${PASTE_END}`

describe('pasteReduce 原子编辑', () => {
  // 文本 `x{span1}y`:x=0, span=[1,4), y=4, len=5
  const base = { text: `x${P(1)}y`, cursor: 5 }
  const pastes = new Map([[1, 'a\nb']])

  it('左移:从 span 后整体跨到 span 前', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 4 }, pastes, { type: 'left' })
    expect(r.buf.cursor).toBe(1)
  })
  it('右移:从 span 前整体跨到 span 后', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'right' })
    expect(r.buf.cursor).toBe(4)
  })
  it('退格:光标紧跟 span END 时整块删并剪除 id', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 4 }, pastes, { type: 'backspace' })
    expect(r.buf.text).toBe('xy')
    expect(r.buf.cursor).toBe(1)
    expect(r.pastes.has(1)).toBe(false)
  })
  it('向后删:光标正处 span START 时整块删并剪除 id', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'delete' })
    expect(r.buf.text).toBe('xy')
    expect(r.pastes.has(1)).toBe(false)
  })
  it('普通退格不误伤 span', () => {
    const r = pasteReduce({ text: `x${P(1)}y`, cursor: 1 }, pastes, { type: 'backspace' })
    expect(r.buf.text).toBe(`${P(1)}y`)
    expect(r.pastes.has(1)).toBe(true)
  })
  it('插入字符不碰 span,Map 不变', () => {
    const r = pasteReduce(base, pastes, { type: 'insert', text: 'z' })
    expect(r.buf.text).toBe(`x${P(1)}yz`)
    expect(r.pastes.get(1)).toBe('a\nb')
  })
  it('submit/none 原样返回 buf', () => {
    expect(pasteReduce(base, pastes, { type: 'submit' }).buf).toEqual(base)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run packages/tui/src/components/pasteFold.test.ts`(pasteReduce 未定义)。

- [ ] **Step 3: 写实现** — 在 pasteFold.ts 顶部 import 补全,删去 `void insert` 占位行,追加内部 helper 与 `pasteReduce`:

```ts
import {
  insert,
  backspace,
  deleteForward,
  moveUp,
  moveDown,
  moveHome,
  moveEnd,
  moveBufferStart,
  moveBufferEnd,
  reduce,
  type TextBuffer,
  type InputEvent,
} from './textBuffer.js'
```

(替换原来仅 `import { insert, type TextBuffer }` 那行;并删掉文件末尾的 `void insert`。)追加:

```ts
/** 位置严格落在某 span 内则吸附到更近边界。 */
function snapOut(text: string, pos: number): number {
  for (const s of spans(text)) {
    if (pos > s.start && pos < s.end) return pos - s.start <= s.end - pos ? s.start : s.end
  }
  return pos
}
/** 左移落点在 span 内 → 吸到 span 起点(整体跨过)。 */
function snapLeft(text: string, pos: number): number {
  for (const s of spans(text)) if (pos > s.start && pos < s.end) return s.start
  return pos
}
/** 右移落点在 span 内 → 吸到 span 终点(整体跨过)。 */
function snapRight(text: string, pos: number): number {
  for (const s of spans(text)) if (pos > s.start && pos < s.end) return s.end
  return pos
}
function snapBuf(buf: TextBuffer): TextBuffer {
  return { ...buf, cursor: snapOut(buf.text, buf.cursor) }
}
/** 剪除不再被任何 span 引用的 pastes 项,保持 Map 与文本同步。 */
function prune(text: string, pastes: PasteMap): Map<number, string> {
  const referenced = new Set(spans(text).map((s) => s.id))
  const out = new Map<number, string>()
  for (const [id, c] of pastes) if (referenced.has(id)) out.set(id, c)
  return out
}
/** 退格:光标紧跟 span END 则整块删,否则普通退格。 */
function atomicBackspace(buf: TextBuffer): TextBuffer {
  if (buf.cursor > 0 && buf.text[buf.cursor - 1] === PASTE_END) {
    const s = spans(buf.text).find((s) => s.end === buf.cursor)
    if (s) return { text: buf.text.slice(0, s.start) + buf.text.slice(s.end), cursor: s.start }
  }
  return backspace(buf)
}
/** 向后删:光标正处 span START 则整块删,否则普通向后删。 */
function atomicDelete(buf: TextBuffer): TextBuffer {
  if (buf.text[buf.cursor] === PASTE_START) {
    const s = spans(buf.text).find((s) => s.start === buf.cursor)
    if (s) return { text: buf.text.slice(0, s.start) + buf.text.slice(s.end), cursor: s.start }
  }
  return deleteForward(buf)
}

/** 占位符感知地应用一个编辑事件,返回新 buf 与新 pastes(span 被删则剪除其 id)。 */
export function pasteReduce(
  buf: TextBuffer,
  pastes: PasteMap,
  ev: InputEvent,
): { buf: TextBuffer; pastes: Map<number, string> } {
  let next: TextBuffer
  switch (ev.type) {
    case 'insert':
      next = insert(buf, ev.text)
      break
    case 'newline':
      next = insert(buf, '\n')
      break
    case 'backspace':
      next = atomicBackspace(buf)
      break
    case 'delete':
      next = atomicDelete(buf)
      break
    case 'left':
      next = { ...buf, cursor: snapLeft(buf.text, Math.max(0, buf.cursor - 1)) }
      break
    case 'right':
      next = { ...buf, cursor: snapRight(buf.text, Math.min(buf.text.length, buf.cursor + 1)) }
      break
    case 'up':
      next = snapBuf(moveUp(buf))
      break
    case 'down':
      next = snapBuf(moveDown(buf))
      break
    case 'home':
      next = snapBuf(moveHome(buf))
      break
    case 'end':
      next = snapBuf(moveEnd(buf))
      break
    case 'pageUp':
      next = snapBuf(moveBufferStart(buf))
      break
    case 'pageDown':
      next = snapBuf(moveBufferEnd(buf))
      break
    case 'submit':
    case 'none':
      next = reduce(buf, ev)
      break
  }
  return { buf: next, pastes: prune(next.text, pastes) }
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run packages/tui/src/components/pasteFold.test.ts`。
- [ ] **Step 5: 检查点** — 测试 + `pnpm -F @zuse/tui typecheck`。
- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/components/pasteFold.ts packages/tui/src/components/pasteFold.test.ts
git commit -m "feat(tui/paste): pasteReduce 占位符感知原子编辑

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: inputBus 粘贴分流 + usePaste hook

**Files:**
- Modify: `packages/tui/src/input/inputBus.ts`
- Test: `packages/tui/src/input/inputBus.test.ts`
- Modify: `packages/tui/src/input/useInput.ts`

- [ ] **Step 1: 追加失败测试**(inputBus.test.ts 末尾):

```ts
describe('粘贴分流', () => {
  it('isPasted 事件投给粘贴订阅者(传内容),不触发按键订阅者', () => {
    const bus = createInputBus()
    const keys: string[] = []
    const pastes: string[] = []
    bus.subscribe({ current: { handler: (input) => keys.push(input), isActive: true } })
    bus.subscribePaste({ current: { handler: (content) => pastes.push(content), isActive: true } })
    // 构造一个粘贴 ParsedKey
    bus.dispatch({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false, shift: false,
      option: false, super: false, sequence: 'a\nb', raw: 'a\nb', isPasted: true,
    })
    expect(pastes).toEqual(['a\nb'])
    expect(keys).toEqual([])
  })

  it('普通按键不触发粘贴订阅者', () => {
    const bus = createInputBus()
    const pastes: string[] = []
    bus.subscribePaste({ current: { handler: (c) => pastes.push(c), isActive: true } })
    bus.dispatch(parseKeypress('a'))
    expect(pastes).toEqual([])
  })

  it('isActive=false 的粘贴订阅者不收', () => {
    const bus = createInputBus()
    const pastes: string[] = []
    bus.subscribePaste({ current: { handler: (c) => pastes.push(c), isActive: false } })
    bus.dispatch({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false, shift: false,
      option: false, super: false, sequence: 'x\ny', raw: 'x\ny', isPasted: true,
    })
    expect(pastes).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run packages/tui/src/input/inputBus.test.ts`(subscribePaste 未定义)。

- [ ] **Step 3: 改 inputBus.ts** — 加粘贴订阅者类型、表、dispatch 分流:

```ts
export type PasteHandler = (content: string) => void
export interface PasteSubscriber {
  handler: PasteHandler
  isActive: boolean
}

export interface InputBus {
  subscribe(ref: { current: KeySubscriber }): () => void
  subscribePaste(ref: { current: PasteSubscriber }): () => void
  dispatch(parsed: ParsedKey): void
}

export function createInputBus(): InputBus {
  const subs = new Set<{ current: KeySubscriber }>()
  const pasteSubs = new Set<{ current: PasteSubscriber }>()
  return {
    subscribe(ref): () => void {
      subs.add(ref)
      return () => { subs.delete(ref) }
    },
    subscribePaste(ref): () => void {
      pasteSubs.add(ref)
      return () => { pasteSubs.delete(ref) }
    },
    dispatch(parsed): void {
      // 粘贴事件单独分流给粘贴订阅者(传原始内容),不进按键通道。
      if (parsed.isPasted) {
        const content = parsed.sequence ?? ''
        for (const ref of [...pasteSubs]) {
          if (pasteSubs.has(ref) && ref.current.isActive) ref.current.handler(content)
        }
        return
      }
      const { input, key } = parsedKeyToInkKey(parsed)
      for (const ref of [...subs]) {
        if (subs.has(ref) && ref.current.isActive) ref.current.handler(input, key)
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run packages/tui/src/input/inputBus.test.ts`。

- [ ] **Step 5: 加 usePaste hook**(useInput.ts):

```ts
import type { KeySubscriber, PasteSubscriber } from './inputBus.js'
// ... 现有 useInput 不动 ...

/**
 * 订阅粘贴事件(bracketed paste 聚合后的完整内容)。与 useInput 同款 ref 订阅模型。
 * 当前仅 InputBox 使用;isActive=false 时不收。
 */
export function usePaste(
  handler: (content: string) => void,
  opts?: { isActive?: boolean },
): void {
  const bus = useInputBus()
  const isActive = opts?.isActive ?? true
  const ref = useRef<PasteSubscriber>({ handler, isActive })
  ref.current.handler = handler
  ref.current.isActive = isActive
  useEffect(() => {
    return bus.subscribePaste(ref)
  }, [bus])
}
```

- [ ] **Step 6: 检查点** — `npx vitest run packages/tui/src/input` + `pnpm -F @zuse/tui typecheck`。
- [ ] **Step 7: 提交**

```bash
git add packages/tui/src/input/inputBus.ts packages/tui/src/input/inputBus.test.ts packages/tui/src/input/useInput.ts
git commit -m "feat(tui/input): inputBus 粘贴分流 + usePaste hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: message 双份文本(types / useConversation / StreamRenderer / App)

**Files:**
- Modify: `packages/tui/src/types.ts`
- Modify: `packages/tui/src/hooks/useConversation.ts`
- Modify: `packages/tui/src/components/StreamRenderer.tsx`
- Modify: `packages/tui/src/App.tsx`
- Test: `packages/tui/src/components/StreamRenderer.test.ts`

> 本任务不引入折叠 UI,只把「双份文本」管线打通:`displayText` 在则用于回显,`text` 始终是发模型的全文。先于 Task 5(InputBox)落地,使 InputBox 能直接调新签名。

- [ ] **Step 1: 加字段 + 失败测试**

`types.ts` 的 `UIMessage` 增:
```ts
  text: string // 累积的文本内容（user 消息为发给模型的全文）
  /** 折叠回显文本:存在时滚动区按它渲染(含 [粘贴#x] 标签),text 仍为全文。仅 user 消息用。 */
  displayText?: string
```

在 `StreamRenderer.test.ts` 追加用例(若无该测试文件按现有同类组件测试风格新建,渲染一条 `role:'user'` 且带 `displayText` 的消息,断言渲染出 displayText 而非 text)。最小断言示例:

```ts
import { render } from 'ink-testing-library'
// ... 复用本仓既有渲染测试工具 ...
it('user 消息有 displayText 时渲染 displayText', () => {
  const { lastFrame } = render(
    <StreamRenderer message={{ id: '1', role: 'user', text: '超长全文不该出现', displayText: '[粘贴#1 · 9 行 · 1.0k 字符]', isStreaming: false }} cwd={process.cwd()} />,
  )
  expect(lastFrame()).toContain('[粘贴#1')
  expect(lastFrame()).not.toContain('超长全文不该出现')
})
```

- [ ] **Step 2: 跑测试确认失败**(displayText 未渲染)。

- [ ] **Step 3: 改 StreamRenderer** — user 分支用 `displayText ?? text`:

把 user 渲染那行(约 `const lines = message.text.split('\n')`)改为:
```ts
    const lines = (message.displayText ?? message.text).split('\n')
```

- [ ] **Step 4: 改 useConversation** — `submit` 与 `sendMessage` 加可选 `displayText`,透传到 UIMessage;`userText` 仍传全文:

- 接口 `submit: (input: string, displayText?: string) => Promise<void>`。
- `sendMessage` 签名加 `displayText?: string`;userMessage 改为:
```ts
const userMessage: UIMessage = { id: generateId(), role: 'user', text, displayText, isStreaming: false }
```
（`runAgent` 的 `userText: text` 不变 —— 模型收全文。）
- `submit` 体里:非斜杠命令路径调用 `sendMessage(input, displayText)`(命令路径不变,命令不会带 displayText)。

- [ ] **Step 5: 改 App** — `handleSubmit` 透传:
```ts
const handleSubmit = useCallback(
  (text: string, displayText?: string) => { void submit(text, displayText) },
  [submit],
)
```

- [ ] **Step 6: 跑测试 + 检查点** — `npx vitest run packages/tui` 全绿、`pnpm -F @zuse/tui typecheck` 零错误。

- [ ] **Step 7: 提交**

```bash
git add packages/tui/src/types.ts packages/tui/src/hooks/useConversation.ts packages/tui/src/components/StreamRenderer.tsx packages/tui/src/components/StreamRenderer.test.ts packages/tui/src/App.tsx
git commit -m "feat(tui): UIMessage 双份文本(displayText 回显 / text 发模型)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: InputBox 接入折叠(usePaste + pasteReduce + 渲染 + 提交展开)

**Files:**
- Modify: `packages/tui/src/components/InputBox.tsx`
- Modify: `packages/tui/src/components/InputBox.test.ts`

> 这是把前面四块缝合到 InputBox 的集成任务。把 InputBox 的状态从单 `buf` 改为 `{ buf, pastes, nextId }` 三元组,编辑走 `pasteReduce`,粘贴走 `usePaste`+`foldPaste`,渲染经 `toDisplay`/`toDisplayCursor` 复用 `splitForRender`,提交用 `expand`/`toDisplay` 产出全文与回显串。

- [ ] **Step 1: 改 onSubmit 签名 + 状态模型**

- `InputBoxProps.onSubmit` 改为 `(text: string, displayText?: string) => void`。
- 状态从 `const [buf, setBuf] = useState<TextBuffer>(emptyBuffer)` 改为:
```ts
interface InputModel { buf: TextBuffer; pastes: Map<number, string>; nextId: number }
const [model, setModel] = useState<InputModel>({ buf: emptyBuffer, pastes: new Map(), nextId: 1 })
```
- 全文里凡用 `buf` 处改 `model.buf`;`setBuf(b => reduce(b, ev))` 改为 `setModel(m => ({ ...m, ...pasteReduce(m.buf, m.pastes, ev) }))`。

- [ ] **Step 2: 接 usePaste**(粘贴折叠 / 单行插入):
```ts
usePaste(
  (content) => {
    if (isDisabled || content.length === 0) return
    if (content.includes('\n')) {
      // 多行:折叠成占位符标签
      setModel((m) => foldPaste(m.buf, m.pastes, m.nextId, content))
    } else {
      // 单行:当普通文本插入
      setModel((m) => ({ ...m, buf: insert(m.buf, content) }))
    }
    setSelectedIndex(0)
    setDismissedText(null)
  },
  { isActive: !isDisabled },
)
```

- [ ] **Step 3: 提交展开**(handleSubmit):
```ts
const handleSubmit = (): void => {
  const full = expand(model.buf.text, model.pastes).trim()
  if (full && !isDisabled) {
    const display = model.pastes.size > 0 ? toDisplay(model.buf.text, model.pastes).trim() : undefined
    onSubmit(full, display)
    setModel((m) => ({ buf: emptyBuffer, pastes: new Map(), nextId: m.nextId }))
    setSelectedIndex(0)
    setDismissedText(null)
  }
}
```
（无参命令 `acceptCommand` 走 `onSubmit(\`/${cmd.name}\`)` 不带 display,保持原样。）

- [ ] **Step 4: 渲染复用 splitForRender**:
```ts
const displayText = toDisplay(model.buf.text, model.pastes)
const displayCursor = toDisplayCursor(model.buf.text, model.buf.cursor, model.pastes)
const isEmpty = model.buf.text.length === 0
const renderLines = splitForRender({ text: displayText, cursor: displayCursor })
```
（命令菜单判定 `isCommandMenuActive(model.buf.text)` 等仍用原始 `model.buf.text`。)

- [ ] **Step 5: import 调整** — 从 `./pasteFold.js` 引 `foldPaste, pasteReduce, expand, toDisplay, toDisplayCursor`;从 `../input/useInput.js` 引 `usePaste`;`./textBuffer.js` 保留 `insert, emptyBuffer, splitForRender, type TextBuffer`(去掉不再直接用的 `reduce`)。

- [ ] **Step 6: 测试** — 在 InputBox.test.ts 追加(用第一期已建的 FakeStdin + InputProvider 注入模式;粘贴用 `stdin.emit('data', '\x1b[200~多行内容\x1b[201~')` 触发):
  - 粘贴多行 → 帧里出现 `[粘贴#1` 标签、不出现原始多行内容。
  - 提交后(发一个回车)→ onSubmit 收到的第一参含展开全文、第二参含 `[粘贴#1`。
  （若组件级断言成本高,至少保证 typecheck + 手动冒烟;核心逻辑已在 pasteFold.test 覆盖。)

- [ ] **Step 7: 检查点 + 提交**
```bash
npx vitest run packages/tui && pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui build
git add packages/tui/src/components/InputBox.tsx packages/tui/src/components/InputBox.test.ts
git commit -m "feat(tui/paste): InputBox 接入粘贴折叠(usePaste+pasteReduce+展开提交)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 端到端冒烟(手动)

- [ ] 构建启动 `pnpm dev`,真实终端逐项验:
  - [ ] 粘贴多行(右键/Ctrl+Shift+V)→ 输入框显示 `[粘贴#1 · N行 · M字符]`,不铺全文。
  - [ ] 光标左右移整体跨过标签;退格/删除整块删掉标签。
  - [ ] 标签后继续打字、再粘第二段 → `#2`。
  - [ ] 回车提交 → 滚动区那条用户消息显示折叠标签;模型回复表明它收到了**全文**(可让它复述粘贴内容行数)。
  - [ ] 单行粘贴 → 照常作为文本插入,不折叠。
- [ ] 收尾:`npx vitest run packages/tui` 全绿、`build` 成功;按约定不推送,留分支待评审。

---

## 附:自检(spec 覆盖)
- §4 触发(≥2 行)→ Task 5 usePaste 分支 ✅
- §3 占位符 PUA 哨兵 → Task 1 ✅
- §6 原子编辑 → Task 2 ✅
- §6 渲染复用 splitForRender → Task 5 Step 4 ✅
- §3/§4 双份文本 → Task 4 ✅
- §4 粘贴分流 → Task 3 ✅
- 提交展开 / 回显折叠 → Task 5 Step 3 + Task 4 ✅
