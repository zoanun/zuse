# 稳定 message-id + 中断标记结构化 设计

> **状态**: 设计已用户确认 → 待用户 review spec → writing-plans。
> **依据（Explore 全链路触点扫描，file:line）**: `core/types.ts:17`（Message 无 id）、`core/conversation.ts:22`（append 总闸）/`:41,50`（structuredClone 保字段）/`:82`（fromJSON 循环 append）、`core/agent.ts:227/327/422/318/439/167`（各消息构造点，均经 commitStaged→append）、`SessionManager.ts:837`（submit 签名，无 client id）/`:1045`（message-start 发的是模型流 id）/`:848,1039,1224,1343`（user-echo 无 id）/`:438-478`（projectMessages 按数组下标 ledgerIndex）/`:985,1130,1272`（checkpoint messageIndex / revert slice）、`ws/clientMessage.ts:35,42`（send/steer → submit，无 id 透传）、`web/state/reducer.ts:64`（applySnapshot 按 `'h'+ledgerIndex`）/`:137`（message-start 用模型 id）/`:194`（user-echo `'ue'+len`）、`web/state/store.tsx:39`（nextId 本地计数）/`:157`（searchJump 拼 `'h'+msgIndex`）/`:153-156`（序号耦合 bug 注释在案）、`web/state/types.ts:9`（web Message 已有 id 但 5 套临时方案）、`search/SearchService.ts:19`（SearchHit.msgIndex 按下标）、`protocol/index.ts:257`（message-start）/`:284`（user-echo）/`:19`（SnapshotMessage）/`:333`（SearchHit）/`:308-311`（ClientMessage send/steer）、`sessionStore.ts:94,107`（JSON 整体 round-trip，无 legacy 回填）。

## 目标 / 动机

给每条账本 `Message` 一个**稳定唯一 id**,源头分配、终身不变,贯穿实时事件→账本→持久化→快照→搜索→checkpoint/revert。解决:

1. **现有 bug**:`searchJump` 靠 `'h'+ledgerIndex` 拼 DOM id,实时追加/revert/压缩致序号漂移 → 跳转静默失效(`store.tsx:153-156` 注释自认)。
2. **精确引用**:能稳定定位"哪一句话",为将来"编辑/分支某条消息"打底(用户明确要的前瞻)。
3. **顺带做掉 follow-up**:中断标记从 web 字符串匹配改为**结构化 flag**(同一套"给 Message 加元数据"管线)。

**取舍已定(用户拍板)**:approach **B**——服务端权威 id,一步到位全链路 id 化(含 checkpoint/revert 按 id 锚定);实时与账本**同一个 id**,无事后对齐。

## ID 模型

### Message 新增两字段（core `types.ts`）
```ts
export interface Message {
  role: 'user' | 'assistant'
  id: string                 // 稳定唯一 id，源头分配、终身不变（持久化/压缩/revert 都不变）
  content: ContentBlock[]
  steer?: string[]
  attachments?: MessageAttachment[]
  interrupt?: true           // 中断标记消息：web 据此渲染系统提示、并略去标记文本 part
}
```
> `id` 设为**必填**(账本内每条都有);构造点必须给,`append` 兜底(见下)。`interrupt` 仅打在 finalize 合成的标记消息上。

### id 格式
短随机 id：`msg_<crypto.randomUUID()>`(core 用 `node:crypto` 的 `randomUUID`,provider 无关)。**不复用模型流 id**(每轮变、非全局唯一)。

### id 源头（按消息类型）
- **用户消息**:**前端生成**('u-'+nextId 已有),随 `send`/`steer` 上行(`ClientMessage` 加 `messageId`),服务端 `submit` 透传,构造 stagedUser 时用作账本 id → 实时气泡 id == 账本 id,零对齐。(client 生成的 id 只是显示/引用键,非安全边界;uuid 防撞。服务端仍校验为非空字符串,缺失则服务端补生成。)
- **助手消息**:**服务端在 message-start 时生成**。`runAgent` 收到 client 的 message-start(模型流 id)时,生成我们自己的 `msg_…`,**在 yield 的 message-start 事件里带上它**(替换模型 id 语义),并**记住**,在回合末构造 assistant 消息(agent.ts:327)时盖同一个 id。→ 实时助手气泡(message-start 事件 id)== 账本 id。
- **工具结果载体 / 中断标记 / runaway / maxTurns 消息**:各构造点**显式赋** `id: genMsgId()`(它们在 web 折叠进助手卡/渲成提示,不单独按 id 成气泡,id 只供账本/持久化/引用)。
- **类型策略(必填,不靠 append 盖章)**:`id` 必填 → **每个构造点都必须给**(TS 编译强制,避免遗漏)。agent.ts 的 ~6 个构造点均如上赋值(stagedUser←opts、assistant←assistantMsgId、其余←genMsgId)。`Conversation.append` 不改语义(可加一条 `if(!message.id) throw` 防御性断言,但类型已保证)。
- **legacy 回填(确定性)**:`Conversation.fromJSON`(conversation.ts:82)加载旧会话时,给**缺 id 的老消息**按下标赋**确定性** id `msg_legacy_<会话或账本指纹>_<下标>`,保证**同一会话多次加载 id 不变**(随机 id 会跨加载漂移,破坏引用稳定性)。新消息永远用随机 `genMsgId()`。

