# 中途取消保留回合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在 LLM 流式回复中途按 Stop 时，保留提问 + 半截助手文本 + 已完成工具，给悬空 tool_use 合成"已中断"结果，注入模型可见的 `[Request interrupted by user]` 标记；副作用不回滚；啥都没生成时把提问退回输入框。

**Architecture:** core/agent.ts 把中断从"丢弃 staged"改为"收尾并提交"（新 `finalizeInterruptedTurn` + 共享 `commitStaged`，接在 :190 顶部与 :250 errored 两个中断点）。server/SessionManager.ts 删掉 abort 时的 todos/cwd 回滚与已折叠 steer 重排，新增 empty-interrupt 判定并 emit 新协议事件 `restore-input`。protocol 加 `restore-input` 事件类型。web 把账本里的中断标记渲染成系统提示、并把 `restore-input` 回填进输入框。

**Tech Stack:** TypeScript；vitest；pnpm；React（web）。provider 无关（anthropic/openai client 中断都 yield error，不抛）。

**依据（本会话逐行核对）:** agent.ts:173/177/186-192/195-197/243-250/252-261/264-269/272-279/374/378-390；anthropic-client.ts:173-182 与 openai-client.ts:303-322（一致 yield error+return）；SessionManager.ts:1007-1008/1020/1063/1074-1082/1096/1112/1184/1195-1204/1218-1220/214-221/858-859；protocol SessionEvent 联合 :256-286；web reducer.ts foldToolResults/applySnapshot/withNotice、store.tsx onMessage:73-100 与 pendingScrollTo、Composer.tsx ComposerHandle:52/useImperativeHandle:268、Shell.tsx:53/84。

---

## File Structure

- **`packages/core/src/agent.ts`** — 中断收尾逻辑（`finalizeInterruptedTurn` + `commitStaged` + 两常量 + 两中断点接线）。核心行为所在。
- **`packages/core/src/agent.test.ts`** — 中断保留的单测（新增若干 it）。
- **`packages/protocol/src/index.ts`** — `SessionEvent` 加 `restore-input`。
- **`packages/server/src/session/SessionManager.ts`** — 删回滚/重排；加 `sawToolUse` + empty-interrupt→emit restore-input。
- **`packages/server/src/session/SessionManager.test.ts`** — 中断保留/不回滚/restore-input 单测。
- **`packages/web/src/state/reducer.ts`** + **`reducer.test.ts`** — 中断标记渲染成系统提示。
- **`packages/web/src/components/Composer.tsx`** — `ComposerHandle` 加 `restoreInput`。
- **`packages/web/src/state/store.tsx`** — 拦截 restore-input 事件 → `pendingRestoreInput`（镜像 pendingScrollTo）。
- **`packages/web/src/components/Shell.tsx`** — useEffect：pendingRestoreInput → composerRef.restoreInput + clear。
- **`packages/web/src/components/Composer.test.tsx`** / **Shell 相关** — 回填单测。

---

## Task 1: core/agent.ts —— 中断时提交而非丢弃

**Files:**
- Modify: `packages/core/src/agent.ts`
- Test: `packages/core/src/agent.test.ts`

- [ ] **Step 1: 写失败测试（先加 fake abort 客户端 + 三条中断用例）**

在 `packages/core/src/agent.test.ts` 顶部辅助函数区（`collect` 之后）加一个"中途 abort"客户端工厂：

```ts
/** 模拟真实 client 的中断：先吐 pre 事件，然后 abort 传入的 controller 并 yield error（对齐
 *  anthropic/openai client 在 signal.aborted 时 yield {type:'error'} 的行为）。 */
function abortingClient(controller: AbortController, pre: StreamEvent[]): ModelClient {
  return {
    getModel: () => 'fake',
    async *sendMessages() {
      for (const e of pre) yield e
      controller.abort()
      yield { type: 'error', message: 'aborted' }
    },
  }
}
```

在 `describe('runAgent', …)` 内新增：

