# M6 — 检查点时间线 + revert 设计

> **日期**: 2026-06-26
> **所属**: [Web UI 路线图总纲](./2026-06-22-web-ui-roadmap.md) 管理面板 M6
> **前置**: F2（SessionManager `revert()` + `checkpoint-recorded` 已实现）、F3（WS 协议）、F4（React SPA）均已在分支
> **状态**: 后端检查点/revert 已就绪；本 spec 加"前端能触发 revert + 看到时间线"，并补齐"revert 后前端正确反映 / 重连看到历史"。

---

## 1. 目标与边界

让用户在 Web 端**看到每回合的检查点时间线**并**一键 revert**（回滚工作区文件 + 对话账本到该检查点）。

**关键设计（已与用户确认）**：revert 要在前端正确反映 + 顺带修"重连/刷新看不到历史"——做法是给 `SessionSnapshot` 加**消息投影**，revert 后后端**重推 snapshot**，前端据此重建消息列表。

**边界**：单内存会话下做（多会话是 S1）。不做检查点的差异预览（diffStat）UI——只列 + revert（diff 预览留 follow-up）。

## 2. 协议改动（`@zuse/protocol`）

```ts
// 新增投影类型（镜像 web 的 Part/Message，纯数据）
export type SnapshotPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; name: string; output: string; isError: boolean }
export interface SnapshotMessage { role: 'user' | 'assistant'; parts: SnapshotPart[] }
export interface CheckpointLite { id: string; label: string }

// ClientMessage += 
  | { type: 'revert'; checkpointId: string }

// SessionEvent += （revert 完成通知；前端据此提示 + 触发重建由随后的 snapshot 帧完成）
  | { type: 'reverted'; checkpointId: string }

// SessionSnapshot += 两字段
  messages: SnapshotMessage[]      // 会话账本投影，供重连/ revert 后重建对话视图
  checkpoints: CheckpointLite[]    // 当前存活的检查点（供时间线，重连后仍在）
```

> `SnapshotPart` 故意与 `packages/web/src/state/types.ts` 的 `Part` 同构（tool-result 用 `isError` 而非 `is_error`），前端可近乎直接映射。

## 3. 后端改动（`@zuse/server`）

### 3.1 SessionManager
- **消息投影**：新增 `projectMessages(): SnapshotMessage[]`——把 `conversation.getMessages()` 的 Anthropic 风格内容块映射为 `SnapshotPart`：`text`→text；`tool_use`→`{kind:'tool-use',id,name,input}`；`tool_result`→`{kind:'tool-result',id,name,output,isError}`。（实现时核对 core 的 `ContentBlock` 真实形状；`tool_result` 块可能无 `name`，缺省取空串或从配对的 tool_use 补，plan 里定。）跳过纯 system/summary 占位的呈现细节由前端处理。
- **扩展快照**：把 `getState()` 扩成（或新增 `getSnapshot()`）含 `messages: projectMessages()` 与 `checkpoints: this.checkpoints.map(c => ({ id: c.hash, label: c.label }))`。`checkpoint-recorded` 事件里的 `id` 已是 hash，时间线与之一致。
- **revert 收尾**：`revert(checkpointId)` 末尾 `this.emit({ type: 'reverted', checkpointId })`（F2 的 revert 已做文件回滚 + 账本截断 + 丢弃后续检查点 + 清 contextTokens；只差这条通知）。

### 3.2 wsServer / clientMessage
- `clientMessage.ts`：`revert` 上行 → `mgr.revert(msg.checkpointId)`（非法/未知 id → mgr 内部 no-op，安全）。
- `wsServer.ts`：事件订阅监听里，收到 `reverted` 事件时，**额外向本连接发一帧最新 `snapshot`**（`mgr.getSnapshot()`）——这样单会话的所有连接各自重建（多客户端广播天然成立）。`reverted` 事件本身也照常以 `event` 帧转发（前端可显示"已回滚"提示）。

## 4. 前端改动（`packages/web`）

- `state/types.ts`：`AppState += checkpoints: CheckpointLite[]`（初值 `[]`）。
- `state/reducer.ts`：
  - `applySnapshot`：除现有字段外，**用 `snapshot.messages` 重建 `state.messages`**（映射 `SnapshotMessage`→UI `Message`，生成稳定 id），并 `state.checkpoints = snapshot.checkpoints`。这同时修掉重连历史为空的问题。
  - 处理 `checkpoint-recorded` 事件 → `checkpoints: [...state.checkpoints, { id: e.id, label: e.label }]`。
  - 处理 `reverted` 事件 → 一条 `info` 通知（"已回滚到检查点"）；真正的消息重建由随后到达的 `snapshot` 帧完成。
- **时间线 UI**：新增轻组件（如 `components/CheckpointTimeline.tsx`，挂在 Sidebar 或 Header 抽屉）——列出 `state.checkpoints`（label + 顺序），每条一个 "revert" 按钮（带二次确认），点击经 store 发 `{ type: 'revert', checkpointId }`。
- store / ws：加一个 `revert(id)` dispatch → WS 发上行 `revert` 消息（复用现有发送通道）。

## 5. 边角 / 鲁棒性
- 空检查点：时间线空态显示提示（"本会话还没有检查点"）。
- revert 进行中：按钮禁用直到收到新 snapshot。
- 投影成本：`projectMessages` 每次 snapshot 调一次（attach / revert / reset 时），非每事件，开销可接受。
- 多客户端：A 触发 revert → 后端对**所有**连接重推 snapshot（各连接收到 `reverted` 事件即自发 snapshot），都同步到回滚后状态。

## 6. 测试
- **协议**：类型编译（新成员）。
- **server**：
  - `projectMessages` 把含 text/tool_use/tool_result 的 conversation 正确投影（构造一个 Conversation 断言输出）。
  - `getSnapshot` 含 messages + checkpoints。
  - `revert()` 末尾 emit `reverted`（脚本化：先跑出一个 checkpoint，再 revert，断言事件 + 账本截断）。
  - wsServer：收到上行 `revert` → 调 mgr.revert → 该连接收到 `reverted` event + 一帧新的 `snapshot`（集成测，端口 0 + 注入假 client + 脚本化一回合产出 checkpoint）。
- **web**：
  - reducer：`applySnapshot` 用 messages 重建消息列表 + 设 checkpoints；`checkpoint-recorded` 追加；`reverted` 出 info 通知。
  - `CheckpointTimeline` 组件：渲染 checkpoints、点击 revert 经 store 发出正确上行消息（@testing-library）。
- 全程不打真实模型/网络。

## 7. 完成判据
浏览器：跑几回合 → 时间线出现对应 checkpoints → 点某条 revert（确认）→ 工作区文件回滚、对话视图截断到该点、后续 checkpoint 消失；刷新页面 → snapshot 带历史，对话与时间线都还在。`@zuse/server` + `@zuse/web` 测试全绿、typecheck 干净、零 `@zuse/tui` 依赖。

## 8. follow-up（非本期）
- 检查点 diff 预览（`snapshotStore.diffStat`）。
- 检查点入 S1 的持久化（跨服务重启）。
- `allow_persist` 权限按钮等 I1 小缺口（已排在 M6 之后单独做）。
