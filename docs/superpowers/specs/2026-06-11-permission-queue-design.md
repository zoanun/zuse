# 权限请求队列(Permission Queue)设计

日期:2026-06-11
状态:已批准(方案 B:FIFO + 同规则清扫)
关联:Phase 5(权限模型)收尾增强;Phase 15(多 Agent 编排)前置项

## 背景与问题

TUI 的权限弹框机制是**单例**:`useConversation.ts` 用一个 `pendingPermission` state 加一个
`permissionResolveRef` 保存"当前唯一一个等待裁决的请求"。`canUseTool` 每次被调用都直接
覆盖这两处:

```ts
canUseTool: (req) => new Promise((resolve) => {
  permissionResolveRef.current = resolve   // ← 第二个并发请求会覆盖第一个
  setPendingPermission(req)
})
```

agent.ts 引入只读工具并发路径(`Promise.all`)后,出现硬死锁:同一轮两个只读工具都命中
ask 规则(`decide()` 里 ask 判定先于 readOnly 自动放行,`ask: ['Read(./**)']` 这类配置合法)
→ 两个 `canUseTool` 并发 → 第二个覆盖第一个的 resolver → 第一个 promise 永不兑现 →
`Promise.all` 永不 settle → agent 循环卡死、输入框禁用。

当前的临时修法是调度层兜底:agent.ts 用 `wouldAsk` 预检,批内任一工具会命中 ask 就整批退
回串行。它堵住了单 agent 内的死锁,但有两个局限:

1. 批内一个工具要弹框,同批 auto-allow 的只读工具也被拖成串行(并行度损失,虽小);
2. **罩不住将来的并行 subagent**(Phase 15):多个 `runAgent` 实例各自独立判定、互不知情,
   两个 agent 各自合法走到 ask 仍会并发打到单例 resolver,同样死锁。调度层无法跨实例协调。

参考实现:cc-haha 在权限层解决此问题——权限请求进队列(按 toolUseID push/remove),每个
请求独立 resolver,UI 一次显示一个,auto-approve 的工具照常并行。

## 目标

- 权限请求从单例改为 **FIFO 队列**:任意多个请求可同时 pending,互不覆盖,各自独立兑现。
- 删除 agent.ts 的 `wouldAsk` 退串行兜底,只读批恢复纯并发(弹框自然排队)。
- 为 Phase 15 并行 subagent 铺路:届时多个 runAgent 实例共用同一个 `canUseTool`,队列天然承接。

## 非目标

- 不做 subagent 本身(Phase 15)。
- 不照搬 cc-haha 全套 PermissionContext(ResolveOnce/claim/update/外部权限后端)——当前体量
  用不上,YAGNI。
- 不改 `decide()` 权限判定语义、不改四档裁决(allow / allow_session / allow_persist / deny)。
- 不处理"跨 agent 的 sessionAllow 写竞态 / appendAllowRule 写盘竞态"——单 agent 下队列逐个
  兑现、天然串行;多 agent 的策略(子代理是否继承父会话 allow 层)留给 Phase 15 设计。

## 方案选型

| 方案 | 描述 | 取舍 |
| --- | --- | --- |
| A. 纯 FIFO | 只排队,逐个问 | 最简,但并行同命令会重复弹一样的框(答了"本会话总是允许"还再问) |
| **B. FIFO + 同规则清扫(选定)** | A 基础上,`allow_session`/`allow_persist` 兑现队头时,把队列里相同 `rule` 的等待项按同一裁决一并兑现 | 语义与 `decide()` 一致:这些项若晚一点过闸,本来就会被刚加进 sessionAllow 的规则自动放行。`allow`(仅本次)与 `deny` 不清扫,逐个问,保守正确 |
| C. cc-haha 全套 | PermissionContext + ResolveOnce + claim | 过重,非目标 |

## 设计

### 1. 新模块:`packages/tui/src/permissionQueue.ts`(纯逻辑,可独立单测)

