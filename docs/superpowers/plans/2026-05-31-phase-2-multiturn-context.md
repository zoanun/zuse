# Phase 2: 多轮 + 上下文 — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One task ≈ one commit, message format `phase 2.X: <做了什么>` (spec §7).

**Goal:** 把对话状态的"权威来源"从 tui 的 React state 下沉到 `@zuse/core` 的 `Conversation` 类(spec §4.2),并在此之上加一个 slash 命令框架(`/help` `/clear` `/save` `/load`)和一个 token 预算雏形。完成后:多轮对话由 core 拥有的 `Conversation` 驱动、可清空、可存盘/读盘,底部状态栏能看到当前上下文占用。

## 背景:当前状态 vs Phase 2 目标

| 步骤 | 现状 | 本计划 |
|------|------|--------|
| 2.1 core `ConversationState` | ❌ 状态全在 tui `useConversation` | **Task 1**:core 建 `Conversation` 类 |
| 2.2 每轮追加消息 | ✅ hook 里重发历史(`.filter().map()`) | **Task 2**:改由 `conversation.append` + `getMessages()` |
| 2.3 渲染完整历史 | ✅ `MessageList` | 不变(refactor 后仍工作) |
| 2.4 token 计数 | ⚠️ 只有累计总数 | **Task 2/5**:区分"累计"与"当前上下文占用",加预算提示 |
| 2.5 slash 命令框架 | ❌ | **Task 3** |
| 2.6 `/clear` | ⚠️ `clear()` 有,无命令入口 | **Task 3** |
| 2.7 `/save` `/load` | ❌ | **Task 4** |

## 架构决策(动工前已与用户确认)

1. **状态下沉到 core(忠于 spec §4.2)。** `Conversation` 是**已提交对话历史**(`Message[]`)的唯一权威来源——就是每轮重发给模型的那段。它是纯数据类、零 React、可单测。
2. **保留 core `Message` 与 tui `UIMessage` 的双模型。** core `Conversation` 只装 `Message`(结构化块、给 API);tui 仍用 `UIMessage`(带 `id`/`isStreaming`/`usage`,给渲染)。两者关系:不流式时 1:1;流式时 tui 多一条"在途占位"(尚未提交进 `Conversation`)。`message-stop` 时才把最终文本提交进 `Conversation`;`error` 时不提交(那一轮失败了)。
3. **`Conversation` 放进 `useRef`,不放 React state。** 可变类不会触发 Ink 重绘,所以渲染列表仍是 React state(`UIMessage[]`),`Conversation` 在 ref 里当"账本"。顺带消除当前 `useCallback([state.messages])` 的 stale-closure 重建。
4. **token 计数区分两个数:**
   - **累计(cumulative)**:整场对话所有轮 `input+output` 之和——花了多少钱(故障模式⑧)。
   - **当前上下文(context)**:**最后一轮**的 `input_tokens`——现在窗口里塞了多少(故障模式②)。这俩是不同的数,之前只显示了前者。

## 关于 `/save` `/load` 的范围说明(给用户的决策点)

- **原 spec §5** 把 `/save` `/load` 列在 Phase 2(2.7)。
- **补充文档 §11.8** 后来把它们重划到 Phase 8(会话持久化,按 cwd 分组 + `--continue`/`--resume` + 每轮自动保存)。
- **本计划取中间路线**:Phase 2 做一个**最小可用**的 `/save` `/load`——序列化能力(`Conversation.toJSON/fromJSON`)本来 Phase 8 也要,提前到 core 里零浪费;命令本身只是把一个对话存成 `~/.zuse/sessions/<name>.json` 的单文件、手动存读。Phase 8 会用**同一个** `Conversation.toJSON` 做 cwd 分组 + 自动保存,是本任务的超集,不会返工 core,只会替换 tui 这一层薄薄的文件 I/O。
- **Task 4 是独立任务**:如果你想严格按 §11.8 把 `/save` `/load` 推到 Phase 8,**直接跳过 Task 4** 即可——前三个任务不依赖它,框架(Task 3)也已经能容纳后补的命令。

