# 中途取消保留回合（Cancel Preserves the Turn）设计

> **状态**: 设计已用户确认 → writing-plans。
> **依据（逐行读真码）**: `packages/core/src/agent.ts`（staging/commit：:173 stagedUser、:177 staged、:186 外层回合循环、:190 顶部 abort 丢弃、:250 errored 丢弃、:252-261 runaway 保留分支、:264-269 组装+暂存助手、:272-279 无工具即提交、:295-374 工具执行+tool_result 暂存、:378-386 maxTurns 收尾、:389-390 原子提交）；`packages/core/src/anthropic-client.ts:173-182` 与 `packages/core/src/openai-client.ts:303-322`（**两个 client 行为一致**：abort 被 catch → `yield {type:'error', ...classifyError}` + `return`，**不抛出、不重试** → 中断对两家 provider 都以 `error` 事件冒出，走 runAgent 的 errored 分支，故本修复 provider 无关）；`packages/server/src/session/SessionManager.ts`（:1007-1008 submit 内 accumulated/assistantStarted、:1020 consumedThisTurn、:1026/1112 abortedMidTurn、:1063 折叠 steer 记录、:1096 error+aborted→emit 'aborted'、:1184 catch 里 emit 'aborted'、:1195-1204 abortedMidTurn 回滚 todos/cwd、:1218-1220 中断重排 steer、:214/221/858-859 todosBeforeTurn/cwdBeforeTurn）。

## 目标

用户在 LLM 流式回复**中途按 Stop** 时，不再丢弃整回合。改为**保留**：用户提问 + 已流出的半截助手文本 + 已完成工具的调用与结果 + 一条模型可见的中断标记；并把任何**悬空 tool_use**（已发出、结果没回）补上"已中断"结果以保证账本对 API 合法。**副作用不回滚**（对齐 CC/opencode/hermes/openclaw 四家一致做法：取消停的是后续工作，不是已发生的事）。附一个 CC nicety：中断落在**啥都还没生成**时，把提问退回输入框供编辑（不留痕）。

## 背景与现状（实证）

`runAgent`（agent.ts）把本回合的新消息先攒在本地 `staged`，只在干净完成时于 :389 一次性 `conversation.append`。中断有两个丢弃点：

- **顶部 :190** `if (signal.aborted) { yield warning; return }` —— 回合边界处（步与步之间）中断 → 丢 staged。
- **:250** `if (errored) return` —— client 把 abort 转成 `error` 事件（anthropic-client.ts:175-182，**不抛异常**），runAgent 收到即 `errored=true`、break 流循环、到此丢 staged。

结果：提问 + 半截回复全蒸发，账本回到发送前。SessionManager 还会在 `abortedMidTurn` 时回滚 todos/cwd（:1195-1204）并重排已折叠的 steer（:1218-1220）。

**内部矛盾（本设计的动机）**：同文件的 **runaway 复读**分支（:252-261）已经做了正确的事——保留提问 + 截断助手文本后提交，其注释（:216-219）明说"不丢整轮，否则用户这轮提问一起消失"。唯独**用户主动 Stop** 没这样做。本设计让用户中断与 runaway 一致。

**四家参考一致（已查源码，file:line 证据在会话记录）**：CC/opencode/hermes/openclaw 中断时都**保留提问+半截文本**、给悬空 tool_use **合成"已中断"结果**、**不回滚副作用**（回滚一律是独立的显式 revert/rollback，从不在 cancel 路径）。CC 还有 rewind nicety（啥没生成就把提问退回输入框）。

## 非目标

- **不回滚任何副作用**：文件写入、cwd、todos、已跑的 Bash/MCP 效果一律照留。显式 `/revert`（shadow-git 检查点）是另一条独立、用户触发的路径，不动。
- **不改真错误路径**：`errored && !signal.aborted`（真·模型/网络错误）仍按现状丢弃整回合。
- **不动 runaway 分支**（它本就提交）。
- **不为子代理特判**：改动在 `runAgent` 本身，Agent 工具（走 runAgent）自动获得中断保留；其临时会话的半截结果即成为它返回的文本。无需额外代码。

## 设计

### A. core/agent.ts —— 中断时"提交"而非"丢弃"

新增内部收尾函数（示意签名，实际私有）：

```ts
/** 把被用户中断的回合收尾并提交：补齐半截助手消息、给悬空 tool_use 合成"已中断"结果、
 *  追加中断标记，然后原子提交。仅用户中断（signal.aborted）调用；真错误不调。 */
function finalizeInterruptedTurn(
  staged: Message[],
  partial: { text: string; toolUses: PendingToolUse[]; assistantStaged: boolean },
): void
```

**中断标记常量**（对齐 CC）：

```ts
const INTERRUPT_MARKER = '[Request interrupted by user]'
const INTERRUPT_MARKER_TOOL_USE = '[Request interrupted by user for tool use]'
```

收尾规则：

