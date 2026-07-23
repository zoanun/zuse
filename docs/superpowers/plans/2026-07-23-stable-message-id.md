# 稳定 message-id + 中断标记结构化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每条账本 Message 一个稳定唯一 id（源头分配、终身不变，贯穿实时事件→账本→持久化→快照→搜索→checkpoint/revert），并把中断标记从 web 字符串匹配改为结构化 flag。

**Architecture:** approach B——用户消息 id 前端生成随上行、助手消息 id 服务端在 message-start 时生成并随事件下行、二者回合末落同一账本 id（实时==账本）。旧会话在 `Conversation.fromJSON` 按下标确定性回填。checkpoint 锚点、搜索命中、web keying/滚动全改用 message id（revert 截断仍需位置，用 index 兜底）。

**Tech Stack:** TypeScript；`node:crypto` randomUUID；vitest；pnpm；React（web）。

**约束：** 传输无关；不 value-import `@zuse/core` 进 web；纯 TS；**web 测试在 `packages/web` 内跑**（根 vitest 排除 web）；**server 无 `test` 脚本**，用 `pnpm exec vitest run packages/server`；server 包名 `@zouyj/zuse-server`。

**依据（file:line，本会话 Explore 实扫）：** `core/types.ts:17` Message；`core/conversation.ts:22` append/`:82` fromJSON/`:41,50` structuredClone 保字段；`core/agent.ts` RunAgentOptions、message-start 处理（stream 循环 ~213-247）、`:227` stagedUser/`:327` assistant/`:318` runaway/`:422` toolResultMsg/`:439` maxTurns/`:167` finalizeInterruptedTurn/`commitStaged`；`SessionManager.ts:837` submit/`:1045` message-start emit/`:848,1039,1224,1343` user-echo/`:438-478` projectMessages/`:985,1130,1272` checkpoint/revert/`:1310` retry；`ws/clientMessage.ts:35,42`；`session/events.ts:33` SessionCheckpoint；`search/SearchService.ts:19`；`protocol/index.ts:257/284/19/333/308-311`；`web/state/reducer.ts:64/137/194`、`store.tsx:39/157`、`types.ts:9`、`Sidebar.tsx:175`。

---

## Task 1: protocol —— 全部字段先落地（type-only，解锁后续）

**Files:** Modify `packages/protocol/src/index.ts`

- [ ] **Step 1: 加字段**

`ClientMessage` 的 send / steer 各加 `messageId: string`：
```ts
  | { type: 'send'; text: string; messageId: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
  | { type: 'steer'; text: string; messageId: string; images?: UploadedImageRef[]; pastedTexts?: PastedTextInput[]; files?: UploadedFileRef[] }
```

`SessionEvent`：
- `message-start` 注释改为账本 id（字段不变）：`| { type: 'message-start'; id: string; model: string }`（在其上方加注释 `// id = 稳定账本消息 id（服务端在 message-start 时生成，与最终落账本的 assistant 消息 id 一致）`）。
- `user-echo` 加 `messageId`：`| { type: 'user-echo'; text: string; messageId: string; steer?: boolean; attachments?: MessageAttachment[] }`。
- `checkpoint-recorded` 加 `anchorMessageId`：`| { type: 'checkpoint-recorded'; id: string; messageIndex: number; anchorMessageId: string; label: string }`。

`SnapshotMessage`（:19）加 `id` + `interrupt?`：
```ts
export interface SnapshotMessage {
  id: string
  role: 'user' | 'assistant'
  parts: SnapshotPart[]
  interrupt?: boolean
  checkpointId?: string
  steer?: boolean
  ledgerIndex?: number
  attachments?: MessageAttachment[]
}
```

`SearchHit`（:333）加 `id`：
```ts
export interface SearchHit { id: string; msgIndex: number; role: 'user' | 'assistant'; snippet: SearchSnippet }
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter @zuse/protocol exec tsc --noEmit`
Expected: 无错误（纯加字段，protocol 无实现）。**注意**：这一步后 core/server/web 会因缺字段暂时 tsc 报错，属预期，后续 task 补齐。

- [ ] **Step 3: commit**

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): message id fields (send/steer messageId, SnapshotMessage.id+interrupt, user-echo/checkpoint/SearchHit ids)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: core —— Message.id + interrupt + id 生成/织入

