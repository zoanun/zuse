# B1 后台子代理接线 + 待投递（pending injection）泛化 — 设计

日期：2026-08-04
分支：`b1-background-agents`
前置：B2（ScheduleWakeup 接线，`ccb97c5`）——本设计直接建立在它抽出的 `deliverToSession` 与「静默判据」之上。

## 1. 问题

`AgentToolDeps.onBackground` 在 server 端**从未接线**。取证：

```
packages/tools/src/agent-tool.ts:19       声明
packages/tools/src/agent-tool.ts:229      使用
packages/tui/src/hooks/useConversation.ts:259   TUI 接了
```

`packages/server` 一处都没有。而 `agent-tool.ts:229` 的分支条件是

```ts
if (runInBackground === true && deps.onBackground) {
```

缺 dep 就落到下面的 `return { output: await executeSubAgent() }` —— **同步阻塞跑完**。

这不只是「功能没做」，而是**模型被告知了一件假事**。工具描述（`agent-tool.ts:40`）写着：

> For background agents: do NOT poll or sleep for status — you will be notified automatically when they finish.

Web 上模型据此以为自己派出了后台任务，实际整个回合卡在那里等，也永远等不到那条通知。

## 2. 为什么不能裸接线

把 `onBackground` 塞进能力上下文就完事 —— 这会复制出 B2 专门要防的那类 bug。三个口子：

**口子 1：`/clear` 把失败通知打进新会话。**
`agent-tool.ts:229-233` 的 rejection 分支**照样调 `onBackground`**（喂 `'(sub-agent background execution failed)'`）。而 `reset()` 第一件事是 `interrupt()` → `SessionManager.ts:587` `this.abort.abort()` → 后台子代理用的正是 `ctx.signal`＝这个 controller → 被中止 → 失败文本投进那个刚清空的新会话。

**口子 2：`release()`/`delete()` 不中止，只取消唤醒。**
`SessionService.ts:198-207` 只有 `cancelWakeup()` + 退订 + `registry.remove`。信号没 abort → 子代理继续跑完 → 往一个已离开 registry 的 manager 投递 → `submit()` 驱动一整轮**既不落盘（autosave 已退订）也没有任何订阅者**的回合。

**口子 3：cron 提前定稿。**
`waitUntilQuiescent` 的判据是 `!isBusy() && !hasPendingWakeup()`。在飞的后台子代理两者都不是 → `fire()` 会在它还跑着时写完 run 记录并 `release()`，踩中口子 2。

一个反直觉的好消息：正常回合结束只置 `this.abort = null`（`SessionManager.ts:1202/1236`）、**不 abort**，所以后台子代理能正常活过回合边界。机制本身是通的，缺的只是生命周期约束。

## 3. 核心抽象：待投递（pending injection）

从会话的视角，「自唤醒」和「在飞的后台子代理」是同一件事：**将来会往本会话推一条消息的东西**。

B2 已经为唤醒建了单槽的 `wakeupTimer` + `hasPendingWakeup()`。本次把它泛化成一张注册表，理由有二：

1. **静默判据** —— cron 要等这些都落地才能定稿 run 记录；
2. **生命周期作废** —— 会话 `reset`/`release`/`delete` 之后，它们的产出无处可去，必须丢弃。

关键收益是**第三种待投递不可能被漏掉**：判据与作废各只有一处，新增一类只是往表里加一项，而不是再往 `waitUntilQuiescent` 和三个生命周期方法里各补一个 `if`。这与 `sessionCapabilities.ts:44-46` 已经写明的取向一致 —— 按类型加 `if` 正是那张清单要消灭的东西。

```ts
type InjectionKind = 'wakeup' | 'background'

interface PendingInjection {
  kind: InjectionKind
  /** 生命周期作废时调用。wakeup=clearTimeout；background 刻意为空，见 §5。 */
  cancel: () => void
}

private pendingInjections = new Map<symbol, PendingInjection>()
```

### API 面

| 方法 | 语义 | 调用方 |
|---|---|---|
| `hasPendingInjection()` | 表非空 | `waitUntilQuiescent` |
| `cancelAllInjections()` | 全部 `cancel()` 并清表 | `reset()`、`SessionService.release()/delete()` |
| `cancelWakeup()` | 仅作废 `kind==='wakeup'` 的项 | `scheduleWakeup()`（新的顶掉旧的） |
| `hasPendingWakeup()` | 存在 `kind==='wakeup'` 项 | B2 既有测试（单槽语义的观测点） |