1. **补半截助手消息**（仅当尚未 push 过、且非空）：若中断落在流式中途（:250 路径，助手消息还没在 :269 组装），用累积 `text` + 已发出的 `toolUses` 组装一条 assistant 消息 push 进 staged。空内容（无 text 无 tool_use）不 push。
2. **合成悬空 tool_use 的结果**：对 staged 里最后一条 assistant 的每个 `tool_use`，若其后没有配对的 tool_result（中途中断、工具没跑），合成一条 user 消息，content = 每个悬空 tool_use 一个 `{type:'tool_result', tool_use_id, content:'[Tool interrupted by user]', is_error:true}`，并在同一条 user 消息末尾追加一个 `{type:'text', text: INTERRUPT_MARKER_TOOL_USE}` 文本块。（工具**已执行完**的 tool_result 已在 staged，效果作数，不动。）
3. **追加纯文本中断标记**（仅当步骤 2 没产生合成结果时，即无悬空 tool_use 的纯文本中断）：push 一条 user 消息 `{role:'user', content:[{type:'text', text: INTERRUPT_MARKER}]}`。
4. **原子提交**：`for (const m of staged) conversation.append(m)` + `conversation.addUsage(turnUsage)`（复用现有 :389-390 逻辑）。

**接线**（两个中断点都走收尾，而非 return）：

- **:190 顶部**：`if (signal.aborted)` → 若 `staged.length > 1`（有生成物：前面步骤的 assistant/tool_result）→ 调 `finalizeInterruptedTurn` 提交；否则（`staged.length === 1`，只有 stagedUser，啥没生成）→ **不提交**，`return`（交给 §B 的 rewind）。仍 `yield {type:'warning'|'aborted'}`？—— 保持现有 `yield {type:'warning', message:'Interrupted.'}` 不变（SessionManager 侧靠 signal.aborted 认定，见 §C）。
- **:250 errored**：拆成
  - `if (errored && signal.aborted)` → 若这回合**有生成物**（判据见下）→ 调 `finalizeInterruptedTurn`（会补半截助手+合成/标记）提交；否则 → 不提交、`return`（§B rewind）。
  - `else if (errored)` → 真错误，`return`（**现状不变**，丢弃）。

> **"有生成物"判据（runAgent 侧，两个中断点统一）** = `text !== '' || toolUses.length > 0 || staged.length > 1`。**不**用 `assistantStarted`——只发了 message-start 却无 text 无 tool_use 不算生成物（避免提交空的 `[user, marker]`）。`staged.length > 1` ⟺ 有过前序步骤，而前序步骤必是 tool_use 步（纯文本步会 :278 clean=true 结束、不会再进下一 turn），故等价于"见过 tool-use"。这与 §B/§C 的 empty-interrupt 判据严格互补。

> 角色交替合法性：纯文本中断 → `…assistant(text), user(marker)`；工具在飞中断 → `…assistant(text+tool_use), user(tool_results+marker文本)`；均以 user 收尾、tool_use 都有配对 result，合法。runaway/maxTurns 分支不受影响。

### B. "啥都没生成" → 提问退回输入框（rewind nicety）

判定 **empty-interrupt** = `signal.aborted && accumulated === '' && !sawToolUse`（即无助手文本、无工具、无前序步骤——与 §A"有生成物"判据严格互补）。**不**看 `assistantStarted`：只发了 message-start 却无内容仍算空。此时 §A 不提交（账本不变）。

- **协议**：新增 server→web 事件 `{ type: 'restore-input', text: string }`（放 `packages/protocol` 的 `ServerMessage`/`SessionEvent` 家族，type-only）。
- **SessionManager**：在 submit 的中断处理里，若判定 empty-interrupt，则**不做常规 aborted 落库**，改 `emit({type:'restore-input', text})`（text = 本回合用户原文，未加 userStamp 的原始输入）。仍 emit `'aborted'`（UI 停止指示）。
- **web**：`Composer` 收到 `restore-input` → 把 `text` 填回输入框并聚焦（若输入框非空则不覆盖，避免踩掉用户新输入——退化为忽略）。reducer/store 接线一个一次性动作。

### C. server/SessionManager.ts —— 去掉回滚，接 empty-interrupt

- **删** :1195-1204 的 `abortedMidTurn` todos/cwd 回滚（回合已提交，副作用照留，与账本/磁盘一致）。
- **删** :1218-1220 的中断 steer 重排 + :1020/:1063 的 `consumedThisTurn`（折叠 steer 已成提交历史，重排会重复投递）。`drainSteerAsFollowUp`（:1228，纯文本回复期间排队的 steer）**保留不动**（与中断无关）。
- **删** :214/221/858-859 的 `todosBeforeTurn/cwdBeforeTurn` 字段与赋值——**前提**：计划实现时 `grep` 确认除回滚外无其它消费者（当前证据只在 :1196-1201 用）。若有其它消费者则保留字段、只删回滚。
- **`abortedMidTurn`（:1026/:1112）**：回滚与重排都删后若变为无消费者则删；但 §B 需要判定 empty-interrupt——用 submit 内既有的 `accumulated`（:1007）+ 新增一个"本回合是否见过 tool-use 事件"的布尔 `sawToolUse`（在 :1082 的 `case 'tool-use'` 置位）。empty-interrupt = `signal.aborted && accumulated === '' && !sawToolUse`。（`accumulated` 在每次 message-start 重置，只反映最后一条助手文本；但有前序步骤必有 tool-use 事件 → `sawToolUse` 兜住，故该判据准确等价于"turn 0 啥没生成"。）
- **保留** :1096 / :1184 的 `emit({type:'aborted'})`（UI 停止指示，和账本标记两回事）。

