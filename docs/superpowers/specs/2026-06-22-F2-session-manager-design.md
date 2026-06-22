# F2 — Headless 会话编排核心（SessionManager）设计

> **日期**: 2026-06-22
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 的地基 spec F2
> **前置**: F0（纯模块下沉 core）、F1（`packages/server` 骨架）
> **下游**: F3（WS 协议接线）消费本模块

---

## 1. 目标与边界

把 TUI `useConversation.ts`（1116 行 React hook）里的会话编排，移植成一个**框架无关、传输无关**的 headless `SessionManager`，作为 Web 后端的会话大脑。

**最高约束：解耦。** 本模块是 **Web 专属**，落在 `packages/server`，**不被 TUI 消费、不迁移 TUI**。它与 TUI 的 `useConversation` 是两个独立演进的编排大脑，只共享 `packages/core` 里的纯原语。详见总纲 §2。

**归属**
- `packages/server/src/session/SessionManager.ts` —— 一个实例 = 一个活动会话。
- `packages/server/src/session/SessionRegistry.ts` —— 极薄 `Map<sessionId, SessionManager>`，供 F3 路由。**完整多会话持久化/列表是 S1**；F2 只做单会话内存态 + 这个路由壳。
- **零 WS/HTTP import**。任何传输概念泄漏进本模块都是设计错误。

**不在 F2 范围（展示层，归 F4 / 各前端）**
- `summarizeOutput` / 工具输出落盘 / OSC-8 链接 / markdown 渲染 / UIMessage 气泡构造。
- F2 **只发原始语义事件**：工具结果带 `event.output` 全文，前端自行决定截断/落盘/渲染。

## 2. 依赖的现有 core 接口（已核实）

- `runAgent(opts: RunAgentOptions): AsyncIterable<StreamEvent>`（`packages/core/src/agent.ts:117`）。入参含 `conversation / client / registry / userText / config / cwd / signal / tracker / settings / sessionAllow / canUseTool / onCwdChange / consumeSteer`。
- `canUseTool?: (req: PermissionRequest) => Promise<PermissionVerdict>`（`agent.ts:78`）。**仅在 'ask' 分支被调用**（`agent.ts:342`，allow/deny 已被 `decide()` 提前裁掉）；契约要求**支持并发**调用。
- 权限类型（`packages/core/src/types.ts`）：`PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'`；`PermissionsConfig = { defaultMode, allow[], ask?, deny[] }`；`PermissionRequest = { toolName, input, specifier, rule, reason }`；`PermissionVerdict = 'allow' | 'deny' | 'allow_session' | 'allow_persist'`；`decide()`（`permission.ts:178`）。
- 压缩：`packages/core/src/compaction.ts` 的 `summarizeForCompaction / findCompactionCut / findCompactionCutByBudget / applyCompaction / extractPreviousSummary / splitMemoryCandidates / estimateCompactionSavings / remapCheckpoints`，及 `resolveContextWindow`、阈值常量 `COMPACTION_THRESHOLD / TAIL_BUDGET_RATIO`。
- failover：`decideFailover / modelKey / badKeysForFailure / resolveFailoverMode`（**当前在 `packages/tui/src/hooks/failoverCore.ts`，F0 须先移到 core**）。
- 记忆巩固：`packages/core/src/memory-consolidation.ts`（`shouldConsolidateMemories / buildConsolidationPrompt / parseConsolidationOps / applyMemoryConsolidation` 等）。
- `Conversation`、`ModelClient` / `createModelClient` / `getProviderConfig`、检查点 SnapshotStore、`autosaveSession`。

## 3. 持有状态（useConversation 的 ref → 实例字段）

| 字段 | 类型 | 来源 ref |
|------|------|----------|
| `conversation` | `Conversation` | `conversationRef` |
| `client` | `ModelClient`（failover 热换） | `clientRef` |
| `cwd` | `string` | `cwdRef` |
| `abort` | `AbortController \| null`（每回合） | `abortRef` |
| `steerQueue` | `string[]` | `steerQueueRef` |
| `todos` | `TodoItem[]` | `todosRef` |
| `checkpoints` | `SessionCheckpoint[]` | `checkpointsRef` |
| `badModels` | `Map<string, ErrorCategory>` | `badModelsRef` |
| `contextTokens` | `number \| undefined` | `contextTokensRef` |
| `ineffectiveCompaction` | `number` | `ineffectiveCompactionRef` |
| `totalUsage` | usage | `state.totalUsage` |
| `permissionPolicy` | 见 §6 | （新增）|
| `pendingPermissions` | `Map<id, {req, resolve}>` | `queueRef` |
| `tracker / snapshotStore / sessionId / createdAt` | — | 对应 ref |