**Files:** Modify `packages/core/src/types.ts`、`packages/core/src/conversation.ts`、`packages/core/src/agent.ts`；Test `packages/core/src/agent.test.ts`、`packages/core/src/conversation.test.ts`

- [ ] **Step 1: types.ts —— Message 加字段**

`Message`（:17）加 `id`（必填）+ `interrupt?`：
```ts
export interface Message {
  role: 'user' | 'assistant'
  /** 稳定唯一 id（源头分配、终身不变；持久化/压缩/revert 都不变）。 */
  id: string
  content: ContentBlock[]
  steer?: string[]
  attachments?: MessageAttachment[]
  /** 中断标记消息：web 据此渲染系统提示并略去标记文本 part。仅 finalizeInterruptedTurn 打。 */
  interrupt?: true
}
```

- [ ] **Step 2: conversation.ts —— genMsgId + fromJSON 确定性回填 + appendUserText/Assistant 给 id**

顶部加：
```ts
import { randomUUID } from 'node:crypto'
/** 新消息的随机稳定 id。 */
export function genMsgId(): string { return `msg_${randomUUID()}` }
```
`appendUserText`/`appendAssistantText` 补 id：
```ts
  appendUserText(text: string): void {
    this.append({ role: 'user', id: genMsgId(), content: [{ type: 'text', text }] })
  }
  appendAssistantText(text: string): void {
    this.append({ role: 'assistant', id: genMsgId(), content: [{ type: 'text', text }] })
  }
```
`fromJSON`（:82）确定性回填旧会话缺 id 的消息（按下标，跨加载稳定）：
```ts
  static fromJSON(data: ConversationSnapshot): Conversation {
    if (data.version !== 1) throw new Error(`Unsupported conversation snapshot version: ${data.version}`)
    const conv = new Conversation()
    data.messages.forEach((m, i) => {
      // legacy 会话无 id：按下标赋确定性 id（同一存档多次加载 id 不变）。新会话消息本就带 id，原样保留。
      conv.append(m.id ? m : { ...m, id: `msg_legacy_${i}` })
    })
    conv._totalUsage = { ...data.totalUsage }
    return conv
  }
```
> `append` 不改（不盖章）；id 必填由构造点保证（下步）。若担心遗漏，可在 append 首加 `if (!message.id) throw new Error('Message missing id')` 作硬断言——**加上它**（防御 + 让漏赋 id 的测试立刻炸）。

- [ ] **Step 3: 写失败测试（conversation.test.ts）**

```ts
import { Conversation, genMsgId } from './conversation.js'
it('fromJSON 给缺 id 的 legacy 消息按下标赋确定性 id，二次加载不变', () => {
  const legacy = { version: 1 as const, messages: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'yo' }] },
  ], totalUsage: { input_tokens: 0, output_tokens: 0 } }
  const a = Conversation.fromJSON(legacy as never).getMessages()
  const b = Conversation.fromJSON(legacy as never).getMessages()
  expect(a[0]!.id).toBe('msg_legacy_0')
  expect(a[1]!.id).toBe('msg_legacy_1')
  expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id)) // 跨加载稳定
})
it('genMsgId 唯一且带前缀', () => {
  expect(genMsgId()).toMatch(/^msg_/)
  expect(genMsgId()).not.toBe(genMsgId())
})
it('append 拒绝无 id 消息', () => {
  expect(() => new Conversation().append({ role: 'user', content: [] } as never)).toThrow(/missing id/)
})
```
Run: `pnpm exec vitest run packages/core/src/conversation.test.ts -t id` → FAIL（genMsgId/回填/断言未实现）。做完 Step 2 → PASS。

- [ ] **Step 4: agent.ts —— 构造点赋 id + 助手 id 织入 message-start + finalize interrupt + RunAgentOptions.userMessageId**

`RunAgentOptions` 加：
```ts
  /** 本回合用户消息的稳定 id（由调用方/前端提供）。缺省时 runAgent 生成一个。 */
  userMessageId?: string
```
`import { genMsgId } from './conversation.js'`（或同文件定义）。