```ts
it('中途中断（纯文本）保留提问+半截文本+标记', async () => {
  const controller = new AbortController()
  const client = abortingClient(controller, [
    { type: 'message-start', id: 'm1', model: 'fake' },
    { type: 'text-delta', text: 'half answer' },
  ])
  const conv = new Conversation()
  await collect(runAgent({
    conversation: conv, client, registry: new ToolRegistry(), userText: 'q', config, cwd: '.', signal: controller.signal,
  }))
  const msgs = conv.getMessages()
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  expect(msgs[1]!.content).toEqual([{ type: 'text', text: 'half answer' }])
  expect(msgs[2]!.content).toEqual([{ type: 'text', text: '[Request interrupted by user]' }])
})

it('中途中断（tool_use 已发、未执行）合成"已中断"结果 + for-tool-use 标记', async () => {
  const controller = new AbortController()
  const client = abortingClient(controller, [
    { type: 'message-start', id: 'm1', model: 'fake' },
    { type: 'text-delta', text: 'let me' },
    { type: 'tool-use', id: 't1', name: 'echo', input: { value: 'x' } },
  ])
  const conv = new Conversation()
  const reg = new ToolRegistry(); reg.register(echoTool())
  await collect(runAgent({
    conversation: conv, client, registry: reg, userText: 'q', config, cwd: '.', signal: controller.signal,
  }))
  const msgs = conv.getMessages()
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  // assistant 含 text + tool_use
  expect(msgs[1]!.content).toEqual([
    { type: 'text', text: 'let me' },
    { type: 'tool_use', id: 't1', name: 'echo', input: { value: 'x' } },
  ])
  // 收尾 user 消息 = 合成的 interrupted tool_result + for-tool-use 标记文本
  expect(msgs[2]!.content).toEqual([
    { type: 'tool_result', tool_use_id: 't1', content: '[Tool interrupted by user]', is_error: true },
    { type: 'text', text: '[Request interrupted by user for tool use]' },
  ])
})

it('啥都没生成就中断 → 不提交（rewind 交给上层）', async () => {
  const controller = new AbortController()
  const client = abortingClient(controller, []) // 无 message-start、无 text、无 tool_use
  const conv = new Conversation()
  await collect(runAgent({
    conversation: conv, client, registry: new ToolRegistry(), userText: 'q', config, cwd: '.', signal: controller.signal,
  }))
  expect(conv.getMessages()).toHaveLength(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/core/src/agent.test.ts -t 中断`
Expected: FAIL —— 现状中断丢弃，`conv.getMessages()` 为空，前两条用例的长度/内容断言不通过。

- [ ] **Step 3: 加常量 + commitStaged + finalizeInterruptedTurn**

在 `packages/core/src/agent.ts` 的 `PendingToolUse` 定义（:135 附近）之后、`runAgent` 之前，加：

