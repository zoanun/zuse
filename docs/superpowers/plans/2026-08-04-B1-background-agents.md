# B1 后台子代理接线 + 待投递泛化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `AgentToolDeps.onBackground` 接进 server 会话，并把「自唤醒」与「在飞的后台子代理」统一成一张「待投递」注册表，让静默判据与生命周期作废各只有一处。

**Architecture:** `SessionManager` 用 `Map<symbol, PendingInjection>` 取代 B2 的单槽 `wakeupTimer` 字段；`waitUntilQuiescent` 改判 `hasPendingInjection()`；`reset()` 与 `SessionService.release()/delete()` 改调 `cancelAllInjections()`。`AgentToolDeps.onBackground` 改成「启动时触发、返回结果回调」的签名，这样调用方能看见「有子代理在飞」——那正是静默判据唯一需要的信息。

**Tech Stack:** TypeScript、Vitest 2.1.9（`isolate: true`, `pool: "forks"`）、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-04-B1-background-agents-design.md`

**依赖顺序：** Task 1（tools 改签名）→ Task 2（tui 跟签名）必须先做，否则 typecheck 红。Task 3 → 4 → 5 是 server 内部，按序。Task 6 是门禁。

---

### Task 1: `packages/tools` — `onBackground` 改签名

**Files:**
- Modify: `packages/tools/src/agent-tool.ts:11-20`（`AgentToolDeps`）、`packages/tools/src/agent-tool.ts:229-234`（后台分支）
- Test: `packages/tools/src/agent-tool.test.ts:520` 起的后台用例

- [ ] **Step 1: 改 `AgentToolDeps.onBackground` 的声明**

把 `packages/tools/src/agent-tool.ts` 中这一行（现为第 18-19 行）：

```ts
  /** 后台 Agent 完成后的通知回调。传入 description + 结果文本。 */
  onBackground?: (description: string, result: string) => void
```

替换为：

```ts
  /**
   * 后台 Agent **启动时**触发，返回「完成时调用」的结果回调。
   *
   * 之所以是「启动时给回调」而不是「完成时给结果」：调用方需要知道有 Agent 在飞
   * （会话静默判据、生命周期作废），而只有启动钩子能提供这个信息；两个并列的钩子
   * 则无法把启动与完成对应起来（description 不唯一，同名子代理无法区分）。
   *
   * 可以 throw 来拒绝启动（如并发上限）——core 的 runOneTool 会转成 isError 回喂模型。
   */
  onBackground?: (description: string) => (result: string) => void
```

- [ ] **Step 2: 改后台分支的调用点**

把 `packages/tools/src/agent-tool.ts` 现有的：

```ts
      if (runInBackground === true && deps.onBackground) {
        executeSubAgent().then(
          (result) => deps.onBackground!(label, result),
          () => deps.onBackground!(label, '(sub-agent background execution failed)'),
        )
        return { output: `Sub-agent "${label}" launched in background. You will be notified when it finishes.` }
      }
```

替换为：

```ts
      if (runInBackground === true && deps.onBackground) {
        // 启动钩子先跑：它可能 throw（并发上限），此时不该已经把子代理放出去。
        const finish = deps.onBackground(label)
        void executeSubAgent().then(
          (result) => finish(result),
          () => finish('(sub-agent background execution failed)'),
        )
        return { output: `Sub-agent "${label}" launched in background. You will be notified when it finishes.` }
      }
```

- [ ] **Step 3: 改既有测试到新签名**

`packages/tools/src/agent-tool.test.ts` 现有用例 `returns immediately in background mode and calls onBackground when done` 里的这一行：

```ts
      onBackground: (desc, result) => { bgResult = { desc, result } },
```

替换为：

```ts
      onBackground: (desc) => (result) => { bgResult = { desc, result } },