---

## File Structure(Phase 2 结束态,★=新增)

```
packages/
├── core/
│   └── src/
│       ├── conversation.ts        ★ Conversation 类 + ConversationSnapshot
│       ├── conversation.test.ts   ★ 单测
│       └── index.ts               ~ 加 export
└── tui/
    └── src/
        ├── types.ts               ~ UIMessage.role 加 'system';ConversationState 加 contextTokens
        ├── commands/
        │   ├── types.ts           ★ SlashCommand / CommandContext
        │   ├── registry.ts        ★ COMMANDS + parseInput + findCommand
        │   └── sessionStore.ts    ★ save/loadConversation 文件 I/O
        ├── hooks/
        │   └── useConversation.ts ~ 重构到 Conversation;新增 submit/命令分发
        ├── components/
        │   ├── StreamRenderer.tsx  ~ 渲染 system 消息
        │   └── UsageFooter.tsx     ~ 显示 context tokens + 预算提示
        └── App.tsx                 ~ onSubmit 改用 submit
```

---

## Task 1: core `Conversation` 类 + 单测(步骤 2.1 / 2.2 / 2.7 地基)

**Files:** Create `packages/core/src/conversation.ts`, `packages/core/src/conversation.test.ts`; Modify `packages/core/src/index.ts`.

- [ ] **Step 1.1: 创建 `packages/core/src/conversation.ts`**

```ts
import type { Message, Usage } from './types.js'

/** Serialized form for /save and /load (Phase 2.7). version gates future migrations. */
export interface ConversationSnapshot {
  version: 1
  messages: Message[]
  totalUsage: Usage
}

/**
 * Conversation — the authoritative store of committed conversation history.
 * This is exactly what gets re-sent to the model each turn (stateless server).
 *
 * Pure data + operations, no React. The TUI holds an instance in a ref and
 * mirrors a render-friendly view into component state.
 */
export class Conversation {
  private messages: Message[] = []
  private _totalUsage: Usage = { input_tokens: 0, output_tokens: 0 }

  append(message: Message): void {
    this.messages.push(message)
  }

  appendUserText(text: string): void {
    this.append({ role: 'user', content: [{ type: 'text', text }] })
  }

  appendAssistantText(text: string): void {
    this.append({ role: 'assistant', content: [{ type: 'text', text }] })
  }

  /** A defensive copy — callers must not mutate our internal array. */
  getMessages(): Message[] {
    return this.messages.map((m) => ({ role: m.role, content: [...m.content] }))
  }

  get length(): number {
    return this.messages.length
  }

  /** Accumulate one turn's usage into the running total (fault mode ⑧). */
  addUsage(usage: Usage): void {
    this._totalUsage = {
      input_tokens: this._totalUsage.input_tokens + usage.input_tokens,
      output_tokens: this._totalUsage.output_tokens + usage.output_tokens,
    }
  }

  get totalUsage(): Usage {
    return { ...this._totalUsage }
  }

  clear(): void {
    this.messages = []
    this._totalUsage = { input_tokens: 0, output_tokens: 0 }
  }

  toJSON(): ConversationSnapshot {
    return { version: 1, messages: this.getMessages(), totalUsage: this.totalUsage }
  }

  static fromJSON(data: ConversationSnapshot): Conversation {
    if (data.version !== 1) {
      throw new Error(`Unsupported conversation snapshot version: ${data.version}`)
    }
    const conv = new Conversation()
    for (const m of data.messages) conv.append(m)
    conv._totalUsage = { ...data.totalUsage }
    return conv
  }
}
```