```ts
/** 用户中断标记（对齐 CC）：作为 user 消息写进账本，下一轮模型可见。 */
const INTERRUPT_MARKER = '[Request interrupted by user]'
const INTERRUPT_MARKER_TOOL_USE = '[Request interrupted by user for tool use]'
const INTERRUPTED_TOOL_RESULT = '[Tool interrupted by user]'

/** 原子提交本回合暂存的消息（clean 路径与中断收尾共用）。 */
function commitStaged(conversation: Conversation, staged: Message[], turnUsage: Usage): void {
  for (const m of staged) conversation.append(m)
  conversation.addUsage(turnUsage)
}

/**
 * 把被用户中断的回合收尾并提交，而非丢弃。必要时补齐半截 assistant 消息、给没有配对
 * tool_result 的 tool_use 合成"已中断"结果（保账本对 API 合法）、追加中断标记，然后提交。
 * 仅在"用户中断且本回合有生成物"时由调用点触发；真错误不调。
 */
function finalizeInterruptedTurn(
  conversation: Conversation,
  staged: Message[],
  turnUsage: Usage,
  partial: { text: string; toolUses: PendingToolUse[] },
): void {
  // 1. 若最后一条暂存消息还不是本回合的 assistant（中途中断在 :269 组装之前 break），用累积
  //    text + 已发出的 tool_use 组装一条 assistant 暂存；空内容不 push。
  if (staged[staged.length - 1]?.role !== 'assistant') {
    const content: ContentBlock[] = []
    if (partial.text) content.push({ type: 'text', text: partial.text })
    for (const tu of partial.toolUses) content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
    if (content.length > 0) staged.push({ role: 'assistant', content })
  }

  // 2. 找最后一条 assistant 里没有配对 tool_result 的 tool_use（中途中断、工具没跑）。
  const last = staged[staged.length - 1]
  const pendingIds: string[] = []
  if (last?.role === 'assistant') {
    for (const b of last.content) {
      if (b.type === 'tool_use' && !staged.some((m) => m.content.some((x) => x.type === 'tool_result' && x.tool_use_id === b.id))) {
        pendingIds.push(b.id)
      }
    }
  }

  // 3. 追加标记：有悬空 tool_use → 合成结果 + for-tool-use 标记（并进同一条 user 消息）；否则纯文本标记。
  if (pendingIds.length > 0) {
    const content: ContentBlock[] = pendingIds.map((id) => ({
      type: 'tool_result', tool_use_id: id, content: INTERRUPTED_TOOL_RESULT, is_error: true,
    }))
    content.push({ type: 'text', text: INTERRUPT_MARKER_TOOL_USE })
    staged.push({ role: 'user', content })
  } else {
    staged.push({ role: 'user', content: [{ type: 'text', text: INTERRUPT_MARKER }] })
  }

  // 4. 原子提交。
  commitStaged(conversation, staged, turnUsage)
}
```

> 确认 `agent.ts` 顶部已从 `./types.js` 引入 `ContentBlock`（若未引入，加到现有 type import 里；`Message`/`Usage` 已在用）。

- [ ] **Step 4: 接线两个中断点**

把 :186-192 顶部丢弃：

```ts
    if (signal.aborted) {
      yield { type: 'warning', message: 'Interrupted.' }
      return // 丢弃 staged —— 什么都不提交
    }
```

改为：

```ts
    if (signal.aborted) {
      yield { type: 'warning', message: 'Interrupted.' }
      // 用户中断：有生成物（前序步骤已暂存）就收尾提交；否则（只有初始 user 消息）不提交，交上层 rewind。
      if (staged.length > 1) finalizeInterruptedTurn(conversation, staged, turnUsage, { text: '', toolUses: [] })
      return
    }
```

把 :250 丢弃：

```ts
    if (errored) return // 真·模型调用失败（error 事件）：什么都不提交
```

改为：

```ts
    if (errored) {
      // 用户中断经 client 转成 error 事件（anthropic/openai 一致）。区分：
      //  - 中断且有生成物 → 收尾提交（半截助手 + 合成/标记）；
      //  - 中断但啥没生成 → 不提交（上层 rewind）；
      //  - 真错误（signal 未 abort）→ 丢弃（现状不变）。
      if (signal.aborted && (text !== '' || toolUses.length > 0 || staged.length > 1)) {
        finalizeInterruptedTurn(conversation, staged, turnUsage, { text, toolUses })
      }
      return
    }
```

把末尾 :389-390 的内联提交：

```ts
  for (const m of staged) conversation.append(m)
  conversation.addUsage(turnUsage)
```

改为复用：

```ts
  commitStaged(conversation, staged, turnUsage)
```

- [ ] **Step 5: 跑测试确认通过（含既有回归）**

Run: `pnpm exec vitest run packages/core/src/agent.test.ts`
Expected: PASS —— 三条新用例过；既有"does not commit anything when the model call errors"（signal 未 abort）仍过（真错误照丢）；runaway/maxTurns/工具用例不变。

- [ ] **Step 6: 加"顶部中断点"用例（tool 执行完、下一轮边界处中断）**

在 agent.test.ts 加（放中断用例组内）：

