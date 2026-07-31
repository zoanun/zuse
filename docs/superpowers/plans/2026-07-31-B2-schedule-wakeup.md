# B2 ScheduleWakeup 接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 server 会话里的模型能用已有的 `ScheduleWakeup` 工具 —— 到点把消息投进本会话并驱动一轮；cron 会话同样可用且不破坏 run 记录的真实性。

**Architecture:** 工具本体不动（`packages/tools/src/schedule-wakeup.ts` 早已存在）。新增一个共享的「投进会话」函数供 ws 上行与唤醒复用；定时器归 `SessionManager` 持有（取消时机全在生命周期事件上）；能力面（R2 的 `SESSION_CAPABILITY_TOOLS`）加第三项，**不为 cron 开特例**；cron 侧改为等唤醒链静默再定稿 run 记录，并给链封顶 1 小时。

**Tech Stack:** TypeScript，vitest（server 无 test 脚本，用根 `pnpm exec vitest run packages/server/...`），零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-31-B2-schedule-wakeup-design.md`

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/server/src/session/deliver.ts` | **新建**。`deliverToSession(mgr, text, opts)` —— 忙则 steer、闲则 submit。ws 与唤醒的唯一真源。 |
| `packages/server/src/session/deliver.test.ts` | **新建**。两条分支各一例。 |
| `packages/server/src/ws/clientMessage.ts` | 改用 `deliverToSession`（纯重构，既有测试守住）。 |
| `packages/server/src/session/SessionManager.ts` | 加 `wakeupTimer`/`wakeupDeadline` 字段 + `scheduleWakeup`/`cancelWakeup`/`hasPendingWakeup`/`setWakeupDeadline`/`waitUntilQuiescent`；`reset()` 取消唤醒；能力面字面量加一项。 |
| `packages/server/src/session/sessionCapabilities.ts` | 接口加 `scheduleWakeup`；清单加第三项。 |
| `packages/server/src/session/SessionService.ts` | `release()`/`delete()` 先取消 live manager 的唤醒。 |
| `packages/server/src/cron/CronScheduler.ts` | `fire()` 设 deadline + 等静默再定稿。 |

---

### Task 1: `deliverToSession` —— 抽出投递规则

**Files:**
- Create: `packages/server/src/session/deliver.ts`
- Create: `packages/server/src/session/deliver.test.ts`
- Modify: `packages/server/src/ws/clientMessage.ts:42-50`

- [ ] **Step 1: 写失败测试**

`packages/server/src/session/deliver.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { deliverToSession } from './deliver.js'

function fake(busy: boolean) {
  return {
    isBusy: vi.fn(() => busy),
    steer: vi.fn(),
    submit: vi.fn(async () => {}),
  }
}

describe('deliverToSession', () => {
  it('回合进行中 → steer(折进当前回合)', () => {
    const mgr = fake(true)
    deliverToSession(mgr, 'hi', { messageId: 'm1' })
    expect(mgr.steer).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { messageId: 'm1' })
    expect(mgr.submit).not.toHaveBeenCalled()
  })

  it('空闲 → submit,且 echo:true(否则前端的"排队中"预览化不成真气泡)', () => {
    const mgr = fake(false)
    deliverToSession(mgr, 'hi')
    expect(mgr.submit).toHaveBeenCalledWith('hi', undefined, undefined, undefined, { echo: true, messageId: undefined })
    expect(mgr.steer).not.toHaveBeenCalled()
  })

  it('submit 失败不抛出去,交给 onError', async () => {
    const mgr = fake(false)
    mgr.submit.mockRejectedValueOnce(new Error('boom'))
    const onError = vi.fn()
    deliverToSession(mgr, 'hi', { onError })
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalledWith('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/deliver.test.ts`
Expected: FAIL —— `Cannot find module './deliver.js'`

- [ ] **Step 3: 实现**

`packages/server/src/session/deliver.ts`:

```ts
import type { SessionManager } from './SessionManager.js'

/** deliverToSession 驱动的 SessionManager 子集（便于单测注入 spy）。 */
export type DeliverTarget = Pick<SessionManager, 'isBusy' | 'steer' | 'submit'>

/**
 * 把一条文本投进会话并驱动一轮。
 *
 * - **忙**（回合进行中）→ `steer`：能折进当前回合就折进去，折不进的由 SessionManager 的
 *   idle-drain 在回合结束后作为独立后续回合排空。直接 submit 会抛「A turn is already in progress」。
 * - **闲** → `submit({ echo: true })`。`echo` 不能省：前端在自己认为「正在跑」时走 steer 路径、
 *   只画一个临时的「排队中」预览，服务端若不回 user-echo，那个预览永远化不成真气泡。
 *
 * ws 上行的 steer 分派与 ScheduleWakeup 的到点投递共用它 —— 两者要的是同一条规则，
 * 各写一遍必然漂移，而漂移的后果是「消息静默丢了」这种最难查的形态。
 */
export function deliverToSession(
  mgr: DeliverTarget,
  text: string,
  opts?: {
    messageId?: string
    images?: Parameters<SessionManager['submit']>[1]
    pastedTexts?: Parameters<SessionManager['submit']>[2]
    files?: Parameters<SessionManager['submit']>[3]
    onError?: (message: string) => void
  },
): void {
  const { messageId, images, pastedTexts, files, onError } = opts ?? {}
  if (mgr.isBusy()) {
    mgr.steer(text, images, pastedTexts, files, { messageId })
    return
  }
  mgr.submit(text, images, pastedTexts, files, { echo: true, messageId }).catch((err: unknown) => {
    onError?.(err instanceof Error ? err.message : String(err))
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/session/deliver.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: ws 改用它**

`packages/server/src/ws/clientMessage.ts` —— 顶部加 `import { deliverToSession } from '../session/deliver.js'`，把 `case 'steer':` 里那两行替换为：

```ts
      case 'steer':
        if (typeof msg.text !== 'string') { sendError('steer: "text" must be a string'); return }
        // The client sends 'steer' whenever IT believes a turn is running. If the server is already
        // idle (the steer raced past turn-end), there's no turn to fold into — deliverToSession
        // routes it as a normal echoed turn instead, so the transient "queued" preview resolves.
        deliverToSession(mgr, msg.text, {
          messageId: msg.messageId, images: msg.images, pastedTexts: msg.pastedTexts, files: msg.files,
          onError: sendError,
        })
        return
```

- [ ] **Step 6: 跑既有 ws 测试确认无回归**

Run: `pnpm exec vitest run packages/server/src/ws/`
Expected: PASS，全部既有用例（含 `dispatches interrupt / steer / ...`）仍绿

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/session/deliver.ts packages/server/src/session/deliver.test.ts packages/server/src/ws/clientMessage.ts
git commit -m "refactor(server): 抽出 deliverToSession，ws 与后续的唤醒投递共用一条规则"
```

---

### Task 2: SessionManager 的唤醒定时器

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`
- Test: `packages/server/src/session/SessionManager.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `packages/server/src/session/SessionManager.test.ts`（沿用该文件既有的 `makeManager`/fake client 工厂；用 `vi.useFakeTimers()`）:

```ts
describe('ScheduleWakeup (B2)', () => {
  it('到点把消息投进会话并驱动一轮', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()                     // 该文件既有工厂
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    mgr.scheduleWakeup(5000, '看看 CI')
    expect(mgr.hasPendingWakeup()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(submit).toHaveBeenCalledWith('⏰ 定时唤醒: 看看 CI', undefined, undefined, undefined, expect.objectContaining({ echo: true }))
    expect(mgr.hasPendingWakeup()).toBe(false)    // 触发后自动清空
    vi.useRealTimers()
  })

  it('同时只保留一个:新的顶掉旧的,旧的不再触发', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    mgr.scheduleWakeup(5000, '旧')
    mgr.scheduleWakeup(9000, '新')
    await vi.advanceTimersByTimeAsync(20000)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).toContain('新')
    vi.useRealTimers()
  })

  it('reset()(新对话)取消待触发的唤醒 —— 否则旧会话的唤醒会打到全新的空会话上', async () => {
    vi.useFakeTimers()
    const mgr = makeManager()
    const submit = vi.spyOn(mgr, 'submit').mockResolvedValue(undefined)
    mgr.scheduleWakeup(5000, '幽灵')
    mgr.reset()
    expect(mgr.hasPendingWakeup()).toBe(false)
    await vi.advanceTimersByTimeAsync(20000)
    expect(submit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('越过 deadline 的安排被拒(cron 唤醒链的额度用完)', () => {
    const mgr = makeManager()
    mgr.setWakeupDeadline(Date.now() + 1000)
    expect(mgr.scheduleWakeup(5000, '超额')).toBe(false)  // 1000ms 后就到期，排不下 5000ms
    expect(mgr.hasPendingWakeup()).toBe(false)
    expect(mgr.scheduleWakeup(500, '来得及')).toBe(true)
    mgr.cancelWakeup()
  })

  it('无 deadline(普通聊天会话)不设上限', () => {
    const mgr = makeManager()
    expect(mgr.scheduleWakeup(3_600_000, '一小时后')).toBe(true)
    mgr.cancelWakeup()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts -t "ScheduleWakeup"`
