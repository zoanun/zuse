# 权限请求队列(Permission Queue)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TUI 权限请求从单例 resolver 改为 FIFO 队列(+同规则清扫),根治并发 ask 死锁,删除 agent.ts 的 wouldAsk 退串行兜底。

**Architecture:** 新增纯逻辑模块 `permissionQueue.ts`(队头兑现 + allow_session/allow_persist 清扫同 rule 项),`useConversation` 用 `queueRef`(真相源)+ state 镜像接线,`canUseTool` 入队不再覆盖;agent.ts 并发条件恢复纯 `readOnly` 判定,canUseTool 契约升级为"实现必须支持并发调用"。

**Tech Stack:** TypeScript + React (ink) + vitest。规范 spec:`docs/superpowers/specs/2026-06-11-permission-queue-design.md`。

**约定:** 所有命令在仓库根 `e:/ai-study/zuse` 执行。提交信息结尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: 纯逻辑模块 permissionQueue(TDD)

**Files:**
- Create: `packages/tui/src/permissionQueue.ts`
- Test: `packages/tui/src/permissionQueue.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/tui/src/permissionQueue.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveHead, type PendingPermission } from './permissionQueue.js'
import type { PermissionVerdict } from '@zuse/core'

/** 造一个队列项;resolve 记录被兑现的裁决,便于断言。 */
function entry(id: string, rule: string, log?: string[]): PendingPermission {
  return {
    id,
    req: { toolName: 'Bash', input: {}, specifier: rule, rule },
    resolve: (v: PermissionVerdict) => log?.push(`${id}:${v}`),
  }
}

describe('resolveHead', () => {
  it('空队列幂等返回空,不抛', () => {
    expect(resolveHead([], 'allow')).toEqual({ settled: [], rest: [] })
  })

  it('allow 只兑现队头,rest 顺序不变', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)'), entry('c', 'Bash(y)')]
    const { settled, rest } = resolveHead(q, 'allow')
    expect(settled.map((p) => p.id)).toEqual(['a'])
    expect(rest.map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('deny 只兑现队头', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)')]
    const { settled, rest } = resolveHead(q, 'deny')
    expect(settled.map((p) => p.id)).toEqual(['a'])
    expect(rest.map((p) => p.id)).toEqual(['b'])
  })

  it('allow_session 清扫队列中同 rule 项(中间+队尾混排),不同 rule 不动', () => {
    const q = [
      entry('a', 'Bash(x)'),
      entry('b', 'Bash(y)'),
      entry('c', 'Bash(x)'),
      entry('d', 'Bash(z)'),
      entry('e', 'Bash(x)'),
    ]
    const { settled, rest } = resolveHead(q, 'allow_session')
    expect(settled.map((p) => p.id)).toEqual(['a', 'c', 'e']) // 保持原顺序
    expect(rest.map((p) => p.id)).toEqual(['b', 'd'])
  })

  it('allow_persist 清扫行为与 allow_session 相同', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)'), entry('c', 'Bash(y)')]
    const { settled, rest } = resolveHead(q, 'allow_persist')
    expect(settled.map((p) => p.id)).toEqual(['a', 'b'])
    expect(rest.map((p) => p.id)).toEqual(['c'])
  })

  it('纯函数:不修改入参数组', () => {
    const q = [entry('a', 'Bash(x)'), entry('b', 'Bash(x)')]
    const snapshot = [...q]
    resolveHead(q, 'allow_session')
    expect(q).toEqual(snapshot)
  })

  it('不在内部调 resolve(副作用归调用方)', () => {
    const log: string[] = []
    const q = [entry('a', 'Bash(x)', log), entry('b', 'Bash(x)', log)]
    resolveHead(q, 'allow_session')
    expect(log).toEqual([]) // resolveHead 本身不触发任何 resolve
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/tui/src/permissionQueue.test.ts`
Expected: FAIL —— `Cannot find module './permissionQueue.js'`(或同义的模块缺失错误)。

- [ ] **Step 3: 写最小实现**

创建 `packages/tui/src/permissionQueue.ts`:

```ts
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'

/**
 * 权限请求队列的队列项。canUseTool 每次被调用就入队一项;UI 一次只显示队头,
 * 用户裁决后经 resolveHead 出队并兑现 resolve,让对应的 gateAndRunTool 继续。
 * 取代旧的单例 resolver —— 并发 ask(同轮只读批 / 将来的并行 subagent)互不覆盖。
 */
export interface PendingPermission {
  /** 入队时生成,仅作 React key / 调试标识。 */
  id: string
  /** 含 toolName/input/specifier/rule/reason,直接喂给 PermissionDialog。 */
  req: PermissionRequest
  /** 兑现即让 agent 循环里 await 此请求的 gateAndRunTool 继续。 */
  resolve: (v: PermissionVerdict) => void
}

/**
 * 队头兑现(纯函数):返回被兑现的项与剩余队列,不修改入参、不调 resolve ——
 * 副作用(依次调用 settled[i].resolve(verdict))由调用方执行,便于单测。
 *
 * allow_session / allow_persist 时清扫队列中相同 rule 的等待项一并兑现:语义与
 * decide() 一致 —— 这些项若晚一点过权限闸,本来就会被刚加进 sessionAllow 的规则
 * 自动放行,提前兑现只是省去无意义的重复弹框。allow(仅本次)/ deny 不清扫,
 * 逐个问,保守正确。rule 按字面相等比较(buildRule 的整串),不做前缀/glob 推断。
 */
export function resolveHead(
  queue: readonly PendingPermission[],
  verdict: PermissionVerdict,
): { settled: PendingPermission[]; rest: PendingPermission[] } {
  if (queue.length === 0) return { settled: [], rest: [] }
  const head = queue[0]!
  const tail = queue.slice(1)
  if (verdict === 'allow_session' || verdict === 'allow_persist') {
    return {
      settled: [head, ...tail.filter((p) => p.req.rule === head.req.rule)],
      rest: tail.filter((p) => p.req.rule !== head.req.rule),
    }
  }
  return { settled: [head], rest: tail }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/tui/src/permissionQueue.test.ts`
Expected: PASS,7 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/permissionQueue.ts packages/tui/src/permissionQueue.test.ts
git commit -m "feat(tui): 权限队列纯逻辑 resolveHead(FIFO+同规则清扫)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: useConversation 接线(单例 → 队列)

**Files:**
- Modify: `packages/tui/src/hooks/useConversation.ts`(权限相关四处:state 声明、canUseTool、resolvePermission、返回值/接口)

- [ ] **Step 1: 加 import**

在 `packages/tui/src/hooks/useConversation.ts` 顶部 import 区(`import { osc8FileLink } ...` 附近)加:

```ts
import { resolveHead, type PendingPermission } from '../permissionQueue.js'
```

- [ ] **Step 2: 替换单例 state 为队列**

找到(当前约 104-107 行):

```ts
  // 等待用户裁决的权限请求；非 null 时渲染对话框、禁用输入框。
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // 保存当前 ask 的 resolve，按键后调用它让 agent 循环继续。
  const permissionResolveRef = useRef<((v: PermissionVerdict) => void) | null>(null)
```

替换为:

```ts
  // 权限请求 FIFO 队列。真相源放 ref:canUseTool 在 agent 循环的异步上下文里被调,
  // 不能依赖闭包里可能陈旧的 state;每次入队/兑现先改 ref 再同步 state 镜像驱动渲染。
  // UI 一次只显示队头;并发 ask(同轮只读批)各自入队、互不覆盖。
  const queueRef = useRef<PendingPermission[]>([])
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([])
```

- [ ] **Step 3: 改 canUseTool 为入队**

找到 sendMessage 里 runAgent 的参数(当前约 243-247 行):

```ts
          canUseTool: (req: PermissionRequest) =>
            new Promise<PermissionVerdict>((resolve) => {
              permissionResolveRef.current = resolve
              setPendingPermission(req)
            }),
```

替换为:

```ts
          canUseTool: (req: PermissionRequest) =>
            new Promise<PermissionVerdict>((resolve) => {
              queueRef.current = [...queueRef.current, { id: generateId(), req, resolve }]
              setPermissionQueue(queueRef.current)
            }),
```

- [ ] **Step 4: 改 resolvePermission 为队头兑现**

找到(当前约 378-384 行):

```ts
  // 用户在对话框按键 → 兑现 agent 正在 await 的 promise，并收起对话框。
  const resolvePermission = useCallback((verdict: PermissionVerdict) => {
    const resolve = permissionResolveRef.current
    permissionResolveRef.current = null
    setPendingPermission(null)
    resolve?.(verdict)
  }, [])
```

替换为:

```ts
  // 用户在对话框按键 → 兑现队头(allow_session/allow_persist 连带清扫同 rule 项),
  // 下一项自动顶上。必须先更新队列再调 resolver:resolver 会让 agent 循环继续,
  // 可能同步触发下一个 canUseTool 入队 —— 顺序反了的话,新入队的项会被旧的
  // rest 快照覆盖丢失。
  const resolvePermission = useCallback((verdict: PermissionVerdict) => {
    const { settled, rest } = resolveHead(queueRef.current, verdict)
    queueRef.current = rest
    setPermissionQueue(rest)
    for (const p of settled) p.resolve(verdict)
  }, [])
```

- [ ] **Step 5: 改对外接口(派生 pendingPermission + 新增队列长度)**

`UseConversationReturn` 接口(当前约 59-60 行)的:

```ts
  pendingPermission: PermissionRequest | null
  resolvePermission: (verdict: PermissionVerdict) => void
```

替换为:

```ts
  /** 权限队列队头(当前显示的请求);null = 无弹框。派生自队列,App 渲染判断不变。 */
  pendingPermission: PermissionRequest | null
  resolvePermission: (verdict: PermissionVerdict) => void
  /** 权限队列总长(含队头)。>1 时对话框标题显示 (1/N)。 */
  permissionQueueLength: number
```

返回对象里(当前约 514-515 行)的:

```ts
    pendingPermission,
    resolvePermission,
```

替换为:

```ts
    pendingPermission: permissionQueue[0]?.req ?? null,
    resolvePermission,
    permissionQueueLength: permissionQueue.length,
```

- [ ] **Step 6: typecheck + 全量测试**

Run: `npx tsc --noEmit -p packages/tui && npx vitest run packages/tui`
Expected: typecheck 通过;tui 既有测试全绿(本 task 无新测试 —— 队列行为已由 Task 1 单测覆盖,hook 接线无现成测试基建,不为此搭)。

- [ ] **Step 7: 提交**