`wakeupTimer` 字段消失，其角色由表中 `kind==='wakeup'` 的项承担；`wakeupDeadline` 不变。
`cancelWakeup()` 保留公开，因为唤醒的「新的顶掉旧的」只该顶唤醒，不该顶掉在飞的后台子代理。

## 4. `AgentToolDeps.onBackground` 改签名

现签名 `(description, result) => void` 只在**结束时**触发，调用方看不见「启动了」——而看见启动正是静默判据唯一需要的东西。加一个并列的启动钩子会带来 start↔end 的关联问题（`description` 不唯一，两个同名子代理无法区分）。

改成**启动时触发、返回结果回调**：

```ts
/**
 * 后台 Agent 启动时触发，返回「完成时调用」的结果回调。
 *
 * 之所以是「启动时给回调」而不是「完成时给结果」：调用方需要知道有 Agent 在飞
 * （会话静默判据、生命周期作废），而只有启动钩子能提供这个信息；两个钩子并列则
 * 无法把启动与完成对应起来（description 不唯一）。
 *
 * 可以 throw 来拒绝启动（如并发上限）——core 的 runOneTool 会转成 isError 回喂模型。
 */
onBackground?: (description: string) => (result: string) => void
```

`agent-tool.ts` 对应改为：

```ts
if (runInBackground === true && deps.onBackground) {
  const finish = deps.onBackground(label)   // 可能 throw（并发上限）
  void executeSubAgent().then(
    (result) => finish(result),
    () => finish('(sub-agent background execution failed)'),
  )
  return { output: `Sub-agent "${label}" launched in background. You will be notified when it finishes.` }
}
```

这是对共享包的**破坏性签名改动**，但调用点只有两处（TUI、agent-tool 自己的测试），且 TUI 侧是 3 行的等价改写：

```ts
onBackground: (desc) => (result) => {
  sendMessageRef.current?.(`🔔 后台 Agent "${desc}" 完成:\n${result}`)
},
```

## 5. 取消语义：只丢弃投递，不中止在飞的子代理

`kind==='background'` 项的 `cancel` 是**空函数**，这是刻意的：

- 真中止需要把可取消句柄从 `packages/tools` 一路传出来，而 `packages/tools` 是 TUI 与 server 共用的；
- 因为 §3 的静默判据已经让 cron **等后台子代理落地才 release**，真正撞上取消的只剩「唤醒链撞 1 小时封顶」这一个罕见情形；
- 在飞的子代理本身有 `SUB_AGENT_MAX_TURNS = 10` 的上限，不会无限跑。

作废的实际效果：完成回调发现自己的 token 已不在表中，直接 return，不投递。

## 6. 并发上限

同一会话最多 `MAX_BACKGROUND_AGENTS = 5` 个在飞的后台子代理。超限时启动钩子 throw：

```ts
throw new Error(`本会话已有 ${MAX_BACKGROUND_AGENTS} 个后台 Agent 在跑，等一个完成再派新的。`)
```

与 B2 唤醒链封顶同一套路数：**如实告诉模型**，由 `runOneTool` 转 isError 回喂，不静默吞掉。防的是模型一口气扒几十个后台子代理把会话和钱包拖垂。

## 7. 接线（`sessionCapabilities.ts`）

`SessionCapabilityContext` 加一个字段，沿用 `scheduleWakeup` 的形状 —— 暴露的是「登记」而非「投递」，到点怎么投是 `SessionManager` 的内部细节：

```ts
/** 登记一个后台 Agent（B1）。返回完成回调。超并发上限时 throw。 */
startBackgroundAgent: (description: string) => (result: string) => void
```

`SESSION_CAPABILITY_TOOLS` 第一项本来就是 `(ctx) => createAgentTool(ctx)`，且 `ctx` 是整体传入的 —— 只要把字段名对上 `AgentToolDeps.onBackground` 即可零成本流过去。但**不这么做**：`ctx` 里叫 `startBackgroundAgent` 更贴合它在会话侧的含义，显式映射一行反而更清楚：

```ts
(ctx) => createAgentTool({ ...ctx, onBackground: ctx.startBackgroundAgent }),
```

`SessionManager` 侧：

```ts
startBackgroundAgent: (desc) => this.startBackgroundAgent(desc),
```