`assistantContentOf` 不变（只产 content）。回合循环内新增助手 id 变量，并在 message-start 时定：
- 在 `let text = ''` 一带加 `let assistantMsgId = genMsgId()`（每轮一个；即使模型没发 message-start 也有）。
- message-start 分支（agent.ts stream 循环里 `event.type === 'message-start'`，现 yield `event`）改为 yield 我们的 id：
  ```ts
  } else if (event.type === 'message-start') {
    yield { type: 'message-start', id: assistantMsgId, model: event.model }
  }
  ```
构造点赋 id：
- stagedUser（:227）：`const stagedUser: Message = { role: 'user', id: opts.userMessageId ?? genMsgId(), content: [{ type: 'text', text: userText }] }`。
- 干净路径 assistant（:327）：`staged.push({ role: 'assistant', id: assistantMsgId, content: assistantContentOf(text, toolUses) })`。
- runaway（:318）：`staged.push({ role: 'assistant', id: assistantMsgId, content: [{ type: 'text', text: `${text.slice(0, REPETITION_MIN_CHARS)}\n\n[output truncated: runaway repetition detected]` }] })`。
- toolResultMsg（:422）：构造时加 `id: genMsgId()`。
- maxTurns 收尾 assistant（:439）：加 `id: genMsgId()`。
- `finalizeInterruptedTurn`（:167）：补的 assistant 用 `assistantMsgId`（把它作参数传入，或在调用点传）——**改签名**加 `assistantMsgId: string`，两个调用点（signal.aborted 顶部、errored 分支）传入当前轮的 `assistantMsgId`；合成 assistant `{ role:'assistant', id: assistantMsgId, content }`；标记 user 消息加 `id: genMsgId()` **且 `interrupt: true`**（两支：tool_use 变体的载体 user 消息、纯文本标记 user 消息都打 `interrupt: true`）。

- [ ] **Step 5: 写失败测试（agent.test.ts）**

```ts
it('每条提交的消息都有 id；助手消息 id == 其 message-start 事件 id', async () => {
  const { client } = fakeClient([[
    { type: 'message-start', id: 'PROVIDER_IGNORED', model: 'fake' },
    { type: 'text-delta', text: 'hi' },
    { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
  ]])
  const conv = new Conversation()
  const events = await collect(runAgent({
    conversation: conv, client, registry: new ToolRegistry(), userText: 'q', userMessageId: 'msg_user_x', config, cwd: '.', signal,
  }))
  const msgs = conv.getMessages()
  expect(msgs.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true)
  expect(msgs[0]!.id).toBe('msg_user_x') // stagedUser 用 opts.userMessageId
  const ms = events.find((e) => e.type === 'message-start') as { id: string }
  expect(msgs[1]!.id).toBe(ms.id)        // 助手账本 id == message-start 事件 id
  expect(ms.id).not.toBe('PROVIDER_IGNORED') // 不再透传模型流 id
})
it('中断标记消息带 interrupt:true', async () => {
  const controller = new AbortController()
  const client = abortingClient(controller, [{ type: 'message-start', id: 'm', model: 'fake' }, { type: 'text-delta', text: 'half' }])
  const conv = new Conversation()
  await collect(runAgent({ conversation: conv, client, registry: new ToolRegistry(), userText: 'q', config, cwd: '.', signal: controller.signal }))
  const marker = conv.getMessages().find((m) => m.interrupt)
  expect(marker).toBeDefined()
  expect(marker!.content.some((b) => b.type === 'text' && b.text === '[Request interrupted by user]')).toBe(true)
})
```
（`abortingClient`/`collect`/`fakeClient`/`USAGE`/`signal` 沿用文件既有。）Run `pnpm exec vitest run packages/core/src/agent.test.ts` → 先 FAIL 后 PASS；既有 35 测试不回归（它们构造 Message 若缺 id 会被 append 断言炸——**同步给既有测试里所有手写 Message 字面量补 `id: genMsgId()` 或 `id: 'm1'` 等**）。

- [ ] **Step 6: typecheck + 全量 core 测试 + commit**