```ts
it('工具步完成后于回合边界中断 → 提交该步 + 纯文本标记', async () => {
  const controller = new AbortController()
  // 一个 run() 会主动 abort 的工具：模拟"工具跑完、下一轮 :190 顶部检查到中断"。
  const abortEcho: Tool = {
    name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} },
    run: async () => { controller.abort(); return { output: 'done' } },
  }
  const client = fakeClient([[
    { type: 'message-start', id: 'm1', model: 'fake' },
    { type: 'tool-use', id: 't1', name: 'echo', input: {} },
    { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
  ]]).client
  const conv = new Conversation()
  const reg = new ToolRegistry(); reg.register(abortEcho)
  await collect(runAgent({
    conversation: conv, client, registry: reg, userText: 'q', config, cwd: '.', signal: controller.signal,
  }))
  const msgs = conv.getMessages()
  // [user, assistant(tool_use), user(tool_result echo), user(标记)]
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
  expect(msgs[2]!.content.some((b) => b.type === 'tool_result' && b.content === 'done')).toBe(true)
  expect(msgs[3]!.content).toEqual([{ type: 'text', text: '[Request interrupted by user]' }])
})
```

Run: `pnpm exec vitest run packages/core/src/agent.test.ts -t 边界`
Expected: PASS。

- [ ] **Step 7: typecheck + commit**

Run: `pnpm --filter @zuse/core exec tsc --noEmit`
Expected: 无错误。

```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "feat(core): preserve the turn on user interrupt instead of discarding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: protocol —— restore-input 事件

**Files:**
- Modify: `packages/protocol/src/index.ts`（`SessionEvent` 联合，:256-286）

- [ ] **Step 1: 加事件类型**

在 `SessionEvent` 联合里（紧接 `| { type: 'aborted' }` 之后）加一行：

```ts
  // 用户在"啥都还没生成"时中断：账本不留痕，改让 web 把这段原始输入退回输入框供编辑（CC rewind）。
  | { type: 'restore-input'; text: string }
```

- [ ] **Step 2: typecheck + commit**

Run: `pnpm --filter @zuse/protocol exec tsc --noEmit`
Expected: 无错误。（若该 filter 名不符，用 `pnpm -F @zuse/protocol exec tsc --noEmit`；以实际输出为准。）

```bash
git add packages/protocol/src/index.ts
git commit -m "feat(protocol): add restore-input session event (interrupt rewind)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: server/SessionManager.ts —— 删回滚/重排 + empty-interrupt→restore-input

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: 先跑基线，记录条数**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts`
Expected: PASS（记基线条数）。

- [ ] **Step 2: 写失败测试**

在 `SessionManager.test.ts` 末尾新增（沿用文件既有 `makeManager`/`makeManagerFromClient`/`makeSettings`/`fakeClient`/`fakeSnapshotStore` 辅助；用 gatedClient 之类已有的可控客户端，或用一个 abort 版脚本客户端。下例用一个"吐半截文本后 abort 并 yield error"的本地客户端）：

```ts
describe('中途取消保留回合', () => {
  function abortingModel(controller: AbortController, pre: StreamEvent[]): ModelClient {
    return {
      getModel: () => 'fake-model',
      async *sendMessages(_m, _c, _t, signal) {
        for (const e of pre) yield e
        controller.abort()
        void signal
        yield { type: 'error', message: 'aborted', category: 'other' }
      },
    }
  }

  it('中断有生成物 → 账本保留该回合、不回滚 todos、emit aborted', async () => {
    const controller = new AbortController()
    const client = abortingModel(controller, [
      { type: 'message-start', id: 'm1', model: 'fake-model' },
      { type: 'text-delta', text: '半截' },
    ])
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(), settings: makeSettings(),
      systemPrompt: 'SYS', permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
    })
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))
    // 手动把 abort 接到 controller：mgr.interrupt() 用的是内部 controller，这里用注入客户端自己 abort。
    await mgr.submit('问题')
    // 该回合被保留在账本里（至少 user + assistant/标记），不是空。
    expect(mgr.getState().messages.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'aborted')).toBe(true)
  })

  it('啥都没生成就中断 → emit restore-input(text=原文)、账本不增', async () => {
    const controller = new AbortController()
    const client = abortingModel(controller, []) // 无任何流事件
    const mgr = new SessionManager({
      sessionId: 's1', cwd: '/work', client, registry: new ToolRegistry(), settings: makeSettings(),
      systemPrompt: 'SYS', permissionPolicy: { interactive: true, config: { defaultMode: 'default', allow: [], ask: [], deny: [] } },
      snapshotStore: fakeSnapshotStore(),
    })
    const events: SessionEvent[] = []
    mgr.subscribe((e) => events.push(e))
    await mgr.submit('原始输入')
    const restore = events.find((e) => e.type === 'restore-input')
    expect(restore).toEqual({ type: 'restore-input', text: '原始输入' })
    expect(mgr.getState().messages).toHaveLength(0)
  })
})
```

> 确认测试文件已 `import type { ModelClient, StreamEvent } from '@zuse/core'` 与 `import type { SessionEvent } from './events.js'`（若缺则补）。`getState().messages` 用既有投影取数器（若名字不同按真实 API 调整，例如 `getState().messageCount` / `projectMessages`）；实现子代理落地时以真实取数器为准。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts -t 中途取消`
Expected: FAIL —— 现状中断丢弃整回合（第一条账本为空）、且不 emit restore-input（第二条找不到）。