- [ ] **Step 1.2: 创建 `packages/core/src/conversation.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { Conversation } from './conversation.js'

describe('Conversation', () => {
  it('appends user/assistant turns in order', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.appendAssistantText('hello')
    const msgs = c.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(msgs[1]?.role).toBe('assistant')
  })

  it('getMessages returns a defensive copy', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    const msgs = c.getMessages()
    msgs.push({ role: 'user', content: [{ type: 'text', text: 'mutated' }] })
    expect(c.length).toBe(1)
  })

  it('accumulates usage across turns', () => {
    const c = new Conversation()
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.addUsage({ input_tokens: 20, output_tokens: 7 })
    expect(c.totalUsage).toEqual({ input_tokens: 30, output_tokens: 12 })
  })

  it('clear() resets messages and usage', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.addUsage({ input_tokens: 10, output_tokens: 5 })
    c.clear()
    expect(c.length).toBe(0)
    expect(c.totalUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('round-trips through toJSON/fromJSON', () => {
    const c = new Conversation()
    c.appendUserText('hi')
    c.appendAssistantText('hello')
    c.addUsage({ input_tokens: 9, output_tokens: 20 })
    const restored = Conversation.fromJSON(c.toJSON())
    expect(restored.getMessages()).toEqual(c.getMessages())
    expect(restored.totalUsage).toEqual(c.totalUsage)
  })

  it('fromJSON throws on unknown version', () => {
    // @ts-expect-error testing runtime guard with a bad version
    expect(() => Conversation.fromJSON({ version: 2, messages: [], totalUsage: { input_tokens: 0, output_tokens: 0 } })).toThrow()
  })
})
```

- [ ] **Step 1.3: 在 `packages/core/src/index.ts` 加导出**

在现有 `export * from ...` 之后加一行:

```ts
export * from './conversation.js'
```

- [ ] **Step 1.4: typecheck + test**

```bash
pnpm -F @zuse/core typecheck
pnpm test
```

Expected:`conversation.test.ts` 6 个用例全过,其余测试不受影响。

- [ ] **Step 1.5: Commit**

```bash
git add packages/core/src/conversation.ts packages/core/src/conversation.test.ts packages/core/src/index.ts
git commit -m "phase 2.1: core Conversation class + serialization + tests"
```

---

## Task 2: 重构 `useConversation` 到 `Conversation`(步骤 2.1/2.2 tui 侧 + 2.4 数据)

把 hook 内联的 `.filter().map()` 历史重建替换为 core `Conversation`,并区分累计/当前上下文 token。**本任务对用户可见行为基本不变**(footer 多一个 context 数,Task 5 再美化)。

**Files:** Modify `packages/tui/src/hooks/useConversation.ts`, `packages/tui/src/types.ts`.

- [ ] **Step 2.1: `types.ts` 加 `contextTokens`,并给 `UIMessage.role` 预加 `'system'`**

`UIMessage.role`: `'user' | 'assistant'` → `'user' | 'assistant' | 'system'`
`ConversationState` 增加一字段:

```ts
  contextTokens?: number  // last turn's input_tokens = current context-window occupancy
```

- [ ] **Step 2.2: 重写 `useConversation.ts`**

要点:
- `const conversationRef = useRef(new Conversation())`(从 `@zuse/core` import `Conversation`)。
- `sendMessage`:`conversationRef.current.appendUserText(text)` → 推 UI 占位 → `client.sendMessages(conversationRef.current.getMessages(), ...)`。
- `message-stop`:`conversationRef.current.appendAssistantText(accumulatedText)` + `addUsage(usage)`;UI 占位标记完成;`setState` 的 `totalUsage = conversationRef.current.totalUsage`、`contextTokens = event.usage.input_tokens`。
- `error` / `catch`:**不提交**助手文本进 `Conversation`(那轮失败);只更新 UI 占位 + `isThinking:false`。
- `clear`:`conversationRef.current.clear()` + 重置 state。
- `useCallback` 依赖去掉 `state.messages`(改用 ref),只剩 `[client, maxTokens]`。

完整内容:

```ts
import { useState, useCallback, useRef } from 'react'
import type { UIMessage, ConversationState } from '../types.js'
import { Conversation, type Usage, type ModelClient } from '@zuse/core'

interface UseConversationOptions {
  client: ModelClient | null
  maxTokens: number
}

interface UseConversationReturn {
  state: ConversationState
  sendMessage: (text: string) => Promise<void>
  clear: () => void
  conversation: Conversation
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useConversation({ client, maxTokens }: UseConversationOptions): UseConversationReturn {
  const conversationRef = useRef<Conversation>(new Conversation())
  const [state, setState] = useState<ConversationState>({
    messages: [],
    isThinking: false,
    totalUsage: undefined,
    contextTokens: undefined,
    error: undefined,
  })

  const sendMessage = useCallback(
    async (text: string) => {
      if (!client) {
        setState((prev) => ({ ...prev, error: 'Client not initialized' }))
        return
      }

      const conversation = conversationRef.current
      conversation.appendUserText(text)

      const userMessage: UIMessage = { id: generateId(), role: 'user', text, isStreaming: false }
      const assistantMessage: UIMessage = { id: generateId(), role: 'assistant', text: '', isStreaming: true }

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage, assistantMessage],
        isThinking: true,
        error: undefined,
      }))

      let accumulatedText = ''

      try {
        for await (const event of client.sendMessages(conversation.getMessages(), {
          model: client.getModel(),
          max_tokens: maxTokens,
        })) {
          if (event.type === 'text-delta') {
            accumulatedText += event.text
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMessage.id ? { ...m, text: accumulatedText } : m,
              ),
            }))
          } else if (event.type === 'message-stop') {
            conversation.appendAssistantText(accumulatedText)
            conversation.addUsage(event.usage)
            const usage = event.usage
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMessage.id ? { ...m, isStreaming: false, usage } : m,
              ),
              isThinking: false,
              totalUsage: conversation.totalUsage,
              contextTokens: usage.input_tokens,
            }))
          } else if (event.type === 'error') {
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, isStreaming: false, text: `Error: ${event.message}` }
                  : m,
              ),
              isThinking: false,
              error: event.message,
            }))
            break
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((m) =>
            m.id === assistantMessage.id
              ? { ...m, isStreaming: false, text: `Error: ${message}` }
              : m,
          ),
          isThinking: false,
          error: message,
        }))
      }
    },
    [client, maxTokens],
  )

  const clear = useCallback(() => {
    conversationRef.current.clear()
    setState({
      messages: [],
      isThinking: false,
      totalUsage: undefined,
      contextTokens: undefined,
      error: undefined,
    })
  }, [])

  return { state, sendMessage, clear, conversation: conversationRef.current }
}
```

> 注意:`error`/`catch` 分支故意**不**调 `appendAssistantText`——失败的回合不进历史,否则下次重发会把 "Error: ..." 当成模型说过的话喂回去。

- [ ] **Step 2.3: typecheck + 手动验证多轮仍工作**

```bash
pnpm -F @zuse/tui typecheck
pnpm -F @zuse/tui dev
```

Expected:连发两三条,模型能记住上下文(说明历史重发正常);footer 的 Total 仍累计。

- [ ] **Step 2.4: Commit**

```bash
git add packages/tui/src/hooks/useConversation.ts packages/tui/src/types.ts
git commit -m "phase 2.2: drive history from core Conversation; track context tokens"
```

---

## Task 3: Slash 命令框架 + `/help` + `/clear`(步骤 2.5 / 2.6)

**Files:** Create `packages/tui/src/commands/types.ts`, `registry.ts`; Modify `useConversation.ts`(加 `submit` + 命令分发 + `print`)、`StreamRenderer.tsx`(渲染 system)、`App.tsx`(用 `submit`)。

- [ ] **Step 3.1: `packages/tui/src/commands/types.ts`**