## 4. 公开 API（全部传输无关）

```ts
class SessionManager {
  constructor(opts: {
    sessionId: string
    cwd: string
    client: ModelClient
    registry: ToolRegistry
    settings: ResolvedSettings
    systemPrompt: string
    permissionPolicy: PermissionPolicy   // 见 §6
    snapshotStore: SnapshotStore
    // ...tracker / createdAt / 初始 conversation(可选,用于 resume)
  })

  submit(text: string, parts?: MessagePart[]): Promise<void>  // 起一个回合
  interrupt(): boolean                                        // abort 当前回合
  steer(text: string): void                                   // 入 steer 队列
  resolvePermission(id: string, verdict: PermissionVerdict): void  // 应答挂起权限(并发安全)
  switchModel(providerId: string, model: string): void
  compact(): Promise<string>                                  // 手动压缩,返回摘要文案
  revert(checkpointId: string): Promise<void>
  getState(): SessionSnapshot                                 // 给迟到/重连客户端的全量快照
  subscribe(listener: (e: SessionEvent) => void): () => void  // 订阅事件,返回退订
  setPermissionPolicy(p: PermissionPolicy): void
}
```

- `subscribe` 返回退订函数；多订阅者（多设备同看一会话）共享同一事件流。
- `getState()` 返回当前消息账本投影 + `isThinking` + `totalUsage` + `contextTokens` + `todos` + `pendingPermissions` 列表 + 当前 model/cwd，供重连方瞬间对齐。

## 5. 事件模型

`SessionEvent` 是 `runAgent` 的 `StreamEvent` 超集 + 编排事件。所有改变可观测状态的动作都 emit 一个事件（替代 TUI 的 `setState/notify`）。

| 类别 | 事件 |
|------|------|
| 透传 runAgent | `message-start` / `text-delta` / `tool-use` / `tool-result`（带 `output` 全文）/ `message-stop` |
| 回合 | `turn-start` / `turn-end` |
| 用量 | `usage-update` / `context-update` |
| 权限 | `permission-request{ id, req }` / `permission-resolved{ id, verdict }` |
| 压缩 | `compaction-start` / `compaction-done{ summaryText }` |
| 降级 | `failover{ fromModel, toModel, reason }` |
| 检查点 | `checkpoint-recorded{ id, messageIndex, label }` |
| 记忆 | `memory-notice{ text }` |
| 其它 | `todos-update` / `cwd-change` / `warning{ message }` / `error{ message, category }` / `aborted` |

> **稳定性**：事件是 plain JSON-able 对象（无函数、无类实例），F3 可直接序列化到 WS。

## 6. 权限流（落实"每会话策略"）

`PermissionPolicy = { mode: PermissionMode; interactive: boolean; config: PermissionsConfig }`

F2 提供给 runAgent 的 `canUseTool`（只会被 'ask' 类调用）按下列裁决：

1. **非交互会话**（`interactive === false`，如 cron/频道预设）：按 `config`/`mode` 确定性裁决——命中 allow 白名单 → `allow`，否则 `deny`。**不外发、不阻塞**。这正是无人值守不卡死的保证。
2. **交互会话**（`interactive === true`，浏览器在用）：
   - 生成 `id`，存入 `pendingPermissions`，emit `permission-request{ id, req }`。
   - 返回一个 Promise，在 `resolvePermission(id, verdict)` 被调用时兑现（并发安全：多条 ask 可同时挂起，各自独立兑现）。
   - 客户端中途断开：请求**留挂起**；重连方经 `getState().pendingPermissions` 看到并应答。
   - `allow_session` / `allow_persist` 经现有 `onPersistAllow` 路径推进 `sessionAllow` / 落盘规则（复用 core）。

复用 core 的 `decide()`/`PermissionsConfig`，**不造新文法**。

## 7. 回合循环（`submit` 内部，移植 useConversation 486–851，去 UI）