```

用例其余部分（含末尾的 `await new Promise((r) => setTimeout(r, 50))` 与后续断言）不动。

- [ ] **Step 4: 加「启动时就被调用」的测试**

在同一个 `── Background Agent ──` 段落内追加：

```ts
  it('后台模式：onBackground 在启动时（而非完成时）被调用', async () => {
    let startedWith: string | null = null
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'bg-done' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => client,
      settings: PERMISSIVE,
      getSystemPrompt: () => 'sys',
      onBackground: (desc) => { startedWith = desc; return () => {} },
    })

    await tool.run(
      { prompt: 'bg task', description: 'start probe', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    // run() 一返回就该已经登记 —— 不 sleep，正是这条用例的意义（旧签名下这里必然是 null）。
    expect(startedWith).toBe('start probe')
  })

  it('后台模式：启动钩子 throw（并发上限）→ run 抛出，子代理不被放出去', async () => {
    let launched = false
    const client = fakeClient([
      [
        { type: 'text-delta', text: 'should not run' },
        { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE },
      ],
    ])

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => { launched = true; return client },
      settings: PERMISSIVE,
      getSystemPrompt: () => 'sys',
      onBackground: () => { throw new Error('额度用完') },
    })

    await expect(
      tool.run(
        { prompt: 'bg task', description: 'over cap', runInBackground: true },
        { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
      ),
    ).rejects.toThrow('额度用完')

    await new Promise((r) => setTimeout(r, 30))
    expect(launched).toBe(false)
  })

  it('后台模式：子代理失败 → 结果回调收到失败文本', async () => {
    let got: string | null = null

    const tool = createAgentTool({
      registry: new ToolRegistry(),
      getClient: () => fakeClient([]),
      settings: PERMISSIVE,
      // 失败注入点：getSystemPrompt 在 executeSubAgent 的 try 内被调用
      // （agent-tool.ts 的 `const sysPrompt = deps.getSystemPrompt() + SUB_AGENT_SUFFIX`），
      // 抛出后被 catch 清理 worktree 再原样 rethrow → 后台 promise reject。
      // 不要用 fakeClient([])（空脚本）来制造失败：无事件时 runAgent 正常结束，
      // executeSubAgent 返回 '(sub-agent produced no text output)'，根本不 reject。
      getSystemPrompt: () => { throw new Error('boom') },
      onBackground: () => (result) => { got = result },
    })

    await tool.run(
      { prompt: 'bg task', description: 'fail probe', runInBackground: true },
      { cwd: '.', signal: new AbortController().signal, tracker: { markRead() {}, getFingerprint: () => undefined } },
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(got).toBe('(sub-agent background execution failed)')
  })
```

**已核实**（不要再改成别的写法）：`packages/tools/src/agent-tool.test.ts:12-21` 的 `fakeClient` 在脚本耗尽时 `scripts[i++] ?? []`，即空脚本只是不产事件、**不抛**，所以 `fakeClient([])` 无法制造失败；`parseModelSpec` 的非法 model 走的是 `return { output, isError: true }`（`agent-tool.ts:117`）且发生在后台分支**之前**，同样不行。唯一在 `executeSubAgent` 的 try 内、且完全受测试控制的抛出点就是 `deps.getSystemPrompt()`。

- [ ] **Step 5: 跑测试**

```
pnpm --filter @zuse/tools exec vitest run src/agent-tool.test.ts
```

预期：全绿。（`packages/tools/src/bash.test.ts` 的 9 条 spawned-shell PATH 失败是既存环境性问题，本步不跑那个文件。）

- [ ] **Step 6: typecheck**

```
pnpm --filter @zuse/tools exec tsc --noEmit
```

预期：EXIT 0。

- [ ] **Step 7: 提交**

```
git add packages/tools/src/agent-tool.ts packages/tools/src/agent-tool.test.ts
git commit -m "refactor(tools): onBackground 改为启动时触发并返回结果回调

调用方需要知道「有后台 Agent 在飞」——会话静默判据与生命周期作废都
依赖这个信息，而旧签名只在完成时触发，看不见启动。并列加一个启动钩子
则无法把启动与完成对应起来（description 不唯一）。

启动钩子可 throw 以拒绝启动（并发上限），此时子代理不被放出去。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `packages/tui` — 跟上新签名

**Files:**
- Modify: `packages/tui/src/hooks/useConversation.ts:258-261`

- [ ] **Step 1: 改调用点**

把 `packages/tui/src/hooks/useConversation.ts` 中：

```ts
        onBackground: (desc, result) => {
          sendMessageRef.current?.(`🔔 后台 Agent "${desc}" 完成:\n${result}`)
        },
```

替换为：

```ts
        onBackground: (desc) => (result) => {
          sendMessageRef.current?.(`🔔 后台 Agent "${desc}" 完成:\n${result}`)
        },
```

行为等价：TUI 不关心「在飞」这件事，只是把结果回调 curry 出来。

- [ ] **Step 2: typecheck**

```
pnpm --filter @zuse/tui exec tsc --noEmit
```

预期：EXIT 0。

- [ ] **Step 3: 跑 TUI 测试**

```
pnpm --filter @zuse/tui test
```

预期：全绿（若有既存失败，如实记录其文件名与条数，不要归咎本次改动 —— 先 `git stash` 跑一次对照再下结论）。

- [ ] **Step 4: 提交**

```
git add packages/tui/src/hooks/useConversation.ts
git commit -m "refactor(tui): 跟上 onBackground 新签名（行为等价）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SessionManager` — 待投递注册表取代单槽 `wakeupTimer`

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: 加类型与常量**

在 `packages/server/src/session/SessionManager.ts` 的 `QUIESCENCE_POLL_MAX_MS`（现第 76 行）之后追加：

```ts
/** 同一会话最多同时在飞的后台 Agent 数。超限时启动钩子 throw，如实回喂模型。 */
const MAX_BACKGROUND_AGENTS = 5

/** 待投递的种类。 */
type InjectionKind = 'wakeup' | 'background'

/**
 * 待投递：将来会往本会话推一条消息的东西（自唤醒 B2、在飞的后台 Agent B1）。
 * 从会话的视角这两者是同一件事，所以合成一张表而不是每类一个字段 ——
 * 静默判据（hasPendingInjection）与生命周期作废（cancelAllInjections）各只有一处，
 * 加第三种待投递时不可能漏掉其中之一。
 */
interface PendingInjection {
  kind: InjectionKind
  /** 生命周期作废时调用。wakeup = clearTimeout；background 刻意为空（见 spec §5）。 */
  cancel: () => void
}
```

- [ ] **Step 2: 换字段**

把现有的（第 227-228 行）：

```ts
  /** 待触发的自唤醒定时器（ScheduleWakeup，B2）。同时至多一个。 */
  private wakeupTimer: ReturnType<typeof setTimeout> | null = null
```

替换为：

```ts
  /** 待投递注册表（自唤醒 + 在飞的后台 Agent）。见 PendingInjection 的注释。 */
  private pendingInjections = new Map<symbol, PendingInjection>()
```

`wakeupDeadline` 字段保持不变。

- [ ] **Step 3: 重写 `scheduleWakeup` / `cancelWakeup` / `hasPendingWakeup`，并新增三个方法**

把现有的 `scheduleWakeup`（其函数注释保留原样不动）函数体替换为：

```ts
  scheduleWakeup(delayMs: number, message: string): boolean {
    if (this.wakeupDeadline !== null && Date.now() + delayMs > this.wakeupDeadline) return false
    this.cancelWakeup()
    const token = Symbol('wakeup')
    const timer = setTimeout(() => {
      // 先摘登记再投递：两件事在同一个同步块内完成，中间没有 await，所以
      // waitUntilQuiescent（轮询，每次检查之间必有 await）观测不到「已摘登记
      // 但回合尚未开始」的假静默窗口 —— submit() 的 isThinking = true 也是同步的
      // （本文件 submit 开头，第一个 await 之前），接得上。
      this.pendingInjections.delete(token)
      // 前缀沿用 TUI：一眼能看出这轮不是人发的。
      deliverToSession(this, `⏰ 定时唤醒: ${message}`, {
        onError: (m) => this.emit({ type: 'warning', message: `定时唤醒投递失败:${m}` }),
      })
    }, delayMs)
    // daemon 不该因为一个待触发的唤醒而无法退出。
    timer.unref?.()
    this.pendingInjections.set(token, { kind: 'wakeup', cancel: () => clearTimeout(timer) })
    return true
  }
```

把现有的 `cancelWakeup()` 整体（含其注释）替换为：

```ts
  /**
   * 仅作废自唤醒。唯一调用点是 scheduleWakeup 的「新的顶掉旧的」—— 它只该顶掉唤醒，
   * 不该顺手清掉在飞的后台 Agent 登记。会话生命周期上的作废走 cancelAllInjections()。
   */
  cancelWakeup(): void {
    for (const [token, inj] of this.pendingInjections) {
      if (inj.kind !== 'wakeup') continue
      inj.cancel()
      this.pendingInjections.delete(token)
    }
  }

  /**
   * 作废**所有**待投递。调用点：本类的 reset()（开新对话）与 SessionService 的
   * release()/delete()（会话离开 registry —— 那些产出既不落盘也送不到任何客户端）。
   */
  cancelAllInjections(): void {
    for (const inj of this.pendingInjections.values()) inj.cancel()
    this.pendingInjections.clear()
  }

  /** 有任何待投递？—— waitUntilQuiescent 的静默判据之一。 */
  hasPendingInjection(): boolean {
    return this.pendingInjections.size > 0
  }

  private countInjections(kind: InjectionKind): number {
    let n = 0
    for (const inj of this.pendingInjections.values()) if (inj.kind === kind) n++
    return n
  }
```

把现有的 `hasPendingWakeup()` 函数体替换为：

```ts
  /** 有自唤醒待触发？（单槽语义的观测点；静默判据用 hasPendingInjection。） */
  hasPendingWakeup(): boolean {
    return this.countInjections('wakeup') > 0
  }
```

- [ ] **Step 4: `waitUntilQuiescent` 改判据**

把该方法内的：

```ts
      if (!this.isBusy() && !this.hasPendingWakeup()) return
```

替换为：

```ts
      if (!this.isBusy() && !this.hasPendingInjection()) return
```

并把该方法的 doc 注释首行：

```
   * 等到会话静默：当前无回合在跑 **且** 无待触发的自唤醒；或越过 deadline。
```

改为：

```
   * 等到会话静默：当前无回合在跑 **且** 无待投递（自唤醒、在飞的后台 Agent）；或越过 deadline。
```

- [ ] **Step 5: `reset()` 改调 `cancelAllInjections()`**

把 `reset()` 中的：

```ts
    this.cancelWakeup()
    this.wakeupDeadline = null
```

替换为：

```ts
    this.cancelAllInjections()
    this.wakeupDeadline = null
```

并把其上方的注释（现为「唤醒的定时器与额度都要清：…」那段）首行改为：

```ts
    // 待投递与唤醒额度都要清：待投递不清，旧会话的自唤醒/后台 Agent 产出会打到这个
```

其余两行保持原样。

- [ ] **Step 6: 跑既有测试确认 B2 行为未回归**

```
pnpm exec vitest run packages/server/src/session/SessionManager.test.ts
```

预期：全绿（B2 那 5 条唤醒用例 `hasPendingWakeup` 断言应原样通过 —— 这正是本步要证明的：泛化没改变单槽语义）。

- [ ] **Step 7: 提交**

```
git add packages/server/src/session/SessionManager.ts
git commit -m "refactor(server): 单槽 wakeupTimer 泛化为待投递注册表

从会话视角「自唤醒」与「在飞的后台 Agent」是同一件事：将来会往本会话
推一条消息的东西。合成一张表后，静默判据与生命周期作废各只有一处，
加第三种待投递时不可能漏掉其一。

waitUntilQuiescent 改判 hasPendingInjection()；reset() 改调
cancelAllInjections()；cancelWakeup() 收窄为「只顶唤醒」，因为
scheduleWakeup 的新顶旧不该清掉在飞的后台 Agent 登记。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `startBackgroundAgent` + 能力接线

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`（新增方法 + 能力上下文加字段）
- Modify: `packages/server/src/session/sessionCapabilities.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/session/SessionManager.test.ts` 末尾追加一个新 describe。**先读该文件顶部的 manager 工厂**（B2 那轮踩过：工厂返回的是 `{ mgr }` 而不是 `mgr`），按它实际的返回形状写：

```ts
describe('后台 Agent（B1）', () => {
  it('完成回调在空闲时驱动一轮（submit + echo）', async () => {
    const { mgr } = makeManager()
    const finish = mgr.startBackgroundAgent('查资料')
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)

    finish('结果文本')

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toContain('🔔 后台 Agent "查资料" 完成')
    expect(submit.mock.calls[0][0]).toContain('结果文本')
  })

  it('登记期间 hasPendingInjection 为 true，完成后为 false', () => {
    const { mgr } = makeManager()
    expect(mgr.hasPendingInjection()).toBe(false)
    const finish = mgr.startBackgroundAgent('活儿')
    expect(mgr.hasPendingInjection()).toBe(true)
    vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    finish('done')
    expect(mgr.hasPendingInjection()).toBe(false)
  })

  it('reset() 之后完成回调不投递（口子 1：/clear 不该收到旧会话的产出）', () => {
    const { mgr } = makeManager()
    const finish = mgr.startBackgroundAgent('活儿')
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    const steer = vi.spyOn(mgr, 'steer').mockImplementation(() => {})

    mgr.reset()
    finish('本该被丢弃的结果')

    expect(submit).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
  })

  it('cancelAllInjections() 之后完成回调不投递（口子 2：release/delete）', () => {
    const { mgr } = makeManager()
    const finish = mgr.startBackgroundAgent('活儿')
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)

    mgr.cancelAllInjections()
    finish('本该被丢弃的结果')

    expect(submit).not.toHaveBeenCalled()
  })

  it('cancelWakeup() 不误伤后台登记（单槽语义只管唤醒）', () => {
    const { mgr } = makeManager()
    mgr.startBackgroundAgent('活儿')
    mgr.cancelWakeup()
    expect(mgr.hasPendingInjection()).toBe(true)
  })

  it('并发上限：第 6 个 throw，且消息带上限数字', () => {
    const { mgr } = makeManager()
    for (let i = 0; i < 5; i++) mgr.startBackgroundAgent(`活儿${i}`)
    expect(() => mgr.startBackgroundAgent('第六个')).toThrow(/5/)
  })

  it('waitUntilQuiescent：只有后台登记（无回合、无唤醒）时也不返回', async () => {
    const { mgr } = makeManager()
    const finish = mgr.startBackgroundAgent('活儿')
    vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)

    let settled = false
    const p = mgr.waitUntilQuiescent(Date.now() + 5000).then(() => { settled = true })

    await new Promise((r) => setTimeout(r, 400))
    expect(settled).toBe(false)   // 后台还在飞 —— 不许静默

    finish('done')
    await p
    expect(settled).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
pnpm exec vitest run packages/server/src/session/SessionManager.test.ts -t "后台 Agent"
```

预期：FAIL —— `mgr.startBackgroundAgent is not a function`。

- [ ] **Step 3: 实现 `startBackgroundAgent`**

在 `packages/server/src/session/SessionManager.ts` 的 `scheduleWakeup` 之前插入：

```ts
  /**
   * 登记一个后台 Agent（B1），返回「完成时调用」的结果回调。
   *
   * 登记的意义有二：让会话静默判据（waitUntilQuiescent → cron 定稿 run 记录）看得见
   * 它在飞；以及让生命周期作废（reset/release/delete）能丢掉它的产出。
   *
   * 超并发上限时 **throw** —— 调用方（Agent 工具的后台分支）会把它冒给 core 的
   * runOneTool，转成 isError 回喂模型，与 B2 唤醒链到顶时同一套路数：如实告知，不静默吞。
   */
  startBackgroundAgent(description: string): (result: string) => void {
    if (this.countInjections('background') >= MAX_BACKGROUND_AGENTS) {
      throw new Error(`本会话已有 ${MAX_BACKGROUND_AGENTS} 个后台 Agent 在跑，等一个完成再派新的。`)
    }
    const token = Symbol('background')
    // cancel 刻意为空：按设计只丢弃投递、不中止在飞的子代理 —— 真中止要把可取消句柄
    // 从 packages/tools（TUI 与 server 共用）一路传出来，而子代理自带 10 轮上限，不值。
    this.pendingInjections.set(token, { kind: 'background', cancel: () => {} })
    return (result: string) => {
      // 先摘登记再投递，同 scheduleWakeup 的到点回调（那里写了为什么这样安全）。
      if (!this.pendingInjections.delete(token)) return  // 已被作废：产出无处可去
      deliverToSession(this, `🔔 后台 Agent "${description}" 完成:\n${result}`, {
        onError: (m) => this.emit({ type: 'warning', message: `后台 Agent 通知投递失败:${m}` }),
      })
    }
  }
```

- [ ] **Step 4: 能力上下文加字段**

在 `packages/server/src/session/sessionCapabilities.ts` 的 `SessionCapabilityContext` 中，`scheduleWakeup` 字段之后追加：

```ts
  /**
   * 登记一个后台 Agent（B1），返回完成回调。超并发上限时 throw。
   * 与 scheduleWakeup 同形：暴露的是「登记」而非「投递」——到点怎么投（忙则 steer /
   * 闲则 submit）是 SessionManager 的内部细节。
   */
  startBackgroundAgent: (description: string) => (result: string) => void
```

- [ ] **Step 5: 接进工具清单**

把 `packages/server/src/session/sessionCapabilities.ts` 中：

```ts
  // ctx supplies exactly AgentToolDeps' fields (plus setTodos, which createAgentTool ignores).
  (ctx) => createAgentTool(ctx),
```

替换为：

```ts
  // ctx 是能力面，字段名按会话侧的含义取；这里显式映射到 AgentToolDeps 的对应字段。
  // （ctx 的其余字段正好覆盖 AgentToolDeps 所需；多出来的 setTodos/scheduleWakeup 被忽略。）
  (ctx) => createAgentTool({ ...ctx, onBackground: ctx.startBackgroundAgent }),
```

- [ ] **Step 6: 在 `SessionManager` 构造里填上该字段**

把 `packages/server/src/session/SessionManager.ts` 的能力上下文字面量中：

```ts
      scheduleWakeup: (delayMs, message) => this.scheduleWakeup(delayMs, message),
```

之后追加一行：

```ts
      startBackgroundAgent: (description) => this.startBackgroundAgent(description),
```

- [ ] **Step 7: 跑测试**

```
pnpm exec vitest run packages/server/src/session/SessionManager.test.ts
```

预期：全绿，含 Step 1 的 7 条新用例。

- [ ] **Step 8: 变异检验（必做）**

临时把 `startBackgroundAgent` 返回的回调里的

```ts
      if (!this.pendingInjections.delete(token)) return
```

改成

```ts
      this.pendingInjections.delete(token)
```

重跑上面的命令，**确认「reset() 之后不投递」与「cancelAllInjections() 之后不投递」两条变红**。看到变红后把代码改回来再重跑一次确认全绿。若没变红，说明测试是假保障，必须重写测试而不是放行。

- [ ] **Step 9: typecheck + 提交**

```
pnpm --filter @zuse/server exec tsc --noEmit
```

```
git add packages/server/src/session/SessionManager.ts packages/server/src/session/sessionCapabilities.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): 接线后台子代理完成通知（B1）

server 端此前从未接 onBackground —— 模型被工具描述告知「会收到完成通知」，
实际同步阻塞跑完且永远等不到。现登记进待投递表，到点复用 deliverToSession
（忙则折进当前回合，闲则起独立回合）。

并发封顶 5 个，超限 throw 让 runOneTool 转 isError 如实回喂模型。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `SessionService.release()` 作废全部待投递

**Files:**
- Modify: `packages/server/src/session/SessionService.ts:198-207`
- Test: `packages/server/src/session/SessionService.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/session/SessionService.test.ts` 中追加。**该文件没有 `makeService` 工厂**（已核实）——它每条用例直接 `new SessionService({...})`，配 `tempDir()` 与 `fakeCreateSessionFactory()`（定义在该文件第 41-61 行）。照这个样子写：

```ts
  it('release() 作废后台 Agent 登记：其完成回调不再驱动回合（口子 2）', async () => {
    const dir = join(tempDir(), 'web-sessions')
    const svc = new SessionService({ dir, cwd: '/work', createSession: fakeCreateSessionFactory() })

    const { id } = await svc.create()
    const mgr = (await svc.getOrLoad(id))!

    const finish = mgr.startBackgroundAgent('活儿')
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)

    svc.release(id)
    finish('本该被丢弃的结果')

    expect(submit).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: 跑测试确认失败**

```
pnpm exec vitest run packages/server/src/session/SessionService.test.ts -t "release() 作废后台"
```

预期：FAIL —— `submit` 被调用了 1 次（因为 `release()` 现在只 `cancelWakeup()`）。

- [ ] **Step 3: 实现**

把 `packages/server/src/session/SessionService.ts` 的 `release()` 中：

```ts
    // 会话即将离开 registry：待触发的自唤醒必须一起取消。否则它到点会驱动一整轮
    // 既不落盘（autosave 已退订）也送不到任何客户端（无订阅者）的回合。
    // 这也是内存上的承重点：定时器闭包捕获着整个 manager，clearTimeout 之后才可回收。
    this.registry.get(id)?.cancelWakeup()
```

替换为：

```ts
    // 会话即将离开 registry：所有待投递（自唤醒、在飞的后台 Agent）必须一起作废。
    // 否则它们到点会驱动一整轮既不落盘（autosave 已退订）也送不到任何客户端
    // （无订阅者）的回合。
    // 这也是内存上的承重点：定时器闭包捕获着整个 manager，clearTimeout 之后才可回收。
    this.registry.get(id)?.cancelAllInjections()
```

`delete()` 不用改 —— 它已经委托给 `release()`。

- [ ] **Step 4: 跑测试**

```
pnpm exec vitest run packages/server/src/session/SessionService.test.ts
```

预期：全绿。（该文件在高负载下有既存 flake —— 若有失败，隔离重跑该条确认，并在报告中如实标注。）

- [ ] **Step 5: 提交**

```
git add packages/server/src/session/SessionService.ts packages/server/src/session/SessionService.test.ts
git commit -m "fix(server): release() 作废全部待投递，不只是自唤醒

会话离开 registry 后，在飞的后台 Agent 完成时会往一个既不落盘（autosave
已退订）也无任何订阅者的 manager 投递，驱动一整轮纯浪费的回合。

delete() 无需改动 —— 它已委托 release()。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 验证门禁

不写新代码，只取证。**每条结论都必须来自实际命令输出**，不得凭记忆。

- [ ] **Step 1: 三包 typecheck**

```
pnpm --filter @zuse/tools exec tsc --noEmit
pnpm --filter @zuse/tui exec tsc --noEmit
pnpm --filter @zuse/server exec tsc --noEmit
```

三条都要 EXIT 0。

- [ ] **Step 2: 受影响套件**

```
pnpm exec vitest run packages/server/src/session packages/server/src/cron
pnpm --filter @zuse/tools exec vitest run src/agent-tool.test.ts
```

记录通过/失败条数。既存的环境性失败（`packages/tools/src/bash.test.ts` 的 spawned-shell PATH、`SessionService.test.ts`/`wsServer.test.ts` 的高负载 flake）可以如实标注并excuse，但**必须先切到 master 跑同一条对照**才能下「既存」的结论。

- [ ] **Step 3: cron 顺序不回归**

```
pnpm exec vitest run packages/server/src/cron/CronScheduler.test.ts
```

预期全绿 —— 特别是 B2 留下的那条「success 记录必须晚于唤醒链静默」。

- [ ] **Step 4: 真 daemon 端到端**

按 `/restart` 重启 daemon（`ZUSE_WEBDIR` 不要传），登录 Web UI（口令 `zuonaok`），让模型用 `Agent` 工具带 `run_in_background: true` 派一个能跑几十秒的子代理，确认：

1. 工具立刻返回 `launched in background`，主回合**不被阻塞**（模型能继续说话）；
2. 子代理完成后出现一条 `🔔 后台 Agent "…" 完成:` 的投递；
3. 若投递时主回合仍在跑，它显示为「↪ 插话」而非独立气泡。

检测第 2 条时**不要**去匹配自己 prompt 里的字样（B2 那轮踩过这个假阳性）——数 `🔔 后台 Agent` 的出现次数。

- [ ] **Step 5: 汇报**

给出：三条 typecheck 的 EXIT、各套件的通过条数、变异检验的结果、端到端的实际观察。不要写「应该没问题」这类没有输出支撑的话。