- [ ] **Step 4: 加 sawToolUse + empty-interrupt 判定 + emit restore-input**

在 submit 的事件循环上方（`let accumulated = ''`（:1007）、`let assistantStarted = false`（:1008）附近）加：

```ts
    let sawToolUse = false
```

在事件 switch 的 `case 'tool-use':`（:1082 附近，`this.emit({ type: 'tool-use', … })` 同处）置位：

```ts
          case 'tool-use':
            sawToolUse = true
            this.emit({ type: 'tool-use', id: event.id, name: event.name, input: event.input, invalid_args: event.invalid_args })
            break
```

在 `abortedMidTurn = controller.signal.aborted`（:1112）之后加 empty-interrupt 判定：

```ts
      abortedMidTurn = controller.signal.aborted
      // "啥都没生成"就中断：runAgent 侧也不提交（见 agent.ts 判据），这里把原始输入退回输入框（CC rewind）。
      const emptyInterrupt = controller.signal.aborted && accumulated === '' && !sawToolUse
```

在 catch 之后、finally 内 turn-end 之前（`if (!resent) this.emit({ type: 'turn-end' })`（:1207）之前，且在 epoch 守卫下）emit restore-input。因 `emptyInterrupt` 在 try 内声明，作用域不达 finally——改为在 try 块内、runAgent loop 之后紧跟 emit（此处仍在 turn 主体、epoch 未变）：

```ts
      // 紧接 abortedMidTurn / emptyInterrupt 计算之后：
      if (emptyInterrupt) this.emit({ type: 'restore-input', text })
```

> `text` 是 submit 的入参（用户原文，未加 userStamp）。empty-interrupt 时 runAgent 不提交（账本不增），故只需 emit 事件、无需再动账本。`'aborted'` 事件仍由 :1096/:1184 照常发。

- [ ] **Step 5: 删掉 abort 回滚与 steer 重排**

删 :1195-1204 整个 `if (abortedMidTurn && this.turnEpoch === epoch) { …todos/cwd 回滚… }` 块。

删 :1218-1220：

```ts
    if (abortedMidTurn && consumedThisTurn.length > 0) {
      this.steerQueue.unshift(...consumedThisTurn.map((text) => ({ text, echoed: true })))
    }
```

删 `consumedThisTurn`：:1020 的 `const consumedThisTurn: string[] = []` 与 consumeSteer 里 :1063 的 `consumedThisTurn.push(combined)` 那一行（保留同处的 `this.emit({ type: 'user-echo', … })` 与 return）。

- [ ] **Step 6: 清理 now-dead 字段（先 grep 确认无其它消费者）**

Run: `git grep -n "todosBeforeTurn\|cwdBeforeTurn\|abortedMidTurn" packages/server/src`
Expected: 除本文件的声明/赋值外无其它消费者。据结果：
- `todosBeforeTurn`（:214 声明、:858 赋值）与 `cwdBeforeTurn`（:221 声明、:859 赋值）删除（含赋值处两行）。
- `abortedMidTurn`（:1026 声明、:1112 赋值）：若删完回滚/重排后仅剩声明+赋值、无消费者，则一并删（emptyInterrupt 用的是 `controller.signal.aborted`，不依赖它）。若仍有消费者则保留。