```bash
git add packages/tui/src/hooks/useConversation.ts
git commit -m "feat(tui): 权限请求单例 resolver 改为 FIFO 队列接线

canUseTool 入队不再覆盖;resolvePermission 先更新队列再兑现 resolver,
防 resolver 同步触发的新入队被旧快照覆盖。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: PermissionDialog 计数标注 + App 传参

**Files:**
- Modify: `packages/tui/src/components/PermissionDialog.tsx`
- Modify: `packages/tui/src/App.tsx`(解构处约 60-77 行、渲染处约 175-176 行)

- [ ] **Step 1: PermissionDialog 加 queueLength prop**

`packages/tui/src/components/PermissionDialog.tsx` 的 props 接口与组件头部:

```ts
interface PermissionDialogProps {
  req: PermissionRequest
  onDecision: (verdict: PermissionVerdict) => void
  /** 权限队列总长(含当前显示的队头)。>1 时标题显示 (1/N),提示后面还有排队的请求。 */
  queueLength?: number
}
```

组件实现(替换原 `export function PermissionDialog({ req, onDecision }` 及标题行):

```tsx
export function PermissionDialog({ req, onDecision, queueLength }: PermissionDialogProps) {
  const detail = req.specifier ? `${req.toolName}: ${req.specifier}` : req.toolName
  const title = queueLength !== undefined && queueLength > 1 ? `权限请求 (1/${queueLength})` : '权限请求'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
```

其余(detail/reason/SelectList)不动。

- [ ] **Step 2: App.tsx 传参**

`packages/tui/src/App.tsx` 的 useConversation 解构(约 60-77 行)中,`resolvePermission,` 之后加一行:

```ts
    permissionQueueLength,
```

渲染处(约 175-176 行):

```tsx
      {pendingPermission ? (
        <PermissionDialog req={pendingPermission} onDecision={resolvePermission} />
```

替换为:

```tsx
      {pendingPermission ? (
        <PermissionDialog req={pendingPermission} onDecision={resolvePermission} queueLength={permissionQueueLength} />
```

- [ ] **Step 3: typecheck + tui 测试**

Run: `npx tsc --noEmit -p packages/tui && npx vitest run packages/tui`
Expected: 全绿(若存在 PermissionDialog 既有快照/文案断言,`queueLength` 未传或 ≤1 时标题仍为「权限请求」,不受影响)。

- [ ] **Step 4: 提交**

```bash
git add packages/tui/src/components/PermissionDialog.tsx packages/tui/src/App.tsx
git commit -m "feat(tui): 权限对话框排队计数标注 (1/N)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: agent.ts 删 wouldAsk 兜底(先反转测试,后删码)

**Files:**
- Modify: `packages/core/src/agent.test.ts`(既有测试 `serializes read-only tools that hit an ask rule...` 整体替换)
- Modify: `packages/core/src/agent.ts`(并发判定块,当前约 161-201 行)

- [ ] **Step 1: 反转回归测试契约**

`packages/core/src/agent.test.ts` 中找到整个 `it('serializes read-only tools that hit an ask rule, so permission prompts never overlap', ...)` 测试块,**整体替换**为:

```ts
  it('runs concurrent ask prompts on read-only tools without deadlock', async () => {
    // 契约:canUseTool 实现必须支持并发调用(多个未兑现 promise 同时在飞)。
    // TUI 用权限队列满足之;本测试的实现直接并发応答。断言两个只读工具的 ask
    // 同时在飞(maxInFlight=2)且都完成 —— 锁住「并发 ask 不死锁」。
    // 历史:旧实现用单例 resolver,并发第二个 ask 会覆盖第一个的 resolve,
    // Promise.all 永不 settle;当时靠 agent.ts 的 wouldAsk 预检退串行绕开,
    // 权限队列落地后兜底已删,本测试取而代之。
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const canUseTool = async (): Promise<PermissionVerdict> => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((res) => setTimeout(res, 10))
      inFlight--
      return 'allow'
    }

    const reg = new ToolRegistry()
    for (const name of ['r1', 'r2']) {
      reg.register({
        name, description: '', readOnly: true,
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ output: name }),
      })
    }
    const askSettings: ResolvedSettings = {
      tools: {},
      permissions: { defaultMode: 'default', allow: [], ask: ['r1', 'r2'], deny: [] },
      providers: {},
    }

    const { client } = fakeClient([
      [
        { type: 'tool-use', id: 'a', name: 'r1', input: {} },
        { type: 'tool-use', id: 'b', name: 'r2', input: {} },
        { type: 'message-stop', stop_reason: 'tool_use', usage: USAGE },
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'message-stop', stop_reason: 'end_turn', usage: USAGE }],
    ])

    const events = await collect(runAgent({
      conversation: new Conversation(), client, registry: reg, userText: 'go', config, cwd: '.', signal,
      settings: askSettings, canUseTool,
    }))

    // 两个 ask 都被问到且同时在飞 —— 不再退串行,也不死锁。
    expect(calls).toBe(2)
    expect(maxInFlight).toBe(2)
    // 两个工具结果仍按各自 id 回喂。
    const results = events.filter((e) => e.type === 'tool-result') as Array<{ id: string; output: string }>
    expect(results.map((r) => `${r.id}:${r.output}`).sort()).toEqual(['a:r1', 'b:r2'])
  })
```

- [ ] **Step 2: 跑测试确认失败(旧实现退串行,maxInFlight=1)**

Run: `npx vitest run packages/core/src/agent.test.ts -t "without deadlock"`
Expected: FAIL —— `expect(maxInFlight).toBe(2)` 收到 1(wouldAsk 兜底仍在,批退串行)。

- [ ] **Step 3: 删 wouldAsk,恢复纯 readOnly 并发判定**

`packages/core/src/agent.ts` 中找到从 `// 同一轮里的多个 tool_use 之间天然无数据依赖` 开始、到 `const canRunConcurrently = ...` 结束的整块(当前约 163-182 行),**整体替换**为:

```ts
    // 同一轮里的多个 tool_use 之间天然无数据依赖（模型一次性请求时还没看到任何结果，
    // 有依赖会分轮做）。但「无数据依赖」≠「无副作用」：Bash 的 cd 改写共享 sessionCwd、
    // Edit 的乐观锁竞争同一文件。所以只在「整批全是只读工具」时才并发 —— 只读工具不调
    // setCwd（cwd 全程不变、共享快照无碍），也不竞争文件锁；混进一个写工具就维持串行。
    //
    // 只读 ≠ 免审：decide() 里 ask 规则先于 readOnly 自动放行判定，并发批内可能多个
    // 工具同时走到 ask。这由 canUseTool 的契约兜住：实现必须支持并发调用（多个未兑现
    // 的 promise 同时在飞）—— TUI 的实现是权限请求队列（弹框逐个排队、互不覆盖，见
    // tui/permissionQueue.ts）；headless 调用方自行保证其 canUseTool 可并发。
    const allReadOnly = toolUses.every((tu) => registry.get(tu.name)?.readOnly === true)
```

再找到并发分支(当前约 200-208 行):

```ts
    let outputs: Array<{ output: string; isError: boolean }>
    if (canRunConcurrently) {
      // 并发执行整批只读工具。已排除会命中 ask 的工具,故并发路径不会触碰 canUseTool;
      // gateAndRunTool 余下逻辑（decide=allow → runOneTool）内部把异常 try/catch 成 isError、
      // 从不抛出,所以 Promise.all 不会因单个失败而整体 reject。只读工具不调 setCwd,cwd 全程不变。
      outputs = await Promise.all(toolUses.map((tu) => gateAndRunTool(registry, tu, buildCtx(), gateDeps())))
    } else {
      // 含写工具 / 单个工具 / 任一工具会命中 ask：串行,保住 cd、乐观锁、ask 排队的顺序语义。
```

替换为:

```ts
    let outputs: Array<{ output: string; isError: boolean }>
    if (allReadOnly && toolUses.length > 1) {
      // 并发执行整批只读工具。gateAndRunTool 把工具异常 try/catch 成 isError 结果;
      // ask 路径的 canUseTool 按契约可并发(见上),故 Promise.all 不会卡死或整体 reject。
      outputs = await Promise.all(toolUses.map((tu) => gateAndRunTool(registry, tu, buildCtx(), gateDeps())))
    } else {
      // 含写工具（或单个工具）：串行,保住 cd / 乐观锁的顺序语义。
```

注意:`buildCtx` / `gateDeps` 两个工厂与串行分支均不动;`decide` 仍被 `gateAndRunTool` 使用,import 不删。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/core/src/agent.test.ts`
Expected: PASS,全部用例绿(含既有并发屏障测试 `runs multiple read-only tools concurrently in one turn`)。

- [ ] **Step 5: typecheck + core 全量**

Run: `npx tsc --noEmit -p packages/core && npx vitest run packages/core/src/agent.test.ts packages/core/src/permission.test.ts packages/core/src/settings.test.ts`
Expected: typecheck 通过(若报 `wouldAsk`/`canRunConcurrently` 未使用残留,说明 Step 3 替换不完整,回去清干净);测试全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/agent.ts packages/core/src/agent.test.ts
git commit -m "refactor(core): 删 wouldAsk 退串行兜底,canUseTool 契约升级为可并发

权限队列(tui/permissionQueue)落地后并发 ask 由队列排队,不再死锁;
只读批恢复纯并发。回归测试契约反转:并发 ask 同时在飞且都完成。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 全量验收

**Files:** 无新改动。

- [ ] **Step 1: 全仓测试 + typecheck**

Run: `npx vitest run && pnpm -r typecheck`
Expected: 除既有的 live API 测试(`anthropic-client.test.ts` 真实网络调用,与本特性无关)外全部通过;typecheck 三包全绿。

- [ ] **Step 2: 手工冒烟(可选但建议)**

在 `.zuse/settings.local.jsonc` 临时加 `"ask": ["Read(./**)"]`,启动 TUI,让模型一轮读两个文件:
- 预期:弹框出现且标题为 `权限请求 (1/2)`;答完第一个,第二个自动顶上(若选「本会话总是允许」且两请求 rule 相同,则一次清空);无挂死。
- 验完撤销临时配置。

- [ ] **Step 3: 快进 master(里程碑收尾,按用户分支约定)**

```bash
git checkout master && git merge --ff-only input-layer-foundation && git checkout input-layer-foundation
```

Expected: master 快进成功(本分支是 master 的纯前进延伸,无分叉)。

---

## Self-Review 记录

- Spec 覆盖:resolveHead 纯函数/清扫语义(Task 1)、queueRef+镜像与先更新后兑现(Task 2)、派生 pendingPermission 与 App 兼容(Task 2/3)、计数标注(Task 3)、agent.ts 删兜底与契约注释(Task 4)、测试契约反转(Task 4)、边界(空队列幂等、Esc=deny 队头不变、写盘幂等)均有对应任务。
- 占位符:无 TBD/TODO;每个代码步骤均含完整代码。
- 类型一致:`PendingPermission`/`resolveHead` 签名在 Task 1 定义,Task 2 引用一致;`permissionQueueLength` 在 Task 2 导出、Task 3 消费,命名一致。