## 协议改动（`protocol/index.ts`，传输无关 type-only）

- `ClientMessage` 的 `send`/`steer` 加 `messageId: string`(前端生成的用户消息 id)。
- `message-start` 事件 `id` 语义改为**服务端账本 id**(注释更新;字段名不变)。
- `user-echo` 事件加 `messageId: string`(回显/steer/retry 的用户消息 id)。
- `SnapshotMessage` 加 `id: string` + `interrupt?: boolean`;`ledgerIndex` 保留(revert 位置/兼容,但**身份用 id**)。
- `SearchHit` 加 `id: string`(与 `msgIndex` 并存,跳转用 id)。
- `checkpoint-recorded` 事件加 `anchorMessageId: string`(锚定的用户消息 id;`messageIndex` 保留)。

## core 改动

- `types.ts`:Message 加 `id`(必填)+ `interrupt?`。
- `conversation.ts`:`append` 盖章兜底 + `genMsgId()`;`appendUserText/appendAssistantText` 走 append 自然获 id。
- `agent.ts`:
  - 新增 `let assistantMsgId: string | null`(每轮);收到 message-start 时 `assistantMsgId = genMsgId()`,yield `{type:'message-start', id: assistantMsgId, model}`;构造 assistant 消息(:327 / runaway:318 / finalize:174)时用它。
  - `stagedUser`(:227):id 从 `opts.userMessageId`(新增 RunAgentOptions 字段,由 submit 透传;缺省 append 兜底)。
  - `finalizeInterruptedTurn`:合成的标记消息打 `interrupt: true`;工具在飞变体的标记 user 消息也打 `interrupt: true`(web 据此略去标记文本、渲提示)。
  - tool_result 载体 / maxTurns 消息:不显式给 id,append 兜底。

## server 改动（`SessionManager.ts` / `clientMessage.ts` / `SearchService.ts`）

- `clientMessage.ts`:send/steer handler 把 `msg.messageId` 透传给 `submit`/`steer`。
- `submit`/`steer` 签名加 `messageId?`(→ 传入 runAgent 的 `opts.userMessageId`;steer 折叠路径同理带 id)。
- `projectMessages`(:438):`SnapshotMessage` 带 `id: message.id`;对 `message.interrupt` 的消息 → 置 `interrupt:true` 且**跳过标记文本 part**(模型看的文本仍在账本 content,不进快照 part)。steer 拆出的独立气泡 id = `${carrierId}#steer${n}`(派生、稳定)。
- `user-echo` 各发射点(:848/1039/1224/1343)带上对应用户消息 id。
- **checkpoint 按 id 锚定**:`SessionCheckpoint` 加 `anchorMessageId`(events.ts);记录时(:1130)取"即将开始的用户消息"的 id;`checkpoint-recorded` 事件带 `anchorMessageId`。
- **revert(checkpointId)**(:1272):先按 `anchorMessageId` 定位当前账本位置(找不到再回退 `messageIndex` 兜底),`slice(0, pos)` 截断;`retry`(:1310)同理按 id 定位原用户消息、拿不到再回退 index。
- `SearchService.ts`(:19):建索引时带 `id: m.id`;`SearchHit` 返回 `id`。

## web 改动（`reducer.ts` / `store.tsx` / `Shell.tsx` / `Sidebar.tsx`）