```ts
import type { PermissionRequest, PermissionVerdict } from '@zuse/core'

export interface PendingPermission {
  id: string                                // 入队时生成,仅作 React key / 调试标识
  req: PermissionRequest                    // 含 toolName/input/specifier/rule/reason
  resolve: (v: PermissionVerdict) => void   // 兑现即让对应 gateAndRunTool 继续
}

/** 队头兑现。返回被兑现的项(含清扫项)与剩余队列;不在内部调 resolve,由调用方执行副作用。 */
export function resolveHead(
  queue: PendingPermission[],
  verdict: PermissionVerdict,
): { settled: PendingPermission[]; rest: PendingPermission[] }
```

- 队列为空时 `resolveHead` 返回 `{ settled: [], rest: [] }`(幂等,不抛)。
- `verdict` 为 `allow_session` / `allow_persist`:`settled` = 队头 + 队列中所有
  `req.rule === 队头.req.rule` 的项(保持原顺序);`rest` = 其余。
- `verdict` 为 `allow` / `deny`:`settled` = 仅队头;`rest` = 其余。
- 纯函数:不修改入参数组,不调 resolve——副作用(依次调用 `settled[i].resolve(verdict)`)
  由 hook 层执行,便于测试。

### 2. `useConversation.ts` 改接线

- 删除 `permissionResolveRef` 单例 ref 与 `pendingPermission` 单例 state。
- 新增 `queueRef = useRef<PendingPermission[]>([])`(真相源)+
  `const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([])`(渲染镜像)。
  真相源放 ref:`canUseTool` 在 agent 循环的异步上下文里被调,不能依赖闭包里可能陈旧的
  state;每次入队/兑现先改 ref 再 `setPermissionQueue([...queueRef.current])` 同步镜像。
- `canUseTool`:

```ts
canUseTool: (req) => new Promise((resolve) => {
  queueRef.current = [...queueRef.current, { id: generateId(), req, resolve }]
  setPermissionQueue(queueRef.current)
})
```

- 对外接口保持兼容:导出的 `pendingPermission` 改为派生值 `permissionQueue[0]?.req ?? null`
  (App.tsx 的 `dialogOpen` / 渲染判断不用动);另导出 `permissionQueueLength`(供对话框显示
  计数)。
- `resolvePermission(verdict)`:

```ts
const { settled, rest } = resolveHead(queueRef.current, verdict)
queueRef.current = rest
setPermissionQueue(rest)
for (const p of settled) p.resolve(verdict)
```

  先更新队列再调 resolver:resolver 会让 agent 循环继续,可能同步触发下一个 `canUseTool`
  入队;若顺序反过来,新入队的项会被旧的 `rest` 快照覆盖丢失。

### 3. `PermissionDialog.tsx`:排队计数标注

新增可选 prop `queueLength?: number`;`queueLength > 1` 时标题渲染为
`权限请求 (1/N)`,否则维持 `权限请求`。让用户知道答完这个后面还有排队的。
交互不变:方向键选择、回车确认、Esc = deny(只 deny 队头,下一项自动顶上)。

### 4. `agent.ts`:删调度层兜底

- 删除 `wouldAsk` 预检与 `canRunConcurrently`,并发条件恢复为
  `allReadOnly && toolUses.length > 1`。
- 注释更新:说明"只读 ≠ 免审,并发批内的 ask 由调用方的 canUseTool 实现负责排队
  (TUI 为权限队列);headless 调用方自行保证其 canUseTool 可并发"。这是 `canUseTool`
  回调契约的一部分:**实现必须支持并发调用**(多个未兑现的 promise 同时在飞)。

### 5. 测试

**`permissionQueue.test.ts`(新增,纯单测):**
- 空队列 resolveHead → `{[], []}`,不抛;
- `allow` / `deny` 只兑现队头,rest 顺序不变;
- `allow_session` 清扫同 rule 项(队头 + 中间 + 队尾混排),不同 rule 不动;
- `allow_persist` 清扫行为与 allow_session 相同;
- 纯函数性:入参数组不被修改。

