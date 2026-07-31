# B2 ScheduleWakeup 接线设计

> **日期**: 2026-07-31
> **性质**: 单个功能 spec（Web UI 路线图 §4.8 的 B2）
> **依赖**: F2（headless SessionManager）✓、R2（会话能力上下文）✓、C1/C2（cron）✓
> **前置事实**: 工具本体 **早已存在** —— `packages/tools/src/schedule-wakeup.ts`（Phase 16，2026-06-17，为 TUI 写的）。本 spec 只做「接进 server 会话」这一件事。

---

## 1. 现状（已逐条核实）

- **工具本体已有**：`createScheduleWakeupTool({ onSchedule: (delayMs, message) => void })`，参数校验 + `delaySeconds` clamp 到 **[1, 3600]** + 「同时只有一个待触发」的语义说明，都已实现并有单测（`schedule-wakeup.test.ts`）。**本 spec 不改它。**
- **TUI 的接法**（`packages/tui/src/hooks/useConversation.ts:272-280`）：一个 `wakeupTimerRef`，新调用先 `clearTimeout` 旧的，到点 `sendMessage(\`⏰ 定时唤醒: ${message}\`)`。
- **server 未接**。`createSession.ts:128` 与 `sessionCapabilities.ts` 的注释都写着「待 C1，需要一个把唤醒消息注入会话的回调」。
- **`submit()` 在回合进行中会抛错**（`SessionManager.ts:864`：`if (this.isThinking && !opts?.isResend) throw`）。所以唤醒不能无脑 submit。
- **投递规则已经存在**（`ws/clientMessage.ts:48-49`）：
  ```ts
  if (mgr.isBusy()) mgr.steer(text, ..., { messageId })
  else mgr.submit(text, ..., { echo: true, messageId }).catch(sendError)
  ```
  唤醒要的就是这条规则，**不需要发明新的**。
- **cron 会话跑完即释放**（`CronScheduler.fire()` 的 `finally: this.sessions.release(sessionId)`）；`release()`（`SessionService.ts:199`）退订 autosave 并移出注册表 —— 之后再跑的回合**既不落盘也送不到任何客户端**。
- `SESSION_CAPABILITY_TOOLS` 现有两项（Agent、TodoWrite），由 `SessionManager` 构造时循环注册（`SessionManager.ts:284-294`）。

## 2. 目标与非目标

**目标**
1. 让 server 会话里的模型能用 `ScheduleWakeup`，到点把消息投进本会话并驱动一轮。
2. 唤醒撞上正在跑的回合时不丢、不炸。
3. cron 会话同样可用，且**不破坏 run 记录的真实性**。

**非目标（明确不做，附理由）**
- **不持久化**（daemon 重启即失效）。上限就是 1 小时，它是「轮询外部状态」的短程工具；真正的排程是 cron，已经做完了。持久化要额外回答「错过的唤醒补不补」「补的时候会话还在不在」，为一个 ≤1h 的工具不值。
- **不改工具本体**（不动 clamp 上限、不做多个并发唤醒）。
- **不做前端改动**。工具卡已对全部工具通用渲染；唤醒消息就是一条普通用户气泡。
- **不做取消唤醒的工具**。「同时只有一个」意味着重新安排即可覆盖；真要停就 Stop/新对话。

## 3. 设计

### 3.1 能力面（R2）

`SessionCapabilityContext` 加一个字段：

```ts
/** 安排一次自唤醒（到点把消息投进本会话并驱动一轮）。同时只保留一个。 */
scheduleWakeup: (delayMs: number, message: string) => void
```

（能力面暴露的是**安排**，不是**投递**：`deliverToSession` 是 `SessionManager.scheduleWakeup` 到点后自己调的内部细节，工具不该看见它。）

`SESSION_CAPABILITY_TOOLS` 加第三项：

```ts
(ctx) => createScheduleWakeupTool({ onSchedule: (delayMs, message) => ctx.scheduleWakeup(delayMs, message) }),
```

**不为 cron 会话开特例。** R2 的整个价值就是「一张清单、循环注册」；为某类会话加 `if` 等于把特例贴回共享机制，正是 R2 当初要消灭的东西。cron 的差异改在 cron 自己那边处理（§3.4）。

### 3.2 投递规则：抽出来共用

新建 `packages/server/src/session/deliver.ts`：

```ts
/**
 * 把一条文本投进会话并驱动一轮 —— 忙则 steer（折进当前回合，折不进就由 idle-drain 作为
 * 独立后续回合排空），闲则作为一条正常消息 submit。
 *
 * ws 上行的 steer 分派与 ScheduleWakeup 到点投递共用它：两者要的是同一条规则，
 * 各写一遍必然漂移（而漂移的后果是「消息静默丢了」这种最难查的形态）。
 */
export function deliverToSession(mgr: DeliverTarget, text: string, opts?: { messageId?: string }): void
```

`ws/clientMessage.ts` 的 steer 分支改为调用它（行为不变，有既有测试兜底）。

### 3.3 定时器归 SessionManager 持有

**不放在工具闭包里** —— 取消的时机全是 manager/service 的生命周期事件，闭包够不着：

| 时机 | 为什么必须取消 |
|---|---|
| `reset()`（新对话） | 旧会话的唤醒打到全新的空会话上，是幽灵消息 |
| `SessionService.release()` | 会话已移出注册表 + 退订 autosave，那一轮的产出无处可去 |
| `SessionService.delete()` | 会话文件都删了 |