### D. web 展示 —— 中断标记渲染成系统提示

账本里 `[Request interrupted by user]` / `…for tool use`（作为 user 消息的文本块，或工具结果消息里的尾随文本块）主要给模型看。web 的消息投影（reducer `foldToolResults` / `Message.tsx`）应识别这两个标记文本，渲染成**低调的系统提示**（如"⛔ 已被用户中断"），而非普通用户气泡；工具在飞变体里，标记文本要从被折叠的 tool_result 卡片中剥离（按精确文本），不污染工具卡。与现有 `'aborted'` 指示对齐，避免重复显示（`'aborted'` 是瞬时 UI 提示，标记是持久历史；二者可共存但视觉上不重复堆两条"已停止"）。

## 数据流

1. 用户 Stop → `SessionManager.interrupt()` → `this.abort.abort()`。
2. client 把 abort 转 `error` 事件（anthropic-client.ts:175-182）→ runAgent 流循环 `errored=true`、break。
3. runAgent 到 :250：`errored && signal.aborted` → `finalizeInterruptedTurn` 提交（半截助手 + 合成/标记）→ `conversation` 增长。
4. SessionManager 事件循环收完，`signal.aborted` 真：
   - 非 empty-interrupt → 正常走完（turn 提交、`emit 'aborted'`、**不回滚**、**不重排 steer**）。
   - empty-interrupt → `emit 'restore-input'` + `emit 'aborted'`，账本不变。
5. web：restore-input → Composer 回填；否则消息流照常渲染（含系统提示样式的中断标记）。

## 错误处理与边界

- **真错误（非中断）**：`errored && !signal.aborted` → 丢弃（现状不变）。
- **中断落在工具执行中**（流已收完、stopReason='tool_use'、工具跑到一半）：staged 已含 assistant + （gateAndRunTool 兜底成的）tool_result，回到 :190 顶部 → `finalizeInterruptedTurn` 提交（此时 tool_use 都已有 result，只追加纯文本标记）。已跑完工具的效果作数。
- **助手 message-start 后无 text 无 tool_use 就中断**：半截助手消息为空 → 不 push；若整回合无其它生成物 → empty-interrupt（rewind）。
- **失败重发（isResend）/压缩视图（conversation !== this.conversation）**：收尾提交要落到**正确的 conversation 对象**（与 :1119-1124 的 fold-back 一致）——计划需确保 finalize 提交进 runAgent 拿到的 `conversation`（视图），SessionManager 的 fold-back 再把新尾并回 ledger。
- **子代理**：其临时 conversation 同样被 finalize 提交，半截作为工具返回文本；父回合的 Agent tool_result 照常进父 staged。

## 测试

- **core/agent.ts 单测**：①纯文本中断 → conversation 末尾 = [user, assistant(半截), user(INTERRUPT_MARKER)]；②工具在飞中断（发了 tool_use、没执行）→ 末尾 = [user, assistant(text+tool_use), user(tool_result is_error + INTERRUPT_MARKER_TOOL_USE 文本)]，每个 tool_use 有配对 result；③工具执行中中断 → 已完成 tool_result 保留 + 纯文本标记；④真错误（error 事件、signal 未 abort）→ conversation 不变（丢弃，现状）；⑤runaway 分支断言不变；⑥empty-interrupt（signal abort 且啥没生成）→ conversation 不变。
- **SessionManager 单测**：①中断 mid-turn（有生成物）→ getState 消息含该回合、todos/cwd **未回滚**、`'aborted'` 已 emit；②折叠 steer 的回合被中断 → steer **不**重排进 queue；③empty-interrupt → emit `'restore-input'`（text=原文）、账本不变、无 todos/cwd 事件。
- **protocol/web**：`restore-input` 类型存在；reducer/Composer 收到 restore-input 回填输入框（输入框已有内容则不覆盖）；中断标记渲染成系统提示、不显示为用户气泡、工具卡不含标记文本。
- **门禁**：core/server/protocol/web 四包 `tsc --noEmit`；`pnpm exec vitest run` 各包；**packages/web 改动 → Playwright** 冒烟（发消息→中途 Stop→看到半截回复+系统提示留存、下一轮模型知道被中断；即时 Stop→提问回到输入框）。

## 涉及文件

- 改：`packages/core/src/agent.ts`（finalizeInterruptedTurn + 常量 + :190/:250 接线）。
- 改：`packages/server/src/session/SessionManager.ts`（删回滚/重排、加 empty-interrupt 判定 + restore-input emit、sawToolUse 布尔）。
- 改：`packages/protocol`（`restore-input` 事件类型）。
- 改：`packages/web`（reducer/store restore-input → Composer 回填；Message/reducer 渲染中断标记为系统提示）。
- 测试：agent 单测、SessionManager 单测、protocol/web 单测、Playwright 冒烟。