Run: `pnpm --filter @zuse/core exec tsc --noEmit`（无错误）
Run: `pnpm exec vitest run packages/core`（全绿）
```bash
git add packages/core/src/types.ts packages/core/src/conversation.ts packages/core/src/agent.ts packages/core/src/agent.test.ts packages/core/src/conversation.test.ts
git commit -m "feat(core): stable Message.id (client user id / server assistant id via message-start) + interrupt flag + legacy backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: server —— submit/steer 透传 id + projectMessages(id/interrupt/略标记/steer 派生) + user-echo id

**Files:** Modify `packages/server/src/session/SessionManager.ts`、`packages/server/src/ws/clientMessage.ts`；Test `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: clientMessage.ts 透传 messageId**

send（:35）：`mgr.submit(msg.text, msg.images, msg.pastedTexts, msg.files, { messageId: msg.messageId })`。
steer（:42）：`mgr.steer(msg.text, msg.images, msg.pastedTexts, msg.files, { messageId: msg.messageId })`（busy 分支）与 `mgr.submit(..., { echo: true, messageId: msg.messageId })`（idle 分支）。

- [ ] **Step 2: submit/steer 签名 + 透传到 runAgent**

`submit` opts 加 `messageId?: string`；调用 runAgent 处传 `userMessageId: opts?.messageId`。`steer` 同理记住 messageId，随折叠/drain 用（steer 折叠进 tool_result 的路径：user-echo 带该 id；drain 成新回合时作 userMessageId）。`echoAttachments`/user-echo 各发射点（:848/1039/1224/1343）加 `messageId`（submit 的用 opts.messageId ?? genMsgId 前端应总给；steer 用其 id；retry 用被重发用户消息的 id）。
> server 需要 `genMsgId`：`import { genMsgId } from '@zuse/core'`（core 已导出）。缺 messageId 时兜底 `genMsgId()`。

- [ ] **Step 3: projectMessages（id + interrupt + 略标记文本 + steer 派生 id）**

`projectMessages`（:438）循环体：
- 每条 `SnapshotMessage` 带 `id: message.id`。
- 若 `message.interrupt`：置 `interrupt: true`，且**跳过等于 `[Request interrupted by user]` / `[Request interrupted by user for tool use]` 的 text part**（模型看的文本仍在账本 content，不进快照 part）。
- steer 拆出的独立气泡（现有逻辑把 `steer` 文本单独成 bubble）id 用派生 `${message.id}#steer${n}`。
- `out.push({ id: message.id, role, parts, interrupt: message.interrupt || undefined, checkpointId, ledgerIndex: i, attachments })`。

- [ ] **Step 4: 写失败测试 + 跑**

```ts
it('projectMessages 每条带 id；interrupt 消息置 flag 且不含标记文本 part', async () => {
  // 用一个已 setTodos/中断的 manager 或直接构造 conversation 含 interrupt 消息，断言 getState().messages
  // 每条有非空 id；interrupt 那条 interrupt===true 且 parts 里无 '[Request interrupted by user]' 文本。
})
it('submit 把前端 messageId 落进账本', async () => {
  // 注入 fakeClient，mgr.submit('q', undefined, undefined, undefined, { messageId: 'msg_u1' })
  // 断言 getConversation().getMessages()[0].id === 'msg_u1'
})
```
Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts`（先 FAIL 后 PASS；既有测试若手写 Message 需补 id）。

- [ ] **Step 5: typecheck + commit**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/ws/clientMessage.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): thread message id through submit/steer; project id+interrupt (omit marker text); user-echo ids

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 持久化 + legacy 回填端到端

**Files:** Test `packages/server/src/session/sessionStore.test.ts`（或 createSession/SessionService 相关）

- [ ] **Step 1: 写测试（旧存档加载得确定性 id、round-trip 保 id）**

```ts
it('加载无 id 的旧会话 JSON → 每条消息得确定性 id，二次加载不变', () => {
  // 写一个 messages 无 id 的 SessionRecord JSON 到临时目录，loadSession 两次，
  // 断言两次每条消息 id 相同且形如 msg_legacy_<i>（经 Conversation.fromJSON）。
})
it('新会话的 message id round-trip 持久化后不变', () => {
  // saveSession 一个带 id 的 conversation，loadSession，断言 id 逐条相等。
})
```
> 具体经 `createSession`/`SessionService` 的恢复路径（它们 `Conversation.fromJSON(record)`）。实现子代理按真实恢复 API 对齐；核心断言 = id 稳定。

- [ ] **Step 2: 跑 + 补实现（若恢复路径未走 fromJSON 则改为走它）+ commit**

Run: `pnpm exec vitest run packages/server`（相关测试 + 全量不回归）
```bash
git add -A packages/server
git commit -m "test(server): message id survives persistence round-trip; legacy sessions get deterministic ids

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: checkpoint / revert 按 id 锚定