```ts
startBackgroundAgent(description: string): (result: string) => void {
  if (this.countInjections('background') >= MAX_BACKGROUND_AGENTS) {
    throw new Error(`本会话已有 ${MAX_BACKGROUND_AGENTS} 个后台 Agent 在跑，等一个完成再派新的。`)
  }
  const token = this.addInjection('background', () => {})
  return (result) => {
    // 先摘登记再投递：两件事在同一个同步块内完成，中间没有 await，
    // 所以 waitUntilQuiescent（轮询，每次检查之间必有 await）观测不到
    // 「已摘登记但回合尚未开始」的假静默窗口。submit() 的 isThinking = true
    // 也是同步的（SessionManager.ts:887，第一个 await 之前），接得上。
    if (!this.pendingInjections.delete(token)) return  // 已被作废：产出无处可去
    deliverToSession(this, `🔔 后台 Agent "${description}" 完成:\n${result}`, {
      onError: (m) => this.emit({ type: 'warning', message: `后台 Agent 通知投递失败:${m}` }),
    })
  }
}
```

投递前缀 `🔔 后台 Agent "…" 完成:` 沿用 TUI 既有措辞，与唤醒的 `⏰ 定时唤醒:` 同族 —— 一眼能看出这轮不是人发的。

## 7.1 三个口子如何被堵上

| 口子 | 堵法 |
|---|---|
| 1 `/clear` 打进新会话 | `reset()` 调 `cancelAllInjections()`，token 离表 → 完成回调 return |
| 2 `release()`/`delete()` 后空转投递 | 两处改调 `cancelAllInjections()`（原为 `cancelWakeup()`），同上 |
| 3 cron 提前定稿 | `waitUntilQuiescent` 判据换成 `hasPendingInjection()`，自动覆盖后台子代理 |

## 8. 测试

**`packages/tools`（agent-tool.test.ts）**
- 后台模式：`onBackground` 在**启动时**被调用一次，返回的回调在子代理完成后收到结果
- 启动钩子 throw → `createAgentTool` 的 execute 抛出（由 core 转 isError，此处只断言抛）
- 子代理失败 → 结果回调收到 `'(sub-agent background execution failed)'`

**`packages/server`（SessionManager.test.ts）**
- 完成回调触发投递：空闲时走 `submit`（带 echo），忙时走 `steer`
- `reset()` 后完成回调**不投递**（口子 1）
- `cancelAllInjections()` 后完成回调**不投递**（口子 2）
- `hasPendingInjection()` 在后台子代理在飞时为 true、完成后为 false
- 并发上限：第 6 个 throw，且消息包含上限数字
- `cancelWakeup()` 只清唤醒、不清后台登记（单槽语义不误伤）
- **顺序钉死**：`waitUntilQuiescent` 在只有后台登记（无回合、无唤醒）时不返回，登记摘掉后才返回

**`packages/server`（SessionService.test.ts）**
- `release()`/`delete()` 后，之前登记的后台完成回调不再驱动回合

**`packages/tui`**
- 既有 `onBackground` 用法改签名后行为不变（若无对应测试则以 typecheck 为准，并在 PR 说明中如实标注未新增测试）

每条行为测试都要能通过**变异检验**：把实现改回旧行为，测试必须变红。B2 那轮的教训 —— 只断言「某方法被调用过」的测试是假保障。

## 8.1 已知遗留：子代理面板的状态永远停在「运行中」

实测（真 daemon）：后台子代理完成后，侧栏「子代理」面板仍显示 `1 运行中 · 0 / 1`。

原因在 `packages/web/src/components/AgentsPanel.tsx` 的 `isBackgroundAck()` —— 它从面板初版
（`a769927`）就存在，注释写明「`launched in background` 的 ack 算作仍在运行」，是**预写**的。
本特性之前 server 从不走后台分支，这段代码永远碰不到；现在碰到了，而没有任何机制能把状态翻成
`done`：完成通知是一条**用户消息**，不是那个 tool-use id 的 tool-result。

**本次不修**，因为正确的修法需要一个协议层决定：给 `onBackground` 传 tool-use id、服务端完成时
额外 emit 一个带 id 的事件、web 据此翻状态 —— 横跨 tools/protocol/server/web 四个包，是另一个
spec 的体量。按 description 文本匹配是廉价替代，但 **description 不唯一**，而「description 不唯一」
正是 §4 里服务端设计用 token 而不用名字的原因，不该在前端把这个错误重新引入一遍。

主对话里的 `🔔 后台 Agent "…" 完成:` 气泡已经把「完成了」说清楚，面板只是辅助视图，
所以这个遗留不阻塞本特性。

## 9. 非目标

- 不做后台子代理的真中止（§5）
- 不修子代理面板的状态（§8.1，另开 spec）
- 不做后台子代理的持久化：daemon 重启即失效，与 B2 唤醒一致（排程归 cron 管）
- 不动前端：投递走既有 `deliverToSession`，Web 看到的就是一条普通用户气泡/插话，无需新组件
- 不动 `SUB_AGENT_MAX_TURNS`、不动子代理的权限/worktree 逻辑