- **applySnapshot 按 id 建 key**(:64):`id: m.id`(不再 `'h'+ledgerIndex`);steer 气泡用投影派生的 id。
- **message-start**(:137):用事件里的服务端 id(现在=账本 id)。
- **user-send**:`nextId('u')` 生成的 id **随 `send` 上行**(`send({type:'send', text, messageId, …})`),乐观气泡用它 → 快照回来同一 id,无需替换。`steer-queued` 同理。
- **user-echo**(:194):用事件的 `messageId`,不再 `'ue'+len`。
- **searchJump**(store.tsx:157):`setPendingScrollTo(hit.id)`;Sidebar `onJump(sessionId, hit.id)`;MessageList 滚到该 id 的 DOM 节点。DOM 节点 id 全线用 message id。
- **中断标记**:reducer 删 `INTERRUPT_MARKERS` 字符串匹配;改为**按 `SnapshotMessage.interrupt` flag** 渲染系统提示(措辞「已被用户中断」不变)。实时仍靠 `aborted` 事件出提示。
- checkpoint 关联:web 按 `anchorMessageId` 把 revert 图标挂到对应消息(替代按 ledgerIndex)。

## 持久化 + 迁移（`sessionStore.ts`）

- Message 带 id 后 JSON round-trip **自动带上**(saveSession/loadSession 无需改)。
- **legacy 回填**:旧会话消息无 id。回填点 = `Conversation.fromJSON`(conversation.ts:82)——遍历 `data.messages` 时给缺 id 的按下标赋**确定性** id(见"legacy 回填"决策)。sessionStore 本身无需改(它只 JSON round-trip)。**验证**:加载旧会话后每条都有 id、**同一会话多次加载 id 不变**(确定性派生保证)。

> **迁移取舍(如实标)**:legacy 派生 id 依赖下标,若老会话后续再 revert 截断,派生 id 仍稳(下标是加载时快照的固定值,不随运行变)。可接受。

## 测试

- **core**:append 给无 id 消息盖章、有 id 不覆盖;runAgent 助手消息 id == 其 message-start 事件 id;stagedUser 用 opts.userMessageId;finalize 标记消息带 interrupt。fromJSON 回填 legacy 确定性 id、二次加载不变。
- **server**:projectMessages 每条带 id、interrupt 消息略标记文本+置 flag、steer 气泡派生 id;submit 透传 client id → 账本;checkpoint 带 anchorMessageId;revert 按 id 定位截断(含"id 找不到回退 index")。SearchHit 带 id。
- **web**:applySnapshot 按 id key;user-send 上行带 messageId 且乐观气泡 id==快照 id;message-start 实时 id==刷新后 id;searchJump 按 id 跳转(构造"实时追加后未重编号"场景验证不再静默失效);中断提示按 flag 渲染、无字符串匹配。
- **门禁**:protocol/core/server/web 四包 tsc + vitest(web 在包内跑);web 改动 → Playwright(发消息→搜索→跳转命中;中断→标记显示;刷新后 id 稳)。

## 分阶段（供 writing-plans 拆 task）

1. **协议 + core 数据模型**:Message.id/interrupt、append 盖章、genMsgId、runAgent 助手 id 织入 message-start、finalize interrupt flag、RunAgentOptions.userMessageId;协议各字段。core 单测。
2. **server 投影/接线**:submit/steer/clientMessage 透传 id、projectMessages(id+interrupt+略标记文本+steer 派生 id)、user-echo 带 id。server 单测。
3. **持久化 + legacy 回填**:fromJSON 确定性回填 + 二次加载稳定性测试。
4. **checkpoint/revert 按 id**:SessionCheckpoint.anchorMessageId、记录/事件/revert/retry 按 id 定位(index 兜底)。
5. **搜索按 id**:SearchService + SearchHit + searchJump + Sidebar。
6. **web 渲染**:applySnapshot/message-start/user-send/user-echo 按 id、DOM id、中断 flag 渲染删字符串匹配、checkpoint 按 anchorMessageId。web 单测 + Playwright。

## 涉及文件（汇总）

- protocol：`index.ts`（ClientMessage/SnapshotMessage/SessionEvent(message-start,user-echo,checkpoint-recorded)/SearchHit）。
- core：`types.ts`、`conversation.ts`、`agent.ts`。
- server：`SessionManager.ts`、`ws/clientMessage.ts`、`session/events.ts`、`search/SearchService.ts`。
- web：`state/reducer.ts`、`state/store.tsx`、`components/Shell.tsx`、`components/Sidebar.tsx`、`components/MessageList.tsx`、`state/types.ts`。
- 测试：各包 + Playwright。