**Files:** Modify `packages/server/src/session/events.ts`、`packages/server/src/session/SessionManager.ts`；Test `SessionManager.test.ts`

- [ ] **Step 1: SessionCheckpoint 加 anchorMessageId**

`events.ts:33` `SessionCheckpoint` 加 `anchorMessageId: string`。

- [ ] **Step 2: 记录 + 事件带 anchor id**

checkpoint 记录处（:1130）：`checkpointIndex` 对应"即将开始的用户消息" —— 该用户消息在 runAgent 里才构造，其 id = 本回合的 `opts.messageId`（前端给的），submit 已知。记 `anchorMessageId: opts?.messageId ?? <该位置消息 id>`。`checkpoint-recorded` 事件（:1131）带 `anchorMessageId`。

- [ ] **Step 3: revert/retry 按 id 定位（index 兜底）**

`revert`（:1272）：`const msgs = this.conversation.getMessages(); const pos = cp.anchorMessageId ? msgs.findIndex((m) => m.id === cp.anchorMessageId) : -1; const cut = pos >= 0 ? pos : cp.messageIndex;` 用 `cut` 做 `slice(0, cut)`；checkpoints 过滤同理按 cut。`retry`（:1310）读原用户消息也先按 anchorMessageId 定位、拿不到回退 `messageIndex`。

- [ ] **Step 4: 测试 + 跑 + commit**

```ts
it('revert 按 anchorMessageId 定位截断（即便前面插过消息位置漂移）', async () => {
  // 构造带 checkpoint 的会话，anchorMessageId 指向某用户消息；断言 revert 截到该消息之前，
  // 且当 messageIndex 与实际 id 位置不一致时以 id 为准。
})
```
Run: `pnpm exec vitest run packages/server`
```bash
git add packages/server/src/session/events.ts packages/server/src/session/SessionManager.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): anchor checkpoints/revert on message id (index fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 搜索按 id

**Files:** Modify `packages/server/src/search/SearchService.ts`；Test 其单测

- [ ] **Step 1: SearchService 建索引带 id、命中返回 id**

`SearchService.ts:19` 建 doc 时 `docs.push({ msgIndex: i, id: m.id, role: m.role, text: ... })`；SearchHit 组装带 `id`。

- [ ] **Step 2: 测试 + 跑 + commit**

```ts
it('SearchHit 带命中消息的 id', () => { /* 索引含 id 的消息，搜关键词，断言 hit.id === 该消息 id */ })
```
Run: `pnpm exec vitest run packages/server`
```bash
git add packages/server/src/search/SearchService.ts packages/server/src/search
git commit -m "feat(server): search hits carry stable message id

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: web —— 按 id 渲染/keying/跳转 + 中断 flag + checkpoint anchor

**Files:** Modify `packages/web/src/state/reducer.ts`、`store.tsx`、`components/Shell.tsx`、`components/Sidebar.tsx`、`components/MessageList.tsx`；Test 各 `.test`

- [ ] **Step 1: user-send 上行带 messageId**

`Shell.tsx:138` 生成 id 后随 `send`：`const id = nextId('u'); send({ type: 'send', text, messageId: id, images, pastedTexts, files }); dispatch({ kind: 'user-send', id, text, attachments })`（steer 同理带 messageId）。store 的 `send` 已透传 ClientMessage。

- [ ] **Step 2: applySnapshot 按 id、message-start 用服务端 id、user-echo 用事件 id、interrupt flag 渲染**