Expected: FAIL —— `mgr.scheduleWakeup is not a function`

- [ ] **Step 3: 实现**

`SessionManager.ts` —— 顶部加 `import { deliverToSession } from './deliver.js'`；在字段区（`private isThinking` 附近）加：

```ts
  /** 待触发的自唤醒定时器（ScheduleWakeup，B2）。同时至多一个。 */
  private wakeupTimer: ReturnType<typeof setTimeout> | null = null
  /** 唤醒链的截止时刻（epoch ms）。null = 不限 —— 普通聊天会话即为 null，cron 会话由 fire() 设。 */
  private wakeupDeadline: number | null = null
```

在 `setTodos` 附近加方法：

```ts
  /**
   * 安排一次自唤醒：delayMs 后把 message 投进本会话并驱动一轮。
   * **同时只保留一个** —— 新的顶掉旧的（沿用 ScheduleWakeup 工具的既有语义）。
   * 返回 false = 被 deadline 拒绝（cron 唤醒链额度用完），调用方要把这件事回给模型，不能静默吞掉。
   */
  scheduleWakeup(delayMs: number, message: string): boolean {
    if (this.wakeupDeadline !== null && Date.now() + delayMs > this.wakeupDeadline) return false
    this.cancelWakeup()
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null
      // 前缀沿用 TUI：一眼能看出这轮不是人发的。
      deliverToSession(this, `⏰ 定时唤醒: ${message}`, {
        onError: (m) => this.emit({ type: 'warning', message: `定时唤醒投递失败:${m}` }),
      })
    }, delayMs)
    // daemon 不该因为一个待触发的唤醒而无法退出。
    this.wakeupTimer.unref?.()
    return true
  }

  /** 取消待触发的唤醒。reset()/release()/delete() 调用 —— 见 spec §3.3 的时机表。 */
  cancelWakeup(): void {
    if (this.wakeupTimer) clearTimeout(this.wakeupTimer)
    this.wakeupTimer = null
  }

  /** 有唤醒待触发？cron 的静默判定用。 */
  hasPendingWakeup(): boolean {
    return this.wakeupTimer !== null
  }

  /** 给本会话的唤醒链设截止时刻（cron 用）。null = 不限。 */
  setWakeupDeadline(at: number | null): void {
    this.wakeupDeadline = at
  }
```

`reset()` 里，在 `this.steerQueue.length = 0` 那一行后面加：

```ts
    this.cancelWakeup() // 否则旧会话的唤醒会打到这个全新的空会话上
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts -t "ScheduleWakeup"`
Expected: PASS（5 passed）

- [ ] **Step 5: 跑整个 SessionManager 套件确认无回归**

Run: `pnpm exec vitest run packages/server/src/session/SessionManager.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/session/SessionManager.test.ts
git commit -m "feat(server): SessionManager 持有自唤醒定时器（同时至多一个 + reset 取消 + deadline 上限）"
```

---

### Task 3: 接进能力面

**Files:**
- Modify: `packages/server/src/session/sessionCapabilities.ts`
- Modify: `packages/server/src/session/SessionManager.ts:275-283`（capabilityCtx 字面量）
- Test: `packages/server/src/session/sessionCapabilities.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `packages/server/src/session/sessionCapabilities.test.ts`:

```ts
it("清单包含 ScheduleWakeup，且把 onSchedule 接到 ctx.scheduleWakeup", async () => {
  const scheduleWakeup = vi.fn(() => true)
  const ctx = makeCtx({ scheduleWakeup })          // 该文件既有的 ctx 工厂，补上新字段
  const tools = SESSION_CAPABILITY_TOOLS.map((make) => make(ctx))
  const wakeup = tools.find((t) => t.name === 'ScheduleWakeup')
  expect(wakeup).toBeDefined()
  await wakeup!.run({ delaySeconds: 30, message: '看 CI' })
  expect(scheduleWakeup).toHaveBeenCalledWith(30_000, '看 CI')
})

