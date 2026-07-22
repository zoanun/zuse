# 中断时清空 todo 计划（Clear the Todo Plan on Interrupt）设计

> **状态**: 设计已用户确认 → 已实现（小改，压缩流程：短 spec + 直接 TDD + /ship）。
> **背景**: 「中途取消保留回合」（`2026-07-21-cancel-preserve-turn`）上线后，取消**不回滚副作用**。实测发现：模型中途建的 todo 计划（如 0/3）在中断后**赖着不走**，用户觉得讨厌，想要清除途径。

## 决策依据（调研四家参考项目）

调研 CC/opencode/hermes/openclaw 的 todo 清除做法（file:line 证据见会话记录）：

- **共性两层**：纯展示的隐藏/折叠（视图开关，不删数据）+ 真删数据（压倒性是**自动、按生命周期触发**，非手动按钮）。
- 真删的触发：全部完成后短暂 linger 再清（cc-haha 5s / hermes 4s）、**hermes 在中断/回退/turn-end 直接清空**、新会话/`/clear`、模型重写成 `[]`。
- 唯一的手动 "x"：cc-haha 桌面 SessionTaskBar——**只在全部完成时出现**（清"已完成批次"，非"放弃在建计划"）。
- **关键洞察**：文件写入从不回滚，但 **todo 列表被当成"临时计划态"**（hermes 中断即清），不是耐久副作用。这修正了 cancel-preserve 里"todos 像文件一样该保留"的过强框定——**todos 该按临时态处理**。

## 目标

用户中断一个**真跑过的回合**时，自动清空当前 todo 计划（"放弃在建计划"）。对齐 hermes 的中断即清。**对话保留不变**（半截回复 + `[Request interrupted by user]` 标记照留），只清临时计划。

## 设计

在 `SessionManager` 的中断收尾处（runAgent 循环之后、fold-back 之前）：

```ts
const interrupted = this.turnEpoch === epoch && controller.signal.aborted
if (interrupted && conversation.length === viewPreLen) {
  // 空中断 → rewind（把未动的输入退回输入框）；账本 + todos 原样不动。
  this.emit({ type: 'restore-input', text })
} else if (interrupted) {
  // 非空中断：这轮真跑过（可能建了计划）才中断。todo 是临时"当前计划"态，非耐久副作用——
  // 清掉，免得废弃的在建计划赖着（对齐 hermes）。对话本身（半截回复+标记）保留不变。
  if (this.todos.length > 0) this.setTodos([])
}
```

- **收敛点：空中断不清**。若消息发出立刻 Stop、模型啥都没生成（空中断，走 rewind），**不清** todo——这轮没建任何计划，清掉的会是**上一轮遗留的计划**，那反而意外。只在"这轮真跑过再中断"时清。（hermes 是无条件清；这里更收敛，不误伤已有计划。）
- **epoch 门控**：reset（新聊天）本就 `interrupt()` + 清 todo；epoch 变了走不到这两支，不重复处理。
- **纯服务端**：`setTodos([])` 触发现成的 `todos-update([])` 事件 → 前端面板消失。**无 protocol / web 改动**，无需新 ClientMessage 或手动按钮。

## 为什么不做「手动清除按钮」/「多 list」/「精准按回合清」

- **手动按钮**：四家里唯一的手动 x 只在全完成时出现，帮不到"废弃在建计划"这个痛点；自动清更省事、更对症。（若日后仍想要随时手动清，再单开。）
- **精准清（只清这一中断轮建的 todo）**：做不到——**todo 没跟产生它的回合绑定**（`TodoItemLite = {content,status}`，服务端就一个 `this.todos` 单数组，TodoWrite 整份替换）。要精准得给 todo 加回合绑定，过度设计。鉴于 todo 本就是"单一当前计划"，整份清空语义上无误伤。
- **多个/嵌套 list**：四家全是单一扁平 list；细分靠模型重写条目即可。多 list 复杂度陡增、收益不清，不做。
- **message-id**（消息唯一 id）：是独立的中型项目（横切 core Message 类型 + 持久化 + 压缩/revert + web keying + 迁移；能修 searchJump 位置寻址静默失效的现有 bug），另行立项，不在本改动内。

## 测试

- **非空中断清计划**：midStreamGatedClient 流出 'partial answer' → setTodos([step1]) → interrupt → release → 断言 `todos === []` 且账本仍含 'partial answer'。
- **空中断留计划**：gatedClient（无流出）→ 先 setTodos([earlier]) → submit 新消息 → interrupt → release → 断言 `todos` 仍有 1 条（未被瞬时 Stop 抹掉）。
- **门禁**：`@zouyj/zuse-server` tsc + `packages/server` vitest。server-only、无 web → **Playwright N/A**。

## 涉及文件

- 改：`packages/server/src/session/SessionManager.ts`（中断收尾处 empty/non-empty 分支）。
- 测试：`packages/server/src/session/SessionManager.test.ts`（2 条新增）。