```ts
import type { Conversation } from '@zuse/core'

/** Capabilities a command may use, supplied by the hook. */
export interface CommandContext {
  conversation: Conversation
  clear: () => void
  print: (text: string) => void // append a 'system' message to the transcript
  save: (name: string) => Promise<string> // returns the written path
  load: (name: string) => Promise<number> // returns loaded message count
}

export interface SlashCommand {
  name: string
  description: string
  run: (args: string, ctx: CommandContext) => void | Promise<void>
}
```

- [ ] **Step 3.2: `packages/tui/src/commands/registry.ts`**

`/save` `/load` 引用的是 Task 4 的 `sessionStore`,但命令对象只调 `ctx.save/ctx.load`,所以这里不直接 import fs。先把四个命令都登记上(`save`/`load` 的实现在 hook 的 ctx 里给;Task 4 之前 ctx.save/load 可以先抛 "not implemented",或与 Task 4 一起落)。

```ts
import type { SlashCommand } from './types.js'

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'List available commands',
    run: (_args, ctx) => {
      ctx.print('Commands:\n' + COMMANDS.map((c) => `  /${c.name} — ${c.description}`).join('\n'))
    },
  },
  {
    name: 'clear',
    description: 'Clear the conversation history',
    run: (_args, ctx) => {
      ctx.clear()
    },
  },
  {
    name: 'save',
    description: 'Save conversation: /save [name]',
    run: async (args, ctx) => {
      const path = await ctx.save(args.trim() || 'default')
      ctx.print(`Saved to ${path}`)
    },
  },
  {
    name: 'load',
    description: 'Load conversation: /load [name]',
    run: async (args, ctx) => {
      const count = await ctx.load(args.trim() || 'default')
      ctx.print(`Loaded ${count} messages.`)
    },
  },
]

export interface ParsedInput {
  isCommand: boolean
  name: string
  args: string
}

export function parseInput(input: string): ParsedInput {
  if (!input.startsWith('/')) return { isCommand: false, name: '', args: '' }
  const rest = input.slice(1)
  const sp = rest.indexOf(' ')
  const name = sp === -1 ? rest : rest.slice(0, sp)
  const args = sp === -1 ? '' : rest.slice(sp + 1)
  return { isCommand: true, name, args }
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name)
}
```

- [ ] **Step 3.3: hook 加 `submit` + `print` + 命令分发**

在 `useConversation.ts`:
- 加 `print(text)`:`setState` 往 `messages` 推一条 `{ id, role:'system', text, isStreaming:false }`。
- 加 `submit(input)`:`parseInput`;若 `isCommand`,`findCommand` 命中就 `await cmd.run(args, ctx)`,未命中 `print('Unknown command: /'+name+'. Try /help')`;否则 `sendMessage(input)`。
- `ctx` 由 hook 组装:`{ conversation: conversationRef.current, clear, print, save, load }`。`save`/`load` 暂时(Task 4 之前)实现为 `print` 一句 "not yet"——但建议直接和 Task 4 一起做完。
- 返回值加 `submit`。

`submit` 草图:

```ts
const print = useCallback((text: string) => {
  setState((prev) => ({
    ...prev,
    messages: [...prev.messages, { id: generateId(), role: 'system' as const, text, isStreaming: false }],
  }))
}, [])

const submit = useCallback(
  async (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return
    const parsed = parseInput(trimmed)
    if (!parsed.isCommand) {
      await sendMessage(trimmed)
      return
    }
    const cmd = findCommand(parsed.name)
    if (!cmd) {
      print(`Unknown command: /${parsed.name}. Try /help`)
      return
    }
    await cmd.run(parsed.args, {
      conversation: conversationRef.current,
      clear,
      print,
      save,   // from Task 4
      load,   // from Task 4
    })
  },
  [sendMessage, clear, print, save, load],
)
```

- [ ] **Step 3.4: `StreamRenderer.tsx` 渲染 `system` 消息**

在 `if (message.role === 'user')` 之前加:

```tsx
  if (message.role === 'system') {
    return (
      <Box marginBottom={1} paddingX={1}>
        <Text dimColor>{message.text}</Text>
      </Box>
    )
  }
```

- [ ] **Step 3.5: `App.tsx` 用 `submit`**

```tsx
const { state, submit } = useConversation({ client, maxTokens: getDefaultMaxTokens() })
// ...
<InputBox onSubmit={submit} isDisabled={state.isThinking} />
```

- [ ] **Step 3.6: typecheck + 手动验证**

```bash
pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui dev
```

Expected:输入 `/help` 列出命令(dim 的 system 行);`/clear` 清空;`/bogus` 提示 unknown;普通文本照常发送。

- [ ] **Step 3.7: Commit**

```bash
git add packages/tui/src/commands packages/tui/src/hooks/useConversation.ts packages/tui/src/components/StreamRenderer.tsx packages/tui/src/App.tsx
git commit -m "phase 2.5: slash command framework + /help + /clear"
```

---

## Task 4: `/save` `/load`(步骤 2.7)— 可选,可整体跳过

**Files:** Create `packages/tui/src/commands/sessionStore.ts`; Modify `useConversation.ts`(实现 `save`/`load` 并重建 UI)。

- [ ] **Step 4.1: `packages/tui/src/commands/sessionStore.ts`**

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { Conversation, type ConversationSnapshot } from '@zuse/core'

const sessionsDir = join(homedir(), '.zuse', 'sessions')