**`agent.test.ts`(改写既有回归):**
- 原"serializes read-only tools that hit an ask rule"测试反转契约:两个只读工具命中 ask,
  canUseTool 实现允许并发(各自延时后 resolve),断言**两个请求都被问到、都完成、无挂死**
  (`calls === 2`,容许 `maxInFlight === 2`),结果按各自 id 回喂。锁住"并发 ask 不死锁"。

**`useConversation` 层:**
- 队列接线的行为(入队顺序、resolvePermission 先更新后兑现)由 permissionQueue 单测 +
  agent 集成测试覆盖;hook 本身不新增专门测试(现状无 hook 级测试基建,不为此搭)。

## 边界与错误处理

- **Esc 取消** = deny 队头(现行为),下一项自动顶上,直至队列清空。
- **回合中断与弹框互斥的现状不变**:对话框打开时输入框被占住,`interrupt()` 不可达;
  队列里的请求都属于进行中的回合,逐个应答后回合自然推进或结束。
- **重复兑现防护**:`resolveHead` 把项从队列移除后才调 resolve,同一项不可能被二次取出;
  Promise 的 resolve 本身幂等(二次调用是 no-op),无需 cc-haha 的 ResolveOnce。
- **allow_persist 并发写盘**:单 agent 内裁决逐个兑现,`appendAllowRule` 写盘天然串行;
  同规则清扫只对**同一条 rule** 生效且只触发一次写盘(settled 项共享同一裁决,写盘动作在
  gateAndRunTool 内各自执行——`appendAllowRule` 幂等去重,重复写同一规则无害)。
- **同规则清扫的边界**:`rule` 是 `buildRule(toolName, specifier)` 的整串(如
  `Bash(git status)`),仅字面相等才清扫;不同命令/路径各自弹框,不做前缀/glob 推断。
- **连发按键防护(实施期增补)**:输入层对同一 stdin chunk 的多个按键同步循环派发,
  重渲染滞后于同步块 —— 按住 Enter/Esc 会在同一渲染窗口连调 resolvePermission,第二次
  会盲裁决未展示的下一项。故 resolvePermission 带 expectedHeadId(调用方渲染快照的队头
  id),与真实队头不符即丢弃。旧单例无此问题(第二次按键 resolve null 天然 no-op)。
  局限:守卫只防同一渲染窗口内的连发;跨 chunk 的按住 Enter 仍会每次 React commit 兑现
  一项(终端绘制可能滞后于 commit)——这是终端 UI 不引入防抖的已接受局限,对话框按队头
  id key remount,保证每个新队头至少从默认项「允许本次」开始。

## 影响面

| 文件 | 改动 |
| --- | --- |
| `packages/tui/src/permissionQueue.ts` | 新增(纯逻辑 + 类型) |
| `packages/tui/src/permissionQueue.test.ts` | 新增 |
| `packages/tui/src/hooks/useConversation.ts` | 单例 → 队列接线;导出 `permissionQueueLength` |
| `packages/tui/src/App.tsx` | 给 PermissionDialog 传 `queueLength`(一行) |
| `packages/tui/src/components/PermissionDialog.tsx` | 标题计数标注(可选 prop) |
| `packages/core/src/agent.ts` | 删 `wouldAsk`/`canRunConcurrently`,恢复纯 readOnly 并发判定,注释更新 canUseTool 并发契约 |
| `packages/core/src/agent.test.ts` | 回归测试契约反转(并发 ask 不死锁) |

## 与后续 Phase 的衔接

Phase 15 并行 subagent 时:多个 runAgent 实例共用同一个 `canUseTool`(TUI 注入的队列版),
跨 agent 的 ask 自动排队,无需再动权限层。届时需另行设计的是 sessionAllow 的共享策略与
`appendAllowRule` 跨实例写盘串行化(见"非目标")。