> 注：`todosBeforeTurn`/`cwdBeforeTurn` 的注释块（:210-220 一带）随字段删除同步清理。若 grep 发现 reset()/其它路径引用它们，则**只删回滚逻辑、保留字段**，并在 commit message 注明。

- [ ] **Step 7: typecheck + 跑测试**

Run: `pnpm --filter @zouyj/zuse-server exec tsc --noEmit`
Expected: 无错误（若 `abortedMidTurn`/字段删后有"声明未使用"错误，说明还有残留引用没清或该保留——按 tsc 提示定）。

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts`
Expected: PASS —— 两条新用例过；基线其余条数保持。**特别关注**既有的 abort 相关用例：若原有测试断言"中断后 todos 回滚"或"折叠 steer 被重排"，这些行为已按设计移除，需**更新该测试的期望**为新行为（保留回合、不回滚、不重排），并在 commit message 说明这是设计变更而非回归。

- [ ] **Step 8: commit**

```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): preserve interrupted turn; drop todos/cwd rollback + steer requeue; restore-input on empty interrupt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: web reducer —— 中断标记渲染成系统提示

**Files:**
- Modify: `packages/web/src/state/reducer.ts`
- Test: `packages/web/src/state/reducer.test.ts`

- [ ] **Step 1: 写失败测试**

在 `reducer.test.ts` 加（沿用文件既有的 snapshot 构造辅助；下例直接构造一个含中断标记的 snapshot 消息数组，断言投影后是系统提示而非用户气泡）：

```ts
it('账本里的中断标记渲染成系统提示，不是用户气泡', () => {
  const snap = {
    sessionId: 's', isThinking: false, model: 'm', modelProviderId: 'p', cwd: '/w',
    totalUsage: undefined, contextTokens: undefined, contextWindow: undefined,
    todos: [], pendingPermissions: [], messageCount: 3,
    messages: [
      { role: 'user', ledgerIndex: 0, parts: [{ kind: 'text', text: 'q' }] },
      { role: 'assistant', ledgerIndex: 1, parts: [{ kind: 'text', text: 'half' }] },
      { role: 'user', ledgerIndex: 2, parts: [{ kind: 'text', text: '[Request interrupted by user]' }] },
    ],
  } as unknown as SessionSnapshot
  const s = reduce(initialState, { kind: 'server', msg: { type: 'snapshot', snapshot: snap } as ServerMessage })
  // 中断标记那条渲染成 system notice，而非 user 气泡
  const marker = s.messages.find((m) => m.role === 'system' && m.parts.some((p) => p.kind === 'text' && p.text === '已被用户中断'))
  expect(marker).toBeDefined()
  expect(s.messages.some((m) => m.role === 'user' && m.parts.some((p) => p.kind === 'text' && p.text.includes('[Request interrupted by user]')))).toBe(false)
})
```

> 若 `reduce`/`initialState`/snapshot 消息类型的确切构造方式与文件既有测试不同，按文件里已有的 snapshot 测试（如"reverted adds an info notice"附近）的构造方式对齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/web/src/state/reducer.test.ts -t 中断标记`
Expected: FAIL —— 现状把标记当普通 user 文本渲染成 user 气泡。

- [ ] **Step 3: 在 foldToolResults 后把标记转成系统提示**

在 `reducer.ts` 顶部加常量（与 core 一致；web 不能 value-import core，故本地声明并注释来源）：

```ts
// 与 packages/core/src/agent.ts 的中断标记保持一致（web 不能 value-import core，故本地复刻）。
const INTERRUPT_MARKERS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]']
```

在 `foldToolResults` 之后（或在其内产出 user 气泡处）加一个后处理：把"内容是中断标记"的 user 气泡替换成 system notice，并从 tool_result 载体消息的残余文本里剥掉标记。最小实现——改 `foldToolResults` 的 `rest` 处理分支：

```ts
      // Keep the user bubble only if it has real (non-tool-result) content; …
      if (rest.length) {
        // 中断标记：不作为 user 气泡，转成低调系统提示（对齐 'aborted' 的"已停止"）。
        const markerPart = rest.find((p) => p.kind === 'text' && INTERRUPT_MARKERS.includes(p.text))
        const realRest = rest.filter((p) => !(p.kind === 'text' && INTERRUPT_MARKERS.includes(p.text)))
        if (markerPart) out.push({ id: 'sys-int-' + out.length, role: 'system', parts: [{ kind: 'text', text: '已被用户中断' }], noticeKind: 'info' } as Hist)
        if (realRest.length) out.push({ ...m, parts: realRest })
      }