1. client 未初始化 → emit `error`，return。
2. **自动压缩**（非 resend）：按当前 model 解析窗口，若 `contextTokens > window*COMPACTION_THRESHOLD && ineffectiveCompaction < 2` → `compact()`（失败非致命，emit `warning` 后照发）。
3. 取 `conversation`（**必须在压缩之后取**——压缩会换 Conversation 实例，详见 useConversation 533–536 的坑）。
4. 检查点：回合前 fire-and-forget `snapshotStore.track()`，记 `checkpointIndex = conversation.length`。
5. 建 `AbortController`，`emit turn-start`。
6. `for await (event of runAgent({...}))`：
   - 透传 `message-start/text-delta/tool-use/tool-result/message-stop` → emit（tool-result 带全文 output）。
   - `message-stop`：`contextTokens = input_tokens + cache_read_input_tokens`（含缓存才是真实窗口占用，见 useConversation 703–705），emit `usage-update`/`context-update`。
   - `error`：若 `signal.aborted` → emit `aborted`；否则 preStream(`accumulated==='' && 无 assistant`) 且 `category∈{quota,auth}` → 记 `failoverDecision`；其余 emit `error`。
   - `warning` → emit。
   - `canUseTool` / `consumeSteer` / `onCwdChange` 接 §6 / steerQueue / cwd 字段。
7. 回合后：记检查点（track 成功才记，含出错回合）、`autosaveSession` fire-and-forget、`maybeConsolidateMemories` fire-and-forget。
8. **failover**（移植 784–840）：标坏 → `decideFailover` → retry 则热换 client + emit `failover` + 新窗口检查（超阈值先 compact）+ `submit(text, {isResend})`；dialog 模式则 emit 一个需前端介入的事件（Web 下等价"请切换模型"，由前端弹 M 选择器，超出 F2）。
9. `finally`：`abort = null`。

## 8. 压缩（移植 `compactConversation` 341–424，去 UI）

照搬：窗口预算尾部保护、迭代摘要（`extractPreviousSummary`）、TodoWrite 状态注入摘要 prompt（`todosRef` → `todoState`，保证 Pending Items 保留）、记忆冲刷（`splitMemoryCandidates` → Memory 工具入库）、反抖动计数、`applyCompaction` 换账本、`remapCheckpoints`、清 `contextTokens`、emit `compaction-start/done`。系统 prompt 的 MEMORY.md 重载（TUI 用 `compactionCounter` 触发 useMemo）在 F2 改为：压缩后重新 `loadPromptSections` 刷新 `systemPrompt` 字段。

## 9. 错误处理矩阵

| 情形 | 处理 |
|------|------|
| abort（Esc/interrupt） | emit `aborted`，定格流 |
| preStream quota/auth | failover（标坏→决策→热换/重发 或 需前端选模型） |
| 流中错误 | emit `error`（重发会重复内容，故不降级） |
| 压缩失败 | 非致命，emit `warning`，按原历史发 |
| autosave/检查点/记忆巩固失败 | 静默（增值动作不得成为新故障点） |
| client 未初始化 | emit `error`，拒发 |

## 10. 多会话与生命周期

- F2：`SessionRegistry` 仅内存 `Map`，提供 `create/get/remove`。
- 会话持久化、跨重启恢复、列表/搜索 = **S1**，不在 F2。
- 后端常驻：SessionManager 实例在回合期间独立于任何客户端连接存活（关浏览器不中断）；事件在无订阅者时仍推进状态（账本/usage 照常更新），重连方靠 `getState()` 补齐 + 续订增量事件。

## 11. 测试（纯单测，不碰 HTTP）

用**假 ModelClient**（喂脚本化 `StreamEvent` 序列）+ 假 ToolRegistry/SnapshotStore：

- 回合循环：脚本化 text/tool 序列 → 断言 emit 的事件序列正确、`conversation` 正确提交。
- 自动压缩：构造 `contextTokens` 超阈值 → 断言回合前触发 compact、换了 Conversation 实例。
- 压缩内容：断言 TodoWrite 状态进了摘要 prompt、检查点重映射、记忆候选入库。
- failover：脚本化 preStream quota error → 断言标坏、`decideFailover` 调用、热换 client、`isResend` 重发、新窗口超阈值先压缩。
- 权限：交互会话 ask → 断言 emit `permission-request` 且 Promise 挂起，`resolvePermission` 后兑现；并发两条 ask 各自独立兑现；非交互会话 ask → 断言确定性裁决、无 `permission-request` 外发。
- interrupt：回合中 abort → emit `aborted`。
- steer：入队 → 断言 `consumeSteer` 被消费。
- 重连：回合中途 `getState()` → 断言快照含进行中的消息/挂起权限。

## 12. 未决/留给下游

- `dialog` 模式 failover 在 Web 下的「请前端选模型」交互（前端弹 M2/模型选择器）属 F3/F4。
- 多模态 `parts` 的实际结构在 F4 定；F2 的 `submit(text, parts?)` 先按 `text` 主路径实现，`parts` 透传占位。
- 工具输出落盘/截断/链接：F4 展示层。