/** Reject path traversal / odd characters; sessions are flat files by name. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned || 'default'
}

export async function saveConversation(name: string, conv: Conversation): Promise<string> {
  await mkdir(sessionsDir, { recursive: true })
  const path = join(sessionsDir, `${safeName(name)}.json`)
  await writeFile(path, JSON.stringify(conv.toJSON(), null, 2), 'utf8')
  return path
}

export async function loadConversation(name: string): Promise<Conversation> {
  const path = join(sessionsDir, `${safeName(name)}.json`)
  const raw = await readFile(path, 'utf8')
  const data = JSON.parse(raw) as ConversationSnapshot
  return Conversation.fromJSON(data)
}
```

- [ ] **Step 4.2: hook 实现 `save`/`load`**

- `save(name)`:`return saveConversation(name, conversationRef.current)`(命令里会 `print` 返回的 path)。
- `load(name)`:
  1. `const loaded = await loadConversation(name)`
  2. `conversationRef.current = loaded`(替换账本)
  3. 用 `loaded.getMessages()` 重建 `UIMessage[]`(每条 flatten content→text、`role`、新 `generateId()`、`isStreaming:false`),`setState({ messages: rebuilt, totalUsage: loaded.totalUsage, contextTokens: undefined, isThinking:false, error:undefined })`
  4. `return loaded.length`

flatten helper:

```ts
function flattenText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}
```

> `conversationRef.current = loaded` 直接换实例没问题——它在 ref 里,不参与渲染;UI 列表由 `setState` 重建。
> 错误处理:`load` 不存在的文件会 throw(`ENOENT`)→ 命令的 `await ctx.load` 抛错。在 `submit` 的命令分支用 try/catch 包住 `cmd.run`,catch 里 `print(\`Error: ${msg}\`)`,避免未捕获 promise 让 UI 卡住。**记得给 Step 3.3 的 `cmd.run` 调用补这个 try/catch。**

- [ ] **Step 4.3: typecheck + 手动验证**

```bash
pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui dev
```

Expected:对话几轮 → `/save mychat` 显示写入路径 → `/clear` → `/load mychat` 显示 "Loaded N messages." 且历史重现;`/load nope` 显示 Error 而非卡死。验证文件落在 `~/.zuse/sessions/mychat.json`。

- [ ] **Step 4.4: Commit**

```bash
git add packages/tui/src/commands/sessionStore.ts packages/tui/src/hooks/useConversation.ts
git commit -m "phase 2.7: /save and /load conversation to ~/.zuse/sessions"
```

---

## Task 5: footer 显示当前上下文 + 预算提示(步骤 2.4 收尾)

**Files:** Modify `packages/tui/src/components/UsageFooter.tsx`, `App.tsx`(传 `contextTokens`)。

- [ ] **Step 5.1: `UsageFooter` 加 `contextTokens` + 软上限提示**

props 加 `contextTokens?: number`。在 Total 之后加一段:当 `contextTokens` 有值时显示 `ctx: N`,超过软阈值(常量 `CONTEXT_SOFT_LIMIT`,先设 100_000)时标黄。

```tsx
const CONTEXT_SOFT_LIMIT = 100_000

// ...inside the footer Box, after the Total <Text>:
{contextTokens !== undefined && (
  <Text dimColor color={contextTokens > CONTEXT_SOFT_LIMIT ? 'yellow' : undefined}>
    {' | '}ctx: {contextTokens}
  </Text>
)}
```

> 这区分了"累计花费(Total)"与"当前窗口占用(ctx)"——正是之前那个 token 讨论里两个不同的数。预算雏形 = 这个软阈值变色,故障模式②的最小可见性防御。Phase 8 的压缩策略会以此为触发信号。

- [ ] **Step 5.2: `App.tsx` 传 `contextTokens={state.contextTokens}`**

- [ ] **Step 5.3: typecheck + 验证 + Commit**

```bash
pnpm -F @zuse/tui typecheck && pnpm -F @zuse/tui dev
git add packages/tui/src/components/UsageFooter.tsx packages/tui/src/App.tsx
git commit -m "phase 2.4: footer shows current context tokens + soft budget hint"
```

---

## Task 6: Phase 2 收尾

- [ ] **Step 6.1: 全量检查**

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm -F @zuse/tui dev   # 手动:多轮 / /help / /clear / /save / /load / ctx 数字
```

- [ ] **Step 6.2: 更新 README 状态行**

`Phase 1: Done. ... Next: Phase 2 ...` → `Phase 2: Done. Multi-turn + slash commands (/clear /save /load). Next: Phase 3 — first tool (Read).`

```bash
git add README.md
git commit -m "docs: phase 2 complete, advance status"
```

- [ ] **Step 6.3: 打 tag**

```bash
git tag v0.3-phase2
```

(推送与否听用户的——不要擅自 push。)

---

## What's NOT in Phase 2(deferred)

- **cwd 分组 session / `--continue` / `--resume` / 每轮自动保存** → Phase 8(复用本期 `Conversation.toJSON`)。
- **历史压缩 / token budget 真正的分配与裁剪** → Phase 8(本期只做"可见性 + 软阈值变色")。
- **mid-conversation `system` 消息进 core `Message`** → 仍按 types.ts 注释延后;本期 `system` 只是 **UI-only** 的命令回显,不进 `Conversation`、不发给模型。
- **工具相关命令(`/tools` 等)** → Phase 4。`/model`/`/mode` → Phase 6/5。
- 冒出来的新点子记进 `BACKLOG.md`,别就地扩范围。

---

## Done Criteria

1. `pnpm test` 中 `Conversation` 单测全过,旧测试不挂。
2. core 导出 `Conversation` / `ConversationSnapshot`;历史重发由 `Conversation.getMessages()` 驱动,hook 不再 `.filter().map()` UI state。
3. `/help` 列命令、`/clear` 清空、未知命令有提示。
4. (若做 Task 4)`/save`→`/clear`→`/load` 能还原对话;坏文件名/不存在不致卡死。
5. footer 同时显示累计 Total 与当前 ctx,ctx 超阈值变色。
6. `pnpm typecheck` / `pnpm lint` 干净。
7. 每个 Task 一个 commit(`phase 2.X:` 格式),Phase 打 tag `v0.3-phase2`。