```

> `noticeKind` 复用现有 `'info'`（reducer withNotice 支持的集合）。`Hist` 类型已含可选 `noticeKind`？——当前 `Hist`（:86）没有 `noticeKind` 字段，而 AppState 的消息类型有（system notice 用）。核对 `types.ts` 里 AppState 消息/`Part` 的实际类型：若 `Hist` 与 AppState 消息类型不一致，给 `Hist` 加可选 `noticeKind?: 'info'|'warn'|'error'|'summary'|'compacting'|'help'` 以对齐（foldToolResults 的输出最终并进 `messages`）。实现子代理落地时以 `types.ts` 真实定义为准，保证 system notice 渲染路径（Message.tsx 现有 noticeKind 分支）能认这条。

- [ ] **Step 4: 跑测试确认通过 + 既有回归**

Run: `pnpm exec vitest run packages/web/src/state/reducer.test.ts`
Expected: PASS（新用例过；既有 snapshot/notice 用例不变）。

- [ ] **Step 5: typecheck + commit**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: 无错误。

```bash
git add packages/web/src/state/reducer.ts packages/web/src/state/reducer.test.ts
git commit -m "feat(web): render interrupt marker as a system notice, not a user bubble

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: web restore-input 接线 —— Composer 回填

**Files:**
- Modify: `packages/web/src/components/Composer.tsx`（ComposerHandle + restoreInput）
- Modify: `packages/web/src/state/store.tsx`（拦截 restore-input → pendingRestoreInput，镜像 pendingScrollTo）
- Modify: `packages/web/src/components/Shell.tsx`（useEffect：pendingRestoreInput → composerRef.restoreInput + clear）
- Test: `packages/web/src/components/Composer.test.tsx`

- [ ] **Step 1: Composer 加 restoreInput（写失败测试）**

在 `Composer.test.tsx` 加（沿用既有渲染 + ref 断言方式）：

```ts
it('restoreInput 把文本填回空输入框', () => {
  const ref = createRef<ComposerHandle>()
  render(<Composer ref={ref} thinking={false} onSend={() => {}} onStop={() => {}} />)
  act(() => { ref.current!.restoreInput('回退的原文') })
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(ta.value).toBe('回退的原文')
})

it('restoreInput 不覆盖已有输入', () => {
  const ref = createRef<ComposerHandle>()
  render(<Composer ref={ref} thinking={false} onSend={() => {}} onStop={() => {}} />)
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: '新输入' } })
  act(() => { ref.current!.restoreInput('回退的原文') })
  expect(ta.value).toBe('新输入')
})
```

> 依 Composer.test.tsx 既有 import（`render`/`screen`/`act`/`fireEvent`/`createRef`）补齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/web/src/components/Composer.test.tsx -t restoreInput`
Expected: FAIL —— `ComposerHandle` 无 `restoreInput`。

- [ ] **Step 3: 实现 Composer.restoreInput**

改 `ComposerHandle`（:52）：

```ts
export interface ComposerHandle { addImages: (files: File[]) => void; addFiles: (files: File[]) => void; restoreInput: (text: string) => void }
```

改 `useImperativeHandle`（:268）：

```ts
  useImperativeHandle(ref, () => ({
    addImages: stage,
    addFiles: stageFiles,
    restoreInput: (text: string) => {
      // 仅在输入框为空时回填，避免踩掉用户已敲的新内容（rewind 是一种便利，不是强制）。
      setValue((cur) => (cur.trim() === '' ? text : cur))
      taRef.current?.focus()
    },
  }))