it('被 deadline 拒绝时，如实告诉模型（不静默吞掉）', async () => {
  const ctx = makeCtx({ scheduleWakeup: vi.fn(() => false) })
  const wakeup = SESSION_CAPABILITY_TOOLS.map((m) => m(ctx)).find((t) => t.name === 'ScheduleWakeup')!
  const r = await wakeup.run({ delaySeconds: 30, message: 'x' })
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/额度|deadline|上限/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/sessionCapabilities.test.ts`
Expected: FAIL —— 找不到 `ScheduleWakeup`

- [ ] **Step 3: 实现**

`sessionCapabilities.ts` —— import 加 `createScheduleWakeupTool`；接口加字段；清单加第三项：

```ts
import { createAgentTool, createTodoWriteTool, createScheduleWakeupTool, type TodoItem } from '@zuse/tools'

// …接口里，setTodos 之后：
  /**
   * 安排一次自唤醒（B2）。返回 false = 被唤醒链的 deadline 拒绝（cron 会话额度用完）。
   * 暴露的是「安排」而非「投递」：到点怎么投（忙则 steer/闲则 submit）是 SessionManager 的内部细节。
   */
  scheduleWakeup: (delayMs: number, message: string) => boolean

// …清单里，第三项：
  // ScheduleWakeup（B2）。**不为 cron 会话开特例** —— R2 的价值就是「一张清单、循环注册」，
  // 按会话类型加 if 等于把特例贴回共享机制。cron 的差异由 CronScheduler 用 deadline 表达。
  (ctx) => createScheduleWakeupTool({
    onSchedule: (delayMs, message) => {
      if (!ctx.scheduleWakeup(delayMs, message)) {
        throw new Error('本次定时任务的自唤醒额度已用完（唤醒链上限 1 小时）——需要更长的轮询请改用 cron 表达式。')
      }
    },
  }),
```

> **为什么用 throw 表达拒绝（已核实，不是猜的）**：`createScheduleWakeupTool` 的 `run` 里没有 try/catch 包住 `onSchedule`，但**不需要**有 —— core 的 `runOneTool`（`packages/core/src/agent.ts:548-580`）在 `try { await tool.run(...) } catch` 里把抛错统一转成
> `{ output: '工具「ScheduleWakeup」执行失败:<message>', isError: true }` 回喂模型。所以抛错**不会打断回合**，模型会看到拒绝原因并可以改用别的办法。因此**工具本体一行都不用改**。

`SessionManager.ts` 的 `capabilityCtx` 字面量加一行：

```ts
      setTodos: (todos) => this.setTodos(todos),
      scheduleWakeup: (delayMs, message) => this.scheduleWakeup(delayMs, message),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/session/sessionCapabilities.test.ts`
Expected: PASS

- [ ] **Step 5: 清掉过时注释**

`createSession.ts:128` 那行 `// ScheduleWakeup（B2）仍未接 —— …` 删掉（已经接了，留着就是假注释）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/session/sessionCapabilities.ts packages/server/src/session/sessionCapabilities.test.ts packages/server/src/session/SessionManager.ts packages/server/src/session/createSession.ts
git commit -m "feat(server): ScheduleWakeup 接进会话能力清单（不为 cron 开特例）"
```

---

### Task 4: release / delete 时取消唤醒

**Files:**
- Modify: `packages/server/src/session/SessionService.ts:180-203`
- Test: `packages/server/src/session/SessionService.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('release() 取消待触发的唤醒 —— 会话已移出注册表，那一轮的产出无处可去', async () => {
  const svc = makeService()                       // 该文件既有工厂
  const { id } = await svc.create({})
  const mgr = (await svc.getOrLoad(id))!
  const cancel = vi.spyOn(mgr, 'cancelWakeup')
  svc.release(id)
  expect(cancel).toHaveBeenCalled()
})

it('delete() 同样取消 —— 会话文件都删了', async () => {
  const svc = makeService()
  const { id } = await svc.create({})
  const mgr = (await svc.getOrLoad(id))!
  const cancel = vi.spyOn(mgr, 'cancelWakeup')
  await svc.delete(id)
  expect(cancel).toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/session/SessionService.test.ts -t "唤醒"`
Expected: FAIL —— `cancelWakeup` 未被调用

- [ ] **Step 3: 实现**

`SessionService.ts` —— `delete()` 的 `this.unsubs.get(id)?.()` **之前**、`release()` 同理，各加一行：

```ts
    // 会话即将离开注册表：待触发的唤醒必须一起取消，否则它到点会驱动一轮
    // 既不落盘（autosave 已退订）也送不到任何客户端（无订阅者）的回合。
    this.registry.get(id)?.cancelWakeup()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/session/SessionService.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/session/SessionService.ts packages/server/src/session/SessionService.test.ts
git commit -m "fix(server): release/delete 会话时取消待触发的自唤醒"
```

---

### Task 5: cron —— run 记录覆盖整条唤醒链

**Files:**
- Modify: `packages/server/src/session/SessionManager.ts`（加 `waitUntilQuiescent`）
- Modify: `packages/server/src/cron/CronScheduler.ts:71-88`
- Test: `packages/server/src/cron/CronScheduler.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('fire() 等唤醒链跑完再定稿 run 记录', async () => {
  // 唤醒轮次发生在 submit() 返回之后。若 fire() 不等，run 的 summary/finishedAt
  // 描述的就不是这个会话实际做过的事。
  const mgr = fakeManager()
  mgr.hasPendingWakeup.mockReturnValueOnce(true).mockReturnValue(false)
  const sched = makeScheduler({ sessions: fakeSessions(mgr) })
  await sched.fire(task)
  const runs = await loadRuns(dir, task.id)
  expect(runs[0]!.status).toBe('success')
  expect(mgr.waitUntilQuiescent).toHaveBeenCalled()
})

it('fire() 给 cron 会话设 1 小时的唤醒链上限', async () => {
  const mgr = fakeManager()
  const sched = makeScheduler({ sessions: fakeSessions(mgr) })
  await sched.fire(task)
  expect(mgr.setWakeupDeadline).toHaveBeenCalledWith(expect.any(Number))
})

it('唤醒链里抛错不让 fire() reject（croner 的 protect 会 await 它）', async () => {
  const mgr = fakeManager()
  mgr.waitUntilQuiescent.mockRejectedValueOnce(new Error('boom'))
  const sched = makeScheduler({ sessions: fakeSessions(mgr) })
  await expect(sched.fire(task)).resolves.toBeUndefined()
  const runs = await loadRuns(dir, task.id)
  expect(runs[0]!.status).toBe('failed')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run packages/server/src/cron/CronScheduler.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `waitUntilQuiescent`**

`SessionManager.ts`，加在 `hasPendingWakeup` 旁边：

```ts
  /**
   * 等到会话静默：当前无回合在跑 **且** 无待触发的唤醒；或越过 deadline。
   * cron 用它把 run 记录的定稿推迟到整条唤醒链结束（否则 summary/finishedAt 描述的
   * 不是这个会话实际做过的事）。轮询而非事件订阅：唤醒到点是 setTimeout，没有对应的事件。
   */
  async waitUntilQuiescent(deadline: number, pollMs = 250): Promise<void> {
    while (Date.now() < deadline) {
      if (!this.isBusy() && !this.hasPendingWakeup()) return
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
```

- [ ] **Step 4: 改 `fire()`**

`CronScheduler.ts` —— 文件顶部加常量：

```ts
/** cron 会话的自唤醒链上限：从本次触发起算 1 小时。到顶后拒绝新唤醒并收尾。 */
const WAKEUP_CHAIN_MS = 60 * 60 * 1000
```

`fire()` 的 try 体改为：

```ts
      sessionId = (await this.sessions.create({ cwd: task.cwd, permissionMode: task.permissionMode, kind: 'cron' })).id
      await appendRun(this.dir, { ...base(), status: 'running' })
      const mgr = await this.sessions.getOrLoad(sessionId)
      if (!mgr) throw new Error('cron session vanished after create')
      const deadline = Date.now() + WAKEUP_CHAIN_MS
      mgr.setWakeupDeadline(deadline)
      await mgr.submit(task.prompt)
      // 模型可能在这一轮里安排了自唤醒。等整条链静默再定稿 —— 否则 summary/finishedAt
      // 描述的不是这个会话实际做过的事。croner 的 protect 会 await fire()，所以
      // 「链还在跑」自然延伸成「这次执行还没结束」，下一次到点不会重入。
      await mgr.waitUntilQuiescent(deadline)
      await appendRun(this.dir, { ...base(), status: 'success', finishedAt: new Date().toISOString(), summary: summarize(mgr.getState()) })
```

`finally` 不变（`release()` 现在会顺带 `cancelWakeup()`，见 Task 4）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run packages/server/src/cron/`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/session/SessionManager.ts packages/server/src/cron/CronScheduler.ts packages/server/src/cron/CronScheduler.test.ts
git commit -m "feat(server): cron 的 run 记录等自唤醒链跑完再定稿（链封顶 1 小时）"
```

---

### Task 6: 验证门禁（不写新代码）

- [ ] **Step 1: typecheck**

Run: `pnpm -F @zouyj/zuse-server exec tsc --noEmit`
Expected: EXIT 0，零输出

- [ ] **Step 2: 全量 server 单测**

Run: `pnpm exec vitest run packages/server`
Expected: 全绿（既知环境性失败按 CLAUDE.md 如实说明，不得把本次引入的失败混进去豁免）

- [ ] **Step 3: 真 daemon 端到端（必做，不可用单测替代）**

单测全程假时钟，覆盖不到「真 setTimeout + 真回合 + 真投递」的接缝。V1/V2 语音的教训：三处真问题全是实测才暴露的。

```
1. pnpm --filter @zuse/web build; 重启 daemon（4180）
2. 浏览器登录（密码 zuonaok），发一条：
   「用 ScheduleWakeup 安排 10 秒后唤醒，消息写『看看现在几点』。安排完就结束这一轮，别的什么都别做。」
3. 断言：工具卡显示 ScheduleWakeup 调用成功；约 10 秒后**自动**出现一条
   `⏰ 定时唤醒: 看看现在几点` 的用户气泡，并驱动出一个新回合。
4. 截图存证。
```

- [ ] **Step 4: 更新路线图**

`docs/superpowers/specs/2026-06-22-web-ui-roadmap.md` §4.8 的 B2 行：`待接` → `✅ 已接（2026-07-31）`，说明栏写实际做法（能力清单第三项 + deliverToSession + cron 唤醒链封顶）。

- [ ] **Step 5: 提交并走 /ship**

```bash
git add docs/superpowers/specs/2026-06-22-web-ui-roadmap.md
git commit -m "docs: 路线图 B2 标记为已接"
```

然后 `/ship`（无 web 代码改动 → Playwright 按上面的真 daemon 验证代替）。

---

## Self-Review

**Spec 覆盖检查**
- §3.1 能力面 → Task 3 ✓
- §3.2 deliverToSession → Task 1 ✓
- §3.3 定时器归属 + 三处取消时机 → Task 2（reset）+ Task 4（release/delete）✓
- §3.4 cron 等静默 + 1 小时封顶 → Task 5 ✓
- §5 测试策略的每一条都能对上具体 Step ✓（含「真 daemon 端到端」= Task 6 Step 3）

**类型一致性**：`scheduleWakeup(delayMs, message) => boolean` 在 spec §3.1、能力面接口、SessionManager 方法、capabilityCtx 字面量四处签名一致 ✓。`hasPendingWakeup`/`cancelWakeup`/`setWakeupDeadline`/`waitUntilQuiescent` 在 plan 内命名前后一致 ✓。

**写 plan 时当场核实掉的一处假设**：Task 3 用 throw 表达 deadline 拒绝，依赖的是「工具抛错会变成 is_error 结果而不是打断回合」。已读 `packages/core/src/agent.ts:548-580` 确认 `runOneTool` 正是这么做的 —— 所以工具本体（`packages/tools/src/schedule-wakeup.ts`）**一行都不用改**，本计划全部改动都在 `packages/server`。

**留给实现者的唯一判断点**：Task 5 的 `waitUntilQuiescent` 用轮询（250ms）。若实现时发现 SessionManager 已有合适的 turn-end 事件可订阅，改成事件驱动更好 —— 但**不要为此新增事件类型**，轮询在这个场景（最长 1 小时、250ms 一次、只在 cron 触发期间跑）的开销可以忽略。