`reducer.ts:64` applySnapshot：`id: m.id`（steer 气泡 id 已由服务端派生 `${id}#steer${n}` 带来，直接用 `m.id`）。删除原 `'h'+(m.ledgerIndex ?? i)` / `'hs'+i` 逻辑。
`message-start`（:137）：`{ id: e.id, role: 'assistant', parts: [] }`（e.id 现在是服务端账本 id，天然与快照一致——无需改，但确认不再本地造 id）。
`user-echo`（:194）：用 `e.messageId` 作 id（不再 `'ue'+len`）。
**中断标记**：删掉 `INTERRUPT_MARKERS` 字符串匹配（Task from earlier）；`foldToolResults`/applySnapshot 里对 `m.interrupt` 的 SnapshotMessage → 产出 system notice（`{ role:'system', noticeKind:'info', parts:[{kind:'text', text:'已被用户中断'}] }`），不作 user 气泡。实时 `aborted` 提示不变。

- [ ] **Step 3: searchJump 按 id、DOM 节点 id 用 message id**

`Sidebar.tsx:175`：`onJump(r.session.id, h.id)`。`store.tsx:157` searchJump 签名 `(sessionId, msgId)` → `setPendingScrollTo(msgId)`。`MessageList` 渲染每条消息的 DOM `id={m.id}`（原可能是 `'h'+i`，改为 `m.id`）；`pendingScrollTo` 用 `document.getElementById(msgId)` 滚动。

- [ ] **Step 4: checkpoint 按 anchorMessageId 关联**

`checkpoint-recorded` reducer 处用 `e.anchorMessageId` 把 revert 关联到该 id 的消息（原按 messageIndex/ledgerIndex）。

- [ ] **Step 5: 测试 + typecheck + 全量 web + commit**

补/改 reducer.test、store.test、Sidebar.test、Shell 相关：applySnapshot 按 id key；user-send 上行含 messageId；interrupt flag → system notice、无字符串匹配；searchJump 按 id。
Run（web 在包内）：`cd packages/web && pnpm exec vitest run`；`pnpm --filter @zuse/web exec tsc --noEmit`。
```bash
git add packages/web/src
git commit -m "feat(web): key/scroll/search/checkpoint by stable message id; interrupt notice by flag (drop string match)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 全链路门禁 + Playwright

- [ ] **Step 1: 四包 tsc**：core/protocol/server/web `tsc --noEmit` 全清。
- [ ] **Step 2: 单测**：`pnpm exec vitest run packages/core packages/protocol packages/server`（并行 flaky 的 SessionService 用例据实豁免）；`cd packages/web && pnpm exec vitest run`。
- [ ] **Step 3: 重建 + 重启 daemon**：`pnpm --filter @zuse/web build`；杀 4180 PID、`nohup pnpm exec tsx packages/server/src/bin.ts &`（不传 ZUSE_WEBDIR）。
- [ ] **Step 4: Playwright 冒烟**（登录后）：①发消息→在侧栏搜历史→点命中→跳转滚到那条(验证 id 定位)；②中断一轮→显示「已被用户中断」系统提示(非用户气泡)；③刷新→半截+提示仍在、同一条消息刷新前后行为一致。截图存证。

---

## Self-Review

**1. Spec coverage：** id 模型(Task2)、协议(Task1)、id 源头 client/server(Task2/3)、必填+构造点赋值(Task2)、legacy 确定性回填(Task2/4)、projectMessages id+interrupt+略标记+steer 派生(Task3)、user-echo id(Task3)、checkpoint/revert 按 id(Task5)、搜索按 id(Task6)、web keying/滚动/中断 flag/checkpoint(Task7)、门禁+Playwright(Task8)——spec 六阶段全覆盖。✓
**2. Placeholder scan：** 核心机制均有具体代码；少数 server 测试步与恢复路径标注"按真实 API 对齐"是**核对指令**(要求实现时读真码)，非占位；web Task7 的改动以精确文件+变换描述给出(mechanical，子代理读现码执行)。✓
**3. Type consistency：** `genMsgId`（core 导出，server import）、`Message.id/interrupt`、`RunAgentOptions.userMessageId`、`submit(...,{messageId})`、`SnapshotMessage.id/interrupt`、`SearchHit.id`、`SessionCheckpoint.anchorMessageId`、`checkpoint-recorded.anchorMessageId`、`user-echo.messageId`、`send/steer.messageId` —— 各处命名一致。✓