新增到 `SessionManager`：

```ts
private wakeupTimer: ReturnType<typeof setTimeout> | null = null
/** 上限用：本会话「唤醒链」不得越过这个时刻（null = 不限，普通聊天会话即为 null）。 */
private wakeupDeadline: number | null = null

/** 安排一次自唤醒。同时只保留一个：新的顶掉旧的（沿用工具语义）。 */
scheduleWakeup(delayMs: number, message: string): void

/** 取消待触发的唤醒（reset/release/delete 调用）。 */
cancelWakeup(): void

/** 有唤醒待触发？cron 的静默判定用。 */
hasPendingWakeup(): boolean
```

`scheduleWakeup` 到点后走 `deliverToSession(this, \`⏰ 定时唤醒: ${message}\`)`（前缀沿用 TUI，一眼能看出这轮不是人发的）。

`reset()` 里在 `this.steerQueue.length = 0` 旁边加一行 `this.cancelWakeup()`；`SessionService.release()`/`delete()` 在退订前对 live manager 调 `cancelWakeup()`。

### 3.4 cron：run 记录必须覆盖整条链

问题：`fire()` 现在的顺序是 `submit → appendRun(success, summary, finishedAt) → release`。若唤醒在 `submit` 返回后才跑，run 记录的摘要与结束时间**已经不描述这个会话实际做了什么**了。

改为：

```
submit(prompt)
  → await mgr.waitUntilQuiescent(deadline)      // 新增
  → appendRun(success, summary, finishedAt)
  → release
```

`waitUntilQuiescent(deadline: number)`：轮询/事件等待，直到 **当前无回合在跑 且 无待触发唤醒**，或越过 `deadline`。

**上限 = 从本次触发起 1 小时**（`CRON_WAKEUP_CHAIN_MS`）。`fire()` 在 `create` 后立刻给 manager 设 `wakeupDeadline = Date.now() + CRON_WAKEUP_CHAIN_MS`；`scheduleWakeup` 见到新唤醒会越过 deadline 就**拒绝并把这件事回给模型**（工具返回 `isError`，说明"本次定时任务的唤醒额度已用完"）—— 不静默吞掉。

**普通聊天会话 `wakeupDeadline = null`，不设上限** —— 那是用户自己的会话，随时能 Stop。

副作用（有意为之）：唤醒链跑着时 `fire()` 的 promise 还没 resolve，croner 的 `protect: true` 因此把「还在跑」的语义自然延伸到唤醒链上，下一次到点不会重入。

## 4. 分期

1. **core/tools**：无改动（工具本体已存在）。
2. **server-1**：`deliver.ts` + `ws/clientMessage.ts` 改用它（纯重构，既有测试守住）。
3. **server-2**：`SessionManager` 的 timer/deadline 三个方法 + `reset()` 取消（+ 单测）。
4. **server-3**：能力面加 `scheduleWakeup`，清单加第三项（+ 单测：工具已注册、到点会投递）。
5. **server-4**：`SessionService.release()/delete()` 取消唤醒（+ 单测）。
6. **server-5**：`waitUntilQuiescent` + `fire()` 改序 + deadline + 拒绝超额唤醒（+ 单测）。
7. **/ship**（无 web 改动 → Playwright N/A；但要用真 daemon 端到端验一次真实唤醒）。

## 5. 测试策略

- **deliver**：忙 → 走 steer；闲 → 走 submit 且 `echo: true`。（ws 既有测试同时守住重构无回归。）
- **SessionManager**：安排后 `hasPendingWakeup()` 为真；到点投递出去；新唤醒顶掉旧的（旧的不再触发）；`reset()` 后不再触发；越过 deadline 的安排被拒且返回 `isError`。
- **能力清单**：`ScheduleWakeup` 出现在会话 registry 里；名称被 `registerExtraTools` 占用时走既有的 warn+跳过路径。
- **SessionService**：`release()`/`delete()` 后待触发的唤醒不再触发。
- **cron**：`fire()` 会等唤醒链（用假时钟/短 deadline）；run 记录的 `finishedAt` 晚于唤醒轮次；到顶后收尾且不卡死；唤醒链里抛错不让 `fire()` reject。
- **真 daemon 端到端**：起 daemon，让模型 `ScheduleWakeup(delaySeconds: 5)`，观察 5 秒后自动出现一条 `⏰ 定时唤醒:` 用户气泡并驱动新回合。**这一条必须实测** —— 单测全程假时钟，覆盖不到「真 setTimeout + 真回合」的接缝（V1/V2 语音的教训：三处真问题全是实测才暴露的）。

## 6. 已知取舍

- **不持久化** → daemon 重启丢唤醒。换来零存储、零「补触发」语义。
- **cron 链封顶 1 小时** → 模型想跨更长时间轮询就得改 cron 表达式。这是对的工具分工。
- **唤醒撞上忙碌会话时会被折进当前回合**（而非另起一轮）→ 语义上从「新回合」变成「插话」。对轮询场景（模型安排完就结束回合）这几乎不会发生；真发生时折进去也合理。
- **`waitUntilQuiescent` 让 `fire()` 可能挂到 1 小时** → 该 cron 任务这段时间内不再重入（`protect`）。这是刻意的：链没跑完，这次执行本来就没结束。