```

- [ ] **Step 4: 跑 Composer 测试通过**

Run: `pnpm exec vitest run packages/web/src/components/Composer.test.tsx`
Expected: PASS（两条新用例过；既有不变）。

- [ ] **Step 5: store 拦截 restore-input（镜像 pendingScrollTo）**

在 `store.tsx`：

- context 类型（`pendingScrollTo: string | null` 附近，:29-31）加：

```ts
  pendingRestoreInput: string | null
  clearRestoreInput: () => void
```

- 状态（:45 `const [pendingScrollTo, setPendingScrollTo] = useState<string | null>(null)` 附近）加：

```ts
  const [pendingRestoreInput, setPendingRestoreInput] = useState<string | null>(null)
```

- onMessage（:73-100，`dispatch({ kind: 'server', msg: m })` 之后）加拦截：

```ts
        if (m.type === 'event' && m.event.type === 'restore-input') setPendingRestoreInput(m.event.text)
```

- Provider value（:185）加：

```ts
        pendingRestoreInput, clearRestoreInput: () => setPendingRestoreInput(null),
```

- [ ] **Step 6: Shell useEffect 消费**

在 `Shell.tsx`：`useStore()` 解构（:43）加 `pendingRestoreInput, clearRestoreInput`；加一个 effect（放在其它 useEffect 附近，如 :193 一带）：

```ts
  useEffect(() => {
    if (pendingRestoreInput !== null) {
      composerRef.current?.restoreInput(pendingRestoreInput)
      clearRestoreInput()
    }
  }, [pendingRestoreInput, clearRestoreInput])
```

- [ ] **Step 7: typecheck + 全量 web 测试**

Run: `pnpm --filter @zuse/web exec tsc --noEmit`
Expected: 无错误。

Run: `pnpm exec vitest run packages/web`
Expected: PASS。

- [ ] **Step 8: commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/components/Composer.test.tsx packages/web/src/state/store.tsx packages/web/src/components/Shell.tsx
git commit -m "feat(web): restore interrupted input to the composer (rewind nicety)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage：**
- §A core commit-instead-of-discard + 两常量 + 两中断点 + 有生成物判据 → Task 1 ✓
- §A 合成悬空 tool_use 结果 + for-tool-use 标记 → Task 1 Step 3/6 ✓
- §B empty-interrupt → 不提交（core）+ restore-input（server）→ Task 1 Step 1(空用例) + Task 3 Step 4 ✓
- §B 协议 restore-input → Task 2 ✓
- §B web Composer 回填（不覆盖已有输入）→ Task 5 ✓
- §C 删 todos/cwd 回滚 + steer 重排 + 死字段 → Task 3 Step 5/6 ✓
- §C sawToolUse 判定、保留 'aborted' → Task 3 Step 4 ✓
- §D web 标记渲染成系统提示、不作 user 气泡、tool 卡不含标记 → Task 4 ✓
- §E 子代理免特判（改在 runAgent）→ Task 1 天然覆盖，无独立 task（设计如此）✓
- 测试矩阵（core 6 类 / server / web）→ 各 task 测试步骤 ✓
- 门禁四包 tsc + vitest + Playwright → 由 /ship 阶段执行（本计划各 task 内已含分包 tsc/vitest）✓

**2. Placeholder scan：** 无 TBD/TODO；改代码步骤均给完整原文→改后码；测试给完整代码。少数"以真实取数器/类型为准"是**核对指令**（要求实现时按真码对齐），非占位。✓

**3. Type consistency：** `finalizeInterruptedTurn`/`commitStaged` 签名在 Task 1 内自洽；`INTERRUPT_MARKER`/`INTERRUPT_MARKER_TOOL_USE`/`INTERRUPTED_TOOL_RESULT`（core）与 web 的 `INTERRUPT_MARKERS`（复刻同串）一致；`restore-input` 事件形状（`{type, text}`）在 protocol/server/store 三处一致；`ComposerHandle.restoreInput(text)` 在 Composer/Shell 一致。✓
